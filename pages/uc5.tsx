import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useBreakpoint } from "../shared/hooks/useBreakpoint";
import { BrowserProvider, type Eip1193Provider } from "ethers";
import { CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import NavBar from "../shared/components/NavBar";
import { buildAdminMessage } from "../use-cases/uc5-perp-trading/lib/auth";
import type { Uc5Config, Uc5Status } from "../use-cases/uc5-perp-trading/lib/types";
import type {
  VmChartResponse,
  VmIngestionStatus,
  VmPortfolio,
  VmSetupStatus,
  VmTradesSummary,
  VmTradingStatus,
} from "../use-cases/uc5-perp-trading/lib/vmRuntime";

const UI_REFRESH_SEC = 3;
const CHART_REFRESH_SEC = 6;
const MARKET_CHART_HEIGHT = 340;
const CONFIDENCE_CHART_HEIGHT = MARKET_CHART_HEIGHT / 2;

type NoticeKind = "success" | "error" | "info";
type Notice = { id: number; kind: NoticeKind; text: string; pending: boolean };
type AdminAuth = { address: string; signature: string; nonce: string; issuedAt: number };
type RpcDomain = { chainId?: unknown; name?: string; version?: string; verifyingContract?: string };
type ChartMarker = VmChartResponse["markers"][number];

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function randNonce() {
  const r = Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
  return `${Date.now()}${r}`;
}

function fmtAgo(ts?: number | null) {
  if (!ts) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  return `${h}h ago`;
}

function fmtCountdown(sec?: number | null) {
  if (sec == null) return "—";
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}h ${m}m ${r}s` : `${m}m ${r}s`;
}

function fmtUsd(v?: number | null, digits = 2) {
  if (v == null || Number.isNaN(v)) return "—";
  return `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function fmtPct(v?: number | null, digits = 1) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Number(v).toFixed(digits)}%`;
}

function toFiniteNumber(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function firstPositiveNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const n = toFiniteNumber(value);
    if (n != null && n > 0) return n;
  }
  return null;
}

function closeReasonLabel(reason?: ChartMarker["closeReason"]) {
  if (reason === "regime_end") return "regime end";
  if (reason === "regime_flip") return "regime flip";
  if (reason === "confidence_change") return "confidence change";
  if (reason === "risk_loop") return "risk loop";
  return "other/manual";
}

function markerColor(marker: ChartMarker) {
  if (marker.type === "ENTRY") return "#15803d";
  if (marker.closeReason === "regime_flip") return "#7a271a";
  if (marker.closeReason === "regime_end") return "#b54708";
  if (marker.closeReason === "confidence_change") return "#b54708";
  if (marker.closeReason === "risk_loop") return "#b42318";
  return "#475467";
}

function shortAddr(addr: string | undefined | null) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function toHexChainId(v: unknown): string | null {
  try {
    if (typeof v === "number" && Number.isFinite(v)) return `0x${Math.trunc(v).toString(16)}`;
    if (typeof v === "bigint") return `0x${v.toString(16)}`;
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return null;
      if (s.startsWith("0x") || s.startsWith("0X")) return `0x${BigInt(s).toString(16)}`;
      return `0x${BigInt(s).toString(16)}`;
    }
  } catch {}
  return null;
}

function asProviderWithRequest(p: Eip1193Provider): Eip1193Provider & { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } {
  return p as Eip1193Provider & { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
}

async function ensureWalletChain(eth: Eip1193Provider, chainIdHex: string) {
  const req = asProviderWithRequest(eth);
  try {
    await req.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
    return;
  } catch (err: unknown) {
    const e = err as { code?: number; message?: string };
    if (e?.code === 4902) {
      await req.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainIdHex,
            chainName: "Ethereal",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://rpc.ethereal.trade"],
          },
        ],
      });
      await req.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chainIdHex }],
      });
      return;
    }
    throw new Error(e?.message || "Failed to switch wallet chain for signing.");
  }
}

function normalizeEdit(c: Uc5Config): Uc5Config {
  const inPos = c.inPositionReassessIntervalSec ?? c.reassessIntervalSec ?? 8;
  return {
    ...c,
    ingestionEnabled: c.ingestionEnabled ?? true,
    ingestIntervalSec: c.ingestIntervalSec ?? c.pollIntervalSeconds ?? 0.5,
    regimeLookbackSeconds: c.regimeLookbackSeconds ?? 1800,
    regimeBarSeconds: c.regimeBarSeconds ?? 1,
    regimeSampleEverySec: c.regimeSampleEverySec ?? Math.max(12, c.regimeBarSeconds ?? 1),
    trendHalfLifeMinSec: c.trendHalfLifeMinSec ?? 450,
    trendEntryStrength: c.trendEntryStrength ?? 0.7,
    flipCooldownSec: c.flipCooldownSec ?? c.cooldownAfterCloseSec ?? 15,
    reassessIntervalSec: inPos,
    decisionLoopIntervalSec: c.decisionLoopIntervalSec ?? 4,
    inPositionReassessIntervalSec: inPos,
    riskLoopIntervalSec: c.riskLoopIntervalSec ?? 1,
    metricsLoopIntervalSec: c.metricsLoopIntervalSec ?? 45,
    minHoldSeconds: c.minHoldSeconds ?? 5,
    exitOnRegimeEnd: c.exitOnRegimeEnd ?? true,
    regimeExitEnabled: c.regimeExitEnabled ?? false,
    maxMarginPct: c.maxMarginPct ?? 25,
    minExpectedMoveBps: c.minExpectedMoveBps ?? 0,
    edgeCostMultiplier: c.edgeCostMultiplier ?? 0,
    fundingRateLimitPct: c.fundingRateLimitPct ?? 0,
    maxDailyTrades: c.maxDailyTrades ?? 0,
    entryMakerPreferred: true,
    entryMarketFallbackEnabled: false,
    entryMarketFallbackMinProb: c.entryMarketFallbackMinProb ?? 0.9,
    cooldownAfterCloseSec: c.cooldownAfterCloseSec ?? c.flipCooldownSec ?? 15,
    emergencyBreakoutEnabled: false,
    entryChaseMaxSec: c.entryChaseMaxSec ?? 10,
    exitChaseMaxSec: c.exitChaseMaxSec ?? 5,
    executionRepriceMs: c.executionRepriceMs ?? 350,
    makerOrderGtdSec: c.makerOrderGtdSec ?? 2,
    makerMinRestMs: c.makerMinRestMs ?? 700,
    makerReplaceOnlyOnTouchMove: c.makerReplaceOnlyOnTouchMove ?? true,
    makerImproveOneTickOnWideSpread: c.makerImproveOneTickOnWideSpread ?? true,
    makerImproveMinSpreadTicks: c.makerImproveMinSpreadTicks ?? 3,
    entryMinFillRatio: c.entryMinFillRatio ?? 0.5,
    atrStopLossConfirmSec: c.atrStopLossConfirmSec ?? 120,
  };
}

const LEGACY_DECISION_PAYLOAD_KEYS = [
  "confidenceThreshold",
  "openConfidenceThreshold",
  "closeConfidenceThreshold",
  "predictionHorizonSeconds",
  "feeEstimateBps",
  "slippageBufferBps",
  "minExpectedMoveBps",
  "edgeCostMultiplier",
  "entryMarketFallbackEnabled",
  "entryMarketFallbackMinProb",
  "cooldownAfterCloseSec",
  "emergencyBreakoutEnabled",
  "emergencyBreakoutMinProb",
  "emergencyBreakoutMinMoveBps",
  "emergencyBreakoutMinAtrPercentile",
] as const;

function buildConfigPayload(edit: Uc5Config, ownerAddress: string): Record<string, unknown> {
  const normalized = normalizeEdit(edit);
  const payload: Record<string, unknown> = {
    ...normalized,
    ownerAddress,
    pollIntervalSeconds: Math.max(1, Math.round(normalized.ingestIntervalSec)),
    reassessIntervalSec: normalized.inPositionReassessIntervalSec,
    entryMakerPreferred: true,
  };
  for (const key of LEGACY_DECISION_PAYLOAD_KEYS) {
    delete payload[key];
  }
  return payload;
}

type TradeRow = {
  id: string;
  entry_ts?: number | null;
  exit_ts?: number | null;
  side?: string | null;
  qty?: number | null;
  entry_price?: number | null;
  exit_price?: number | null;
  pnl?: number | null;
  fees?: number | null;
  duration_sec?: number | null;
  close_reason?: string | null;
  note?: string | null;
};

function fmtDuration(sec?: number | null) {
  if (sec == null || sec < 0) return "—";
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtDateTime(ts?: number | null) {
  if (!ts) return "—";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function closeReasonTag(reason?: string | null) {
  if (!reason) return "—";
  if (reason === "regime_end") return "REGIME END";
  if (reason === "regime_flip") return "FLIP";
  if (reason === "risk_loop") return "SL/TP";
  if (reason === "confidence_change") return "CONFIDENCE";
  return "MANUAL";
}

function parseErrorText(raw: unknown, fallback: string): string {
  if (!raw || typeof raw !== "object") return fallback;
  if ("error" in raw && typeof (raw as { error?: unknown }).error === "string") {
    return String((raw as { error?: unknown }).error);
  }
  return fallback;
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...(init || {}), cache: "no-store" });
  const text = await r.text();
  let j: unknown = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = {};
  }
  if (!r.ok) {
    throw new Error(parseErrorText(j, `${r.status} ${r.statusText}`));
  }
  return j as T;
}

export default function Uc5Page() {
  const { isMobile, isMobileOrTablet } = useBreakpoint();
  const [cfg, setCfg] = useState<Uc5Config | null>(null);
  const [edit, setEdit] = useState<Uc5Config | null>(null);

  const [status, setStatus] = useState<Uc5Status | null>(null);
  const [ingestion, setIngestion] = useState<VmIngestionStatus | null>(null);
  const [trading, setTrading] = useState<VmTradingStatus | null>(null);
  const [chart, setChart] = useState<VmChartResponse>({ candles: [], markers: [], confidence: [], regimeStrength: [] });
  const [portfolio, setPortfolio] = useState<VmPortfolio | null>(null);
  const [tradeSummary, setTradeSummary] = useState<VmTradesSummary | null>(null);
  const [setup, setSetup] = useState<VmSetupStatus | null>(null);

  const [tradesPage, setTradesPage] = useState(0);
  const [tradesData, setTradesData] = useState<{ trades: TradeRow[]; total: number } | null>(null);

  const [walletAddr, setWalletAddr] = useState("");
  const [busy, setBusy] = useState("");
  const [signerAddr, setSignerAddr] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeRef = useRef(1);

  const isOwner = useMemo(() => {
    if (!walletAddr || !cfg?.ownerAddress) return false;
    return walletAddr.toLowerCase() === String(cfg.ownerAddress).toLowerCase();
  }, [walletAddr, cfg?.ownerAddress]);

  const addNotice = useCallback((kind: NoticeKind, text: string, pending = false) => {
    const id = noticeRef.current++;
    setNotices((curr) => [{ id, kind, text, pending }, ...curr].slice(0, 8));
    return id;
  }, []);

  const updateNotice = useCallback((id: number, patch: Partial<Notice>) => {
    setNotices((curr) => curr.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  }, []);

  const dismissNotice = useCallback((id: number) => {
    setNotices((curr) => curr.filter((n) => n.id !== id));
  }, []);

  const refreshConfig = useCallback(async () => {
    const c = await readJson<Uc5Config>("/api/uc5/config");
    setCfg(c);
    setEdit((prev) => prev ?? normalizeEdit(c));
  }, []);

  const refreshFast = useCallback(async () => {
    const [s, ing, tr, p, ts, sw] = await Promise.all([
      readJson<Uc5Status>("/api/uc5/status"),
      readJson<VmIngestionStatus>("/api/uc5/ingestion"),
      readJson<VmTradingStatus>("/api/uc5/trading"),
      readJson<VmPortfolio>("/api/uc5/portfolio"),
      readJson<VmTradesSummary>("/api/uc5/trades-summary"),
      readJson<VmSetupStatus>("/api/uc5/setup"),
    ]);
    setStatus(s);
    setIngestion(ing);
    setTrading(tr);
    setPortfolio(p);
    setTradeSummary(ts);
    setSetup(sw);
  }, []);

  const refreshChart = useCallback(async () => {
    const c = await readJson<VmChartResponse>("/api/uc5/chart?range=24h&resolution=1m");
    setChart(c);
  }, []);

  const refreshTrades = useCallback(async (page: number) => {
    const limit = 10;
    const offset = page * limit;
    const d = await readJson<{ trades: TradeRow[]; total: number }>(`/api/uc5/trades?limit=${limit}&offset=${offset}`);
    setTradesData(d);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        await Promise.all([refreshConfig(), refreshFast(), refreshChart(), refreshTrades(0)]);
      } catch {
        if (!cancelled) addNotice("error", "Failed to load UC5 data from VM.", false);
      }
    };
    void init();

    const t1 = setInterval(() => void refreshFast().catch(() => {}), UI_REFRESH_SEC * 1000);
    const t2 = setInterval(() => void refreshChart().catch(() => {}), CHART_REFRESH_SEC * 1000);
    const t3 = setInterval(() => void refreshConfig().catch(() => {}), 20_000);
    // Refresh trades on each fast cycle so new closes appear automatically
    const t4 = setInterval(() => void refreshTrades(tradesPage).catch(() => {}), 15_000);

    return () => {
      cancelled = true;
      clearInterval(t1);
      clearInterval(t2);
      clearInterval(t3);
      clearInterval(t4);
    };
  }, [addNotice, refreshChart, refreshConfig, refreshFast, refreshTrades, tradesPage]);

  const validation = useMemo(() => {
    const errors: Record<string, string> = {};
    if (!edit) return errors;
    if (edit.maxLeverage < 1 || edit.maxLeverage > 20) errors.maxLeverage = "Max leverage must be 1.0 to 20.0";
    if (edit.maxMarginPct < 0 || edit.maxMarginPct > 100) errors.maxMarginPct = "Max margin % must be 0 to 100";
    if ((edit.regimeLookbackSeconds ?? 1800) < 60 || (edit.regimeLookbackSeconds ?? 1800) > 86400) {
      errors.regimeLookbackSeconds = "Regime lookback must be 60 to 86400 sec";
    }
    if ((edit.regimeBarSeconds ?? 1) < 1 || (edit.regimeBarSeconds ?? 1) > 60) {
      errors.regimeBarSeconds = "Regime bar size must be 1 to 60 sec";
    }
    if ((edit.regimeSampleEverySec ?? Math.max(12, edit.regimeBarSeconds ?? 1)) < 1 || (edit.regimeSampleEverySec ?? Math.max(12, edit.regimeBarSeconds ?? 1)) > 300) {
      errors.regimeSampleEverySec = "Regime sample cadence must be 1 to 300 sec";
    }
    if ((edit.trendHalfLifeMinSec ?? 450) < 60 || (edit.trendHalfLifeMinSec ?? 450) > 7200) {
      errors.trendHalfLifeMinSec = "Trend half-life min must be 60 to 7200 sec";
    }
    if ((edit.trendEntryStrength ?? 0.7) < 0.5 || (edit.trendEntryStrength ?? 0.7) > 0.99) {
      errors.trendEntryStrength = "Trend entry strength must be 0.50 to 0.99";
    }
    if ((edit.flipCooldownSec ?? 15) < 0 || (edit.flipCooldownSec ?? 15) > 600) {
      errors.flipCooldownSec = "Flip cooldown must be 0 to 600 sec";
    }
    if (edit.minHoldSeconds < 0 || edit.minHoldSeconds > 259200) {
      errors.minHoldSeconds = "Min hold must be 0 to 259200 sec";
    }
    if (edit.maxHoldSeconds < 5 || edit.maxHoldSeconds > 259200) {
      errors.maxHoldSeconds = "Max hold must be 5 to 259200 sec";
    }
    if (edit.maxHoldSeconds < edit.minHoldSeconds) {
      errors.maxHoldSeconds = "Max hold must be >= min hold";
    }
    if (edit.ingestIntervalSec < 0.2 || edit.ingestIntervalSec > 60) {
      errors.ingestIntervalSec = "Ingest interval must be 0.2 to 60 sec";
    }
    if (edit.riskLoopIntervalSec < 1 || edit.riskLoopIntervalSec > 5) {
      errors.riskLoopIntervalSec = "Risk loop interval must be 1 to 5 sec";
    }
    if (edit.decisionLoopIntervalSec < 3 || edit.decisionLoopIntervalSec > 60) {
      errors.decisionLoopIntervalSec = "Flat decision interval must be 3 to 60 sec";
    }
    if (edit.inPositionReassessIntervalSec < 5 || edit.inPositionReassessIntervalSec > 300) {
      errors.inPositionReassessIntervalSec = "In-position reassess interval must be 5 to 300 sec";
    }
    if (edit.metricsLoopIntervalSec < 30 || edit.metricsLoopIntervalSec > 300) {
      errors.metricsLoopIntervalSec = "Slow metrics interval must be 30 to 300 sec";
    }
    return errors;
  }, [edit]);

  const hasValidationErrors = Object.keys(validation).length > 0;

  const signOwnerAction = useCallback(
    async (action: string, payload: unknown): Promise<AdminAuth> => {
      if (!walletAddr) throw new Error("Connect MetaMask first.");
      if (!isOwner) throw new Error("Owner wallet required.");
      const eth = (window as { ethereum?: Eip1193Provider }).ethereum;
      if (!eth) throw new Error("MetaMask not found.");
      const provider = new BrowserProvider(eth);
      const signer = await provider.getSigner();
      const nonce = randNonce();
      const issuedAt = nowSec();
      const message = buildAdminMessage({ action, nonce, issuedAt, payload });
      const signature = await signer.signMessage(message);
      return { address: walletAddr, signature, nonce, issuedAt };
    },
    [isOwner, walletAddr]
  );

  async function connectWallet() {
    try {
      const eth = (window as { ethereum?: Eip1193Provider }).ethereum;
      if (!eth) throw new Error("MetaMask not found in this browser.");
      const provider = new BrowserProvider(eth);
      const accounts = (await provider.send("eth_requestAccounts", [])) as string[];
      const addr = accounts?.[0] || "";
      setWalletAddr(addr);
    } catch (e: unknown) {
      addNotice("error", e instanceof Error ? e.message : "Failed to connect wallet");
    }
  }

  async function saveConfig() {
    if (!cfg || !edit) return;
    if (hasValidationErrors) {
      addNotice("error", "Fix validation errors before saving.");
      return;
    }
    const pendingId = addNotice("info", "Saving settings...", true);
    setBusy("save");
    try {
      const payload = buildConfigPayload(edit, cfg.ownerAddress);
      const auth = await signOwnerAction("SET_CONFIG", payload);
      await readJson<{ ok: true }>("/api/uc5/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: payload, auth }),
      });
      updateNotice(pendingId, { kind: "success", text: "Settings saved.", pending: false });
      await Promise.all([refreshConfig(), refreshFast()]);
    } catch (e: unknown) {
      updateNotice(pendingId, { kind: "error", text: e instanceof Error ? e.message : "Save failed", pending: false });
    } finally {
      setBusy("");
    }
  }

  async function setIngestionEnabled(enabled: boolean) {
    const pendingId = addNotice("info", enabled ? "Enabling ingestion..." : "Disabling ingestion...", true);
    setBusy("ingestion");
    try {
      const auth = await signOwnerAction("SET_INGESTION", { enabled });
      await readJson<{ ok: true }>("/api/uc5/ingestion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled, auth }),
      });
      updateNotice(pendingId, {
        kind: "success",
        text: enabled ? "Data ingestion enabled." : "Data ingestion disabled.",
        pending: false,
      });
      await Promise.all([refreshConfig(), refreshFast()]);
    } catch (e: unknown) {
      updateNotice(pendingId, { kind: "error", text: e instanceof Error ? e.message : "Failed to update ingestion", pending: false });
    } finally {
      setBusy("");
    }
  }

  async function setTradingEnabled(enabled: boolean) {
    const pendingId = addNotice("info", enabled ? "Enabling trading..." : "Disabling trading and flattening position...", true);
    setBusy("trading");
    try {
      const auth = await signOwnerAction("SET_TRADING", { enabled });
      const out = await readJson<{ ok: true; flattened?: boolean }>("/api/uc5/trading", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled, auth }),
      });
      const text = enabled
        ? "Trading enabled."
        : out.flattened
          ? "Trading disabled after closing position."
          : "Trading disabled.";
      updateNotice(pendingId, { kind: "success", text, pending: false });
      await Promise.all([refreshConfig(), refreshFast()]);
    } catch (e: unknown) {
      updateNotice(pendingId, { kind: "error", text: e instanceof Error ? e.message : "Failed to update trading", pending: false });
    } finally {
      setBusy("");
    }
  }

  async function sendFlatten() {
    const pendingId = addNotice("info", "Sending flatten command...", true);
    setBusy("flatten");
    try {
      const auth = await signOwnerAction("CMD_FLATTEN", { type: "FLATTEN" });
      await readJson<{ ok: true }>("/api/uc5/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "FLATTEN", auth }),
      });
      updateNotice(pendingId, { kind: "success", text: "Flatten command queued.", pending: false });
      await refreshFast();
    } catch (e: unknown) {
      updateNotice(pendingId, { kind: "error", text: e instanceof Error ? e.message : "Flatten failed", pending: false });
    } finally {
      setBusy("");
    }
  }

  async function discoverSubaccount() {
    if (!walletAddr) return addNotice("error", "Connect wallet first.");
    setBusy("discover-sub");
    try {
      const j = await readJson<{ data?: Array<{ id: string; name: string }> }>(
        `/api/uc5/ethereal?path=/v1/subaccount&sender=${encodeURIComponent(walletAddr)}`
      );
      const first = j?.data?.[0];
      if (!first) throw new Error("No subaccount found for this address.");
      setEdit((p) => (p ? { ...p, subaccountId: first.id, subaccountName: first.name } : p));
      addNotice("success", "Subaccount discovered and filled.");
    } catch (e: unknown) {
      addNotice("error", e instanceof Error ? e.message : "Subaccount discovery failed");
    } finally {
      setBusy("");
    }
  }

  async function discoverProduct() {
    if (!edit) return;
    setBusy("discover-product");
    try {
      const ticker = edit.ticker || "BTCUSD";
      const j = await readJson<{ data?: Array<{ id: string; displayTicker?: string; ticker?: string }> }>(
        `/api/uc5/ethereal?path=/v1/product&ticker=${encodeURIComponent(ticker)}`
      );
      const first = j?.data?.[0];
      if (!first) throw new Error(`No product found for ${ticker}`);
      setEdit((p) => (p ? { ...p, productId: first.id } : p));
      addNotice("success", `Product discovered: ${first.displayTicker || first.ticker || ticker}`);
    } catch (e: unknown) {
      addNotice("error", e instanceof Error ? e.message : "Product discovery failed");
    } finally {
      setBusy("");
    }
  }

  async function createLinkSignerRequest() {
    if (!edit) return;
    if (!walletAddr) return addNotice("error", "Connect wallet first.");
    if (!isOwner) return addNotice("error", "Owner wallet required.");
    if (!edit.subaccountId || !edit.subaccountName) return addNotice("error", "Discover subaccount first.");
    if (!signerAddr) return addNotice("error", "Paste the bot signer address.");

    const pendingId = addNotice("info", "Creating LINK_SIGNER request...", true);
    setBusy("link-signer");
    try {
      const rpc = await readJson<{ domain?: RpcDomain }>("/api/uc5/ethereal?path=/v1/rpc/config");
      if (!rpc?.domain) throw new Error("Could not load Ethereal EIP-712 domain.");

      const eth = (window as { ethereum?: Eip1193Provider }).ethereum;
      if (!eth) throw new Error("MetaMask not found.");
      const chainIdHex = toHexChainId(rpc.domain.chainId);
      if (!chainIdHex) throw new Error("Invalid chainId in Ethereal domain.");
      await ensureWalletChain(eth, chainIdHex);
      const provider = new BrowserProvider(eth);
      const signer = await provider.getSigner();

      const nonce = randNonce();
      const signedAt = nowSec();
      const types = {
        LinkSigner: [
          { name: "sender", type: "address" },
          { name: "signer", type: "address" },
          { name: "subaccount", type: "bytes32" },
          { name: "nonce", type: "uint64" },
          { name: "signedAt", type: "uint64" },
        ],
      };
      const values = {
        sender: walletAddr,
        signer: signerAddr,
        subaccount: edit.subaccountName,
        nonce,
        signedAt,
      };

      const senderSignature = await (signer as unknown as { signTypedData: (d: unknown, t: unknown, v: unknown) => Promise<string> }).signTypedData(
        rpc.domain,
        types,
        values
      );

      await readJson<{ ok: true }>("/api/uc5/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "LINK_SIGNER",
          payload: {
            subaccountId: edit.subaccountId,
            sender: walletAddr,
            subaccount: edit.subaccountName,
            signer: signerAddr,
            nonce,
            signedAt,
            senderSignature,
          },
        }),
      });
      updateNotice(pendingId, { kind: "success", text: "LINK_SIGNER request queued.", pending: false });
    } catch (e: unknown) {
      updateNotice(pendingId, { kind: "error", text: e instanceof Error ? e.message : "LINK_SIGNER failed", pending: false });
    } finally {
      setBusy("");
    }
  }

  const chartRows = useMemo(
    () =>
      chart.candles.map((c) => ({
        t: c.t,
        close: c.close,
        time: new Date(c.t).toLocaleTimeString(),
      })),
    [chart.candles]
  );
  const markerRows = useMemo(() => chart.markers.filter((m) => m.price != null), [chart.markers]);
  const regimeRows = useMemo(
    () => {
      return (chart.regimeStrength && chart.regimeStrength.length > 0
        ? chart.regimeStrength.map((p) => ({
            t: p.t,
            strengthPct: Math.max(0, Math.min(100, Number(p.strength || 0) * 100)),
            state: p.state,
            direction: p.direction || null,
            reason: p.reason || "",
          }))
        : (chart.confidence || []).map((p) => ({
            t: p.t,
            strengthPct: Math.max(0, Math.min(100, Number(p.pUp || 0) * 100)),
            state: "",
            direction: null,
            reason: "",
          }))) as Array<{ t: number; strengthPct: number; state: string; direction: string | null; reason: string }>;
    },
    [chart.confidence, chart.regimeStrength]
  );

  const marginCapAmount = useMemo(() => {
    const pv = portfolio?.portfolioValueUsd || 0;
    const pct = edit?.maxMarginPct || 0;
    return (pv * pct) / 100;
  }, [edit?.maxMarginPct, portfolio?.portfolioValueUsd]);

  const modeLabel = isOwner ? "Owner mode (can control bot)" : "Read-only mode";
  const signerLinked = Boolean(setup?.botSigner?.linked ?? cfg?.botSignerLinked);
  const missingSetup = useMemo(() => {
    const out = new Set<string>(setup?.missing || []);
    if (!cfg?.subaccountId) out.add("subaccountId");
    if (!cfg?.subaccountName) out.add("subaccountName");
    if (!cfg?.productId) out.add("productId");
    if (!signerLinked) out.add("botSignerLink");
    return Array.from(out);
  }, [cfg?.productId, cfg?.subaccountId, cfg?.subaccountName, setup?.missing, signerLinked]);
  const shouldShowSetup = Boolean(setup?.needsSetup || missingSetup.length > 0);
  const yDomain = useMemo<[number, number] | undefined>(() => {
    if (!chartRows.length) return undefined;
    const prices = chartRows.map((r) => r.close);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const pad = Math.max((max - min) * 0.02, 10);
    return [min - pad, max + pad];
  }, [chartRows]);
  const trendEntryStrengthPct = useMemo(
    () =>
      Math.max(
        0,
        Math.min(
          100,
          100 *
            Number(
              status?.runtime?.trendEntryStrength ??
                edit?.trendEntryStrength ??
                cfg?.trendEntryStrength ??
                0.7
            )
        )
      ),
    [cfg?.trendEntryStrength, edit?.trendEntryStrength, status?.runtime?.trendEntryStrength]
  );
  const renderChartTooltip = useCallback(
    (ctx: unknown) => {
      const raw = ctx as {
        active?: boolean;
        label?: number;
        payload?: Array<{ value?: number }>;
      };
      if (!raw.active || !raw.payload?.length) return null;
      const ts = Number(raw.label || 0);
      const price = typeof raw.payload[0]?.value === "number" ? raw.payload[0].value : null;
      const hits = markerRows.filter((m) => Math.abs(m.t - ts) <= 30_000);
      return (
        <div style={tooltipBox}>
          <div style={{ fontWeight: 800 }}>{new Date(ts).toLocaleString()}</div>
          <div>Close: {price != null ? fmtUsd(price, 2) : "—"}</div>
          {hits.map((m, i) => (
            <div key={`${m.t}-${i}`} style={{ color: markerColor(m) }}>
              {m.type} {m.side ? `(${m.side})` : ""} {m.price != null ? fmtUsd(Number(m.price), 2) : "—"}
              {m.type === "EXIT" ? ` • ${closeReasonLabel(m.closeReason)}` : ""}
            </div>
          ))}
        </div>
      );
    },
    [markerRows]
  );
  const renderConfidenceTooltip = useCallback(
    (ctx: unknown) => {
      const raw = ctx as {
        active?: boolean;
        label?: number;
        payload?: Array<{ value?: number }>;
      };
      if (!raw.active || !raw.payload?.length) return null;
      const ts = Number(raw.label || 0);
      const strength = typeof raw.payload[0]?.value === "number" ? raw.payload[0].value : null;
      const hit = regimeRows.find((row) => Math.abs(row.t - ts) <= 30_000) || null;
      return (
        <div style={tooltipBox}>
          <div style={{ fontWeight: 800 }}>{new Date(ts).toLocaleString()}</div>
          <div>Trend strength: {strength != null ? `${strength.toFixed(1)}%` : "—"}</div>
          <div>Entry threshold: {trendEntryStrengthPct.toFixed(1)}%</div>
          <div>State: {hit?.state || "—"}</div>
          <div>Direction: {hit?.direction || "—"}</div>
        </div>
      );
    },
    [regimeRows, trendEntryStrengthPct]
  );

  return (
    <>
      <style jsx global>{`
        .uc5-recharts .recharts-cartesian-axis-tick text { fill: rgba(232,232,240,0.35) !important; font-size: 10px !important; }
        .uc5-recharts .recharts-cartesian-grid line { stroke: rgba(255,255,255,0.05) !important; }
        .uc5-ctrl details > summary { list-style: none; }
        .uc5-ctrl details > summary::-webkit-details-marker { display: none; }
        .uc5-ctrl input[type=range] { accent-color: #f59e0b; }
        .uc5-ctrl input[type=checkbox] { accent-color: #f59e0b; width: 15px; height: 15px; }
        .uc5-ctrl input[type=number], .uc5-ctrl input[type=text] {
          background: rgba(255,255,255,0.06) !important;
          border: 1px solid rgba(255,255,255,0.12) !important;
          color: #e8e8f0 !important; border-radius: 8px !important;
          padding: 8px 10px !important; width: 100% !important;
          outline: none !important; font-size: 13px !important;
        }
        .uc5-ctrl input[type=number]:disabled { opacity: 0.4 !important; }
        .uc5-ctrl input[type=number]:focus { border-color: rgba(245,158,11,0.5) !important; }
        .uc5-ctrl input[type=range] { width: 100%; }
        .uc5-ctrl summary:hover { background: rgba(255,255,255,0.03) !important; }
      `}</style>
      <NavBar active={"uc5" as never} />
      <div style={{ ...wrap, padding: isMobile ? "20px 16px 48px" : "14px 16px 48px", maxWidth: isMobile ? "100%" : 1400 }}>

        {notices.length > 0 && (
          <div style={{ display: "grid", gap: 6 }}>
            {notices.map((n) => (
              <div key={n.id} style={bannerStyle(n.kind)}>
                <div>{n.pending ? "In progress: " : ""}{n.text}</div>
                <button style={bannerClose} onClick={() => dismissNotice(n.id)} disabled={n.pending}>Dismiss</button>
              </div>
            ))}
          </div>
        )}

        {/* HERO */}
        <div style={heroBar}>
          <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap", flex: 1 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", color: "#f59e0b", padding: "3px 7px", border: "1px solid rgba(245,158,11,0.35)", borderRadius: 5 }}>UC5</span>
              <span style={{ fontSize: isMobile ? 16 : 22, fontWeight: 800, color: "#e8e8f0", letterSpacing: "-0.01em" }}>AI Autopilot Perps</span>
              <span style={{ fontSize: 13, color: "rgba(232,232,240,0.45)" }}>{edit?.ticker || "BTCUSD"} · Ethereal</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: isMobile ? 20 : 28, fontWeight: 800, color: "#e8e8f0", fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>
                {status?.market?.price ? fmtUsd(status.market.price, 0) : "—"}
              </span>
              {status?.market?.oraclePrice && (
                <span style={{ fontSize: 12, color: "rgba(232,232,240,0.38)" }}>oracle {fmtUsd(status.market.oraclePrice, 0)}</span>
              )}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 999, border: `1px solid ${status?.bot?.alive ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)"}`, background: status?.bot?.alive ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: status?.bot?.alive ? "#22c55e" : "#ef4444", display: "inline-block", boxShadow: status?.bot?.alive ? "0 0 6px #22c55e" : "none" }} />
              <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", color: status?.bot?.alive ? "#22c55e" : "#ef4444" }}>{status?.bot?.alive ? "BOT RUNNING" : "BOT STOPPED"}</span>
            </div>
            {status?.agent?.desired && status.agent.desired !== "FLAT" && (
              <div style={{ padding: "6px 12px", borderRadius: 999, fontWeight: 800, fontSize: 11, letterSpacing: "0.08em", background: status.agent.desired === "LONG" ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)", border: `1px solid ${status.agent.desired === "LONG" ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)"}`, color: status.agent.desired === "LONG" ? "#22c55e" : "#ef4444" }}>
                {status.agent.desired === "LONG" ? "▲ LONG" : "▼ SHORT"}
              </div>
            )}
            <span style={isOwner ? ownerBadge : readonlyBadge}>{modeLabel}</span>
            {walletAddr ? (
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 10, color: "rgba(232,232,240,0.4)", letterSpacing: "0.06em" }}>CONNECTED</div>
                <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, color: "#e8e8f0", wordBreak: "break-all" }}>{shortAddr(walletAddr)}</div>
              </div>
            ) : (
              <button onClick={connectWallet} style={btnPrimary}>Connect MetaMask</button>
            )}
          </div>
        </div>

        {/* METRICS STRIP */}
        <div style={{ ...metricsStrip, flexWrap: isMobile ? "wrap" : "nowrap" }}>
          {([
            { label: "BID", val: status?.market?.bestBid ? fmtUsd(status.market.bestBid, 0) : "—", color: "#22c55e" },
            { label: "ASK", val: status?.market?.bestAsk ? fmtUsd(status.market.bestAsk, 0) : "—", color: "#ef4444" },
            { label: "SPREAD", val: (status?.market?.bestBid && status?.market?.bestAsk) ? `${(((status.market.bestAsk - status.market.bestBid) / status.market.bestAsk) * 10000).toFixed(1)} bps` : "—", color: "rgba(232,232,240,0.7)" },
            { label: "MARGIN USED", val: `${fmtUsd(portfolio?.usedMarginUsd)} · ${fmtPct(portfolio?.usedMarginPct)}`, color: "rgba(232,232,240,0.7)" },
            { label: "UNREAL PNL", val: fmtUsd(portfolio?.unrealizedPnl), color: (portfolio?.unrealizedPnl ?? 0) >= 0 ? "#22c55e" : "#ef4444" },
            { label: "TODAY PNL", val: fmtUsd(portfolio?.realizedPnlToday), color: (portfolio?.realizedPnlToday ?? 0) >= 0 ? "#22c55e" : "#ef4444" },
            { label: "REGIME", val: status?.agent?.regimeState ? `${status.agent.regimeState}${status.agent.regimeDirection ? " " + String(status.agent.regimeDirection) : ""}` : "—", color: "rgba(232,232,240,0.7)" },
            { label: "CONFIDENCE", val: status?.agent?.regimeStrength != null ? `${(status.agent.regimeStrength * 100).toFixed(1)}% ${status.agent.confidenceBand || ""}` : "—", color: "#f59e0b" },
          ] as Array<{ label: string; val: string; color: string }>).map(({ label, val, color }) => (
            <div key={label} style={{ padding: isMobile ? "0 10px" : "0 18px", borderRight: "1px solid rgba(255,255,255,0.06)", flexShrink: 0 }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "rgba(232,232,240,0.32)", marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>{val}</div>
            </div>
          ))}
        </div>

        {/* MAIN DASHBOARD GRID */}
        <div style={{ display: "grid", gridTemplateColumns: isMobileOrTablet ? "1fr" : "1fr 340px", gap: 12, alignItems: "start", minWidth: 0 }}>

          {/* Charts column */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <div style={darkCard}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
                <div>
                  <span style={chartCardTitle}>{edit?.ticker || "BTCUSD"} · 1m · 24h</span>
                  <span style={{ marginLeft: 10, fontSize: 10, color: "rgba(232,232,240,0.3)" }}>{chart.candles.length} pts</span>
                </div>
                <div style={{ fontSize: 10, color: "rgba(232,232,240,0.3)", textAlign: "right" }}>
                  <span style={{ color: "#22c55e" }}>● entry</span>{" · "}<span style={{ color: "#f59e0b" }}>● regime end</span>{" · "}<span style={{ color: "#b45309" }}>● flip</span>{" · "}<span style={{ color: "#ef4444" }}>● risk exit</span>{" · "}<span style={{ color: "#6b7280" }}>● other</span>
                </div>
              </div>
              {chart.partial24h && <div style={{ fontSize: 11, color: "#f59e0b", marginBottom: 8 }}>Partial 24h · missing: {(chart.missingDays || []).join(", ") || "unknown"}</div>}
              {chartRows.length === 0 ? (
                <div style={{ height: isMobile ? 220 : MARKET_CHART_HEIGHT, display: "grid", placeItems: "center", color: "rgba(232,232,240,0.25)", fontSize: 13 }}>No chart data yet</div>
              ) : (
                <div className="uc5-recharts" style={{ width: "100%", height: isMobile ? 220 : MARKET_CHART_HEIGHT }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartRows} margin={{ top: 16, right: 16, left: 4, bottom: 4 }} syncId="uc5-price">
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(v) => new Date(Number(v)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} tick={{ fontSize: 10, fill: "rgba(232,232,240,0.32)" }} tickLine={false} axisLine={false} />
                      <YAxis type="number" domain={yDomain ?? ["auto", "auto"]} tickFormatter={(v) => Number(v).toFixed(0)} tick={{ fontSize: 10, fill: "rgba(232,232,240,0.32)" }} tickLine={false} axisLine={false} width={52} />
                      <Tooltip content={renderChartTooltip} />
                      <Line dataKey="close" type="monotone" stroke="#f59e0b" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                      {markerRows.slice(-500).map((m, i) => (
                        <ReferenceDot key={`${m.t}-${i}`} x={m.t} y={Number(m.price)} r={4} fill={markerColor(m)} stroke="rgba(0,0,0,0.4)" strokeWidth={1} ifOverflow="visible" />
                      ))}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
            <div style={darkCard}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
                <span style={chartCardTitle}>REGIME STRENGTH</span>
                <span style={{ fontSize: 10, color: "rgba(232,232,240,0.3)" }}>Ornstein-Uhlenbeck · dashed = entry threshold</span>
              </div>
              {regimeRows.length === 0 ? (
                <div style={{ height: isMobile ? 100 : CONFIDENCE_CHART_HEIGHT, display: "grid", placeItems: "center", color: "rgba(232,232,240,0.25)", fontSize: 13 }}>No regime data yet</div>
              ) : (
                <div className="uc5-recharts" style={{ width: "100%", height: isMobile ? 100 : CONFIDENCE_CHART_HEIGHT }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={regimeRows} margin={{ top: 8, right: 16, left: 4, bottom: 4 }} syncId="uc5-price">
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(v) => new Date(Number(v)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} tick={{ fontSize: 10, fill: "rgba(232,232,240,0.32)" }} tickLine={false} axisLine={false} />
                      <YAxis type="number" domain={[0, 100]} tickFormatter={(v) => `${Number(v).toFixed(0)}%`} tick={{ fontSize: 10, fill: "rgba(232,232,240,0.32)" }} tickLine={false} axisLine={false} width={40} />
                      <Tooltip content={renderConfidenceTooltip} />
                      <ReferenceLine y={trendEntryStrengthPct} stroke="#f59e0b" strokeDasharray="4 4" strokeOpacity={0.6} ifOverflow="extendDomain" />
                      <Line dataKey="strengthPct" type="monotone" stroke="#60a5fa" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* PORTFOLIO + STATS — inside left column to fill space below charts */}
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12 }}>
              <div style={darkCard}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
                  <span style={sideCardLabel}>PORTFOLIO</span>
                  <span style={{ fontSize: 10, color: "rgba(232,232,240,0.3)", fontFamily: "ui-monospace, Menlo, monospace" }}>{shortAddr(cfg?.ownerAddress)}</span>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 34, fontWeight: 900, color: "#e8e8f0", letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>{fmtUsd(portfolio?.portfolioValueUsd)}</div>
                  <div style={{ fontSize: 11, color: "rgba(232,232,240,0.35)", letterSpacing: "0.08em", marginTop: 2 }}>TOTAL VALUE</div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {([
                    { k: "Available margin", v: fmtUsd(portfolio?.availableMarginUsd), c: undefined as string | undefined },
                    { k: "Used margin", v: `${fmtUsd(portfolio?.usedMarginUsd)} · ${fmtPct(portfolio?.usedMarginPct)}`, c: undefined as string | undefined },
                    { k: "Unrealized PnL", v: fmtUsd(portfolio?.unrealizedPnl), c: (portfolio?.unrealizedPnl ?? 0) >= 0 ? "#22c55e" : "#ef4444" },
                    { k: "Realized PnL today", v: fmtUsd(portfolio?.realizedPnlToday), c: (portfolio?.realizedPnlToday ?? 0) >= 0 ? "#22c55e" : "#ef4444" },
                    { k: "Realized PnL total", v: fmtUsd(portfolio?.realizedPnlTotal), c: (portfolio?.realizedPnlTotal ?? 0) >= 0 ? "#22c55e" : "#ef4444" },
                  ] as Array<{ k: string; v: string; c: string | undefined }>).map(({ k, v, c }) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                      <span style={{ fontSize: 12, color: "rgba(232,232,240,0.48)" }}>{k}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: c || "#e8e8f0", fontVariantNumeric: "tabular-nums" }}>{v}</span>
                    </div>
                  ))}
                  {portfolio?.startPortfolioValueUsd != null && portfolio.startPortfolioValueUsd > 0 && (() => {
                    const startVal = portfolio.startPortfolioValueUsd!;
                    const curVal = portfolio.portfolioValueUsd ?? 0;
                    const startAt = portfolio.startPortfolioAt ?? 0;
                    const totalReturnPct = curVal > 0 ? ((curVal - startVal) / startVal) * 100 : null;
                    const daysSince = startAt > 0 ? (Date.now() - startAt) / 86400000 : 0;
                    const annualizedPct = totalReturnPct != null && daysSince > 0
                      ? (Math.pow(curVal / startVal, 365 / daysSince) - 1) * 100
                      : null;
                    return (
                      <>
                        <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", marginTop: 4, paddingTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "rgba(232,232,240,0.28)", marginBottom: 2 }}>PERFORMANCE</div>
                          {([
                            { k: "Start value", v: fmtUsd(startVal), c: undefined as string | undefined },
                            { k: "Tracking since", v: startAt > 0 ? fmtDateTime(startAt) : "—", c: undefined as string | undefined },
                            { k: "Total return", v: totalReturnPct != null ? `${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(2)}%` : "—", c: totalReturnPct != null ? (totalReturnPct >= 0 ? "#22c55e" : "#ef4444") : undefined },
                            { k: "Annualized", v: annualizedPct != null ? `${annualizedPct >= 0 ? "+" : ""}${annualizedPct.toFixed(1)}%` : "—", c: annualizedPct != null ? (annualizedPct >= 0 ? "#22c55e" : "#ef4444") : undefined },
                          ] as Array<{ k: string; v: string; c: string | undefined }>).map(({ k, v, c }) => (
                            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                              <span style={{ fontSize: 12, color: "rgba(232,232,240,0.48)" }}>{k}</span>
                              <span style={{ fontSize: 13, fontWeight: 700, color: c || "#e8e8f0", fontVariantNumeric: "tabular-nums" }}>{v}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
              <div style={darkCard}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
                  <span style={sideCardLabel}>TRADE STATS</span>
                  <span style={{ fontSize: 10, color: "rgba(232,232,240,0.3)" }}>all-time</span>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 34, fontWeight: 900, color: "#e8e8f0", letterSpacing: "-0.02em" }}>{tradeSummary?.totalTrades ?? 0}</div>
                  <div style={{ fontSize: 11, color: "rgba(232,232,240,0.35)", letterSpacing: "0.08em", marginTop: 2 }}>TOTAL TRADES</div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {([
                    { k: "Win rate", v: fmtPct((tradeSummary?.winRate ?? 0) * 100), c: "#f59e0b" },
                    { k: "Avg win", v: fmtUsd(tradeSummary?.avgWin), c: "#22c55e" },
                    { k: "Avg loss", v: fmtUsd(tradeSummary?.avgLoss), c: "#ef4444" },
                    { k: "Regime end exits", v: String(tradeSummary?.closedByRegimeEnd ?? 0), c: undefined as string | undefined },
                    { k: "Regime flip exits", v: String(tradeSummary?.closedByRegimeFlip ?? 0), c: undefined as string | undefined },
                    { k: "Risk loop exits", v: String(tradeSummary?.closedByRiskLoop ?? 0), c: undefined as string | undefined },
                    { k: "Other / manual exits", v: String(tradeSummary?.closedByOther ?? 0), c: undefined as string | undefined },
                  ] as Array<{ k: string; v: string; c: string | undefined }>).map(({ k, v, c }) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                      <span style={{ fontSize: 12, color: "rgba(232,232,240,0.48)" }}>{k}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: c || "#e8e8f0", fontVariantNumeric: "tabular-nums" }}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Side column */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

            <div style={darkCard}>
              <div style={sideCardLabel}>AGENT DECISION</div>
              <div style={{ fontSize: 32, fontWeight: 900, letterSpacing: "-0.02em", textAlign: "center", padding: "12px 0 8px", color: status?.agent?.desired === "LONG" ? "#22c55e" : status?.agent?.desired === "SHORT" ? "#ef4444" : "rgba(232,232,240,0.28)" }}>
                {status?.agent?.desired === "LONG" ? "▲ LONG" : status?.agent?.desired === "SHORT" ? "▼ SHORT" : "— FLAT"}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                {([
                  { label: "REGIME", val: `${status?.agent?.regimeState || "—"}${status?.agent?.regimeDirection ? " " + String(status.agent.regimeDirection) : ""}` },
                  { label: "STRENGTH", val: status?.agent?.regimeStrength != null ? `${(status.agent.regimeStrength * 100).toFixed(1)}%` : "—" },
                  { label: "BAND", val: status?.agent?.confidenceBand || "—" },
                  { label: "LAST CHANGE", val: status?.agent?.lastRegimeChangeAt ? fmtAgo(status.agent.lastRegimeChangeAt) : "—" },
                ] as Array<{ label: string; val: string }>).map(({ label, val }) => (
                  <div key={label} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: "8px 10px" }}>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "rgba(232,232,240,0.3)", marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#e8e8f0" }}>{val}</div>
                  </div>
                ))}
              </div>
              <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 5 }}>
                {([
                  { label: "Next decision", val: fmtCountdown(trading?.countdowns?.nextDecisionInSec) },
                  { label: "Next reassess", val: fmtCountdown(trading?.countdowns?.nextReassessInSec) },
                  { label: "Max hold ends", val: fmtCountdown(trading?.countdowns?.maxHoldEndsInSec) },
                  { label: "Cooldown ends", val: fmtCountdown(trading?.countdowns?.cooldownEndsInSec) },
                  { label: "Initial hold", val: fmtCountdown(trading?.countdowns?.initialHoldEndsInSec) },
                ] as Array<{ label: string; val: string }>).map(({ label, val }) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                    <span style={{ color: "rgba(232,232,240,0.45)" }}>{label}</span>
                    <span style={{ fontWeight: 700, color: "#e8e8f0", fontVariantNumeric: "tabular-nums" }}>{val}</span>
                  </div>
                ))}
              </div>
              {status?.agent?.reasonHuman && (
                <div style={{ marginTop: 10, padding: "8px 10px", background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.15)", borderRadius: 8, fontSize: 12, color: "rgba(232,232,240,0.7)", lineHeight: 1.5 }}>{status.agent.reasonHuman}</div>
              )}
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: "pointer", fontSize: 11, color: "rgba(232,232,240,0.35)", userSelect: "none" }}>Raw diagnostics</summary>
                <pre style={{ marginTop: 6, fontSize: 10, color: "rgba(232,232,240,0.4)", overflowX: "auto", background: "rgba(0,0,0,0.3)", padding: 8, borderRadius: 6, lineHeight: 1.4 }}>{status?.agent?.reasonRaw || "No raw metrics."}</pre>
              </details>
            </div>

            <div style={darkCard}>
              <div style={sideCardLabel}>OPEN POSITION</div>
              {status?.position?.open ? (() => {
                const pos = status.position!;
                const marketRecord = (status?.market || {}) as Record<string, unknown>;
                const currentPrice =
                  firstPositiveNumber(
                    status.market?.price,
                    status.market?.oraclePrice,
                    marketRecord.markPrice,
                    marketRecord.mark_price,
                    marketRecord.mid,
                    marketRecord.lastPrice,
                    marketRecord.last_price
                  ) ?? 0;
                const posRecord = pos as unknown as Record<string, unknown>;
                const entryPrice =
                  firstPositiveNumber(
                    pos.entryPrice,
                    posRecord.entry_price,
                    posRecord.entryPx,
                    posRecord.entry_px,
                    posRecord.avgEntryPrice,
                    posRecord.avg_entry_price
                  ) ?? 0;
                const regimeDiagnostics =
                  status?.agent?.regimeDiagnostics && typeof status.agent.regimeDiagnostics === "object"
                    ? (status.agent.regimeDiagnostics as Record<string, unknown>)
                    : null;
                const entryAtrPct =
                  firstPositiveNumber(
                    pos.entryAtrPct,
                    posRecord.entryAtrPct,
                    posRecord.entry_atr_pct
                  ) ?? 0;
                const liveAtrPct =
                  firstPositiveNumber(
                    pos.liveAtrPct,
                    posRecord.liveAtrPct,
                    posRecord.live_atr_pct,
                    pos.atrPct,
                    posRecord.atrPct,
                    posRecord.atr_pct,
                    regimeDiagnostics?.atrPct,
                    regimeDiagnostics?.atr_pct,
                    regimeDiagnostics?.atr
                  ) ?? 0;
                const atrPct = entryAtrPct > 0 ? entryAtrPct : liveAtrPct;
                const atrUsd = atrPct > 0 && entryPrice > 0 ? atrPct * entryPrice : null;
                const fixedStopPrice = firstPositiveNumber(pos.fixedStopPrice, posRecord.fixedStopPrice, posRecord.fixed_stop_price);
                const fixedTakePrice = firstPositiveNumber(pos.fixedTakePrice, posRecord.fixedTakePrice, posRecord.fixed_take_price);
                const fixedStopPct = firstPositiveNumber(pos.fixedStopPct, posRecord.fixedStopPct, posRecord.fixed_stop_pct);
                const fixedTakePct = firstPositiveNumber(pos.fixedTakePct, posRecord.fixedTakePct, posRecord.fixed_take_pct);
                const runtimeCfg =
                  status?.runtime ||
                  (cfg
                    ? {
                      stopLossPct: cfg.stopLossPct,
                      stopLossAtrMult: cfg.stopLossAtrMult,
                      atrStopLossConfirmSec: cfg.atrStopLossConfirmSec,
                      takeProfitPct: cfg.takeProfitPct,
                      takeProfitAtrMult: cfg.takeProfitAtrMult,
                    }
                  : null) ||
                (edit
                  ? {
                      stopLossPct: edit.stopLossPct,
                      stopLossAtrMult: edit.stopLossAtrMult,
                      atrStopLossConfirmSec: edit.atrStopLossConfirmSec,
                      takeProfitPct: edit.takeProfitPct,
                      takeProfitAtrMult: edit.takeProfitAtrMult,
                    }
                  : null);
                const slFixedPct = firstPositiveNumber(runtimeCfg?.stopLossPct) ?? 0;
                const tpFixedPct = firstPositiveNumber(runtimeCfg?.takeProfitPct) ?? 0;
                const slAtrMult = firstPositiveNumber(runtimeCfg?.stopLossAtrMult) ?? 0;
                const tpAtrMult = firstPositiveNumber(runtimeCfg?.takeProfitAtrMult) ?? 0;
                const atrSlDebounceActive = Boolean(posRecord.atrStopLossDebounceActive ?? posRecord.atr_stop_loss_debounce_active);
                const atrSlConfirmSecRaw = Number(
                  posRecord.atrStopLossConfirmSec ?? posRecord.atr_stop_loss_confirm_sec ?? runtimeCfg?.atrStopLossConfirmSec ?? 0
                );
                const atrSlConfirmRemainingSecRaw = Number(
                  posRecord.atrStopLossConfirmRemainingSec ?? posRecord.atr_stop_loss_confirm_remaining_sec
                );
                const atrSlConfirmSec = Number.isFinite(atrSlConfirmSecRaw) ? Math.max(0, Math.round(atrSlConfirmSecRaw)) : 0;
                const atrSlConfirmRemainingSec = Number.isFinite(atrSlConfirmRemainingSecRaw)
                  ? Math.max(0, Math.round(atrSlConfirmRemainingSecRaw))
                  : null;
                const isAtrBasedSl = fixedStopPrice == null && slFixedPct <= 0 && slAtrMult > 0 && atrPct > 0;
                const isAtrBasedTp = fixedTakePrice == null && tpFixedPct <= 0 && tpAtrMult > 0 && atrPct > 0;
                const slPctComputed = isAtrBasedSl ? slAtrMult * atrPct : slFixedPct;
                const tpPctComputed = isAtrBasedTp ? tpAtrMult * atrPct : tpFixedPct;
                const slPct = fixedStopPct ?? slPctComputed;
                const tpPct = fixedTakePct ?? tpPctComputed;
                const isLong = pos.side === "LONG";
                const slPrice = fixedStopPrice ?? (entryPrice > 0 && slPct > 0 ? (isLong ? entryPrice * (1 - slPct) : entryPrice * (1 + slPct)) : null);
                const tpPrice = fixedTakePrice ?? (entryPrice > 0 && tpPct > 0 ? (isLong ? entryPrice * (1 + tpPct) : entryPrice * (1 - tpPct)) : null);
                const distToSlUsd = slPrice != null && currentPrice > 0 ? Math.abs(currentPrice - slPrice) : null;
                const distToTpUsd = tpPrice != null && currentPrice > 0 ? Math.abs(currentPrice - tpPrice) : null;
                const distToSlPct = distToSlUsd != null && currentPrice > 0 ? (distToSlUsd / currentPrice) * 100 : null;
                const distToTpPct = distToTpUsd != null && currentPrice > 0 ? (distToTpUsd / currentPrice) * 100 : null;
                const distToSlAtr = distToSlUsd != null && atrUsd && atrUsd > 0 ? distToSlUsd / atrUsd : null;
                const distToTpAtr = distToTpUsd != null && atrUsd && atrUsd > 0 ? distToTpUsd / atrUsd : null;
                const exitsLabel = fixedStopPrice != null || fixedTakePrice != null
                  ? "frozen at entry"
                  : (isAtrBasedSl || isAtrBasedTp ? "ATR-based exits" : "fixed exits");
                const progressPct = (slPrice != null && tpPrice != null && currentPrice > 0)
                  ? Math.max(0, Math.min(100, ((currentPrice - slPrice) / (tpPrice - slPrice)) * 100))
                  : null;
                const row = (label: string, val: React.ReactNode, valColor = "#e8e8f0") => (
                  <div key={String(label)} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 12 }}>
                    <span style={{ color: "rgba(232,232,240,0.45)" }}>{label}</span>
                    <span style={{ fontWeight: 700, color: valColor, fontFamily: "monospace" }}>{val}</span>
                  </div>
                );
                return (
                  <div>
                    <div style={{ fontSize: 22, fontWeight: 900, textAlign: "center", padding: "10px 0 6px", letterSpacing: "-0.01em", color: isLong ? "#22c55e" : "#ef4444" }}>
                      {isLong ? "▲ LONG" : "▼ SHORT"}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {row("SIZE", `${pos.size?.toFixed(6) || "—"} BTC`)}
                      {row("ENTRY", fmtUsd(entryPrice || null))}
                      {row("AGE", pos.ageSec != null ? `${Math.floor(pos.ageSec / 60)}m ${Math.floor(pos.ageSec % 60)}s` : "—")}
                      {row("UNREAL PNL", fmtUsd(pos.unrealizedPnl), (pos.unrealizedPnl ?? 0) >= 0 ? "#22c55e" : "#ef4444")}

                      {/* ATR / exits block — always shown when position open */}
                      <div style={{ margin: "4px 0 2px", padding: "8px 10px", background: "rgba(6,182,212,0.06)", border: "1px solid rgba(6,182,212,0.15)", borderRadius: 8 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "rgba(6,182,212,0.7)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
                          ATR · {exitsLabel}
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                          <span style={{ color: "rgba(232,232,240,0.5)" }}>{entryAtrPct > 0 ? "ATR at entry" : "1 ATR"}</span>
                          <span style={{ fontFamily: "monospace", fontWeight: 700, color: atrUsd != null ? "#06b6d4" : "rgba(232,232,240,0.3)" }}>
                            {atrUsd != null
                              ? <>{fmtUsd(atrUsd)} <span style={{ color: "rgba(232,232,240,0.4)", fontSize: 11 }}>({(atrPct * 100).toFixed(3)}%)</span></>
                              : "not computed"}
                          </span>
                        </div>

                        {/* SL distance */}
                        {slPrice != null && (
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, marginBottom: 3 }}>
                            <span style={{ color: "#ef4444", opacity: 0.8 }}>
                              SL {fmtUsd(slPrice)}
                              {isAtrBasedSl && <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.6 }}>({slAtrMult}× ATR)</span>}
                            </span>
                            <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#ef4444" }}>
                              {distToSlAtr != null ? `${distToSlAtr.toFixed(2)}× ATR` : distToSlPct != null ? `${distToSlPct.toFixed(2)}%` : "—"}
                              {distToSlPct != null && distToSlAtr == null && (
                                <span style={{ fontSize: 10, color: "rgba(239,68,68,0.6)", marginLeft: 4 }}>({distToSlPct.toFixed(2)}%)</span>
                              )}
                            </span>
                          </div>
                        )}
                        {atrSlDebounceActive && atrSlConfirmRemainingSec != null && (
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
                            <span style={{ color: "rgba(239,68,68,0.75)" }}>SL confirm</span>
                            <span style={{ fontFamily: "monospace", color: "#ef4444" }}>
                              {fmtCountdown(atrSlConfirmRemainingSec)} / {fmtCountdown(atrSlConfirmSec)}
                            </span>
                          </div>
                        )}

                        {/* TP distance */}
                        {tpPrice != null && (
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                            <span style={{ color: "#22c55e", opacity: 0.8 }}>
                              TP {fmtUsd(tpPrice)}
                              {isAtrBasedTp && <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.6 }}>({tpAtrMult}× ATR)</span>}
                            </span>
                            <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#22c55e" }}>
                              {distToTpAtr != null ? `${distToTpAtr.toFixed(2)}× ATR` : distToTpPct != null ? `${distToTpPct.toFixed(2)}%` : "—"}
                              {distToTpPct != null && distToTpAtr == null && (
                                <span style={{ fontSize: 10, color: "rgba(34,197,94,0.6)", marginLeft: 4 }}>({distToTpPct.toFixed(2)}%)</span>
                              )}
                            </span>
                          </div>
                        )}

                        {/* Fallback when no SL/TP configured */}
                        {slPrice == null && tpPrice == null && (
                          <div style={{ fontSize: 11, color: "rgba(232,232,240,0.3)" }}>No SL/TP configured</div>
                        )}
                      </div>

                      {/* Progress bar SL → TP */}
                      {progressPct != null && (
                        <div style={{ marginTop: 2 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "rgba(232,232,240,0.35)", marginBottom: 3 }}>
                            <span>SL</span>
                            <span style={{ color: "rgba(232,232,240,0.25)" }}>{progressPct.toFixed(0)}% to TP</span>
                            <span>TP</span>
                          </div>
                          <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,0.08)", position: "relative", overflow: "hidden" }}>
                            <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${progressPct}%`, background: progressPct > 60 ? "#22c55e" : progressPct < 25 ? "#ef4444" : "#f59e0b", borderRadius: 3, transition: "width 0.5s" }} />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })() : (
                <div style={{ textAlign: "center", padding: "20px 0", fontSize: 18, fontWeight: 700, color: "rgba(232,232,240,0.2)", letterSpacing: "0.1em" }}>— FLAT —</div>
              )}
            </div>

            <div style={darkCard}>
              <div style={sideCardLabel}>EXECUTION</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {([
                  { label: "QUOTE FEED", val: status?.execution?.wsQuotes?.subscribed ? "WS LIVE" : "REST", ok: status?.execution?.wsQuotes?.subscribed as boolean | undefined },
                  { label: "WS STATE", val: status?.execution?.wsQuotes?.connected ? "CONNECTED" : (status?.execution?.wsQuotes ? "DISCONNECTED" : "—"), ok: status?.execution?.wsQuotes?.connected as boolean | undefined },
                  { label: "MAKER FILL %", val: status?.execution?.fillsAuditLast20?.summary ? `${(status.execution.fillsAuditLast20.summary.makerRatePct ?? 0).toFixed(1)}%` : "—", ok: (status?.execution?.fillsAuditLast20?.summary?.makerRatePct ?? 0) >= 70 as unknown as boolean | undefined },
                  { label: "FEES 20 FILLS", val: status?.execution?.fillsAuditLast20?.summary ? fmtUsd(status.execution.fillsAuditLast20.summary.totalFeesUsd) : "—", ok: undefined as boolean | undefined },
                  { label: "LAST ENTRY", val: status?.execution?.lastEntryFill ? (status.execution.lastEntryFill.isMaker ? "MAKER" : "TAKER") : "—", ok: status?.execution?.lastEntryFill?.isMaker as boolean | undefined },
                  { label: "LAST EXIT", val: status?.execution?.lastExitMethod || "—", ok: (status?.execution?.lastExitMethod === "maker") as boolean | undefined },
                ] as Array<{ label: string; val: string; ok: boolean | undefined }>).map(({ label, val, ok }) => (
                  <div key={label} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: "8px 10px" }}>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "rgba(232,232,240,0.3)", marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: ok === undefined ? "#e8e8f0" : ok ? "#22c55e" : "#ef4444" }}>{val}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", flexDirection: "column", gap: 5 }}>
                {([
                  { label: "Avg fill time", val: status?.execution?.avgEntryTimeToFirstFillMs != null ? `${Math.round(status.execution.avgEntryTimeToFirstFillMs)} ms` : "—" },
                  { label: "WS restarts", val: `${status?.execution?.wsQuotes?.restartCount ?? 0} (${status?.execution?.wsQuotes?.lastRestartReason || "—"})` },
                  { label: "Partial fill accepts", val: status?.execution?.entryMakerOpened != null ? `${status.execution.entryMakerPartialAccepts ?? 0} (${(status.execution.entryMakerPartialRatePct ?? 0).toFixed(1)}%)` : "—" },
                ] as Array<{ label: string; val: string }>).map(({ label, val }) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                    <span style={{ color: "rgba(232,232,240,0.38)" }}>{label}</span>
                    <span style={{ fontWeight: 600, color: "rgba(232,232,240,0.65)" }}>{val}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* STATUS ROW */}
        <div style={statusRow}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", background: status?.bot?.alive ? "rgba(34,197,94,0.06)" : "rgba(255,255,255,0.025)", border: `1px solid ${status?.bot?.alive ? "rgba(34,197,94,0.2)" : "rgba(255,255,255,0.06)"}`, borderRadius: 10 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: status?.bot?.alive ? "#22c55e" : "#ef4444", display: "inline-block", boxShadow: status?.bot?.alive ? "0 0 6px #22c55e" : "none" }} />
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "rgba(232,232,240,0.38)" }}>HEARTBEAT</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#e8e8f0" }}>{fmtAgo(status?.updatedAt)}{status?.bot?.version ? ` · v${status.bot.version}` : ""}</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, flex: 1 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: ingestion?.running ? "#22c55e" : "rgba(232,232,240,0.2)", display: "inline-block" }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "rgba(232,232,240,0.38)" }}>DATA INGESTION</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#e8e8f0" }}>{ingestion?.running ? "RUNNING" : "STOPPED"} · {(ingestion?.ingestionRatePerMin5m ?? 0).toFixed(1)} ticks/min</div>
            </div>
            <button style={ingestion?.enabled ? miniWarnBtn : miniGreenBtn} disabled={!isOwner || !!busy} onClick={() => void setIngestionEnabled(!(ingestion?.enabled ?? true))}>
              {ingestion?.enabled ? "PAUSE" : "START"}
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, flex: 1 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: trading?.running ? "#22c55e" : "rgba(232,232,240,0.2)", display: "inline-block" }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "rgba(232,232,240,0.38)" }}>TRADING</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#e8e8f0" }}>{trading?.running ? "RUNNING" : "STOPPED"} · {trading?.positionOpen ? `${trading.side || "OPEN"} · ${fmtCountdown(trading?.timeSinceEntrySec)} age` : "no position"}</div>
              {(() => {
                const todayCount = status?.trading?.tradesToday ?? 0;
                const maxDaily = status?.trading?.maxDailyTrades ?? 0;
                const atLimit = maxDaily > 0 && todayCount >= maxDaily;
                const fillPct = maxDaily > 0 ? Math.min(100, (todayCount / maxDaily) * 100) : 0;
                return (
                  <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 10, color: atLimit ? "#ef4444" : "rgba(232,232,240,0.45)" }}>
                      {todayCount} / {maxDaily > 0 ? maxDaily : "∞"} today
                    </span>
                    {maxDaily > 0 && (
                      <div style={{ flex: 1, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${fillPct}%`, background: atLimit ? "#ef4444" : "#f59e0b", borderRadius: 2, transition: "width 0.5s" }} />
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
            <button style={trading?.enabled ? miniWarnBtn : miniGreenBtn} disabled={!isOwner || !!busy} onClick={() => void setTradingEnabled(!(trading?.enabled ?? true))}>
              {trading?.enabled ? "PAUSE" : "START"}
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10 }}>
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "rgba(232,232,240,0.38)" }}>LAST ACTION</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: status?.lastAction?.ok === false ? "#ef4444" : status?.lastAction?.ok ? "#22c55e" : "#e8e8f0" }}>
                {status?.lastAction?.type || (trading?.lastAction && typeof trading.lastAction === "object" && "type" in (trading.lastAction as { type?: unknown }) ? String((trading.lastAction as { type?: unknown }).type) : "—")}
              </div>
            </div>
          </div>
          <div style={{ marginLeft: isMobile ? 0 : "auto", width: isMobile ? "100%" : "auto" }}>
            <button style={{ ...btnDanger, padding: "10px 20px", fontWeight: 900, letterSpacing: "0.05em", width: isMobile ? "100%" : "auto" }} disabled={!isOwner || !!busy} onClick={() => void sendFlatten()}>■ FLATTEN NOW</button>
          </div>
        </div>

        {/* TRADE HISTORY */}
        <div style={darkCard}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
            <span style={sideCardLabel}>TRADE HISTORY</span>
            {tradesData && (
              <span style={{ fontSize: 10, color: "rgba(232,232,240,0.3)" }}>
                {tradesData.total === 0 ? "No closed trades" : `${tradesPage * 10 + 1}–${Math.min((tradesPage + 1) * 10, tradesData.total)} of ${tradesData.total}`}
              </span>
            )}
          </div>
          {!tradesData || tradesData.trades.length === 0 ? (
            <div style={{ textAlign: "center", padding: "24px 0", fontSize: 13, color: "rgba(232,232,240,0.25)" }}>No closed trades yet</div>
          ) : (
            <>
              <div style={{ overflowX: "auto" as const, WebkitOverflowScrolling: "touch" as const }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr>
                      {(["Side", "Entry", "Exit", "Entry $", "Exit $", "P&L", "Fees", "Duration", "Reason", "Fill"] as string[]).map((h) => (
                        <th key={h} style={{ textAlign: "left", padding: "4px 8px", fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", color: "rgba(232,232,240,0.3)", borderBottom: "1px solid rgba(255,255,255,0.06)", whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tradesData.trades.map((t, i) => {
                      const isLong = t.side === "LONG";
                      const pnlColor = t.pnl == null ? "#e8e8f0" : t.pnl >= 0 ? "#22c55e" : "#ef4444";
                      return (
                        <tr key={t.id ?? i} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                          <td style={{ padding: "6px 8px", fontWeight: 700, color: isLong ? "#22c55e" : "#ef4444", whiteSpace: "nowrap" }}>{t.side || "—"}</td>
                          <td style={{ padding: "6px 8px", color: "rgba(232,232,240,0.7)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{fmtDateTime(t.entry_ts)}</td>
                          <td style={{ padding: "6px 8px", color: "rgba(232,232,240,0.7)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{fmtDateTime(t.exit_ts)}</td>
                          <td style={{ padding: "6px 8px", color: "#e8e8f0", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{fmtUsd(t.entry_price)}</td>
                          <td style={{ padding: "6px 8px", color: "#e8e8f0", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{fmtUsd(t.exit_price)}</td>
                          <td style={{ padding: "6px 8px", fontWeight: 700, color: pnlColor, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{t.pnl != null ? fmtUsd(t.pnl) : "—"}</td>
                          <td style={{ padding: "6px 8px", color: "rgba(232,232,240,0.55)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{t.fees != null ? fmtUsd(t.fees) : "—"}</td>
                          <td style={{ padding: "6px 8px", color: "rgba(232,232,240,0.55)", whiteSpace: "nowrap" }}>{fmtDuration(t.duration_sec)}</td>
                          <td style={{ padding: "6px 8px", color: "rgba(232,232,240,0.6)", whiteSpace: "nowrap", fontSize: 11 }}>{closeReasonTag(t.close_reason)}</td>
                          <td style={{ padding: "6px 8px", color: "rgba(232,232,240,0.5)", whiteSpace: "nowrap", fontSize: 11 }}>{t.note || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {tradesData.total > 10 && (
                <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginTop: 12, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                  <button
                    style={{ padding: "4px 12px", fontSize: 11, fontWeight: 700, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: tradesPage === 0 ? "rgba(232,232,240,0.2)" : "#e8e8f0", cursor: tradesPage === 0 ? "default" : "pointer" }}
                    disabled={tradesPage === 0}
                    onClick={() => { const p = tradesPage - 1; setTradesPage(p); void refreshTrades(p); }}
                  >Prev</button>
                  <span style={{ fontSize: 11, color: "rgba(232,232,240,0.4)" }}>{tradesPage + 1} / {Math.ceil(tradesData.total / 10)}</span>
                  <button
                    style={{ padding: "4px 12px", fontSize: 11, fontWeight: 700, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: (tradesPage + 1) * 10 >= tradesData.total ? "rgba(232,232,240,0.2)" : "#e8e8f0", cursor: (tradesPage + 1) * 10 >= tradesData.total ? "default" : "pointer" }}
                    disabled={(tradesPage + 1) * 10 >= tradesData.total}
                    onClick={() => { const p = tradesPage + 1; setTradesPage(p); void refreshTrades(p); }}
                  >Next</button>
                </div>
              )}
            </>
          )}
        </div>

        {/* INGESTION DETAIL */}
        <details style={darkCard}>
          <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 11, letterSpacing: "0.1em", color: "rgba(232,232,240,0.4)", userSelect: "none" }}>DATA INGESTION DETAIL</summary>
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
            {([
              { k: "Collecting since", v: ingestion?.collectingSince ? new Date(ingestion.collectingSince).toLocaleString() : "—" },
              { k: "Last tick at", v: ingestion?.lastTickAt ? `${new Date(ingestion.lastTickAt).toLocaleTimeString()} (${fmtAgo(ingestion.lastTickAt)})` : "—" },
              { k: "Ticks collected", v: (ingestion?.ticksCollected ?? 0).toLocaleString() },
              { k: "Last 24h ticks", v: (ingestion?.ticks24h ?? 0).toLocaleString() },
              { k: "Ingestion rate (5m)", v: `${(ingestion?.ingestionRatePerMin5m ?? 0).toFixed(2)} ticks/min` },
              { k: "DB size", v: ingestion?.dbSizeBytes != null ? `${(ingestion.dbSizeBytes / 1024 / 1024).toFixed(2)} MB` : "—" },
            ] as Array<{ k: string; v: string }>).map(({ k, v }) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                <span style={{ color: "rgba(232,232,240,0.45)" }}>{k}</span>
                <span style={{ fontWeight: 600, color: "#e8e8f0" }}>{v}</span>
              </div>
            ))}
          </div>
        </details>

        {/* CONTROL CENTER */}
        <div className="uc5-ctrl" style={{ ...controlCenter, padding: isMobile ? "16px 14px 14px" : "20px 20px 16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: isMobile ? "flex-start" : "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ fontSize: isMobile ? 14 : 16, fontWeight: 900, color: "#e8e8f0", letterSpacing: "0.04em" }}>
                <span style={{ color: "#f59e0b", marginRight: 8 }}>&#9881;</span>CONTROL CENTER
              </div>
              <div style={{ fontSize: 12, color: "rgba(232,232,240,0.38)", marginTop: 3 }}>Owner settings · requires MetaMask signature</div>
            </div>
            <span style={isOwner ? ownerBadge : readonlyBadge}>{modeLabel}</span>
          </div>

          <details open style={ctrlSection}>
            <summary style={ctrlSummary}>
              <span style={{ marginRight: 8, color: "#f59e0b" }}>&#9654;</span>
              <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.1em", color: "#f59e0b" }}>STRATEGY &amp; SIGNAL</span>
              <span style={{ marginLeft: 10, fontSize: 11, color: "rgba(232,232,240,0.35)", fontWeight: 400 }}>regime thresholds · timing · loops</span>
            </summary>
            <div style={ctrlBody}>
              <div style={{ ...grid4ctrl, gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(240px, 1fr))" }}>
                <Field label="openConfidenceThreshold" help="Min confidence to open a position." error={validation.openConfidenceThreshold}>
                  <input style={input} type="number" min={0.5} max={0.95} step={0.01} value={edit?.openConfidenceThreshold ?? 0.65} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, openConfidenceThreshold: Number(e.target.value), confidenceThreshold: Number(e.target.value) } : p))} />
                </Field>
                <Field label="closeConfidenceThreshold" help="Min confidence to keep position open." error={validation.closeConfidenceThreshold}>
                  <input style={input} type="number" min={0.45} max={0.9} step={0.01} value={edit?.closeConfidenceThreshold ?? 0.55} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, closeConfidenceThreshold: Number(e.target.value) } : p))} />
                </Field>
                <Field label="trendEntryStrength" help="Only TREND regimes at or above this strength may open a position." error={validation.trendEntryStrength}>
                  <input style={input} type="number" min={0.5} max={0.99} step={0.01} value={edit?.trendEntryStrength ?? 0.7} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, trendEntryStrength: Number(e.target.value) } : p))} />
                </Field>
                <Field label="trendHalfLifeMinSec" help="Minimum OU half-life (sec) before treating a regime as TREND." error={validation.trendHalfLifeMinSec}>
                  <input style={input} type="number" min={60} max={7200} step={30} value={edit?.trendHalfLifeMinSec ?? 450} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, trendHalfLifeMinSec: Number(e.target.value) } : p))} />
                </Field>
                <Field label="regimeLookbackSeconds" help="Bar history window for the regime engine." error={validation.regimeLookbackSeconds}>
                  <input style={input} type="number" min={60} max={86400} step={60} value={edit?.regimeLookbackSeconds ?? 1800} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, regimeLookbackSeconds: Number(e.target.value) } : p))} />
                </Field>
                <Field label="regimeBarSeconds" help="Tick aggregation bar size before regime evaluation." error={validation.regimeBarSeconds}>
                  <input style={input} type="number" min={1} max={60} step={1} value={edit?.regimeBarSeconds ?? 1} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, regimeBarSeconds: Number(e.target.value) } : p))} />
                </Field>
                <Field label="regimeSampleEverySec" help="Regime estimator ingests one bar every N seconds." error={validation.regimeSampleEverySec}>
                  <input style={input} type="number" min={1} max={300} step={1} value={edit?.regimeSampleEverySec ?? Math.max(12, edit?.regimeBarSeconds ?? 1)} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, regimeSampleEverySec: Number(e.target.value) } : p))} />
                </Field>
                <Field label="flipCooldownSec" help="Cooldown after REGIME_END or REGIME_FLIP exit." error={validation.flipCooldownSec}>
                  <input style={input} type="number" min={0} max={600} step={1} value={edit?.flipCooldownSec ?? 15} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, flipCooldownSec: Number(e.target.value), cooldownAfterCloseSec: Number(e.target.value) } : p))} />
                </Field>
                <Field label="decisionLoopIntervalSec" help="Flat decision cadence (3-60s)." error={validation.decisionLoopIntervalSec}>
                  <input style={input} type="number" min={3} max={60} step={1} value={edit?.decisionLoopIntervalSec ?? 4} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, decisionLoopIntervalSec: Number(e.target.value) } : p))} />
                </Field>
                <Field label="inPositionReassessIntervalSec" help="In-position reassessment cadence (5-300s)." error={validation.inPositionReassessIntervalSec}>
                  <input style={input} type="number" min={5} max={300} step={1} value={edit?.inPositionReassessIntervalSec ?? 8} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, reassessIntervalSec: Number(e.target.value), inPositionReassessIntervalSec: Number(e.target.value) } : p))} />
                </Field>
                <Field label="riskLoopIntervalSec" help="Fast risk/execution loop (1-5s)." error={validation.riskLoopIntervalSec}>
                  <input style={input} type="number" min={1} max={5} step={1} value={edit?.riskLoopIntervalSec ?? 1} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, riskLoopIntervalSec: Number(e.target.value) } : p))} />
                </Field>
                <Field label="metricsLoopIntervalSec" help="Slow funding/OI polling interval (30-300s)." error={validation.metricsLoopIntervalSec}>
                  <input style={input} type="number" min={30} max={300} step={1} value={edit?.metricsLoopIntervalSec ?? 45} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, metricsLoopIntervalSec: Number(e.target.value) } : p))} />
                </Field>
                <Field label="ingestIntervalSec" help="Tick write cadence into SQLite (0.2-60s)." error={validation.ingestIntervalSec}>
                  <input style={input} type="number" min={0.2} max={60} step={0.1} value={edit?.ingestIntervalSec ?? 0.5} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, ingestIntervalSec: Number(e.target.value), pollIntervalSeconds: Number(e.target.value) } : p))} />
                </Field>
              </div>
            </div>
          </details>

          <details style={ctrlSection}>
            <summary style={ctrlSummary}>
              <span style={{ marginRight: 8, color: "#ef4444" }}>&#9654;</span>
              <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.1em", color: "#ef4444" }}>RISK &amp; STOPS</span>
              <span style={{ marginLeft: 10, fontSize: 11, color: "rgba(232,232,240,0.35)", fontWeight: 400 }}>leverage · margin · SL/TP · hold times</span>
            </summary>
            <div style={ctrlBody}>
              <div style={{ ...grid4ctrl, gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(240px, 1fr))" }}>
                <Field label="maxLeverage" help="Range 1.0 to 20.0." error={validation.maxLeverage}>
                  <input style={input} type="number" min={1} max={20} step={0.1} value={edit?.maxLeverage ?? 2} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, maxLeverage: Number(e.target.value) } : p))} />
                </Field>
                <Field label="maxMarginUsd" help="Hard USD cap on margin used." error={undefined}>
                  <input style={input} type="number" min={1} max={100000} step={10} value={edit?.maxMarginUsd ?? 100} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, maxMarginUsd: Number(e.target.value) } : p))} />
                </Field>
                <Field label="maxMarginPct (%)" help={`Portfolio ${fmtUsd(portfolio?.portfolioValueUsd)} · cap ${fmtUsd(marginCapAmount)} · used ${fmtUsd(portfolio?.usedMarginUsd)} (${fmtPct(portfolio?.usedMarginPct)})`} error={validation.maxMarginPct}>
                  <div style={{ display: "grid", gap: 6 }}>
                    <input type="range" min={0} max={100} step={1} value={edit?.maxMarginPct ?? 25} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, maxMarginPct: Number(e.target.value) } : p))} />
                    <input style={input} type="number" min={0} max={100} step={1} value={edit?.maxMarginPct ?? 25} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, maxMarginPct: Number(e.target.value) } : p))} />
                  </div>
                </Field>
                <Field label="maxDailyLossUsd" help="Stop trading for the day if realized loss exceeds this. 0 = disabled." error={undefined}>
                  <input style={input} type="number" min={0} max={10000000} step={1} value={edit?.maxDailyLossUsd ?? 0} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, maxDailyLossUsd: Number(e.target.value) } : p))} />
                </Field>
                <Field label="minHoldSeconds" help="Minimum hold before regime exits are allowed. Set 600 to hold 10 min through noisy regime oscillations." error={validation.minHoldSeconds}>
                  <input style={input} type="number" min={0} max={259200} step={1} value={edit?.minHoldSeconds ?? 5} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, minHoldSeconds: Number(e.target.value) } : p))} />
                </Field>
                <Field label="regimeExitEnabled" help="Allow the regime model to close positions. Disable to use only SL/TP/trailing/max-hold for exits — the regime still controls entries.">
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: isOwner ? "pointer" : "default" }}>
                    <input type="checkbox" checked={edit?.regimeExitEnabled ?? false} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, regimeExitEnabled: e.target.checked } : p))} />
                    <span style={{ fontSize: 12, color: "rgba(232,232,240,0.7)" }}>{edit?.regimeExitEnabled ? "ON — regime can close positions" : "OFF — only SL/TP/trailing/max-hold exits"}</span>
                  </label>
                </Field>
                <Field label="exitOnRegimeEnd" help="Exit when regime turns uncertain/flat (RANGE or UNKNOWN). Disable to only exit on active direction reversal — prevents premature exits from regime noise. Has no effect when regimeExitEnabled is OFF.">
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: isOwner ? "pointer" : "default" }}>
                    <input type="checkbox" checked={edit?.exitOnRegimeEnd ?? true} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, exitOnRegimeEnd: e.target.checked } : p))} />
                    <span style={{ fontSize: 12, color: "rgba(232,232,240,0.7)" }}>{edit?.exitOnRegimeEnd ? "ON — exits on FLAT/UNKNOWN regime" : "OFF — only exits on direction flip"}</span>
                  </label>
                </Field>
                <Field label="maxHoldSeconds" help="Force-close position after this duration." error={validation.maxHoldSeconds}>
                  <input style={input} type="number" min={5} max={259200} step={1} value={edit?.maxHoldSeconds ?? 7200} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, maxHoldSeconds: Number(e.target.value) } : p))} />
                </Field>
                <Field label="stopLossPct" help="Fixed stop loss (e.g. 0.003 = 0.3%). 0 = use ATR-based stop." error={undefined}>
                  <input style={input} type="number" min={0} max={1} step={0.001} value={edit?.stopLossPct ?? 0} disabled={!isOwner} onChange={(e) => { const v = Number(e.target.value); setEdit((p) => (p ? { ...p, stopLossPct: v === 0 ? null : v } : p)); }} />
                </Field>
                <Field label="stopLossAtrMult" help="ATR-based stop: SL = entry +/- N x ATR. Active when stopLossPct is null/0. Rec: 2.0." error={undefined}>
                  <input style={input} type="number" min={0} max={20} step={0.1} value={edit?.stopLossAtrMult ?? 0} disabled={!isOwner} onChange={(e) => { const v = Number(e.target.value); setEdit((p) => (p ? { ...p, stopLossAtrMult: v === 0 ? null : v } : p)); }} />
                </Field>
                <Field label="atrStopLossConfirmSec" help="Only for ATR-based SL: price must stay beyond SL for this long before exit (spike protection). TP remains immediate." error={undefined}>
                  <input style={input} type="number" min={0} max={900} step={1} value={edit?.atrStopLossConfirmSec ?? 120} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, atrStopLossConfirmSec: Number(e.target.value) } : p))} />
                </Field>
                <Field label="takeProfitPct" help="Fixed take profit (e.g. 0.006 = 0.6%). 0 = use ATR-based TP." error={undefined}>
                  <input style={input} type="number" min={0} max={1} step={0.001} value={edit?.takeProfitPct ?? 0} disabled={!isOwner} onChange={(e) => { const v = Number(e.target.value); setEdit((p) => (p ? { ...p, takeProfitPct: v === 0 ? null : v } : p)); }} />
                </Field>
                <Field label="takeProfitAtrMult" help="ATR-based TP: target = entry +/- N x ATR. Active when takeProfitPct is null/0. Rec: 4.0." error={undefined}>
                  <input style={input} type="number" min={0} max={20} step={0.1} value={edit?.takeProfitAtrMult ?? 0} disabled={!isOwner} onChange={(e) => { const v = Number(e.target.value); setEdit((p) => (p ? { ...p, takeProfitAtrMult: v === 0 ? null : v } : p)); }} />
                </Field>
                <Field label="trailingStopPct" help="Trailing stop fraction (e.g. 0.006 = 0.6%). 0 = disabled." error={undefined}>
                  <input style={input} type="number" min={0} max={1} step={0.001} value={edit?.trailingStopPct ?? 0} disabled={!isOwner} onChange={(e) => { const v = Number(e.target.value); setEdit((p) => (p ? { ...p, trailingStopPct: v === 0 ? null : v } : p)); }} />
                </Field>
              </div>
            </div>
          </details>

          <details style={ctrlSection}>
            <summary style={ctrlSummary}>
              <span style={{ marginRight: 8, color: "#60a5fa" }}>&#9654;</span>
              <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.1em", color: "#60a5fa" }}>EXECUTION</span>
              <span style={{ marginLeft: 10, fontSize: 11, color: "rgba(232,232,240,0.35)", fontWeight: 400 }}>maker orders · spread · chase · timing</span>
            </summary>
            <div style={ctrlBody}>
              <div style={{ ...grid4ctrl, gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(240px, 1fr))" }}>
                <Field label="feeEstimateBps" help="Estimated round-trip cost in bps." error={undefined}>
                  <input style={input} type="number" min={0} max={100} step={0.5} value={edit?.feeEstimateBps ?? 3} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, feeEstimateBps: Number(e.target.value) } : p))} />
                </Field>
                <Field label="slippageBufferBps" help="Extra buffer added to fee estimate." error={undefined}>
                  <input style={input} type="number" min={0} max={100} step={0.5} value={edit?.slippageBufferBps ?? 4} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, slippageBufferBps: Number(e.target.value) } : p))} />
                </Field>
                <Field label="maxSpreadBpsForTrade" help="Skip entries when live spread is wider than this." error={undefined}>
                  <input style={input} type="number" min={1} max={100} step={0.1} value={edit?.maxSpreadBpsForTrade ?? 12} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, maxSpreadBpsForTrade: Number(e.target.value) } : p))} />
                </Field>
                <Field label="exitSpreadInsaneBps" help="Force market exit if spread exceeds this at exit." error={undefined}>
                  <input style={input} type="number" min={5} max={300} step={1} value={edit?.exitSpreadInsaneBps ?? 28} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, exitSpreadInsaneBps: Number(e.target.value) } : p))} />
                </Field>
                <Field label="executionRepriceMs" help="Cancel/replace cadence for active maker chases." error={undefined}>
                  <input style={input} type="number" min={100} max={5000} step={50} value={edit?.executionRepriceMs ?? 350} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, executionRepriceMs: Number(e.target.value) } : p))} />
                </Field>
                <Field label="makerOrderGtdSec" help="GTD lifetime for each maker order placed." error={undefined}>
                  <input style={input} type="number" min={1} max={30} step={1} value={edit?.makerOrderGtdSec ?? 2} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, makerOrderGtdSec: Number(e.target.value) } : p))} />
                </Field>
                <Field label="makerMinRestMs" help="Minimum rest before replacing a resting maker order." error={undefined}>
                  <input style={input} type="number" min={100} max={5000} step={50} value={edit?.makerMinRestMs ?? 700} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, makerMinRestMs: Number(e.target.value) } : p))} />
                </Field>
                <Field label="entryChaseMaxSec" help="Abort unfilled maker entry after this many seconds." error={undefined}>
                  <input style={input} type="number" min={0.5} max={30} step={0.5} value={edit?.entryChaseMaxSec ?? 10} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, entryChaseMaxSec: Number(e.target.value) } : p))} />
                </Field>
                <Field label="exitChaseMaxSec" help="After this window, market safety override is allowed on exit." error={undefined}>
                  <input style={input} type="number" min={0.5} max={30} step={0.5} value={edit?.exitChaseMaxSec ?? 5} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, exitChaseMaxSec: Number(e.target.value) } : p))} />
                </Field>
                <Field label="entryMinFillRatio" help="Accept partial maker fills once this share of target size is filled." error={undefined}>
                  <input style={input} type="number" min={0.1} max={1} step={0.05} value={edit?.entryMinFillRatio ?? 0.5} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, entryMinFillRatio: Number(e.target.value) } : p))} />
                </Field>
                <Field label="makerImproveMinSpreadTicks" help="Improve by one tick when spread is at least this wide." error={undefined}>
                  <input style={input} type="number" min={1} max={20} step={1} value={edit?.makerImproveMinSpreadTicks ?? 3} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, makerImproveMinSpreadTicks: Number(e.target.value) } : p))} />
                </Field>
                <Field label="maxOrdersPerHour" help="Rate limit on order submissions per hour." error={undefined}>
                  <input style={input} type="number" min={1} max={2000} step={1} value={edit?.maxOrdersPerHour ?? 120} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, maxOrdersPerHour: Number(e.target.value) } : p))} />
                </Field>
                <Field label="makerReplaceOnlyOnTouchMove" help="Preserve queue priority unless the touch price actually moves." error={undefined}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, color: "#e8e8f0", fontSize: 13 }}>
                    <input type="checkbox" checked={Boolean(edit?.makerReplaceOnlyOnTouchMove ?? true)} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, makerReplaceOnlyOnTouchMove: e.target.checked } : p))} />
                    Replace only on touch move
                  </label>
                </Field>
                <Field label="makerImproveOneTickOnWideSpread" help="Improve by one tick while staying post-only when spread is wide." error={undefined}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, color: "#e8e8f0", fontSize: 13 }}>
                    <input type="checkbox" checked={Boolean(edit?.makerImproveOneTickOnWideSpread ?? true)} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, makerImproveOneTickOnWideSpread: e.target.checked } : p))} />
                    Improve one tick on wide spread
                  </label>
                </Field>
                <Field label="entryMakerPreferred" help="Entry is locked to maker-only post-only chase." error={undefined}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, color: "rgba(232,232,240,0.4)", fontSize: 13 }}>
                    <input type="checkbox" checked disabled onChange={() => {}} />
                    Maker-only entry (locked)
                  </label>
                </Field>
                <Field label="exitMakerFirstSafety" help="Exit uses post-only chasing first, then market safety after ~5s." error={undefined}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, color: "rgba(232,232,240,0.4)", fontSize: 13 }}>
                    <input type="checkbox" checked disabled onChange={() => {}} />
                    Maker-first exit + market safety (locked)
                  </label>
                </Field>
              </div>
            </div>
          </details>

          <details open style={ctrlSection}>
            <summary style={ctrlSummary}>
              <span style={{ marginRight: 8, color: "#22c55e" }}>&#9654;</span>
              <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.1em", color: "#22c55e" }}>PROFITABILITY CONTROLS</span>
              <span style={{ marginLeft: 10, fontSize: 11, color: "rgba(232,232,240,0.35)", fontWeight: 400 }}>edge gate · funding · daily limit</span>
            </summary>
            <div style={ctrlBody}>
              <div style={{ ...grid4ctrl, gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(240px, 1fr))" }}>
                <Field label="minExpectedMoveBps" help="Min expected price move (bps) to enter. 0 = disabled. Rec: 14." error={undefined}>
                  <input style={input} type="number" min={0} max={500} step={1} value={edit?.minExpectedMoveBps ?? 0} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, minExpectedMoveBps: Number(e.target.value) } : p))} />
                </Field>
                <Field label="edgeCostMultiplier" help="Required edge as multiple of round-trip cost. 0 = disabled. Rec: 1.5." error={undefined}>
                  <input style={input} type="number" min={0} max={5} step={0.1} value={edit?.edgeCostMultiplier ?? 0} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, edgeCostMultiplier: Number(e.target.value) } : p))} />
                </Field>
                <Field label="fundingRateLimitPct" help="Max adverse hourly funding rate to allow entry. 0 = disabled. Rec: 0.0005." error={undefined}>
                  <input style={input} type="number" min={0} max={1} step={0.0001} value={edit?.fundingRateLimitPct ?? 0} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, fundingRateLimitPct: Number(e.target.value) } : p))} />
                </Field>
                <Field label="maxDailyTrades" help="Max completed trades per calendar day. 0 = unlimited. Rec: 6." error={undefined}>
                  <input style={input} type="number" min={0} max={100} step={1} value={edit?.maxDailyTrades ?? 0} disabled={!isOwner} onChange={(e) => setEdit((p) => (p ? { ...p, maxDailyTrades: Number(e.target.value) } : p))} />
                </Field>
              </div>
            </div>
          </details>

          <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <button style={saveBtnCtrl} disabled={!isOwner || !!busy || hasValidationErrors} onClick={() => void saveConfig()}>
              {busy === "save" ? "Saving..." : "Save Settings"}
            </button>
            {hasValidationErrors && <span style={{ fontSize: 12, color: "#ef4444" }}>Fix validation errors before saving.</span>}
          </div>
        </div>

        {/* SETUP WIZARD */}
        {shouldShowSetup ? (
          <div style={{ ...darkCard, border: "1px solid rgba(245,158,11,0.25)", background: "rgba(245,158,11,0.04)" }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#f59e0b", letterSpacing: "0.08em", marginBottom: 12 }}>SETUP REQUIRED</div>
            <div style={{ fontSize: 12, color: "rgba(232,232,240,0.5)", marginBottom: 12 }}>Missing: {missingSetup.join(", ")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <StepRow title="Discover subaccount" text="Used for balances and active positions." buttonText={busy === "discover-sub" ? "Discovering..." : "Discover subaccount"} disabled={!isOwner || !!busy} onClick={() => void discoverSubaccount()} />
              <StepRow title="Discover productId" text="Used for market data and order placement." buttonText={busy === "discover-product" ? "Discovering..." : "Discover productId"} disabled={!isOwner || !!busy} onClick={() => void discoverProduct()} />
              <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 14 }}>
                <div style={{ fontWeight: 700, color: "#e8e8f0", marginBottom: 4 }}>Link bot signer (recommended)</div>
                <div style={{ color: "rgba(232,232,240,0.5)", marginBottom: 10, fontSize: 13 }}>Safer than trading with your MetaMask private key.</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input style={{ ...input, minWidth: isMobile ? 0 : 280, flex: 1 }} placeholder="Bot signer address (0x...)" value={signerAddr} onChange={(e) => setSignerAddr(e.target.value)} />
                  <button style={btnPrimary} disabled={!isOwner || !!busy || !signerAddr} onClick={() => void createLinkSignerRequest()}>{busy === "link-signer" ? "Requesting..." : "Request link"}</button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

      </div>
    </>
  );
}

function StepRow(props: { title: string; text: string; buttonText: string; disabled: boolean; onClick: () => void }) {
  return (
    <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 12, display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
      <div>
        <div style={{ fontWeight: 700, color: "#e8e8f0" }}>{props.title}</div>
        <div style={{ color: "rgba(232,232,240,0.5)", marginTop: 3, fontSize: 13 }}>{props.text}</div>
      </div>
      <button style={btnSecondary} disabled={props.disabled} onClick={props.onClick}>{props.buttonText}</button>
    </div>
  );
}

function Field(props: { label: string; help?: string; error?: string; children: ReactNode }) {
  return (
    <div style={fieldCard}>
      <div style={{ fontWeight: 700, fontSize: 12, color: "#e8e8f0", marginBottom: 4 }}>{props.label}</div>
      {props.help ? <div style={{ color: "rgba(232,232,240,0.42)", marginBottom: 8, fontSize: 11, lineHeight: 1.5 }}>{props.help}</div> : null}
      <div>{props.children}</div>
      {props.error ? <div style={{ color: "#ef4444", marginTop: 6, fontSize: 11 }}>{props.error}</div> : null}
    </div>
  );
}

function KV(props: { k: string; v: string }) {
  return (
    <div style={kvRow}>
      <span style={kStyle}>{props.k}</span>
      <span style={vStyle}>{props.v}</span>
    </div>
  );
}

const wrap: CSSProperties = { maxWidth: 1400, margin: "0 auto", padding: "14px 16px 48px", display: "flex", flexDirection: "column", gap: 12 };
const heroBar: CSSProperties = { background: "rgba(255,255,255,0.032)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" };
const metricsStrip: CSSProperties = { background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: "12px 4px", display: "flex", overflowX: "auto", gap: 0, scrollbarWidth: "none" };
const darkCard: CSSProperties = { background: "rgba(255,255,255,0.032)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: 18, minWidth: 0 };
const chartCardTitle: CSSProperties = { fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", color: "rgba(232,232,240,0.6)" };
const sideCardLabel: CSSProperties = { fontSize: 9, fontWeight: 800, letterSpacing: "0.14em", color: "rgba(232,232,240,0.35)", display: "block", marginBottom: 6 };
const statusRow: CSSProperties = { background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: "12px 14px", display: "flex", gap: 10, alignItems: "stretch", flexWrap: "wrap" };
const controlCenter: CSSProperties = { background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: "20px 20px 16px" };
const ctrlSection: CSSProperties = { marginBottom: 6, border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, overflow: "hidden" };
const ctrlSummary: CSSProperties = { cursor: "pointer", padding: "11px 14px", display: "flex", alignItems: "center", background: "rgba(255,255,255,0.015)", userSelect: "none" };
const ctrlBody: CSSProperties = { padding: "14px 14px 12px", borderTop: "1px solid rgba(255,255,255,0.05)" };
const grid4ctrl: CSSProperties = { display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" };
const fieldCard: CSSProperties = { background: "rgba(255,255,255,0.028)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "11px 12px 10px" };
const kvRow: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" };
const kStyle: CSSProperties = { color: "rgba(232,232,240,0.48)", fontSize: 12 };
const vStyle: CSSProperties = { color: "#e8e8f0", fontSize: 12, fontWeight: 700, textAlign: "right", maxWidth: 260 };
const input: CSSProperties = { width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)", outline: "none", background: "rgba(255,255,255,0.06)", color: "#e8e8f0", fontSize: 13 };
const btnPrimary: CSSProperties = { borderRadius: 10, border: "1px solid #f59e0b", background: "#f59e0b", color: "#0a0a0f", padding: "9px 14px", fontWeight: 800, cursor: "pointer", fontSize: 13 };
const btnSecondary: CSSProperties = { borderRadius: 10, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.06)", color: "#e8e8f0", padding: "9px 14px", fontWeight: 700, cursor: "pointer", fontSize: 13 };
const btnDanger: CSSProperties = { borderRadius: 10, border: "1px solid #ef4444", background: "#ef4444", color: "#fff", padding: "9px 14px", fontWeight: 800, cursor: "pointer", fontSize: 13 };
const miniWarnBtn: CSSProperties = { borderRadius: 7, border: "1px solid rgba(245,158,11,0.4)", background: "rgba(245,158,11,0.1)", color: "#f59e0b", padding: "5px 10px", fontWeight: 800, cursor: "pointer", fontSize: 10, letterSpacing: "0.06em", flexShrink: 0 };
const miniGreenBtn: CSSProperties = { borderRadius: 7, border: "1px solid rgba(34,197,94,0.4)", background: "rgba(34,197,94,0.1)", color: "#22c55e", padding: "5px 10px", fontWeight: 800, cursor: "pointer", fontSize: 10, letterSpacing: "0.06em", flexShrink: 0 };
const saveBtnCtrl: CSSProperties = { borderRadius: 10, border: "1px solid #f59e0b", background: "#f59e0b", color: "#0a0a0f", padding: "11px 22px", fontWeight: 900, cursor: "pointer", fontSize: 14, letterSpacing: "0.04em" };
const ownerBadge: CSSProperties = { display: "inline-block", borderRadius: 999, padding: "5px 10px", border: "1px solid rgba(34,197,94,0.4)", background: "rgba(34,197,94,0.08)", color: "#22c55e", fontWeight: 800, fontSize: 11, letterSpacing: "0.06em" };
const readonlyBadge: CSSProperties = { display: "inline-block", borderRadius: 999, padding: "5px 10px", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.04)", color: "rgba(232,232,240,0.5)", fontWeight: 800, fontSize: 11, letterSpacing: "0.06em" };
const tooltipBox: CSSProperties = { background: "rgba(10,10,20,0.95)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: "8px 10px", boxShadow: "0 4px 16px rgba(0,0,0,0.4)", fontSize: 12, color: "#e8e8f0" };
const bannerClose: CSSProperties = { border: "1px solid rgba(255,255,255,0.15)", borderRadius: 7, background: "rgba(255,255,255,0.06)", color: "#e8e8f0", fontSize: 11, padding: "4px 8px", cursor: "pointer" };

function bannerStyle(kind: "success" | "error" | "info"): CSSProperties {
  if (kind === "success") return { border: "1px solid rgba(34,197,94,0.35)", background: "rgba(34,197,94,0.08)", color: "#22c55e", borderRadius: 10, padding: "10px 14px", display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", fontSize: 13 };
  if (kind === "error") return { border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.08)", color: "#ef4444", borderRadius: 10, padding: "10px 14px", display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", fontSize: 13 };
  return { border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)", color: "rgba(232,232,240,0.8)", borderRadius: 10, padding: "10px 14px", display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", fontSize: 13 };
}
