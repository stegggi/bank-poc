import path from "node:path";
import { promises as fsp } from "node:fs";

import {
  createGeckoTerminalClient,
  getPoolDisplayText,
  parseFeeRateFromText,
  parseTickSpacingText,
  parseVariantFromText,
} from "./geckoterminal_client.mjs";
import { compareToCurrentPool, computeEconomicsAndStats, mean, stdev } from "./scoring.mjs";

const NETWORK_ID = "base";
const NETWORK_META = { id: "base", name: "Base", chainId: 8453 };
const TINY = 1e-9;
const MAX_OHLCV_DAYS = 30;
const DEFAULT_MAX_OHLCV_POOLS_PER_RUN = 10;

const TOKEN_ALLOWLIST = [
  { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", stable: false },
  { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", stable: true },
  { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", stable: false },
  { symbol: "USDT", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", stable: true },
  { symbol: "DAI", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", stable: true },
];

const ALLOWLIST_BY_ADDRESS = new Map(TOKEN_ALLOWLIST.map((t) => [t.address.toLowerCase(), t]));

const TARGET_DEX_MATCHERS = [
  { key: "aerodrome_slipstream", displayName: "Aerodrome Slipstream", test: (n) => n.includes("aerodrome") && n.includes("slipstream") },
  { key: "uniswap_v3_base", displayName: "Uniswap v3 (Base)", test: (n) => n.includes("uniswap") && n.includes("v3") && n.includes("base") },
  { key: "pancakeswap_v3_base", displayName: "PancakeSwap v3 (Base)", test: (n) => n.includes("pancake") && n.includes("v3") && n.includes("base") },
  { key: "sushiswap_v3_base", displayName: "SushiSwap v3 (Base)", test: (n) => n.includes("sushi") && n.includes("v3") && n.includes("base") },
];

function nowIso() {
  return new Date().toISOString();
}

function utcDateKey(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getNested(obj, path) {
  let cur = obj;
  for (const key of Array.isArray(path) ? path : []) {
    if (!isObject(cur) && !Array.isArray(cur)) return undefined;
    cur = cur[key];
    if (cur == null) return cur;
  }
  return cur;
}

function firstFinite(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function normAddr(addr) {
  if (!addr) return null;
  const s = String(addr).trim();
  if (!s) return null;
  return s.toLowerCase();
}

function uniqueBy(arr, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(arr) ? arr : []) {
    const key = keyFn(item);
    if (key == null) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function canonicalPairKey(pair) {
  const a = String(pair?.baseSymbol || "").trim().toUpperCase();
  const b = String(pair?.quoteSymbol || "").trim().toUpperCase();
  if (!a && !b) return "";
  return [a, b].filter(Boolean).sort().join("/");
}

function strictPoolKey(dexId, address) {
  const dex = String(dexId || "").trim().toLowerCase();
  const addr = normAddr(address);
  if (!dex || !addr) return null;
  return `${dex}|${addr}`;
}

function resourceKey(type, id) {
  return `${String(type || "")}:${String(id || "")}`;
}

function indexIncluded(included) {
  const map = new Map();
  for (const item of Array.isArray(included) ? included : []) {
    if (!item?.type || !item?.id) continue;
    map.set(resourceKey(item.type, item.id), item);
  }
  return map;
}

function getRelResource(parent, relName, includedIdx) {
  const rel = parent?.relationships?.[relName]?.data;
  if (!rel) return null;
  if (Array.isArray(rel)) {
    return rel.map((r) => includedIdx.get(resourceKey(r?.type, r?.id))).filter(Boolean);
  }
  return includedIdx.get(resourceKey(rel?.type, rel?.id)) || null;
}

function parseDexEntry(dex) {
  const attrs = dex?.attributes || {};
  const name =
    String(attrs.name || attrs.display_name || attrs.identifier || dex?.id || "")
      .trim() || String(dex?.id || "");
  return { dexId: String(dex?.id || ""), dexName: name };
}

function parseTokenEntry(token) {
  const attrs = token?.attributes || {};
  const address = normAddr(attrs.address || attrs.token_address || attrs.contract_address || token?.id);
  const symbol = String(attrs.symbol || attrs.name || "").trim() || null;
  return {
    id: String(token?.id || ""),
    address,
    symbol,
    name: String(attrs.name || "").trim() || null,
  };
}

function parseFeeAndSelector({ attrs, dexName, poolText }) {
  const tickSpacing = num(attrs.tick_spacing ?? attrs.tickSpacing ?? attrs.tick_spacing_v3, NaN);
  const feeTierRaw = num(
    attrs.fee_tier ?? attrs.feeTier ?? attrs.fee_tier_bps ?? attrs.lp_fee_tier ?? attrs.swap_fee_bps,
    NaN
  );
  const feePctField = num(
    attrs.fee_percentage ??
      attrs.fee_percent ??
      attrs.feePercentage ??
      attrs.pool_fee_percentage ??
      attrs.swap_fee_percentage,
    NaN
  );
  const feeRateFromText = parseFeeRateFromText(poolText);
  let feeRateFromField = null;
  if (Number.isFinite(feePctField) && feePctField > 0 && feePctField <= 1) {
    feeRateFromField = feePctField / 100;
  } else if (Number.isFinite(feeTierRaw) && feeTierRaw > 0 && feeTierRaw <= 1_000_000) {
    feeRateFromField = feeTierRaw / 1_000_000;
  }
  const feeRate = Number.isFinite(Number(feeRateFromText))
    ? Number(feeRateFromText)
    : (Number.isFinite(Number(feeRateFromField)) ? Number(feeRateFromField) : null);
  const feeIsInferred = Number.isFinite(Number(feeRate));
  const dexLower = String(dexName || "").toLowerCase();
  const parsedTickSpacingText = parseTickSpacingText(poolText);
  const parsedTickSpacing = Number.isFinite(Number(parsedTickSpacingText)) ? Number(parsedTickSpacingText) : NaN;
  let type = "unknown";
  let value = null;
  if (dexLower.includes("slipstream") && Number.isFinite(tickSpacing) && tickSpacing > 0) {
    type = "tickSpacing";
    value = Math.round(tickSpacing);
  } else if (dexLower.includes("slipstream") && Number.isFinite(parsedTickSpacing) && parsedTickSpacing > 0) {
    type = "tickSpacing";
    value = Math.round(parsedTickSpacing);
  } else if (Number.isFinite(feeTierRaw) && feeTierRaw > 0) {
    type = "feeTier";
    value = Math.round(feeTierRaw);
  } else if (Number.isFinite(tickSpacing) && tickSpacing > 0) {
    type = "tickSpacing";
    value = Math.round(tickSpacing);
  }
  return {
    selector: {
      type,
      value,
      feeRate,
      feeIsInferred,
      variantLabel: parseVariantFromText(poolText),
      tickSpacingText: parsedTickSpacingText || (Number.isFinite(tickSpacing) && tickSpacing > 0 ? String(Math.round(tickSpacing)) : null),
    },
  };
}

function parseVolume24hUsd(attrs) {
  const v = firstFinite(
    getNested(attrs, ["volume_usd", "h24"]),
    getNested(attrs, ["volume_usd", "24h"]),
    getNested(attrs, ["volume_usd", "day"]),
    attrs?.volume_usd_h24,
    attrs?.volume_24h_usd,
    attrs?.h24_volume_usd,
    attrs?.volume24hUsd,
    attrs?.volume_usd
  );
  return Math.max(0, num(v, 0));
}

function parsePoolEntry(poolResource, includedIdx) {
  if (!poolResource) return null;
  const attrs = poolResource.attributes || {};
  const dex = getRelResource(poolResource, "dex", includedIdx);
  const baseTokenRes = getRelResource(poolResource, "base_token", includedIdx);
  const quoteTokenRes = getRelResource(poolResource, "quote_token", includedIdx);
  const dexMeta = dex ? parseDexEntry(dex) : { dexId: "", dexName: "" };
  const baseToken = baseTokenRes ? parseTokenEntry(baseTokenRes) : null;
  const quoteToken = quoteTokenRes ? parseTokenEntry(quoteTokenRes) : null;
  const poolAddress = normAddr(attrs.address || attrs.pool_address || attrs.contract_address) ||
    (String(poolResource.id || "").includes("_") ? String(poolResource.id).split("_").pop()?.toLowerCase() : null);
  if (!poolAddress || !baseToken?.address || !quoteToken?.address) return null;
  const tvlUsd = Math.max(
    0,
    num(
      attrs.reserve_in_usd ??
        attrs.reserveInUsd ??
        attrs.tvl_usd ??
        attrs.total_value_locked_usd ??
        attrs.total_reserve_in_usd,
      0
    )
  );
  const pairKey = `${(ALLOWLIST_BY_ADDRESS.get(baseToken.address)?.symbol || baseToken.symbol || "UNK")}/${(ALLOWLIST_BY_ADDRESS.get(
    quoteToken.address
  )?.symbol || quoteToken.symbol || "UNK")}`;
  const poolText = getPoolDisplayText(poolResource, [
    dexMeta.dexName,
    pairKey,
    baseToken.symbol || "",
    quoteToken.symbol || "",
  ]);
  const { selector } = parseFeeAndSelector({ attrs, dexName: dexMeta.dexName, poolText });
  return {
    raw: poolResource,
    address: poolAddress,
    dex: dexMeta,
    poolName: String(attrs.name || attrs.pool_name || "").trim() || null,
    poolText,
    baseToken,
    quoteToken,
    pairKey,
    selector,
    tvlUsd,
    volume24hUsd: parseVolume24hUsd(attrs),
    attrs,
  };
}

function isAllowedPair(candidate) {
  const base = ALLOWLIST_BY_ADDRESS.get(normAddr(candidate?.baseToken?.address));
  const quote = ALLOWLIST_BY_ADDRESS.get(normAddr(candidate?.quoteToken?.address));
  if (!base || !quote) return false;
  return Boolean(base.stable || quote.stable);
}

export function parseOhlcvDaily(ohlcvJson) {
  const rows =
    ohlcvJson?.data?.attributes?.ohlcv_list ||
    ohlcvJson?.data?.attributes?.ohlcv ||
    ohlcvJson?.data?.ohlcv_list ||
    [];
  const parsed = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [ts, open, high, low, close, volume] = row;
    const rec = {
      tsSec: num(ts, NaN),
      open: num(open, NaN),
      high: num(high, NaN),
      low: num(low, NaN),
      close: num(close, NaN),
      volume: Math.max(0, num(volume, NaN)),
    };
    if (
      [rec.tsSec, rec.open, rec.high, rec.low, rec.close, rec.volume].every((v) => Number.isFinite(v)) &&
      rec.close > 0
    ) {
      parsed.push(rec);
    }
  }
  parsed.sort((a, b) => a.tsSec - b.tsSec);
  return parsed;
}

function computeOhlcvStats(ohlcvRows) {
  const rows = Array.isArray(ohlcvRows) ? ohlcvRows : [];
  const vols30 = rows.slice(-30).map((r) => r.volume);
  const vols7 = rows.slice(-7).map((r) => r.volume);
  const ranges7 = rows
    .slice(-7)
    .map((r) => (r.close > 0 ? (Math.max(0, r.high - r.low) / r.close) : NaN))
    .filter((v) => Number.isFinite(v) && v >= 0);
  const avgVol7 = mean(vols7);
  const avgVol30 = mean(vols30);
  const stability30 = avgVol30 > 0 ? stdev(vols30) / avgVol30 : 0;
  return {
    volAvg7dUsd: avgVol7,
    volAvg30dUsd: avgVol30,
    dailyRangePct7d: mean(ranges7),
    volumeStability30d: stability30,
    ohlcvDays: rows.length,
  };
}

async function readJsonIfExists(filePath) {
  try {
    const txt = await fsp.readFile(filePath, "utf8");
    if (!txt.trim()) return null;
    return JSON.parse(txt);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await fsp.rename(tmp, filePath);
}

async function readJsonLinesIfExists(filePath) {
  try {
    const txt = await fsp.readFile(filePath, "utf8");
    if (!txt.trim()) return [];
    return txt
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }
}

async function appendJsonLines(filePath, rows) {
  const lines = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (lines.length === 0) return;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const payload = lines.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fsp.appendFile(filePath, payload, { encoding: "utf8", mode: 0o600 });
}

function buildTvlHistoryIndex(entries) {
  const byPool = new Map();
  const existingDailyKeys = new Set();
  for (const e of Array.isArray(entries) ? entries : []) {
    const poolAddress = normAddr(e?.poolAddress);
    const dateKey = String(e?.dateKey || "");
    const tvlUsd = num(e?.tvlUsd, NaN);
    if (!poolAddress || !dateKey || !Number.isFinite(tvlUsd)) continue;
    const dedupeKey = `${dateKey}:${poolAddress}`;
    if (existingDailyKeys.has(dedupeKey)) continue;
    existingDailyKeys.add(dedupeKey);
    let arr = byPool.get(poolAddress);
    if (!arr) {
      arr = [];
      byPool.set(poolAddress, arr);
    }
    arr.push({
      dateKey,
      poolAddress,
      tvlUsd,
      venueId: e?.venueId ? String(e.venueId) : null,
      pairKey: e?.pairKey ? String(e.pairKey) : null,
    });
  }
  for (const arr of byPool.values()) {
    arr.sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)));
  }
  return { byPool, existingDailyKeys };
}

function computeTvlAveragesForPool({ poolAddress, tvlUsdToday, tvlHistoryIndex }) {
  const addr = normAddr(poolAddress);
  const hist = addr ? tvlHistoryIndex.byPool.get(addr) || [] : [];
  const tvls = hist.map((r) => num(r.tvlUsd, 0)).filter((v) => Number.isFinite(v) && v >= 0);
  const last7 = tvls.slice(-7);
  const last30 = tvls.slice(-30);
  const tvlHistoryDays = tvls.length;
  const tvlAvg7dUsd = last7.length > 0 ? mean(last7) : num(tvlUsdToday, 0);
  const tvlAvg30dUsd = last30.length > 0 ? mean(last30) : num(tvlUsdToday, 0);
  return { tvlAvg7dUsd, tvlAvg30dUsd, tvlHistoryDays };
}

function pairDisplaySymbols(candidate) {
  const b = ALLOWLIST_BY_ADDRESS.get(normAddr(candidate?.baseToken?.address));
  const q = ALLOWLIST_BY_ADDRESS.get(normAddr(candidate?.quoteToken?.address));
  return {
    baseSymbol: b?.symbol || candidate?.baseToken?.symbol || "UNK",
    quoteSymbol: q?.symbol || candidate?.quoteToken?.symbol || "UNK",
  };
}

function venueSelectorForCurrentPool(currentPoolMeta, gtCandidate) {
  const selectorType = String(currentPoolMeta?.selector?.type || gtCandidate?.selector?.type || "unknown");
  const selectorValueRaw = currentPoolMeta?.selector?.value;
  const selectorValue = Number.isFinite(Number(selectorValueRaw))
    ? Number(selectorValueRaw)
    : Number.isFinite(Number(gtCandidate?.selector?.value))
      ? Number(gtCandidate.selector.value)
      : null;
  return {
    type: selectorType === "fee" ? "feeTier" : selectorType,
    value: selectorValue,
    feeRate: Number.isFinite(Number(gtCandidate?.selector?.feeRate)) ? Number(gtCandidate.selector.feeRate) : null,
    feeIsInferred: Boolean(gtCandidate?.selector?.feeIsInferred),
    variantLabel: gtCandidate?.selector?.variantLabel || null,
    tickSpacingText: gtCandidate?.selector?.tickSpacingText || null,
  };
}

function makeCurrentFallbackRow({ currentRef }) {
  if (!currentRef?.poolAddress) return null;
  const pair = currentRef.pair || { baseSymbol: "WETH", quoteSymbol: "USDC", pairKey: "WETH/USDC" };
  return {
    rank: 0,
    isCurrent: true,
    dex: {
      id: currentRef.dexId || "unknown",
      name: currentRef.dexName || "Current Pool",
    },
    chain: { id: "base", chainId: 8453 },
    pool: { address: currentRef.poolAddress, name: null },
    pair: {
      baseSymbol: pair.baseSymbol || "WETH",
      quoteSymbol: pair.quoteSymbol || "USDC",
      baseAddress: pair.baseAddress || null,
      quoteAddress: pair.quoteAddress || null,
      pairKey: pair.pairKey || `${pair.baseSymbol || "WETH"}/${pair.quoteSymbol || "USDC"}`,
    },
    selector: currentRef.selector || {
      type: "unknown",
      value: null,
      feeRate: null,
      feeIsInferred: false,
      variantLabel: null,
      tickSpacingText: null,
    },
    stats: {
      tvlUsd: 0,
      tvlAvg7dUsd: 0,
      tvlAvg30dUsd: 0,
      tvlHistoryDays: 0,
      volAvg7dUsd: 0,
      volAvg30dUsd: 0,
      feesDay7dUsd: null,
      feesDay30dUsd: null,
      feePower7d: 0,
      feePower30d: 0,
      dailyRangePct7d: 0,
      volumeStability30d: 0,
      flowTrend: null,
    },
    economics: {
      expectedFeesDayUsd: 0,
      expectedCostsDayUsd: 0,
      expectedNetDayUsd: 0,
      expectedRebalancesPerDay: 0,
      expectedCostPerRebalanceUsd: 0,
      gasBaselineUsd: num(currentRef.gasBaselineUsd, 0.03),
      rebalanceSwapNotionalPct: num(currentRef.rebalanceSwapNotionalPct, 0.1),
      finalScore: null,
      scoreReason: "current_pool_fallback",
    },
    scalability: {
      scalable: false,
      scalableByTvl: false,
      scalableBySize: false,
      tvlMinUsd: 0,
      maxRefCapitalPctOfTvl: 0,
      refCapitalPctOfTvl: 0,
    },
    compareToCurrent: {
      rating: "Similar",
      reason: "Current pool baseline unavailable",
      expectedNetDiffDayUsd: 0,
      switchCostUsd: 0,
      breakEvenDays: null,
    },
  };
}

async function discoverTargetDexes(client, logger) {
  const dexesJson = await client.getDexes({ page: 1, pageSize: 100 });
  const dexes = Array.isArray(dexesJson?.data) ? dexesJson.data : [];
  const selected = [];
  for (const matcher of TARGET_DEX_MATCHERS) {
    const found = dexes.find((d) => matcher.test(String(d?.attributes?.name || d?.id || "").toLowerCase()));
    if (!found) {
      if (logger?.warn) logger.warn(`[pool_compare] dex not found on base: ${matcher.displayName}`);
      continue;
    }
    const parsed = parseDexEntry(found);
    selected.push({ dexId: parsed.dexId, dexName: matcher.displayName || parsed.dexName });
  }
  return selected;
}

async function fetchDexCandidates(client, dex, { pageSize, logger }) {
  const json = await client.getPools({ dexId: dex.dexId, page: 1, pageSize, include: "base_token,quote_token,dex" });
  const includedIdx = indexIncluded(json?.included);
  const pools = Array.isArray(json?.data) ? json.data : [];
  const parsed = pools.map((p) => parsePoolEntry(p, includedIdx)).filter(Boolean);
  const filtered = parsed.filter(isAllowedPair).map((p) => ({
    ...p,
    dex: { id: dex.dexId, name: dex.dexName },
  }));
  filtered.sort((a, b) => num(b.tvlUsd, 0) - num(a.tvlUsd, 0));
  if (logger?.info) logger.info(`[pool_compare] ${dex.dexName}: ${filtered.length} eligible pools from top page`);
  return filtered;
}

async function fetchPoolByAddress(client, poolAddress, { logger }) {
  const json = await client.getPool(poolAddress, { include: "base_token,quote_token,dex" });
  const includedIdx = indexIncluded(json?.included);
  const pool = parsePoolEntry(json?.data, includedIdx);
  if (!pool) return null;
  if (!isAllowedPair(pool)) {
    if (logger?.warn) logger.warn(`[pool_compare] current pool ${poolAddress} not in allowed universe`);
    return pool;
  }
  return pool;
}

async function fetchOhlcvRowsForCandidate(client, candidate, { logger }) {
  const idsToTry = uniqueBy(
    [candidate?.address, candidate?.raw?.id].filter(Boolean).map((v) => String(v)),
    (v) => v.toLowerCase()
  );
  let lastErr = null;
  for (const poolId of idsToTry) {
    try {
      const ohlcvJson = await client.getOhlcvDay(poolId, {
        limit: MAX_OHLCV_DAYS,
        aggregate: 1,
        currency: "usd",
        retries: 0,
      });
      const rows = parseOhlcvDaily(ohlcvJson);
      if (rows.length > 0) {
        if (poolId !== candidate?.address && logger?.info) {
          logger.info(`[pool_compare] OHLCV fallback succeeded for ${candidate?.address} using ${poolId}`);
        }
        return rows;
      }
      if (logger?.warn) {
        logger.warn(`[pool_compare] OHLCV empty for ${poolId} (${candidate?.pairKey || candidate?.address})`);
      }
    } catch (err) {
      lastErr = err;
      if (Number(err?.status) === 429) {
        if (logger?.warn) {
          logger.warn(`[pool_compare] OHLCV rate-limited for ${poolId}; skipping remaining ID variants`);
        }
        return { rows: [], rateLimited: true };
      }
      if (logger?.warn) {
        logger.warn(
          `[pool_compare] OHLCV fetch failed for ${poolId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
  if (lastErr) return { rows: [], rateLimited: false };
  return { rows: [], rateLimited: false };
}

function roughCandidateFeePowerScore(candidate) {
  const tvlUsd = Math.max(TINY, num(candidate?.tvlUsd, 0));
  const feeRate = Number.isFinite(Number(candidate?.selector?.feeRate)) ? Math.max(0, Number(candidate.selector.feeRate)) : null;
  const vol24hUsd = Math.max(0, num(candidate?.volume24hUsd, 0));
  if (vol24hUsd > 0 && feeRate != null) return (vol24hUsd * feeRate) / tvlUsd;
  if (vol24hUsd > 0) return vol24hUsd / tvlUsd;
  return Math.max(0, num(candidate?.tvlUsd, 0)) / 1_000_000;
}

function buildPoolRowBase(candidate) {
  const sym = pairDisplaySymbols(candidate);
  return {
    rank: 0,
    isCurrent: false,
    dex: { id: candidate.dex?.dexId || candidate.dex?.id || "", name: candidate.dex?.dexName || candidate.dex?.name || "Unknown" },
    chain: { id: "base", chainId: 8453 },
    pool: { address: candidate.address, name: candidate.poolName || null },
    pair: {
      baseSymbol: sym.baseSymbol,
      quoteSymbol: sym.quoteSymbol,
      baseAddress: candidate.baseToken?.address || null,
      quoteAddress: candidate.quoteToken?.address || null,
      pairKey: `${sym.baseSymbol}/${sym.quoteSymbol}`,
    },
    selector: {
      type: candidate.selector?.type || "unknown",
      value: Number.isFinite(Number(candidate.selector?.value)) ? Number(candidate.selector.value) : null,
      feeRate: Number.isFinite(Number(candidate.selector?.feeRate)) ? Number(candidate.selector.feeRate) : null,
      feeIsInferred: Boolean(candidate.selector?.feeIsInferred),
      variantLabel: candidate.selector?.variantLabel || null,
      tickSpacingText: candidate.selector?.tickSpacingText || null,
    },
    stats: {
      tvlUsd: Math.max(0, num(candidate.tvlUsd, 0)),
      tvlAvg7dUsd: 0,
      tvlAvg30dUsd: 0,
      tvlHistoryDays: 0,
      volAvg7dUsd: 0,
      volAvg30dUsd: 0,
      feesDay7dUsd: null,
      feesDay30dUsd: null,
      feePower7d: null,
      feePower30d: null,
      dailyRangePct7d: 0,
      volumeStability30d: 0,
      flowTrend: null,
    },
    economics: {
      expectedFeesDayUsd: null,
      expectedCostsDayUsd: 0,
      expectedNetDayUsd: null,
      expectedRebalancesPerDay: 0,
      expectedCostPerRebalanceUsd: 0,
      gasBaselineUsd: 0,
      rebalanceSwapNotionalPct: 0,
      finalScore: null,
      scoreReason: null,
    },
    scalability: {
      scalable: false,
      scalableByTvl: false,
      scalableBySize: false,
      tvlMinUsd: 0,
      maxRefCapitalPctOfTvl: 0,
      refCapitalPctOfTvl: 0,
    },
    compareToCurrent: {
      rating: "Similar",
      reason: "Pending comparison",
      expectedNetDiffDayUsd: 0,
      switchCostUsd: 0,
      breakEvenDays: null,
    },
  };
}

export async function runPoolComparisonJob({
  rankingsPath,
  tvlHistoryPath,
  currentRef,
  settings,
  logger = console,
  fetchFn = globalThis.fetch,
}) {
  const cfg = {
    enabled: settings?.enabled !== false,
    computeHourUtc: clamp(Math.round(num(settings?.computeHourUtc, 8)), 0, 23),
    maxCandidatesPerDex: clamp(Math.round(num(settings?.maxCandidatesPerDex, 50)), 5, 100),
    topN: clamp(Math.round(num(settings?.topN, 5)), 1, 20),
    minTvlUsd: Math.max(0, num(settings?.minTvlUsd, 2_000_000)),
    maxRefCapitalPctOfTvl: clamp(num(settings?.maxRefCapitalPctOfTvl, 0.0025), 0, 1),
    requireFeeRateInference: settings?.requireFeeRateInference !== false,
    allowLowTvlInTable: settings?.allowLowTvlInTable !== false,
    rebalanceSwapNotionalPct: clamp(num(settings?.rebalanceSwapNotionalPct, 0.1), 0, 1),
  };
  if (!cfg.enabled) {
    const disabled = {
      ok: false,
      computedAtIso: nowIso(),
      network: NETWORK_META,
      current: null,
      top5: [],
      lastError: "poolComparison disabled",
    };
    await writeJsonAtomic(rankingsPath, disabled);
    return disabled;
  }

  const client = createGeckoTerminalClient({
    network: NETWORK_ID,
    fetchFn,
    logger,
    minDelayMs: 2200,
    maxRetries: 3,
    timeoutMs: 15_000,
  });

  const dateKey = utcDateKey();
  const dexes = await discoverTargetDexes(client, logger);
  const candidateList = [];
  for (const dex of dexes) {
    try {
      const perDex = await fetchDexCandidates(client, dex, { pageSize: cfg.maxCandidatesPerDex, logger });
      candidateList.push(...perDex.slice(0, cfg.maxCandidatesPerDex));
    } catch (err) {
      if (logger?.warn) logger.warn(`[pool_compare] failed dex candidate fetch ${dex.dexName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let candidates = uniqueBy(candidateList, (c) => strictPoolKey(c?.dex?.dexId || c?.dex?.id, c?.address));

  const currentPoolAddress = normAddr(currentRef?.poolAddress);
  let currentCandidate = currentPoolAddress ? candidates.find((c) => normAddr(c.address) === currentPoolAddress) : null;
  if (!currentCandidate && currentPoolAddress) {
    try {
      const fetchedCurrent = await fetchPoolByAddress(client, currentPoolAddress, { logger });
      if (fetchedCurrent) {
        const dexNameOverride = currentRef?.dexName || fetchedCurrent.dex?.dexName || fetchedCurrent.dex?.name || "Current Pool";
        currentCandidate = {
          ...fetchedCurrent,
          dex: {
            dexId: fetchedCurrent.dex?.dexId || fetchedCurrent.dex?.id || currentRef?.dexId || "",
            dexName: dexNameOverride,
          },
        };
        candidates.push(currentCandidate);
      }
    } catch (err) {
      if (logger?.warn) logger.warn(`[pool_compare] failed to fetch current pool ${currentPoolAddress}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  candidates = uniqueBy(candidates, (c) => strictPoolKey(c?.dex?.dexId || c?.dex?.id, c?.address));

  const ohlcvPriority = uniqueBy(
    [currentCandidate, ...candidates.slice().sort((a, b) => roughCandidateFeePowerScore(b) - roughCandidateFeePowerScore(a))].filter(
      Boolean
    ),
    (c) => strictPoolKey(c?.dex?.dexId || c?.dex?.id, c?.address)
  );
  const maxOhlcvPools = clamp(Math.max(cfg.topN * 2 + 2, 8), 6, DEFAULT_MAX_OHLCV_POOLS_PER_RUN);
  const ohlcvFetchSet = new Set(
    ohlcvPriority
      .slice(0, maxOhlcvPools)
      .map((c) => strictPoolKey(c?.dex?.dexId || c?.dex?.id, c?.address))
      .filter(Boolean)
  );

  const rawHistory = await readJsonLinesIfExists(tvlHistoryPath);
  const tvlHistoryIndex = buildTvlHistoryIndex(rawHistory);
  const tvlAppends = [];

  const rows = [];
  const refCapitalUsd = Math.max(0, num(currentRef?.refCapitalUsd, 0));
  const gasBaselineUsd = Math.max(0, num(currentRef?.gasBaselineUsd, 0.03));
  const bandHalfBps = Math.max(25, Math.round(num(currentRef?.band?.bandHalfBps, 100)));
  const edgeRebalancePct = clamp(num(currentRef?.band?.edgeRebalancePct, 0.85), 0.1, 0.99);
  let ohlcvRateLimited = false;
  let ohlcv429Count = 0;
  let ohlcvFallbackVolumeCount = 0;
  let ohlcvSkippedByBudgetCount = 0;
  let ohlcvSkippedAfterRateLimitCount = 0;

  for (const candidate of candidates) {
    let ohlcvRows = [];
    const candidateKey = strictPoolKey(candidate?.dex?.dexId || candidate?.dex?.id, candidate?.address);
    const shouldFetchOhlcv = !!candidateKey && ohlcvFetchSet.has(candidateKey);
    if (shouldFetchOhlcv) {
      if (!ohlcvRateLimited) {
        const ohlcvRes = await fetchOhlcvRowsForCandidate(client, candidate, { logger });
        ohlcvRows = Array.isArray(ohlcvRes?.rows) ? ohlcvRes.rows : [];
        if (ohlcvRes?.rateLimited) {
          ohlcvRateLimited = true;
          ohlcv429Count += 1;
          if (logger?.warn) {
            logger.warn("[pool_compare] GeckoTerminal OHLCV rate limit hit; skipping OHLCV for remaining candidates this run");
          }
        }
      } else {
        ohlcvSkippedAfterRateLimitCount += 1;
      }
    } else {
      ohlcvSkippedByBudgetCount += 1;
    }

    let ohlcvStats = computeOhlcvStats(ohlcvRows);
    const volume24hFallback = Math.max(0, num(candidate.volume24hUsd, 0));
    if (ohlcvStats.volAvg7dUsd <= 0 && volume24hFallback > 0) {
      ohlcvFallbackVolumeCount += 1;
      ohlcvStats = {
        ...ohlcvStats,
        volAvg7dUsd: volume24hFallback,
        volAvg30dUsd: volume24hFallback,
        volumeStability30d: ohlcvStats.volumeStability30d > 0 ? ohlcvStats.volumeStability30d : 1,
      };
    }
    const tvlRow = {
      dateKey,
      poolAddress: candidate.address,
      tvlUsd: Math.max(0, num(candidate.tvlUsd, 0)),
      venueId: candidate.dex?.dexId || candidate.dex?.id || "",
      pairKey: candidate.pairKey || "",
    };
    const dedupeKey = `${dateKey}:${candidate.address}`;
    if (!tvlHistoryIndex.existingDailyKeys.has(dedupeKey)) {
      tvlHistoryIndex.existingDailyKeys.add(dedupeKey);
      let arr = tvlHistoryIndex.byPool.get(candidate.address);
      if (!arr) {
        arr = [];
        tvlHistoryIndex.byPool.set(candidate.address, arr);
      }
      arr.push(tvlRow);
      arr.sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)));
      tvlAppends.push(tvlRow);
    }
    const tvlAverages = computeTvlAveragesForPool({
      poolAddress: candidate.address,
      tvlUsdToday: candidate.tvlUsd,
      tvlHistoryIndex,
    });

    const row = buildPoolRowBase(candidate);
    row.stats = {
      ...row.stats,
      tvlUsd: Math.max(0, num(candidate.tvlUsd, 0)),
      tvlAvg7dUsd: tvlAverages.tvlAvg7dUsd,
      tvlAvg30dUsd: tvlAverages.tvlAvg30dUsd,
      tvlHistoryDays: tvlAverages.tvlHistoryDays,
      volAvg7dUsd: ohlcvStats.volAvg7dUsd,
      volAvg30dUsd: ohlcvStats.volAvg30dUsd,
      dailyRangePct7d: ohlcvStats.dailyRangePct7d,
      volumeStability30d: ohlcvStats.volumeStability30d,
    };

    const econ = computeEconomicsAndStats({
      stats: row.stats,
      selector: row.selector,
      refCapitalUsd,
      bandHalfBps,
      edgeRebalancePct,
      gasBaselineUsd,
      minTvlUsd: cfg.minTvlUsd,
      maxRefCapitalPctOfTvl: cfg.maxRefCapitalPctOfTvl,
      requireFeeRateInference: cfg.requireFeeRateInference,
      rebalanceSwapNotionalPct: cfg.rebalanceSwapNotionalPct,
    });
    row.stats = { ...row.stats, ...econ.stats };
    row.economics = econ.economics;
    row.scalability = econ.scalability;
    rows.push(row);
  }

  if (tvlAppends.length > 0) {
    await appendJsonLines(tvlHistoryPath, tvlAppends);
  }

  rows.sort((a, b) => {
    const scoreDiff = num(b.economics?.finalScore, Number.NEGATIVE_INFINITY) - num(a.economics?.finalScore, Number.NEGATIVE_INFINITY);
    if (scoreDiff !== 0) return scoreDiff;
    return num(b.stats?.tvlAvg7dUsd, 0) - num(a.stats?.tvlAvg7dUsd, 0);
  });

  const currentRow =
    rows.find((r) => normAddr(r?.pool?.address) === currentPoolAddress) ||
    makeCurrentFallbackRow({ currentRef: {
      poolAddress: currentPoolAddress,
      dexId: currentRef?.dexId || "",
      dexName: currentRef?.dexName || "",
      pair: currentRef?.pair || null,
      selector: currentRef?.selector || null,
      gasBaselineUsd,
      rebalanceSwapNotionalPct: cfg.rebalanceSwapNotionalPct,
    } });

  if (currentRow) {
    currentRow.isCurrent = true;
    currentRow.rank = 0;
    if (currentRef?.selector) {
      currentRow.selector = venueSelectorForCurrentPool(currentRef, { selector: currentRow.selector });
    }
    if (currentRef?.pair) {
      currentRow.pair = {
        ...currentRow.pair,
        baseSymbol: currentRef.pair.baseSymbol || currentRow.pair.baseSymbol,
        quoteSymbol: currentRef.pair.quoteSymbol || currentRow.pair.quoteSymbol,
        baseAddress: currentRef.pair.baseAddress || currentRow.pair.baseAddress,
        quoteAddress: currentRef.pair.quoteAddress || currentRow.pair.quoteAddress,
        pairKey: currentRef.pair.pairKey || currentRow.pair.pairKey,
      };
    }
  }

  const estimatedSwitchCostUsd = Math.max(0, gasBaselineUsd * 2 + 0.02);
  for (const row of rows) {
    row.compareToCurrent = compareToCurrentPool(row, currentRow, {
      switchCostUsd: estimatedSwitchCostUsd,
      requireFeeRateInference: cfg.requireFeeRateInference,
    });
  }

  const rowsSorted = rows
    .slice()
    .sort((a, b) => {
      const scoreDiff = num(b.economics?.finalScore, Number.NEGATIVE_INFINITY) - num(a.economics?.finalScore, Number.NEGATIVE_INFINITY);
      if (scoreDiff !== 0) return scoreDiff;
      return num(b.stats?.tvlAvg7dUsd, 0) - num(a.stats?.tvlAvg7dUsd, 0);
    });

  const nonCurrentRows = rowsSorted.filter((r) => {
    const addr = normAddr(r?.pool?.address);
    return !(currentPoolAddress && addr === currentPoolAddress);
  });

  const scalableRows = nonCurrentRows.filter((r) => {
    if (!r?.scalability?.scalable) return false;
    if (cfg.requireFeeRateInference && !r?.selector?.feeIsInferred) return false;
    return true;
  });
  const notRecommendedRows = cfg.allowLowTvlInTable
    ? nonCurrentRows.filter((r) => !r?.scalability?.scalable || (cfg.requireFeeRateInference && !r?.selector?.feeIsInferred))
    : [];

  const dedupedRows = uniqueBy(scalableRows, (r) => strictPoolKey(r?.dex?.id, r?.pool?.address));
  const bestPerVenue = uniqueBy(dedupedRows, (r) => String(r?.dex?.id || "").toLowerCase());
  const selected = [];
  const selectedKeys = new Set();
  const tryPush = (row) => {
    if (!row || selected.length >= cfg.topN) return;
    const key = strictPoolKey(row?.dex?.id, row?.pool?.address);
    if (!key || selectedKeys.has(key)) return;
    selectedKeys.add(key);
    selected.push(row);
  };
  for (const row of bestPerVenue) tryPush(row);
  for (const row of dedupedRows) tryPush(row);
  for (const row of scalableRows) tryPush(row);

  const top5 = selected
    .slice(0, cfg.topN)
    .map((r, idx) => ({ ...r, rank: idx + 1 }));
  const notRecommended = uniqueBy(notRecommendedRows, (r) => strictPoolKey(r?.dex?.id, r?.pool?.address))
    .slice(0, cfg.topN)
    .map((r, idx) => ({ ...r, rank: idx + 1 }));

  if (currentRow) {
    currentRow.compareToCurrent = {
      rating: "Similar",
      reason: "Current pool baseline",
      expectedNetDiffDayUsd: 0,
      switchCostUsd: estimatedSwitchCostUsd,
      breakEvenDays: 0,
    };
  }

  const out = {
    ok: true,
    computedAtIso: nowIso(),
    network: NETWORK_META,
    universe: {
      venues: dexes.map((d) => ({ dexId: d.dexId, dexName: d.dexName })),
      tokenAllowlist: TOKEN_ALLOWLIST.map((t) => ({ address: t.address, symbol: t.symbol })),
      pairRule: "allowlist AND at least one stable",
    },
    ref: {
      currentPool: {
        poolAddress: currentPoolAddress,
        dexId: currentRef?.dexId || currentRow?.dex?.id || null,
        dexName: currentRef?.dexName || currentRow?.dex?.name || null,
        pairKey: currentRef?.pair?.pairKey || currentRow?.pair?.pairKey || null,
        selector: currentRef?.selector || currentRow?.selector || null,
        band: {
          bandHalfBps,
          edgeRebalancePct,
        },
        refCapitalUsd,
      },
    },
    current: currentRow,
    top5,
    notRecommended,
    notes: {
      limitations: [
        "Daily ranking uses GeckoTerminal public API snapshots and daily OHLCV; not real-time.",
        "Fees/day, FeePower, and expected net/day are heuristics based on daily volume, inferred fee tier, TVL snapshots, and a simple churn proxy.",
        "TVL averages use local daily snapshots and may fall back to current TVL for newly observed pools.",
        "Pools with unknown fee tier or insufficient scalability are excluded from Top 5 recommendations by default.",
        "OHLCV requests are rate-limit constrained on GeckoTerminal free tier; some rows may use 24h volume fallback or incomplete OHLCV coverage.",
      ],
    },
    debug: {
      gecko: client.snapshot(),
      candidatesConsidered: rows.length,
      generatedDateKey: dateKey,
      ohlcv: {
        maxPoolsRequested: maxOhlcvPools,
        selectedPools: ohlcvFetchSet.size,
        rateLimited: ohlcvRateLimited,
        rateLimitHits: ohlcv429Count,
        fallbackVolumeRows: ohlcvFallbackVolumeCount,
        skippedByBudget: ohlcvSkippedByBudgetCount,
        skippedAfterRateLimit: ohlcvSkippedAfterRateLimitCount,
      },
    },
  };

  await writeJsonAtomic(rankingsPath, out);
  return out;
}

export async function loadPoolComparisonCache(rankingsPath) {
  const parsed = await readJsonIfExists(rankingsPath);
  if (!parsed || typeof parsed !== "object") return null;
  return parsed;
}
