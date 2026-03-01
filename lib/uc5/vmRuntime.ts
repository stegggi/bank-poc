import { Uc5ConfigSchema, type Uc5Config, type Uc5Status } from "./types";

type CacheEntry<T> = { value: T; expiresAt: number };
type VmCache = {
  config?: CacheEntry<Uc5Config>;
  status?: CacheEntry<Uc5Status>;
  data?: Record<string, CacheEntry<unknown>>;
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
    botSignerAddress: "",
    botSignerLinked: false,
    ingestionEnabled: true,
    tradingEnabled: true,
    killSwitch: false,
    pollIntervalSeconds: 1,
    ingestIntervalSec: Number(process.env.UC5_INGEST_INTERVAL_SEC || 0.5),
    regimeLookbackSeconds: 1800,
    regimeBarSeconds: 1,
    regimeSampleEverySec: 12,
    trendEntryStrength: 0.7,
    flipCooldownSec: 15,
    reassessIntervalSec: 8,
    decisionLoopIntervalSec: 4,
    inPositionReassessIntervalSec: 8,
    riskLoopIntervalSec: 1,
    metricsLoopIntervalSec: 45,
    predictionHorizonSeconds: 30,
    maxLeverage: 2,
    maxMarginPct: 25,
    maxMarginUsd: 100,
    confidenceThreshold: 0.65,
    openConfidenceThreshold: 0.65,
    closeConfidenceThreshold: 0.55,
    minHoldSeconds: 5,
    maxHoldSeconds: 7200,
    maxOrdersPerHour: 120,
    smartEntryTimeoutMs: 900,
    orderGuardMs: 200,
    maxSpreadBpsForTrade: 12,
    exitSpreadInsaneBps: 28,
    feeEstimateBps: 3,
    slippageBufferBps: 4,
    minExpectedMoveBps: 0,
    edgeCostMultiplier: 0,
    entryMakerPreferred: true,
    entryMarketFallbackEnabled: false,
    entryMarketFallbackMinProb: 0.9,
    cooldownAfterCloseSec: 5,
    emergencyBreakoutEnabled: false,
    emergencyBreakoutMinProb: 0.94,
    emergencyBreakoutMinMoveBps: 35,
    emergencyBreakoutMinAtrPercentile: 0.85,
    entryChaseMaxSec: 10,
    exitChaseMaxSec: 5,
    executionRepriceMs: 350,
    makerOrderGtdSec: 2,
    makerMinRestMs: 700,
    makerReplaceOnlyOnTouchMove: true,
    makerImproveOneTickOnWideSpread: true,
    makerImproveMinSpreadTicks: 3,
    entryMinFillRatio: 0.5,
    stopLossPct: 0.003,
    stopLossAtrMult: null,
    takeProfitPct: 0.006,
    takeProfitAtrMult: null,
    trailingStopPct: null,
    maxDailyLossUsd: 0,
    tapeCvdEnabled: false,
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

async function getVmJsonCached<T>(key: string, path: string, ttlMs: number, fallback: T): Promise<T> {
  const c = cache();
  if (!c.data) c.data = {};
  const now = Date.now();
  const prev = c.data[key] as CacheEntry<T> | undefined;
  if (prev && prev.expiresAt > now) return prev.value;
  try {
    const r = await fetchVm(path, { headers: { accept: "application/json" } }, 8000);
    if (!r.ok) throw new Error(`VM ${path} ${r.status}`);
    const j = (await r.json()) as T;
    c.data[key] = { value: j, expiresAt: now + ttlMs };
    return j;
  } catch {
    if (prev?.value !== undefined) return prev.value;
    return fallback;
  }
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

export type VmIngestionStatus = {
  updatedAt: number;
  enabled: boolean;
  running: boolean;
  ingestIntervalSec: number;
  collectingSince?: number | null;
  lastTickAt?: number | null;
  ticksCollected?: number;
  ticks24h?: number;
  dbSizeBytes?: number | null;
  ingestionRatePerMin5m?: number;
  lastTickAgeSec?: number | null;
};

export type VmTradingStatus = {
  updatedAt: number;
  enabled: boolean;
  running: boolean;
  positionOpen: boolean;
  side?: "LONG" | "SHORT" | null;
  timeSinceEntrySec?: number | null;
  entryAt?: number | null;
  initialHoldEndsAt?: number | null;
  nextReassessAt?: number | null;
  maxHoldEndsAt?: number | null;
  cooldownUntil?: number | null;
  nextDecisionAt?: number | null;
  countdowns?: {
    initialHoldEndsInSec?: number | null;
    nextReassessInSec?: number | null;
    maxHoldEndsInSec?: number | null;
    cooldownEndsInSec?: number | null;
    nextDecisionInSec?: number | null;
  };
  lastAction?: unknown;
};

export type VmChartResponse = {
  candles: Array<{ t: number; open: number; high: number; low: number; close: number }>;
  markers: Array<{
    t: number;
    price: number | null;
    type: "ENTRY" | "EXIT";
    side?: string | null;
    eventType?: string;
    closeReason?: "regime_end" | "regime_flip" | "confidence_change" | "risk_loop" | "other";
  }>;
  confidence?: Array<{ t: number; pUp: number }>;
  regimeStrength?: Array<{ t: number; strength: number; state: string; direction?: string | null; reason?: string }>;
  partial24h?: boolean;
  missingDays?: string[];
};

export type VmPortfolio = {
  updatedAt: number;
  portfolioValueUsd?: number | null;
  availableMarginUsd?: number | null;
  usedMarginUsd?: number | null;
  usedMarginPct?: number | null;
  unrealizedPnl?: number | null;
  realizedPnlToday?: number | null;
  realizedPnlTotal?: number | null;
  error?: string | null;
};

export type VmTradesSummary = {
  totalTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  realizedPnlTotal: number;
  realizedPnlToday: number;
  closedByRegimeEnd: number;
  closedByRegimeFlip: number;
  closedByConfidence: number;
  closedByRiskLoop: number;
  closedByOther: number;
};

export type VmSetupStatus = {
  updatedAt: number;
  missing: string[];
  needsSetup: boolean;
  botSigner?: {
    configuredAddress?: string;
    linkedDetectable?: boolean;
    linked?: boolean;
    required?: boolean;
    status?: string;
  };
};

export async function getVmIngestionCached(ttlMs = 2_000): Promise<VmIngestionStatus> {
  return getVmJsonCached<VmIngestionStatus>("ingestion", "/ingestion", ttlMs, {
    updatedAt: Date.now(),
    enabled: false,
    running: false,
    ingestIntervalSec: 2,
  });
}

export async function getVmTradingCached(ttlMs = 2_000): Promise<VmTradingStatus> {
  return getVmJsonCached<VmTradingStatus>("trading", "/trading", ttlMs, {
    updatedAt: Date.now(),
    enabled: false,
    running: false,
    positionOpen: false,
  });
}

export async function getVmChartCached(range = "24h", resolution = "1m", ttlMs = 4_000): Promise<VmChartResponse> {
  const key = `chart:${range}:${resolution}`;
  const path = `/uc5/chart?range=${encodeURIComponent(range)}&resolution=${encodeURIComponent(resolution)}`;
  return getVmJsonCached<VmChartResponse>(key, path, ttlMs, { candles: [], markers: [], confidence: [], regimeStrength: [] });
}

export async function getVmPortfolioCached(ttlMs = 3_000): Promise<VmPortfolio> {
  return getVmJsonCached<VmPortfolio>("portfolio", "/uc5/portfolio", ttlMs, { updatedAt: Date.now() });
}

export async function getVmTradesSummaryCached(ttlMs = 5_000): Promise<VmTradesSummary> {
  return getVmJsonCached<VmTradesSummary>("trades:summary", "/uc5/trades/summary", ttlMs, {
    totalTrades: 0,
    winRate: 0,
    avgWin: 0,
    avgLoss: 0,
    realizedPnlTotal: 0,
    realizedPnlToday: 0,
    closedByRegimeEnd: 0,
    closedByRegimeFlip: 0,
    closedByConfidence: 0,
    closedByRiskLoop: 0,
    closedByOther: 0,
  });
}

export async function getVmSetupCached(ttlMs = 10_000): Promise<VmSetupStatus> {
  return getVmJsonCached<VmSetupStatus>("setup", "/uc5/setup", ttlMs, {
    updatedAt: Date.now(),
    missing: [],
    needsSetup: false,
  });
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
