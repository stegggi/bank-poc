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
  const inPos = c.inPositionReassessIntervalSec ?? c.reassessIntervalSec ?? 8;
  return {
    ...c,
    ingestionEnabled: c.ingestionEnabled ?? true,
    ingestIntervalSec: c.ingestIntervalSec ?? c.pollIntervalSeconds ?? 0.5,
    regimeLookbackSeconds: c.regimeLookbackSeconds ?? 1800,
    regimeBarSeconds: c.regimeBarSeconds ?? 1,
    regimeSampleEverySec: c.regimeSampleEverySec ?? Math.max(12, c.regimeBarSeconds ?? 1),
    trendEntryStrength: c.trendEntryStrength ?? 0.7,
    flipCooldownSec: c.flipCooldownSec ?? c.cooldownAfterCloseSec ?? 15,
    reassessIntervalSec: inPos,
    decisionLoopIntervalSec: c.decisionLoopIntervalSec ?? 4,
    inPositionReassessIntervalSec: inPos,
    riskLoopIntervalSec: c.riskLoopIntervalSec ?? 1,
    metricsLoopIntervalSec: c.metricsLoopIntervalSec ?? 45,
    minHoldSeconds: c.minHoldSeconds ?? 5,
    maxMarginPct: c.maxMarginPct ?? 25,
    minExpectedMoveBps: 0,
    edgeCostMultiplier: 0,
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
  const [chart, setChart] = useState<VmChartResponse>({ candles: [], markers: [], confidence: [], regimeStrength: [] });
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
    if ((edit.regimeLookbackSeconds ?? 1800) < 60 || (edit.regimeLookbackSeconds ?? 1800) > 86400) {
      errors.regimeLookbackSeconds = "Regime lookback must be 60 to 86400 sec";
    }
    if ((edit.regimeBarSeconds ?? 1) < 1 || (edit.regimeBarSeconds ?? 1) > 60) {
      errors.regimeBarSeconds = "Regime bar size must be 1 to 60 sec";
    }
    if ((edit.regimeSampleEverySec ?? Math.max(12, edit.regimeBarSeconds ?? 1)) < 1 || (edit.regimeSampleEverySec ?? Math.max(12, edit.regimeBarSeconds ?? 1)) > 300) {
      errors.regimeSampleEverySec = "Regime sample cadence must be 1 to 300 sec";
    }
    if ((edit.trendEntryStrength ?? 0.7) < 0.5 || (edit.trendEntryStrength ?? 0.7) > 0.99) {
      errors.trendEntryStrength = "Trend entry strength must be 0.50 to 0.99";
    }
    if ((edit.flipCooldownSec ?? 15) < 0 || (edit.flipCooldownSec ?? 15) > 600) {
      errors.flipCooldownSec = "Flip cooldown must be 0 to 600 sec";
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
              <KV k="Regime sample cadence" v={`${status?.runtime?.regimeSampleEverySec ?? edit?.regimeSampleEverySec ?? Math.max(12, edit?.regimeBarSeconds ?? 1)}s`} />
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
              <KV
                k="Entry maker fill rate"
                v={
                  status?.execution?.entryMakerChases != null
                    ? `${(status.execution.entryMakerFillRatePct ?? 0).toFixed(1)}% (${status.execution.entryMakerOpened ?? 0}/${status.execution.entryMakerChases ?? 0})`
                    : "—"
                }
              />
              <KV
                k="Entry time to fill"
                v={
                  status?.execution?.avgEntryTimeToFirstFillMs != null
                    ? `${Math.round(status.execution.avgEntryTimeToFirstFillMs)} ms`
                    : "—"
                }
              />
              <KV
                k="Partial-fill accepts"
                v={
                  status?.execution?.entryMakerOpened != null
                    ? `${status.execution.entryMakerPartialAccepts ?? 0} (${(status.execution.entryMakerPartialRatePct ?? 0).toFixed(1)}%)`
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

            <Field label="Regime lookback (sec)" help="Bar history window sent into the UC5 regime engine." error={validation.regimeLookbackSeconds}>
              <input
                style={input}
                type="number"
                min={60}
                max={86400}
                step={60}
                value={edit?.regimeLookbackSeconds ?? 1800}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, regimeLookbackSeconds: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="Regime bar size (sec)" help="SQLite ticks are aggregated to this bar size before regime evaluation." error={validation.regimeBarSeconds}>
              <input
                style={input}
                type="number"
                min={1}
                max={60}
                step={1}
                value={edit?.regimeBarSeconds ?? 1}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, regimeBarSeconds: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="Regime sample cadence (sec)" help="UC6 regime estimator ingests one bar every N seconds. Default 12s matches UC6." error={validation.regimeSampleEverySec}>
              <input
                style={input}
                type="number"
                min={1}
                max={300}
                step={1}
                value={edit?.regimeSampleEverySec ?? Math.max(12, edit?.regimeBarSeconds ?? 1)}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, regimeSampleEverySec: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="Trend entry strength" help="Only TREND regimes at or above this strength may open a position." error={validation.trendEntryStrength}>
              <input
                style={input}
                type="number"
                min={0.5}
                max={0.99}
                step={0.01}
                value={edit?.trendEntryStrength ?? 0.7}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, trendEntryStrength: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="Flip cooldown (sec)" help="Cooldown after REGIME_END or REGIME_FLIP exit to avoid whipsaw re-entry." error={validation.flipCooldownSec}>
              <input
                style={input}
                type="number"
                min={0}
                max={600}
                step={1}
                value={edit?.flipCooldownSec ?? 15}
                disabled={!isOwner}
                onChange={(e) =>
                  setEdit((p) =>
                    p
                      ? { ...p, flipCooldownSec: Number(e.target.value), cooldownAfterCloseSec: Number(e.target.value) }
                      : p
                  )
                }
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

            <Field label="Max spread (bps)" help="Skip entries when live spread is wider than this." error={undefined}>
              <input
                style={input}
                type="number"
                min={1}
                max={100}
                step={0.1}
                value={edit?.maxSpreadBpsForTrade ?? 12}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, maxSpreadBpsForTrade: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="Entry chase max (sec)" help="Abort unfilled maker entry after this many seconds and stay flat." error={undefined}>
              <input
                style={input}
                type="number"
                min={0.5}
                max={30}
                step={0.5}
                value={edit?.entryChaseMaxSec ?? 10}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, entryChaseMaxSec: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="Exit chase max (sec)" help="After this window, market safety override is allowed on exit." error={undefined}>
              <input
                style={input}
                type="number"
                min={0.5}
                max={30}
                step={0.5}
                value={edit?.exitChaseMaxSec ?? 5}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, exitChaseMaxSec: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="Execution reprice (ms)" help="Cancel/replace cadence for active maker chases." error={undefined}>
              <input
                style={input}
                type="number"
                min={100}
                max={2000}
                step={50}
                value={edit?.executionRepriceMs ?? 350}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, executionRepriceMs: Number(e.target.value) } : p))}
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
              label="exitMakerFirstSafety"
              help="Exit uses post-only chasing first, then market safety override after ~5s."
              error={undefined}
            >
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
                <input type="checkbox" checked disabled onChange={() => {}} />
                Maker-first exit + market safety (locked)
              </label>
            </Field>

            <Field label="Maker min rest (ms)" help="Minimum rest time before replacing a resting maker order." error={undefined}>
              <input
                style={input}
                type="number"
                min={100}
                max={5000}
                step={50}
                value={edit?.makerMinRestMs ?? 700}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, makerMinRestMs: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="Entry min fill ratio" help="Accept partial maker fills once this share of target size is filled." error={undefined}>
              <input
                style={input}
                type="number"
                min={0.1}
                max={1}
                step={0.05}
                value={edit?.entryMinFillRatio ?? 0.5}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, entryMinFillRatio: Number(e.target.value) } : p))}
              />
            </Field>

            <Field
              label="makerReplaceOnlyOnTouchMove"
              help="Preserve queue priority unless the touch actually moves."
              error={undefined}
            >
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
                <input
                  type="checkbox"
                  checked={Boolean(edit?.makerReplaceOnlyOnTouchMove ?? true)}
                  disabled={!isOwner}
                  onChange={(e) => setEdit((p) => (p ? { ...p, makerReplaceOnlyOnTouchMove: e.target.checked } : p))}
                />
                Replace only on touch move
              </label>
            </Field>

            <Field
              label="makerImproveOneTickOnWideSpread"
              help="When spread is wide enough, improve by one tick while staying post-only."
              error={undefined}
            >
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
                <input
                  type="checkbox"
                  checked={Boolean(edit?.makerImproveOneTickOnWideSpread ?? true)}
                  disabled={!isOwner}
                  onChange={(e) => setEdit((p) => (p ? { ...p, makerImproveOneTickOnWideSpread: e.target.checked } : p))}
                />
                Improve one tick on wide spread
              </label>
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
              24h chart ({chart.candles.length} points). Markers: green=entry, amber=regime end, brown=regime flip, red=risk exit, gray=other/manual close.
            </div>
            {chart.partial24h ? (
              <div style={{ fontSize: 12, color: "#b54708", marginBottom: 8 }}>
                Partial 24h data (missing DB day: {(chart.missingDays || []).join(", ") || "unknown"}).
              </div>
            ) : null}
            {chartRows.length === 0 ? (
              <div style={{ height: MARKET_CHART_HEIGHT, display: "grid", placeItems: "center", color: "#666" }}>No chart data yet.</div>
            ) : (
              <div style={{ width: "100%", minWidth: 0, height: MARKET_CHART_HEIGHT, minHeight: MARKET_CHART_HEIGHT }}>
                <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={MARKET_CHART_HEIGHT}>
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
              Regime strength history (0-100%), with TREND entry threshold.
            </div>
            {regimeRows.length === 0 ? (
              <div style={{ height: CONFIDENCE_CHART_HEIGHT, display: "grid", placeItems: "center", color: "#666" }}>No regime data yet.</div>
            ) : (
              <div style={{ width: "100%", minWidth: 0, height: CONFIDENCE_CHART_HEIGHT, minHeight: CONFIDENCE_CHART_HEIGHT }}>
                <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={CONFIDENCE_CHART_HEIGHT}>
                  <ComposedChart data={regimeRows} margin={{ top: 8, right: 24, left: 8, bottom: 8 }} syncId="uc5-price-confidence">
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
                    <ReferenceLine y={trendEntryStrengthPct} stroke="#b54708" strokeDasharray="4 4" ifOverflow="extendDomain" />
                    <Line dataKey="strengthPct" type="monotone" stroke="#0c4a6e" strokeWidth={2} dot={false} isAnimationActive={false} />
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
              <KV k="Closed by regime end" v={String(tradeSummary?.closedByRegimeEnd ?? 0)} />
              <KV k="Closed by regime flip" v={String(tradeSummary?.closedByRegimeFlip ?? 0)} />
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
            <KV k="Regime state" v={status?.agent?.regimeState || status?.agent?.regime || "—"} />
            <KV k="Regime direction" v={status?.agent?.regimeDirection || "—"} />
            <KV
              k="Trend strength"
              v={
                status?.agent?.regimeStrength != null
                  ? `${(status.agent.regimeStrength * 100).toFixed(1)}% (${status.agent.confidenceBand || "—"})`
                  : "—"
              }
            />
            <KV
              k="Last regime change"
              v={status?.agent?.lastRegimeChangeAt ? new Date(status.agent.lastRegimeChangeAt).toLocaleString() : "—"}
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
const grid2: CSSProperties = { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", minWidth: 0 };
const grid3: CSSProperties = { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", minWidth: 0 };
const grid4: CSSProperties = { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" };
const card: CSSProperties = { border: "1px solid #e6e8eb", borderRadius: 14, padding: 14, background: "#fff", minWidth: 0 };
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
