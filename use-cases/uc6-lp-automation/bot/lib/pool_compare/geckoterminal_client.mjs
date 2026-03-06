const GECKO_BASE_URL = "https://api.geckoterminal.com/api/v2";

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim();
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const raw = String(headerValue).trim();
  if (!raw) return null;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

function buildUrl(baseUrl, pathname, params = {}) {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const relPath = String(pathname || "").replace(/^\/+/, "");
  const url = new URL(relPath, base);
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null) continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export function getPoolDisplayText(resource, extras = []) {
  const attrs = resource?.attributes || resource?.attrs || resource || {};
  const labels = [
    attrs?.name,
    attrs?.pool_name,
    attrs?.symbol,
    attrs?.display_name,
    attrs?.token_name,
    attrs?.pool_label,
    attrs?.label,
    ...(Array.isArray(attrs?.labels) ? attrs.labels : []),
    ...(Array.isArray(attrs?.tags) ? attrs.tags : []),
    resource?.id,
    ...extras,
  ];
  return uniqueStrings(labels).join(" | ");
}

export function parseFeeRateFromText(text) {
  const raw = String(text || "");
  if (!raw) return null;
  const matches = [...raw.matchAll(/(\d+(?:\.\d+)?)\s*%/g)]
    .map((match) => {
      const rawValue = String(match[1] || "");
      const pct = Number(rawValue);
      const decimals = (rawValue.split(".")[1] || "").length;
      return { pct, decimals, rawValue };
    })
    .filter((m) => Number.isFinite(m.pct) && m.pct > 0 && m.pct <= 1);
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    if (b.decimals !== a.decimals) return b.decimals - a.decimals;
    if (b.rawValue.length !== a.rawValue.length) return b.rawValue.length - a.rawValue.length;
    return a.pct - b.pct;
  });
  return matches[0].pct / 100;
}

export function parseVariantFromText(text) {
  const raw = String(text || "");
  if (!raw) return null;
  if (/\bCL\s*100\b/i.test(raw)) return "CL100";
  if (/\bCL\s*50\b/i.test(raw)) return "CL50";
  if (/\bCL\s*1\b/i.test(raw)) return "CL1";
  if (/basic\s+volatile/i.test(raw)) return "Basic Volatile";
  return null;
}

export function parseTickSpacingText(text) {
  const raw = String(text || "");
  if (!raw) return null;
  const explicit = raw.match(/tick\s*spacing\s*[:=]?\s*(\d+)/i) || raw.match(/tickspacing\s*[:=]?\s*(\d+)/i);
  if (explicit) return String(explicit[1]);
  return null;
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export function createGeckoTerminalClient({
  baseUrl = GECKO_BASE_URL,
  network = "base",
  fetchFn = globalThis.fetch,
  minDelayMs = 350,
  maxRetries = 3,
  timeoutMs = 15_000,
  logger = null,
} = {}) {
  if (typeof fetchFn !== "function") {
    throw new Error("GeckoTerminal client requires a fetch implementation");
  }

  let lastRequestAtMs = 0;
  let queue = Promise.resolve();
  let requestCount = 0;
  let lastError = null;

  async function runQueued(fn) {
    const run = async () => {
      const now = Date.now();
      const waitMs = Math.max(0, minDelayMs - (now - lastRequestAtMs));
      if (waitMs > 0) await sleep(waitMs);
      lastRequestAtMs = Date.now();
      return fn();
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  async function requestJson(pathname, { params = {}, retries = maxRetries, requestTimeoutMs = timeoutMs } = {}) {
    const url = buildUrl(baseUrl, pathname, params);
    return runQueued(async () => {
      let attempt = 0;
      let delayMs = 500;
      while (true) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("timeout")), requestTimeoutMs);
        try {
          requestCount += 1;
          const res = await fetchFn(url, {
            method: "GET",
            headers: {
              accept: "application/json",
            },
            signal: controller.signal,
          });
          const text = await res.text();
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = null;
          }

          if (!res.ok) {
            const err = new Error(
              `GeckoTerminal ${res.status} ${res.statusText} for ${url}${parsed ? `: ${JSON.stringify(parsed).slice(0, 400)}` : ""}`
            );
            err.status = res.status;
            err.url = url;
            err.body = parsed;
            lastError = err.message;
            const canRetry = attempt < retries && isRetryableStatus(res.status);
            if (!canRetry) throw err;
            const retryAfter = parseRetryAfterMs(res.headers.get("retry-after"));
            const backoff = retryAfter != null ? retryAfter : delayMs + Math.floor(Math.random() * 250);
            if (logger && typeof logger.warn === "function") {
              logger.warn(`[pool_compare] retrying ${pathname} after ${res.status} (${attempt + 1}/${retries})`);
            }
            await sleep(clamp(backoff, 250, 30_000));
            attempt += 1;
            delayMs = Math.min(delayMs * 2, 10_000);
            continue;
          }
          lastError = null;
          return parsed;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err || "unknown");
          lastError = msg;
          const isAbort = msg.toLowerCase().includes("abort") || msg.toLowerCase().includes("timeout");
          const canRetry = attempt < retries && isAbort;
          if (!canRetry) throw err;
          await sleep(delayMs + Math.floor(Math.random() * 200));
          attempt += 1;
          delayMs = Math.min(delayMs * 2, 10_000);
        } finally {
          clearTimeout(timer);
        }
      }
    });
  }

  return {
    network,
    snapshot() {
      return {
        requestCount,
        lastError,
        lastRequestAtIso: lastRequestAtMs ? new Date(lastRequestAtMs).toISOString() : null,
      };
    },
    requestJson,
    getDexes({ page = 1, pageSize = 100 } = {}) {
      return requestJson(`/networks/${network}/dexes`, {
        params: { page, page_size: pageSize },
      });
    },
    getPools({ page = 1, pageSize = 100, dexId = null, include = "base_token,quote_token,dex" } = {}) {
      const params = { page, page_size: pageSize, include };
      if (dexId) params.dex = dexId;
      return requestJson(`/networks/${network}/pools`, { params });
    },
    getPool(poolAddress, { include = "base_token,quote_token,dex" } = {}) {
      return requestJson(`/networks/${network}/pools/${encodeURIComponent(String(poolAddress))}`, {
        params: { include },
      });
    },
    getOhlcvDay(poolAddress, { limit = 30, aggregate = 1, currency = "usd", retries = maxRetries } = {}) {
      return requestJson(`/networks/${network}/pools/${encodeURIComponent(String(poolAddress))}/ohlcv/day`, {
        params: { aggregate, limit, currency },
        retries,
      });
    },
    async getPoolsMulti(addresses = [], { include = "base_token,quote_token,dex" } = {}) {
      const list = Array.isArray(addresses) ? addresses.filter(Boolean).map(String) : [];
      if (list.length === 0) return { data: [], included: [] };
      return requestJson(`/networks/${network}/pools/multi/${list.join(",")}`, {
        params: { include },
      });
    },
  };
}
