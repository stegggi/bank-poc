import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { BrowserProvider, type Eip1193Provider } from "ethers";
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

type NoticeKind = "success" | "error" | "info";
type Notice = { id: number; kind: NoticeKind; text: string; pending: boolean };
type AdminAuth = { address: string; signature: string; nonce: string; issuedAt: number };

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

function shortAddr(addr: string) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function normalizeEdit(c: Uc5Config): Uc5Config {
  return {
    ...c,
    ingestionEnabled: c.ingestionEnabled ?? true,
    ingestIntervalSec: c.ingestIntervalSec ?? c.pollIntervalSeconds ?? 2,
    reassessIntervalSec: c.reassessIntervalSec ?? 300,
    maxMarginPct: c.maxMarginPct ?? 25,
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
  const [chart, setChart] = useState<VmChartResponse>({ candles: [], markers: [] });
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
    if (edit.confidenceThreshold < 0.5 || edit.confidenceThreshold > 0.95) {
      errors.confidenceThreshold = "Confidence threshold must be 0.50 to 0.95";
    }
    if (edit.minHoldSeconds < 3600 || edit.minHoldSeconds > 259200) {
      errors.minHoldSeconds = "Min hold must be 3600 to 259200 sec (60m to 72h)";
    }
    if (edit.maxHoldSeconds < 3600 || edit.maxHoldSeconds > 259200) {
      errors.maxHoldSeconds = "Max hold must be 3600 to 259200 sec (60m to 72h)";
    }
    if (edit.maxHoldSeconds < edit.minHoldSeconds) {
      errors.maxHoldSeconds = "Max hold must be >= min hold";
    }
    if (edit.predictionHorizonSeconds < 3600 || edit.predictionHorizonSeconds > 259200) {
      errors.predictionHorizonSeconds = "Entry horizon must be 3600 to 259200 sec";
    }
    if (edit.ingestIntervalSec < 1 || edit.ingestIntervalSec > 60) {
      errors.ingestIntervalSec = "Ingest interval must be 1 to 60 sec";
    }
    if (edit.reassessIntervalSec < 60 || edit.reassessIntervalSec > 86400) {
      errors.reassessIntervalSec = "Reassess interval must be 60 to 86400 sec";
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
      const payload: Uc5Config = {
        ...normalizeEdit(edit),
        ownerAddress: cfg.ownerAddress,
        pollIntervalSeconds: normalizeEdit(edit).ingestIntervalSec,
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
      const rpc = await readJson<{ domain?: unknown }>("/api/uc5/ethereal?path=/v1/rpc/config");
      if (!rpc?.domain) throw new Error("Could not load Ethereal EIP-712 domain.");

      const eth = (window as { ethereum?: Eip1193Provider }).ethereum;
      if (!eth) throw new Error("MetaMask not found.");
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

  const marginCapAmount = useMemo(() => {
    const pv = portfolio?.portfolioValueUsd || 0;
    const pct = edit?.maxMarginPct || 0;
    return (pv * pct) / 100;
  }, [edit?.maxMarginPct, portfolio?.portfolioValueUsd]);

  const modeLabel = isOwner ? "Owner mode (can control bot)" : "Read-only mode";

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
              <KV k="Initial 60m hold ends" v={fmtCountdown(trading?.countdowns?.initialHoldEndsInSec)} />
              <KV k="Next reassessment" v={fmtCountdown(trading?.countdowns?.nextReassessInSec)} />
              <KV k="Max hold ends" v={fmtCountdown(trading?.countdowns?.maxHoldEndsInSec)} />
              <KV k="Next entry evaluation" v={fmtCountdown(trading?.countdowns?.nextDecisionInSec)} />
              <KV k="Last action" v={String(trading?.lastAction && typeof trading.lastAction === "object" && "type" in (trading.lastAction as { type?: unknown }) ? (trading.lastAction as { type?: unknown }).type : "—")} />
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

            <Field label="Confidence threshold" help="Long if p>threshold, short if p<(1-threshold)." error={validation.confidenceThreshold}>
              <input
                style={input}
                type="number"
                min={0.5}
                max={0.95}
                step={0.01}
                value={edit?.confidenceThreshold ?? 0.6}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, confidenceThreshold: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="Entry horizon (sec)" help="At least 60 minutes (3600 sec)." error={validation.predictionHorizonSeconds}>
              <input
                style={input}
                type="number"
                min={3600}
                max={259200}
                step={60}
                value={edit?.predictionHorizonSeconds ?? 3600}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, predictionHorizonSeconds: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="Min time in market (sec)" help="Minimum 3600 sec (60 min)." error={validation.minHoldSeconds}>
              <input
                style={input}
                type="number"
                min={3600}
                max={259200}
                step={60}
                value={edit?.minHoldSeconds ?? 3600}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, minHoldSeconds: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="Max time in market (sec)" help="Up to 259200 sec (72h)." error={validation.maxHoldSeconds}>
              <input
                style={input}
                type="number"
                min={3600}
                max={259200}
                step={60}
                value={edit?.maxHoldSeconds ?? 7200}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, maxHoldSeconds: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="ingestIntervalSec" help="Tick write cadence into SQLite." error={validation.ingestIntervalSec}>
              <input
                style={input}
                type="number"
                min={1}
                max={60}
                step={1}
                value={edit?.ingestIntervalSec ?? 2}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, ingestIntervalSec: Number(e.target.value), pollIntervalSeconds: Number(e.target.value) } : p))}
              />
            </Field>

            <Field label="reassessIntervalSec" help="Reassessment cadence after initial hold." error={validation.reassessIntervalSec}>
              <input
                style={input}
                type="number"
                min={60}
                max={86400}
                step={10}
                value={edit?.reassessIntervalSec ?? 300}
                disabled={!isOwner}
                onChange={(e) => setEdit((p) => (p ? { ...p, reassessIntervalSec: Number(e.target.value) } : p))}
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
              24h chart ({chart.candles.length} points). Trade markers: green=entry, red=exit/flatten.
            </div>
            <SimplePriceChart candles={chartRows} markers={chart.markers} />
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
              <KV k="Win rate" v={fmtPct((tradeSummary?.winRate ?? 0) * 100)} />
              <KV k="Avg win" v={fmtUsd(tradeSummary?.avgWin)} />
              <KV k="Avg loss" v={fmtUsd(tradeSummary?.avgLoss)} />
              <KV k="Open position" v={status?.position?.open ? `${status.position.side || "OPEN"} (${status.position.size?.toFixed(6) || "0"})` : "No"} />
              <KV k="Entry" v={status?.position?.entryAt ? `${fmtUsd(status.position.entryPrice)} @ ${new Date(status.position.entryAt).toLocaleTimeString()}` : "—"} />
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

        {setup?.needsSetup ? (
          <section style={{ marginTop: 16 }}>
            <h2 style={sectionTitle}>Setup Wizard (Advanced)</h2>
            <div style={card}>
              <div style={{ color: "#555", marginBottom: 10 }}>
                Missing setup: {setup.missing.join(", ")}
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
const bannerClose: CSSProperties = { border: "1px solid #d0d5dd", borderRadius: 8, background: "#fff", fontSize: 12, padding: "4px 8px", cursor: "pointer" };

function bannerStyle(kind: NoticeKind): CSSProperties {
  if (kind === "success") return { border: "1px solid #a6f4c5", background: "#ecfdf3", color: "#067647", borderRadius: 10, padding: "10px 12px", display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" };
  if (kind === "error") return { border: "1px solid #fecdca", background: "#fef3f2", color: "#b42318", borderRadius: 10, padding: "10px 12px", display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" };
  return { border: "1px solid #d0d5dd", background: "#f8f9fb", color: "#344054", borderRadius: 10, padding: "10px 12px", display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" };
}

function SimplePriceChart(props: {
  candles: Array<{ t: number; close: number; time: string }>;
  markers: Array<{ t: number; price: number | null; type: "ENTRY" | "EXIT"; side?: string | null; eventType?: string }>;
}) {
  const w = 1100;
  const h = 320;
  const pad = 26;

  if (props.candles.length === 0) {
    return <div style={{ height: 320, display: "grid", placeItems: "center", color: "#666" }}>No chart data yet.</div>;
  }

  const minT = props.candles[0].t;
  const maxT = props.candles[props.candles.length - 1].t;
  const prices = props.candles.map((c) => c.close);
  const markerPrices = props.markers.filter((m) => m.price != null).map((m) => Number(m.price));
  const minP = Math.min(...prices, ...(markerPrices.length ? markerPrices : prices));
  const maxP = Math.max(...prices, ...(markerPrices.length ? markerPrices : prices));
  const pRange = Math.max(1e-9, maxP - minP);
  const tRange = Math.max(1, maxT - minT);

  const xOf = (t: number) => pad + ((t - minT) / tRange) * (w - pad * 2);
  const yOf = (p: number) => h - pad - ((p - minP) / pRange) * (h - pad * 2);

  const d = props.candles
    .map((c, i) => `${i === 0 ? "M" : "L"} ${xOf(c.t).toFixed(2)} ${yOf(c.close).toFixed(2)}`)
    .join(" ");

  const ticks = 6;
  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="UC5 24h price chart">
        {Array.from({ length: ticks + 1 }).map((_, i) => {
          const y = pad + (i * (h - pad * 2)) / ticks;
          return <line key={`gy-${i}`} x1={pad} y1={y} x2={w - pad} y2={y} stroke="#edf0f4" strokeWidth="1" />;
        })}
        {Array.from({ length: ticks + 1 }).map((_, i) => {
          const x = pad + (i * (w - pad * 2)) / ticks;
          return <line key={`gx-${i}`} x1={x} y1={pad} x2={x} y2={h - pad} stroke="#f5f6f7" strokeWidth="1" />;
        })}
        <path d={d} fill="none" stroke="#111827" strokeWidth="2" />
        {props.markers
          .filter((m) => m.price != null)
          .slice(-500)
          .map((m, i) => {
            const x = xOf(m.t);
            const y = yOf(Number(m.price));
            const fill = m.type === "ENTRY" ? "#15803d" : "#b42318";
            return (
              <circle key={`${m.t}-${i}`} cx={x} cy={y} r={4} fill={fill}>
                <title>
                  {`${m.type}${m.side ? ` (${m.side})` : ""} ${fmtUsd(Number(m.price), 2)} @ ${new Date(m.t).toLocaleString()}`}
                </title>
              </circle>
            );
          })}
        <text x={pad} y={14} fontSize="11" fill="#667085">
          {new Date(minT).toLocaleString()}
        </text>
        <text x={w - pad} y={14} textAnchor="end" fontSize="11" fill="#667085">
          {new Date(maxT).toLocaleString()}
        </text>
      </svg>
    </div>
  );
}
