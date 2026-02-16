import { Uc5ConfigSchema, type Uc5Config, type Uc5Status } from "./types";

type CacheEntry<T> = { value: T; expiresAt: number };
type VmCache = {
  config?: CacheEntry<Uc5Config>;
  status?: CacheEntry<Uc5Status>;
};

const g = globalThis as typeof globalThis & { __uc5VmCache?: VmCache };

function cache(): VmCache {
  if (!g.__uc5VmCache) g.__uc5VmCache = {};
  return g.__uc5VmCache;
}

export function uc5VmBaseUrl(): string {
  return String(process.env.UC5_BOT_TELEMETRY_URL || process.env.UC5_VM_BASE_URL || "").replace(/\/+$/, "");
}

export function defaultUc5Config(): Uc5Config {
  return Uc5ConfigSchema.parse({
    version: 1,
    ownerAddress: process.env.UC5_OWNER_ADDRESS || process.env.NEXT_PUBLIC_UC5_OWNER_ADDRESS || "",
    etherealApiBase: process.env.UC5_ETHEREAL_API_BASE || "https://api.ethereal.trade",
    etherealArchiveBase: process.env.UC5_ETHEREAL_ARCHIVE_BASE || "https://archive.ethereal.trade",
    ticker: "BTCUSD",
    productId: "",
    subaccountId: "",
    subaccountName: "",
    tradingEnabled: true,
    killSwitch: false,
    pollIntervalSeconds: 2,
    predictionHorizonSeconds: 3600,
    maxLeverage: 2,
    maxMarginUsd: 100,
    confidenceThreshold: 0.6,
    minHoldSeconds: 3600,
    maxHoldSeconds: 7200,
    maxOrdersPerHour: 120,
  });
}

export function fallbackUc5Status(message = "Bot status unavailable. Check VM URL/connectivity."): Uc5Status {
  return {
    updatedAt: Date.now(),
    bot: { alive: false, message },
  };
}

function messageFromUnknown(err: unknown, fallback: string): string {
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object" && "error" in err && typeof (err as { error?: unknown }).error === "string") {
    return String((err as { error?: unknown }).error);
  }
  return fallback;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(id);
  }
}

export async function fetchVm(path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const base = uc5VmBaseUrl();
  if (!base) throw new Error("Missing UC5_BOT_TELEMETRY_URL (or UC5_VM_BASE_URL).");
  return fetchWithTimeout(`${base}${path.startsWith("/") ? path : `/${path}`}`, init, timeoutMs);
}

function botTokenHeader(): Record<string, string> {
  const t = String(process.env.UC5_BOT_TOKEN || "");
  if (!t) throw new Error("Missing UC5_BOT_TOKEN on Vercel");
  return { "x-uc5-bot-token": t };
}

export async function getVmConfigCached(ttlMs = 15_000): Promise<Uc5Config> {
  const c = cache();
  const now = Date.now();
  if (c.config && c.config.expiresAt > now) return c.config.value;

  try {
    const r = await fetchVm("/config", { headers: { accept: "application/json" } }, 8000);
    if (!r.ok) throw new Error(`VM /config ${r.status}`);
    const j = await r.json();
    const cfg = Uc5ConfigSchema.parse(j);
    c.config = { value: cfg, expiresAt: now + ttlMs };
    return cfg;
  } catch {
    if (c.config?.value) return c.config.value;
    return defaultUc5Config();
  }
}

export async function postVmConfig(cfg: Uc5Config): Promise<unknown> {
  const r = await fetchVm(
    "/config",
    {
      method: "POST",
      headers: { ...botTokenHeader(), "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ config: cfg }),
    },
    10_000
  );
  const text = await r.text();
  let out: unknown = null;
  try {
    out = text ? JSON.parse(text) : null;
  } catch {
    out = { raw: text };
  }
  if (!r.ok) throw new Error(messageFromUnknown(out, `VM /config failed (${r.status})`));
  const nextCfg =
    out && typeof out === "object" && "config" in out ? Uc5ConfigSchema.parse((out as { config?: unknown }).config || cfg) : cfg;
  cache().config = { value: nextCfg, expiresAt: Date.now() + 15_000 };
  return out;
}

export async function getVmStatusCached(ttlMs = 2_000): Promise<Uc5Status> {
  const c = cache();
  const now = Date.now();
  if (c.status && c.status.expiresAt > now) return c.status.value;

  try {
    const r = await fetchVm("/status", { headers: { accept: "application/json" } }, 8000);
    if (!r.ok) throw new Error(`VM /status ${r.status}`);
    const j = (await r.json()) as Uc5Status;
    c.status = { value: j, expiresAt: now + ttlMs };
    return j;
  } catch {
    if (c.status?.value) return c.status.value;
    return fallbackUc5Status();
  }
}

export async function postVmCommand(command: { type: string; payload?: unknown }): Promise<unknown> {
  const r = await fetchVm(
    "/command",
    {
      method: "POST",
      headers: { ...botTokenHeader(), "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(command),
    },
    10_000
  );
  const text = await r.text();
  let out: unknown = null;
  try {
    out = text ? JSON.parse(text) : null;
  } catch {
    out = { raw: text };
  }
  if (!r.ok) throw new Error(messageFromUnknown(out, `VM /command failed (${r.status})`));
  return out;
}

export async function getVmCommands(): Promise<{ commands: unknown[] }> {
  try {
    const r = await fetchVm(
      "/commands",
      { headers: { ...botTokenHeader(), accept: "application/json" } },
      8000
    );
    if (!r.ok) throw new Error(`VM /commands ${r.status}`);
    const j = await r.json();
    const commands = Array.isArray(j?.commands) ? j.commands : [];
    return { commands };
  } catch {
    return { commands: [] };
  }
}

export async function postVmCommandUpdates(
  updates: Array<{ id: string; status: "DONE" | "ERROR"; result?: unknown }>
): Promise<unknown> {
  const r = await fetchVm(
    "/command-updates",
    {
      method: "POST",
      headers: { ...botTokenHeader(), "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ updates }),
    },
    8000
  );
  const text = await r.text();
  let out: unknown = null;
  try {
    out = text ? JSON.parse(text) : null;
  } catch {
    out = { raw: text };
  }
  if (!r.ok) throw new Error(messageFromUnknown(out, `VM /command-updates failed (${r.status})`));
  return out;
}
