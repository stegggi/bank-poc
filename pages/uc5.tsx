import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { BrowserProvider, type Eip1193Provider } from "ethers";
import { CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import NavBar from "../components/NavBar";
import { buildAdminMessage } from "../lib/uc5/auth";
import type { Uc5Config, Uc5Status } from "../lib/uc5/types";
import type {
  VmChartResponse,
  VmIngestionStatus,
  VmPortfolio,
  VmSetupStatus,
  VmTradesSummary,
  VmTradingStatus,
} from "../lib/uc5/vmRuntime";

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

function closeReasonLabel(reason?: ChartMarker["closeReason"]) {
  if (reason === "confidence_change") return "confidence change";
  if (reason === "risk_loop") return "risk loop";
  return "other/manual";
}

function markerColor(marker: ChartMarker) {
  if (marker.type === "ENTRY") return "#15803d";
  if (marker.closeReason === "confidence_change") return "#b54708";
  if (marker.closeReason === "risk_loop") return "#b42318";
  return "#475467";
}

function shortAddr(addr: string) {
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
  const openThreshold = c.openConfidenceThreshold ?? c.confidenceThreshold ?? 0.65;
  const closeThreshold = c.closeConfidenceThreshold ?? Math.max(0.5, openThreshold - 0.1);
  const inPos = c.inPositionReassessIntervalSec ?? c.reassessIntervalSec ?? 8;
  return {
    ...c,
    ingestionEnabled: c.ingestionEnabled ?? true,
    ingestIntervalSec: c.ingestIntervalSec ?? c.pollIntervalSeconds ?? 0.5,
    reassessIntervalSec: inPos,
    decisionLoopIntervalSec: c.decisionLoopIntervalSec ?? 4,
    inPositionReassessIntervalSec: inPos,
    riskLoopIntervalSec: c.riskLoopIntervalSec ?? 1,
    metricsLoopIntervalSec: c.metricsLoopIntervalSec ?? 45,
    confidenceThreshold: openThreshold,
    openConfidenceThreshold: openThreshold,
    closeConfidenceThreshold: closeThreshold,
    minHoldSeconds: c.minHoldSeconds ?? 5,
    maxMarginPct: c.maxMarginPct ?? 25,
    feeEstimateBps: c.feeEstimateBps ?? 3,
    slippageBufferBps: c.slippageBufferBps ?? 4,
    minExpectedMoveBps: 0,
    edgeCostMultiplier: 0,
    entryMakerPreferred: true,
    entryMarketFallbackEnabled: false,
    entryMarketFallbackMinProb: c.entryMarketFallbackMinProb ?? 0.9,
    cooldownAfterCloseSec: c.cooldownAfterCloseSec ?? 5,
    emergencyBreakoutEnabled: false,
    emergencyBreakoutMinProb: c.emergencyBreakoutMinProb ?? 0.94,
    emergencyBreakoutMinMoveBps: c.emergencyBreakoutMinMoveBps ?? 35,
    emergencyBreakoutMinAtrPercentile: c.emergencyBreakoutMinAtrPercentile ?? 0.85,
    entryChaseMaxSec: c.entryChaseMaxSec ?? 5,
    exitChaseMaxSec: c.exitChaseMaxSec ?? 5,
    executionRepriceMs: c.executionRepriceMs ?? 200,
    makerOrderGtdSec: c.makerOrderGtdSec ?? 2,
  };
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
  const [cfg, setCfg] = useState<Uc5Config | null>(null);
  const [edit, setEdit] = useState<Uc5Config | null>(null);

  const [status, setStatus] = useState<Uc5Status | null>(null);
  const [ingestion, setIngestion] = useState<VmIngestionStatus | null>(null);
  const [trading, setTrading] = useState<VmTradingStatus | null>(null);
  const [chart, setChart] = useState<VmChartResponse>({ candles: [], markers: [], confidence: [] });
  const [portfolio, setPortfolio] = useState<VmPortfolio | null>(null);
  const [tradeSummary, setTradeSummary] = useState<VmTradesSummary | null>(null);
  const [setup, setSetup] = useState<VmSetupStatus | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        await Promise.all([refreshConfig(), refreshFast(), refreshChart()]);
      } catch {
        if (!cancelled) addNotice("error", "Failed to load UC5 data from VM.", false);
      }
    };
    void init();

    const t1 = setInterval(() => void refreshFast().catch(() => {}), UI_REFRESH_SEC * 1000);
    const t2 = setInterval(() => void refreshChart().catch(() => {}), CHART_REFRESH_SEC * 1000);
    const t3 = setInterval(() => void refreshConfig().catch(() => {}), 20_000);

    return () => {
      cancelled = true;
      clearInterval(t1);
      clearInterval(t2);
      clearInterval(t3);
    };
  }, [addNotice, refreshChart, refreshConfig, refreshFast]);

  const validation = useMemo(() => {
    const errors: Record<string, string> = {};
    if (!edit) return errors;
    if (edit.maxLeverage < 1 || edit.maxLeverage > 20) errors.maxLeverage = "Max leverage must be 1.0 to 20.0";
    if (edit.maxMarginPct < 0 || edit.maxMarginPct > 100) errors.maxMarginPct = "Max margin % must be 0 to 100";
    if (edit.openConfidenceThreshold < 0.5 || edit.openConfidenceThreshold > 0.95) {
      errors.openConfidenceThreshold = "Open threshold must be 0.50 to 0.95";
    }
    if (edit.closeConfidenceThreshold < 0.45 || edit.closeConfidenceThreshold > 0.9) {
      errors.closeConfidenceThreshold = "Close threshold must be 0.45 to 0.90";
    }
    if (edit.closeConfidenceThreshold > edit.openConfidenceThreshold) {
      errors.closeConfidenceThreshold = "Close threshold should be <= open threshold";
    }
    if (edit.minHoldSeconds < 5 || edit.minHoldSeconds > 259200) {
      errors.minHoldSeconds = "Min hold must be 5 to 259200 sec";
    }
    if (edit.maxHoldSeconds < 5 || edit.maxHoldSeconds > 259200) {
      errors.maxHoldSeconds = "Max hold must be 5 to 259200 sec";
    }
    if (edit.maxHoldSeconds < edit.minHoldSeconds) {
      errors.maxHoldSeconds = "Max hold must be >= min hold";
    }
    if (edit.predictionHorizonSeconds < 10 || edit.predictionHorizonSeconds > 259200) {
      errors.predictionHorizonSeconds = "Entry horizon must be 10 to 259200 sec";
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
    if (edit.feeEstimateBps < 0 || edit.feeEstimateBps > 100) {
      errors.feeEstimateBps = "Fee estimate must be 0 to 100 bps";
    }
    if (edit.slippageBufferBps < 0 || edit.slippageBufferBps > 100) {
      errors.slippageBufferBps = "Slippage buffer must be 0 to 100 bps";
    }
    if (edit.minExpectedMoveBps < 0 || edit.minExpectedMoveBps > 500) {
      errors.minExpectedMoveBps = "Min expected move must be 0 to 500 bps";
    }
    if (edit.edgeCostMultiplier < 0 || edit.edgeCostMultiplier > 5) {
      errors.edgeCostMultiplier = "Edge multiplier must be 0.0 to 5.0";
    }
    if (edit.entryMarketFallbackMinProb < 0.5 || edit.entryMarketFallbackMinProb > 0.99) {
      errors.entryMarketFallbackMinProb = "Fallback min probability must be 0.50 to 0.99";
    }
    if (edit.cooldownAfterCloseSec < 0 || edit.cooldownAfterCloseSec > 600) {
      errors.cooldownAfterCloseSec = "Cooldown after close must be 0 to 600 sec";
    }
    if (edit.emergencyBreakoutMinProb < 0.5 || edit.emergencyBreakoutMinProb > 0.99) {
      errors.emergencyBreakoutMinProb = "Emergency breakout min probability must be 0.50 to 0.99";
    }
    if (edit.emergencyBreakoutMinMoveBps < 1 || edit.emergencyBreakoutMinMoveBps > 1000) {
      errors.emergencyBreakoutMinMoveBps = "Emergency breakout min move must be 1 to 1000 bps";
    }
    if (edit.emergencyBreakoutMinAtrPercentile < 0 || edit.emergencyBreakoutMinAtrPercentile > 1) {
      errors.emergencyBreakoutMinAtrPercentile = "Emergency breakout ATR percentile must be 0.00 to 1.00";
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
      const normalized = normalizeEdit(edit);
      const payload: Uc5Config = {
        ...normalized,
        ownerAddress: cfg.ownerAddress,
        pollIntervalSeconds: Math.max(1, Math.round(normalized.ingestIntervalSec)),
        confidenceThreshold: normalized.openConfidenceThreshold,
        reassessIntervalSec: normalized.inPositionReassessIntervalSec,
        entryMakerPreferred: true,
        entryMarketFallbackEnabled: false,
        minExpectedMoveBps: 0,
        edgeCostMultiplier: 0,
        emergencyBreakoutEnabled: false,
      };
      const auth = await signOwnerAction("SET_CONFIG", payload);
      await readJson<{ ok: true }>("/api/uc5/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: payload, auth }),
      });
      setCfg(payload);
      setEdit(payload);
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
  const confidenceRows = useMemo(
    () =>
      (chart.confidence || []).map((p) => ({
        t: p.t,
        confidencePct: Math.max(0, Math.min(100, Number(p.pUp || 0) * 100)),
      })),
    [chart.confidence]
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
  const openThresholdPct = useMemo(
    () =>
      Math.max(
        0,
        Math.min(
          100,
          100 *
            Number(
              status?.runtime?.openConfidenceThreshold ??
                edit?.openConfidenceThreshold ??
                cfg?.openConfidenceThreshold ??
                cfg?.confidenceThreshold ??
                0.65
            )
        )
      ),
    [cfg?.confidenceThreshold, cfg?.openConfidenceThreshold, edit?.openConfidenceThreshold, status?.runtime?.openConfidenceThreshold]
  );
  const closeThresholdPct = useMemo(
    () =>
      Math.max(
        0,
        Math.min(
          100,
          100 *
            Number(
              status?.runtime?.closeConfidenceThreshold ??
                edit?.closeConfidenceThreshold ??
                cfg?.closeConfidenceThreshold ??
                Math.max(
                  0.5,
                  Number(
                    status?.runtime?.openConfidenceThreshold ??
                      edit?.openConfidenceThreshold ??
                      cfg?.openConfidenceThreshold ??
                      cfg?.confidenceThreshold ??
                      0.65
                  ) - 0.1
                )
            )
        )
      ),
    [
      cfg?.closeConfidenceThreshold,
      cfg?.confidenceThreshold,
      cfg?.openConfidenceThreshold,
      edit?.closeConfidenceThreshold,
      edit?.openConfidenceThreshold,
      status?.runtime?.closeConfidenceThreshold,
      status?.runtime?.openConfidenceThreshold,
    ]
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
      const confidence = typeof raw.payload[0]?.value === "number" ? raw.payload[0].value : null;
      return (
        <div style={tooltipBox}>
          <div style={{ fontWeight: 800 }}>{new Date(ts).toLocaleString()}</div>
          <div>Confidence: {confidence != null ? `${confidence.toFixed(1)}%` : "—"}</div>
          <div>Open threshold: {openThresholdPct.toFixed(1)}%</div>
          <div>Close threshold: {closeThresholdPct.toFixed(1)}%</div>
        </div>
      );
    },
    [closeThresholdPct, openThresholdPct]
  );

  return (
    <>
      <NavBar active={"uc5" as never} />
      <div style={wrap}>
        <div style={hero}>
          <div>
            <h1 style={{ margin: 0, fontSize: 32 }}>UC5 — AI Autopilot Perps Bot</h1>
            <p style={{ margin: "8px 0 0", color: "#555" }}>
              Public dashboard stays read-only. Owner wallet can change strategy and control runtime.
            </p>
            <div style={{ marginTop: 10 }}>
              <span style={isOwner ? badgeOwner : badgeReadonly}>{modeLabel}</span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {walletAddr ? (
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, color: "#666" }}>Connected</div>
                <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}>
                  {shortAddr(walletAddr)}
                </div>
              </div>
            ) : (
              <button onClick={connectWallet} style={btnPrimary}>
                Connect MetaMask
              </button>
            )}
          </div>
        </div>

        {notices.length > 0 ? (
          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            {notices.map((n) => (
              <div key={n.id} style={bannerStyle(n.kind)}>
                <div>{n.pending ? "In progress: " : ""}{n.text}</div>
                <button style={bannerClose} onClick={() => dismissNotice(n.id)} disabled={n.pending}>
                  Dismiss
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <section style={{ marginTop: 14 }}>
          <h2 style={sectionTitle}>Bot Status</h2>
          <div style={grid3}>
            <div style={card}>
              <div style={cardTitle}>Heartbeat</div>
              <KV k="Heartbeat" v={fmtAgo(status?.updatedAt)} />
              <KV k="Alive" v={status?.bot?.alive ? "RUNNING" : "STOPPED"} />
              <KV k="Message" v={status?.bot?.message || "—"} />
              <KV k="Version" v={status?.bot?.version || "—"} />
            </div>

            <div style={card}>
              <div style={cardTitle}>Data Ingestion</div>
              <KV k="Status" v={ingestion?.running ? "RUNNING" : "STOPPED"} />
              <KV k="Collecting since" v={ingestion?.collectingSince ? new Date(ingestion.collectingSince).toLocaleString() : "—"} />
              <KV k="Last tick at" v={ingestion?.lastTickAt ? `${new Date(ingestion.lastTickAt).toLocaleTimeString()} (${fmtAgo(ingestion.lastTickAt)})` : "—"} />
              <KV k="Ticks collected" v={(ingestion?.ticksCollected ?? 0).toLocaleString()} />
              <KV k="Last 24h ticks" v={(ingestion?.ticks24h ?? 0).toLocaleString()} />
              <KV k="Ingestion rate (5m)" v={`${(ingestion?.ingestionRatePerMin5m ?? 0).toFixed(2)} ticks/min`} />
              <KV k="DB size" v={ingestion?.dbSizeBytes != null ? `${(ingestion.dbSizeBytes / 1024 / 1024).toFixed(2)} MB` : "—"} />
              <div style={{ marginTop: 10 }}>
                <button
                  style={ingestion?.enabled ? btnWarn : btnPrimary}
                  disabled={!isOwner || !!busy}
                  onClick={() => void setIngestionEnabled(!(ingestion?.enabled ?? true))}
                >
                  {ingestion?.enabled ? "Ingestion OFF" : "Ingestion ON"}
                </button>
              </div>
            </div>

            <div style={card}>
              <div style={cardTitle}>Trading</div>
              <KV k="Status" v={trading?.running ? "RUNNING" : "STOPPED"} />
              <KV k="Position" v={trading?.positionOpen ? `${trading.side || "OPEN"}` : "No open trade"} />
              <KV k="Time since entry" v={fmtCountdown(trading?.timeSinceEntrySec)} />
              <KV k="Risk loop" v={`${status?.runtime?.riskLoopIntervalSec ?? edit?.riskLoopIntervalSec ?? 1}s`} />
              <KV k="Flat decision loop" v={`${status?.runtime?.decisionLoopIntervalSec ?? edit?.decisionLoopIntervalSec ?? 4}s`} />
              <KV
                k="In-position loop"
                v={`${status?.runtime?.inPositionReassessIntervalSec ?? edit?.inPositionReassessIntervalSec ?? 8}s`}
              />
              <KV k="Initial hold ends" v={fmtCountdown(trading?.countdowns?.initialHoldEndsInSec)} />
              <KV k="Next reassessment" v={fmtCountdown(trading?.countdowns?.nextReassessInSec)} />
              <KV k="Max hold ends" v={fmtCountdown(trading?.countdowns?.maxHoldEndsInSec)} />
              <KV k="Cooldown ends" v={fmtCountdown(trading?.countdowns?.cooldownEndsInSec)} />
              <KV k="Next entry evaluation" v={fmtCountdown(trading?.countdowns?.nextDecisionInSec)} />
              <KV k="Last action" v={String(trading?.lastAction && typeof trading.lastAction === "object" && "type" in (trading.lastAction as { type?: unknown }) ? (trading.lastAction as { type?: unknown }).type : "—")} />
              <KV k="Maker-only entry" v={status?.execution?.makerOnlyEntry ? "ON (locked)" : "—"} />
              <KV k="Exit safety override" v={status?.execution?.makerFirstExitWithMarketSafety ? `ON (${status.execution?.exitMarketSafetyAfterSec ?? 5}s)` : "—"} />
              <KV
                k="Quote feed"
                v={
                  status?.execution?.wsQuotes?.subscribed ? "WS BookDepth" : status?.execution?.quoteSource || "REST"
                }
              />
              <KV
                k="WS quotes"
                v={
                  status?.execution?.wsQuotes
                    ? `${status.execution.wsQuotes.connected ? "connected" : "disconnected"} / ${status.execution.wsQuotes.subscribed ? "subscribed" : "not subscribed"}`
                    : "—"
                }
              />
              <KV
                k="Last entry fill"
                v={
                  status?.execution?.lastEntryFill
                    ? `${status.execution.lastEntryFill.isMaker ? "maker" : "taker"} | fee ${fmtUsd(status.execution.lastEntryFill.feeUsd)}`
                    : "—"
                }
              />
              <KV k="Last exit method" v={status?.execution?.lastExitMethod || "—"} />
              <KV
                k="Last 20 fills"
                v={
                  status?.execution?.fillsAuditLast20?.summary
                    ? `maker ${(status.execution.fillsAuditLast20.summary.makerRatePct ?? 0).toFixed(1)}% | fees ${fmtUsd(
                        status.execution.fillsAuditLast20.summary.totalFeesUsd
                      )}`
                    : "—"
                }
              />
              <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  style={trading?.enabled ? btnWarn : btnPrimary}
                  disabled={!isOwner || !!busy}
                  onClick={() => void setTradingEnabled(!(trading?.enabled ?? true))}
                >
                  {trading?.enabled ? "Trading OFF" : "Trading ON"}
                </button>
                <button style={btnDanger} disabled={!isOwner || !!busy} onClick={() => void sendFlatten()}>
                  Flatten Now
                </button>
              </div>
            </div>
          </div>
        </section>

        <section style={{ marginTop: 16 }}>
          <h2 style={sectionTitle}>Owner Controls</h2>
          <p style={{ marginTop: 0, color: "#666" }}>
            Strategy/risk knobs only. Runtime toggles are in Bot Status.
          </p>
          <div style={grid4}>
            <Field label="Max leverage" help="Range 1.0 to 20.0, step 0.1." error={validation.maxLeverage}>
              <input
                style={input}
                type="number"
                min={1}
                max={20}
                step={0.1}
                value={edit?.maxLeverage ?? 2}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, maxLeverage: Number(e.target.value) } : p))}
              />
            </Field>

            <Field
              label="Max margin used (%)"
              help={`Portfolio ${fmtUsd(portfolio?.portfolioValueUsd)} | Cap amount ${fmtUsd(marginCapAmount)} | Used ${fmtUsd(
                portfolio?.usedMarginUsd
              )} (${fmtPct(portfolio?.usedMarginPct)})`}
              error={validation.maxMarginPct}
            >
              <div style={{ display: "grid", gap: 8 }}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={edit?.maxMarginPct ?? 25}
                  disabled={!isOwner}
                  onChange={(e) => setEdit((p) => (p ? { ...p, maxMarginPct: Number(e.target.value) } : p))}
                />
                <input
                  style={input}
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={edit?.maxMarginPct ?? 25}
                  disabled={!isOwner}
                  onChange={(e) => setEdit((p) => (p ? { ...p, maxMarginPct: Number(e.target.value) } : p))}
                />
              </div>
            </Field>

            <Field
              label="Open confidence threshold"
              help="Flat -> long if p_up >= open, short if p_up <= 1-open."
              error={validation.openConfidenceThreshold}
            >
              <input
                style={input}
                type="number"
                min={0.5}
                max={0.95}
                step={0.01}
                value={edit?.openConfidenceThreshold ?? 0.65}
                disabled={!isOwner}
                onChange={(e) =>
                  setEdit((p) =>
                    p
                      ? {
                          ...p,
                          confidenceThreshold: Number(e.target.value),
                          openConfidenceThreshold: Number(e.target.value),
                        }
                      : p
                  )
                }
              />
            </Field>

            <Field
              label="Close confidence threshold"
              help="Long holds while p_up >= close; short holds while p_up <= 1-close."
              error={validation.closeConfidenceThreshold}
            >
              <input
                style={input}
                type="number"
                min={0.45}
                max={0.9}
                step={0.01}
                value={edit?.closeConfidenceThreshold ?? 0.55}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, closeConfidenceThreshold: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="Entry horizon (sec)" help="Minimum 10 sec." error={validation.predictionHorizonSeconds}>
              <input
                style={input}
                type="number"
                min={10}
                max={259200}
                step={1}
                value={edit?.predictionHorizonSeconds ?? 30}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, predictionHorizonSeconds: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="Min time in market (sec)" help="Minimum 5 sec." error={validation.minHoldSeconds}>
              <input
                style={input}
                type="number"
                min={5}
                max={259200}
                step={1}
                value={edit?.minHoldSeconds ?? 5}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, minHoldSeconds: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="Max time in market (sec)" help="Up to 259200 sec (72h)." error={validation.maxHoldSeconds}>
              <input
                style={input}
                type="number"
                min={5}
                max={259200}
                step={1}
                value={edit?.maxHoldSeconds ?? 7200}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, maxHoldSeconds: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="ingestIntervalSec" help="Tick write cadence into SQLite (0.2-60s, 0.5s recommended)." error={validation.ingestIntervalSec}>
              <input
                style={input}
                type="number"
                min={0.2}
                max={60}
                step={0.1}
                value={edit?.ingestIntervalSec ?? 0.5}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, ingestIntervalSec: Number(e.target.value), pollIntervalSeconds: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="riskLoopIntervalSec" help="Fast risk/execution loop (1-5s)." error={validation.riskLoopIntervalSec}>
              <input
                style={input}
                type="number"
                min={1}
                max={5}
                step={1}
                value={edit?.riskLoopIntervalSec ?? 1}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, riskLoopIntervalSec: Number(e.target.value) } : p))}
              />
            </Field>

            <Field
              label="decisionLoopIntervalSec"
              help="Flat decision cadence (3-60s)."
              error={validation.decisionLoopIntervalSec}
            >
              <input
                style={input}
                type="number"
                min={3}
                max={60}
                step={1}
                value={edit?.decisionLoopIntervalSec ?? 4}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, decisionLoopIntervalSec: Number(e.target.value) } : p))}
              />
            </Field>

            <Field
              label="inPositionReassessIntervalSec"
              help="In-position reassessment cadence (5-300s)."
              error={validation.inPositionReassessIntervalSec}
            >
              <input
                style={input}
                type="number"
                min={5}
                max={300}
                step={1}
                value={edit?.inPositionReassessIntervalSec ?? 8}
                disabled={!isOwner}
                onChange={(e) =>
                  setEdit((p) =>
                    p
                      ? {
                          ...p,
                          reassessIntervalSec: Number(e.target.value),
                          inPositionReassessIntervalSec: Number(e.target.value),
                        }
                      : p
                  )
                }
              />
            </Field>

            <Field
              label="metricsLoopIntervalSec"
              help="Slow funding/OI polling interval (30-300s)."
              error={validation.metricsLoopIntervalSec}
            >
              <input
                style={input}
                type="number"
                min={30}
                max={300}
                step={1}
                value={edit?.metricsLoopIntervalSec ?? 45}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, metricsLoopIntervalSec: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="feeEstimateBps" help="Estimated taker fee in bps for edge filter." error={validation.feeEstimateBps}>
              <input
                style={input}
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={edit?.feeEstimateBps ?? 3}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, feeEstimateBps: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="slippageBufferBps" help="Extra cost cushion for expected-edge filter." error={validation.slippageBufferBps}>
              <input
                style={input}
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={edit?.slippageBufferBps ?? 4}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, slippageBufferBps: Number(e.target.value) } : p))}
              />
            </Field>

            <Field
              label="minExpectedMoveBps"
              help="Disabled for higher trading frequency (locked to 0)."
              error={validation.minExpectedMoveBps}
            >
              <input
                style={input}
                type="number"
                min={0}
                max={500}
                step={1}
                value={0}
                disabled
                onChange={() => {}}
              />
            </Field>

            <Field
              label="edgeCostMultiplier"
              help="Disabled for higher trading frequency (locked to 0)."
              error={validation.edgeCostMultiplier}
            >
              <input
                style={input}
                type="number"
                min={0}
                max={5}
                step={0.1}
                value={0}
                disabled
                onChange={() => {}}
              />
            </Field>

            <Field
              label="entryMakerPreferred"
              help="Entry execution is locked to maker-only post-only chase."
              error={undefined}
            >
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
                <input
                  type="checkbox"
                  checked
                  disabled
                  onChange={() => {}}
                />
                Maker-only entry (locked)
              </label>
            </Field>

            <Field
              label="entryMarketFallbackEnabled"
              help="Disabled to prevent taker entries."
              error={undefined}
            >
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
                <input
                  type="checkbox"
                  checked={false}
                  disabled
                  onChange={() => {}}
                />
                Market entry fallback OFF (locked)
              </label>
            </Field>

            <Field
              label="exitMakerFirstSafety"
              help="Exit uses post-only chasing first, then market safety override after ~5s."
              error={undefined}
            >
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
                <input type="checkbox" checked disabled onChange={() => {}} />
                Maker-first exit + market safety (locked)
              </label>
            </Field>

            <Field
              label="entryMarketFallbackMinProb"
              help="Inactive while market entry fallback is locked OFF."
              error={validation.entryMarketFallbackMinProb}
            >
              <input
                style={input}
                type="number"
                min={0.5}
                max={0.99}
                step={0.01}
                value={edit?.entryMarketFallbackMinProb ?? 0.9}
                disabled
                onChange={() => {}}
              />
            </Field>

            <Field
              label="cooldownAfterCloseSec"
              help="Block re-entry for this many seconds after a close."
              error={validation.cooldownAfterCloseSec}
            >
              <input
                style={input}
                type="number"
                min={0}
                max={600}
                step={1}
                value={edit?.cooldownAfterCloseSec ?? 5}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, cooldownAfterCloseSec: Number(e.target.value) } : p))}
              />
            </Field>

            <Field
              label="emergencyBreakoutEnabled"
              help="Disabled by default to keep re-entry behavior simple."
              error={undefined}
            >
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
                <input
                  type="checkbox"
                  checked={Boolean(edit?.emergencyBreakoutEnabled ?? false)}
                  disabled
                  onChange={() => {}}
                />
                Emergency breakout bypass (inactive by default)
              </label>
            </Field>

            <Field
              label="emergencyBreakoutMinProb"
              help="Inactive unless emergency breakout is enabled."
              error={validation.emergencyBreakoutMinProb}
            >
              <input
                style={input}
                type="number"
                min={0.5}
                max={0.99}
                step={0.01}
                value={edit?.emergencyBreakoutMinProb ?? 0.94}
                disabled
                onChange={() => {}}
              />
            </Field>

            <Field
              label="emergencyBreakoutMinMoveBps"
              help="Inactive unless emergency breakout is enabled."
              error={validation.emergencyBreakoutMinMoveBps}
            >
              <input
                style={input}
                type="number"
                min={1}
                max={1000}
                step={1}
                value={edit?.emergencyBreakoutMinMoveBps ?? 35}
                disabled
                onChange={() => {}}
              />
            </Field>

            <Field
              label="emergencyBreakoutMinAtrPercentile"
              help="Inactive unless emergency breakout is enabled."
              error={validation.emergencyBreakoutMinAtrPercentile}
            >
              <input
                style={input}
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={edit?.emergencyBreakoutMinAtrPercentile ?? 0.85}
                disabled
                onChange={() => {}}
              />
            </Field>
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
            <button style={btnPrimary} disabled={!isOwner || !!busy || hasValidationErrors} onClick={() => void saveConfig()}>
              {busy === "save" ? "Saving..." : "Save settings"}
            </button>
          </div>
        </section>

        <section style={{ marginTop: 16 }}>
          <h2 style={sectionTitle}>Market</h2>
          <div style={card}>
            <div style={{ fontSize: 13, color: "#666", marginBottom: 8 }}>
              24h chart ({chart.candles.length} points). Markers: green=entry, amber=close by confidence, red=close by risk loop, gray=other close.
            </div>
            {chart.partial24h ? (
              <div style={{ fontSize: 12, color: "#b54708", marginBottom: 8 }}>
                Partial 24h data (missing DB day: {(chart.missingDays || []).join(", ") || "unknown"}).
              </div>
            ) : null}
            {chartRows.length === 0 ? (
              <div style={{ height: MARKET_CHART_HEIGHT, display: "grid", placeItems: "center", color: "#666" }}>No chart data yet.</div>
            ) : (
              <div style={{ width: "100%", height: MARKET_CHART_HEIGHT }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartRows} margin={{ top: 16, right: 24, left: 8, bottom: 8 }} syncId="uc5-price-confidence">
                    <CartesianGrid strokeDasharray="3 3" stroke="#edf0f4" />
                    <XAxis
                      dataKey="t"
                      type="number"
                      domain={["dataMin", "dataMax"]}
                      tickFormatter={(v) => new Date(Number(v)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      tick={{ fontSize: 12, fill: "#667085" }}
                    />
                    <YAxis
                      type="number"
                      domain={yDomain ?? ["auto", "auto"]}
                      tickFormatter={(v) => Number(v).toFixed(0)}
                      tick={{ fontSize: 12, fill: "#667085" }}
                      width={58}
                    />
                    <Tooltip content={renderChartTooltip} />
                    <Line dataKey="close" type="monotone" stroke="#111827" strokeWidth={2} dot={false} isAnimationActive={false} />
                    {markerRows.slice(-500).map((m, i) => (
                      <ReferenceDot
                        key={`${m.t}-${i}`}
                        x={m.t}
                        y={Number(m.price)}
                        r={4}
                        fill={markerColor(m)}
                        stroke="none"
                        ifOverflow="visible"
                      />
                    ))}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
            <div style={{ fontSize: 13, color: "#666", margin: "12px 0 8px" }}>
              Confidence history (0-100%), with open/close thresholds.
            </div>
            {confidenceRows.length === 0 ? (
              <div style={{ height: CONFIDENCE_CHART_HEIGHT, display: "grid", placeItems: "center", color: "#666" }}>No confidence data yet.</div>
            ) : (
              <div style={{ width: "100%", height: CONFIDENCE_CHART_HEIGHT }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={confidenceRows} margin={{ top: 8, right: 24, left: 8, bottom: 8 }} syncId="uc5-price-confidence">
                    <CartesianGrid strokeDasharray="3 3" stroke="#edf0f4" />
                    <XAxis
                      dataKey="t"
                      type="number"
                      domain={["dataMin", "dataMax"]}
                      tickFormatter={(v) => new Date(Number(v)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      tick={{ fontSize: 12, fill: "#667085" }}
                    />
                    <YAxis
                      type="number"
                      domain={[0, 100]}
                      tickFormatter={(v) => `${Number(v).toFixed(0)}%`}
                      tick={{ fontSize: 12, fill: "#667085" }}
                      width={58}
                    />
                    <Tooltip content={renderConfidenceTooltip} />
                    <ReferenceLine y={openThresholdPct} stroke="#b54708" strokeDasharray="4 4" ifOverflow="extendDomain" />
                    <ReferenceLine y={closeThresholdPct} stroke="#1d2939" strokeDasharray="4 4" ifOverflow="extendDomain" />
                    <Line dataKey="confidencePct" type="monotone" stroke="#0c4a6e" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </section>

        <section style={{ marginTop: 16 }}>
          <h2 style={sectionTitle}>Position & Portfolio Performance</h2>
          <div style={grid2}>
            <div style={card}>
              <div style={cardTitle}>Portfolio</div>
              <KV k="Portfolio value" v={fmtUsd(portfolio?.portfolioValueUsd)} />
              <KV k="Available margin" v={fmtUsd(portfolio?.availableMarginUsd)} />
              <KV k="Used margin" v={`${fmtUsd(portfolio?.usedMarginUsd)} (${fmtPct(portfolio?.usedMarginPct)})`} />
              <KV k="Unrealized PnL" v={fmtUsd(portfolio?.unrealizedPnl)} />
              <KV k="Realized PnL (today)" v={fmtUsd(portfolio?.realizedPnlToday)} />
              <KV k="Realized PnL (total)" v={fmtUsd(portfolio?.realizedPnlTotal)} />
            </div>
            <div style={card}>
              <div style={cardTitle}>Trade Stats</div>
              <KV k="Total trades" v={String(tradeSummary?.totalTrades ?? 0)} />
              <KV k="Closed by confidence change" v={String(tradeSummary?.closedByConfidence ?? 0)} />
              <KV k="Closed by risk loop" v={String(tradeSummary?.closedByRiskLoop ?? 0)} />
              <KV k="Closed by other/manual" v={String(tradeSummary?.closedByOther ?? 0)} />
              <KV k="Win rate" v={fmtPct((tradeSummary?.winRate ?? 0) * 100)} />
              <KV k="Avg win" v={fmtUsd(tradeSummary?.avgWin)} />
              <KV k="Avg loss" v={fmtUsd(tradeSummary?.avgLoss)} />
              <KV k="Open position" v={status?.position?.open ? `${status.position.side || "OPEN"} (${status.position.size?.toFixed(6) || "0"})` : "No"} />
              <KV
                k="Entry"
                v={
                  status?.position?.entryAt
                    ? `${fmtUsd(
                        status.position.entryPrice ??
                          (status.position.open ? status?.market?.price : null)
                      )} @ ${new Date(status.position.entryAt).toLocaleTimeString()}`
                    : "—"
                }
              />
            </div>
          </div>
        </section>

        <section style={{ marginTop: 16 }}>
          <h2 style={sectionTitle}>Agent</h2>
          <div style={card}>
            <KV k="Desired" v={status?.agent?.desired || "—"} />
            <KV
              k="Confidence"
              v={
                status?.agent?.confidence != null
                  ? `${(status.agent.confidence * 100).toFixed(1)}% (${status.agent.confidenceBand || "—"})`
                  : "—"
              }
            />
            <KV k="Reason" v={status?.agent?.reasonHuman || status?.agent?.reason || "—"} />
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: "pointer", fontWeight: 700 }}>Advanced details</summary>
              <div style={{ marginTop: 8, color: "#555", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}>
                {status?.agent?.reasonRaw || "No raw metrics."}
              </div>
            </details>
          </div>
        </section>

        {shouldShowSetup ? (
          <section style={{ marginTop: 16 }}>
            <h2 style={sectionTitle}>Setup Wizard (Advanced)</h2>
            <div style={card}>
              <div style={{ color: "#555", marginBottom: 10 }}>
                Missing setup: {missingSetup.join(", ")}
              </div>
              <div style={{ display: "grid", gap: 10 }}>
                <StepRow
                  title="Discover subaccount"
                  text="Used for balances and active positions."
                  buttonText={busy === "discover-sub" ? "Discovering..." : "Discover subaccount"}
                  disabled={!isOwner || !!busy}
                  onClick={() => void discoverSubaccount()}
                />
                <StepRow
                  title="Discover productId"
                  text="Used for market data and order placement."
                  buttonText={busy === "discover-product" ? "Discovering..." : "Discover productId"}
                  disabled={!isOwner || !!busy}
                  onClick={() => void discoverProduct()}
                />
                <div style={{ border: "1px solid #e6e8eb", borderRadius: 12, padding: 10 }}>
                  <div style={{ fontWeight: 700 }}>Link bot signer (recommended)</div>
                  <div style={{ color: "#666", marginTop: 4 }}>Safer than trading with your MetaMask private key.</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                    <input
                      style={{ ...input, minWidth: 280, flex: 1 }}
                      placeholder="Bot signer address (0x...)"
                      value={signerAddr}
                      onChange={(e) => setSignerAddr(e.target.value)}
                      disabled={!isOwner}
                    />
                    <button style={btnSecondary} disabled={!isOwner || !!busy} onClick={() => void createLinkSignerRequest()}>
                      {busy === "link-signer" ? "Signing..." : "Create LINK_SIGNER request"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>
        ) : (
          <section style={{ marginTop: 16 }}>
            <div style={completeCard}>Setup complete ✅</div>
          </section>
        )}
      </div>
    </>
  );
}

function StepRow(props: { title: string; text: string; buttonText: string; disabled: boolean; onClick: () => void }) {
  return (
    <div style={{ border: "1px solid #e6e8eb", borderRadius: 12, padding: 10, display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
      <div>
        <div style={{ fontWeight: 700 }}>{props.title}</div>
        <div style={{ color: "#666", marginTop: 4 }}>{props.text}</div>
      </div>
      <button style={btnSecondary} disabled={props.disabled} onClick={props.onClick}>
        {props.buttonText}
      </button>
    </div>
  );
}

function Field(props: { label: string; help?: string; error?: string; children: ReactNode }) {
  return (
    <div style={fieldCard}>
      <div style={{ fontWeight: 800 }}>{props.label}</div>
      {props.help ? <div style={{ color: "#666", marginTop: 4, fontSize: 13, lineHeight: 1.4 }}>{props.help}</div> : null}
      <div style={{ marginTop: 8 }}>{props.children}</div>
      {props.error ? <div style={{ color: "#b42318", marginTop: 6, fontSize: 12 }}>{props.error}</div> : null}
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

const wrap: CSSProperties = { maxWidth: 1280, margin: "0 auto", padding: "18px 16px 40px" };
const hero: CSSProperties = {
  border: "1px solid #e6e8eb",
  background: "#fff",
  borderRadius: 16,
  padding: 18,
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
};
const sectionTitle: CSSProperties = { margin: "0 0 10px", fontSize: 22 };
const grid2: CSSProperties = { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" };
const grid3: CSSProperties = { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" };
const grid4: CSSProperties = { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" };
const card: CSSProperties = { border: "1px solid #e6e8eb", borderRadius: 14, padding: 14, background: "#fff" };
const completeCard: CSSProperties = { border: "1px solid #d1fadf", background: "#ecfdf3", color: "#067647", borderRadius: 12, padding: 12, fontWeight: 700 };
const fieldCard: CSSProperties = { border: "1px solid #e6e8eb", borderRadius: 12, padding: 12, background: "#fff" };
const cardTitle: CSSProperties = { fontSize: 14, fontWeight: 900, marginBottom: 8 };
const kvRow: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: "1px dashed #f0f0f0" };
const kStyle: CSSProperties = { color: "#666", fontSize: 13 };
const vStyle: CSSProperties = { color: "#111", fontSize: 13, fontWeight: 700, textAlign: "right", maxWidth: 260 };
const input: CSSProperties = { width: "100%", padding: "10px", borderRadius: 10, border: "1px solid #d0d5dd", outline: "none" };
const btnPrimary: CSSProperties = { borderRadius: 10, border: "1px solid #111", background: "#111", color: "#fff", padding: "10px 12px", fontWeight: 800, cursor: "pointer" };
const btnSecondary: CSSProperties = { borderRadius: 10, border: "1px solid #d0d5dd", background: "#fff", color: "#111", padding: "10px 12px", fontWeight: 700, cursor: "pointer" };
const btnWarn: CSSProperties = { borderRadius: 10, border: "1px solid #f79009", background: "#fff9f0", color: "#b54708", padding: "10px 12px", fontWeight: 800, cursor: "pointer" };
const btnDanger: CSSProperties = { borderRadius: 10, border: "1px solid #b42318", background: "#b42318", color: "#fff", padding: "10px 12px", fontWeight: 800, cursor: "pointer" };
const badgeOwner: CSSProperties = { display: "inline-block", borderRadius: 999, padding: "6px 10px", border: "1px solid #a6f4c5", background: "#ecfdf3", color: "#067647", fontWeight: 800, fontSize: 12 };
const badgeReadonly: CSSProperties = { display: "inline-block", borderRadius: 999, padding: "6px 10px", border: "1px solid #d0d5dd", background: "#f8f9fb", color: "#344054", fontWeight: 800, fontSize: 12 };
const tooltipBox: CSSProperties = {
  background: "#fff",
  border: "1px solid #d0d5dd",
  borderRadius: 10,
  padding: "8px 10px",
  boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
  fontSize: 12,
  color: "#101828",
};
const bannerClose: CSSProperties = { border: "1px solid #d0d5dd", borderRadius: 8, background: "#fff", fontSize: 12, padding: "4px 8px", cursor: "pointer" };

function bannerStyle(kind: NoticeKind): CSSProperties {
  if (kind === "success") return { border: "1px solid #a6f4c5", background: "#ecfdf3", color: "#067647", borderRadius: 10, padding: "10px 12px", display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" };
  if (kind === "error") return { border: "1px solid #fecdca", background: "#fef3f2", color: "#b42318", borderRadius: 10, padding: "10px 12px", display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" };
  return { border: "1px solid #d0d5dd", background: "#f8f9fb", color: "#344054", borderRadius: 10, padding: "10px 12px", display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" };
}
