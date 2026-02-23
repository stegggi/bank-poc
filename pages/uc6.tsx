import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { BrowserProvider, type Eip1193Provider } from "ethers";
import NavBar from "../components/NavBar";

const BASE_CHAIN_ID_HEX = "0x2105";
const BASE_CHAIN_ID_DEC = 8453;
const OWNER_ADDRESS = String(process.env.NEXT_PUBLIC_UC6_OWNER_ADDRESS || "");
const STATUS_POLL_MS = 3_000;

type EthereumProvider = Eip1193Provider & {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: any[]) => void) => void;
  removeListener?: (event: string, listener: (...args: any[]) => void) => void;
};

type Uc6Venue = "slipstream" | "uniswapv3";
type CompoundMode = "on_rebalance" | "threshold_harvest";
type OwnerAction = "update_settings" | "force_rebalance" | "liquidate_and_pause";

type Uc6DraftSettings = {
  tradingEnabled: boolean;
  killSwitch: boolean;
  venue: Uc6Venue;
  bandHalfBps: number;
  edgeRebalancePct: number;
  minRebalanceIntervalSec: number;
  maxRebalancesPerDay: number;
  slippageBps: number;
  pollIntervalMs: number;
  maxDeployUsdc: number;
  maxInitialMintUsdc: number;
  minTopUpUsd: number;
  reserveMinUsdc: number;
  reservePct: number; // percentage in UI
  reserveMaxUsdc: number;
  compoundMode: CompoundMode;
  harvestThresholdUsd: number;
  failureCooldownSec: number;
  churnProtectionEnabled: boolean;
  churnMaxCostToFeeRatio: number; // percentage in UI
};

type OwnerPayload = {
  tradingEnabled: boolean;
  killSwitch: boolean;
  venue: Uc6Venue;
  bandHalfBps: number;
  edgeRebalancePct: number;
  minRebalanceIntervalSec: number;
  maxRebalancesPerDay: number;
  slippageBps: number;
  pollIntervalMs: number;
  maxDeployUsdc: number;
  maxInitialMintUsdc: number;
  minTopUpUsd: number;
  reserveMinUsdc: number;
  reservePct: number;
  reserveMaxUsdc: number;
  compoundMode: CompoundMode;
  harvestThresholdUsd: number;
  failureCooldownSec: number;
  churnProtectionEnabled: boolean;
  churnMaxCostToFeeRatio: number;
};

type Uc6Status = {
  ok?: boolean;
  ts?: string;
  account?: string;
  tradingEnabled?: boolean;
  killSwitch?: boolean;
  market?: {
    chain?: { name?: string; chainId?: number };
    venueActive?: Uc6Venue;
    pair?: { base?: string; quote?: string };
    selector?: { type?: "tickSpacing" | "fee"; value?: number };
    poolAddress?: string | null;
    spotPrice?: { usdcPerWeth?: number; updatedAtIso?: string | null };
    tick?: { current?: number; spacing?: number };
    primary?: unknown;
    fallback?: unknown;
  };
  settings?: {
    tradingEnabled?: boolean;
    killSwitch?: boolean;
    venue?: Uc6Venue;
    bandHalfBps?: number;
    edgeRebalancePct?: number;
    minRebalanceIntervalSec?: number;
    maxRebalancesPerDay?: number;
    slippageBps?: number;
    pollIntervalMs?: number;
    maxDeployUsdc?: number;
    maxInitialMintUsdc?: number;
    minTopUpUsd?: number;
    reservePolicy?: {
      minUsdc?: number;
      pct?: number;
      maxUsdc?: number;
      effectiveTargetUsdc?: number;
    };
    reserveMinUsdc?: number;
    reservePct?: number;
    reserveMaxUsdc?: number;
    compoundMode?: CompoundMode;
    harvestThresholdUsd?: number;
    failureCooldownSec?: number;
    churnProtection?: {
      enabled?: boolean;
      maxCostToFeeRatio?: number;
      currentRatioToday?: number | null;
    };
    churnProtectionEnabled?: boolean;
    churnMaxCostToFeeRatio?: number;
  };
  position?: {
    tokenId?: string | null;
    tickLower?: number | null;
    tickUpper?: number | null;
    centerTick?: number | null;
    inRange?: boolean;
    distanceToEdge?: { ticks?: number | null; pct?: number | null };
    liquidity?: string | null;
    amountsInLP?: {
      usdc?: number;
      weth?: number;
      usdValue?: number;
      sideUsd?: { usdc?: number; weth?: number };
    };
  };
  wallet?: {
    balances?: { usdc?: number; weth?: number; eth?: number };
    valuesUsd?: { usdc?: number; weth?: number; eth?: number; total?: number };
    allocationUsd?: { idle?: number; lpDeployed?: number; reserveTarget?: number };
    deployedPct?: number;
  };
  fees?: {
    collectableNow?: { usdc?: number; weth?: number; usd?: number; isEstimated?: boolean };
    collectedTodayUsd?: number;
    collected7dUsd?: number;
    collectedTotalUsd?: number;
    pendingCompoundUsd?: number;
  };
  costs?: {
    gasTodayUsd?: number;
    gas7dUsd?: number;
    gasTotalUsd?: number;
    swapCostsTodayUsd?: number;
    swapCosts7dUsd?: number;
    swapCostsTotalUsd?: number;
    mintBurnTodayUsd?: number;
    mintBurn7dUsd?: number;
    mintBurnTotalUsd?: number;
    totalTodayUsd?: number;
    total7dUsd?: number;
    totalTotalUsd?: number;
  };
  pnl?: {
    netTodayUsd?: number;
    net7dUsd?: number;
    netTotalUsd?: number;
    aprToday?: number | null;
    apr7d?: number | null;
    apr30d?: number | null;
  };
  ops?: {
    rebalancesToday?: number;
    rebalances24h?: number;
    rebalances7d?: number;
    churnRatioToday?: number | null;
    timeInRange?: {
      sinceIso?: string | null;
      eligibleMs?: number;
      inRangeMs?: number;
      pct?: number | null;
    };
    lastRebalanceAtIso?: string | null;
    cooldownRemainingSec?: number | null;
    positionInventory?: {
      ownerNftCount?: number;
      activeCount?: number;
      totalUsdValue?: number;
      active?: Array<{
        tokenId?: string;
        tickLower?: number;
        tickUpper?: number;
        liquidity?: string;
        usdValue?: number;
        inRange?: boolean | null;
      }>;
    } | null;
    lastDecision?: Record<string, unknown> | null;
    lastError?: { atIso?: string | null; message?: string } | null;
  };
  counters?: { reason?: string };
  events?: {
    lastN?: Array<{
      atIso?: string;
      type?: string;
      reason?: string;
      txHashes?: string[];
      gasUsd?: number;
      swapCostUsd?: number;
      slippageBpsReal?: number | null;
      mintBurnUsd?: number;
      feesCollectedUsd?: number;
      netUsd?: number;
      isEstimated?: boolean;
      message?: string;
    }>;
  };
  lastDecision?: unknown;
  lastError?: string | null;
};

function defaultDraft(): Uc6DraftSettings {
  return {
    tradingEnabled: false,
    killSwitch: true,
    venue: "slipstream",
    bandHalfBps: 100,
    edgeRebalancePct: 0.85,
    minRebalanceIntervalSec: 300,
    maxRebalancesPerDay: 20,
    slippageBps: 30,
    pollIntervalMs: 2000,
    maxDeployUsdc: 50_000,
    maxInitialMintUsdc: 50,
    minTopUpUsd: 20,
    reserveMinUsdc: 25,
    reservePct: 0,
    reserveMaxUsdc: 0,
    compoundMode: "on_rebalance",
    harvestThresholdUsd: 30,
    failureCooldownSec: 900,
    churnProtectionEnabled: false,
    churnMaxCostToFeeRatio: 40,
  };
}

function n(v: unknown, fallback: number): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function coerceDraft(settings: Uc6Status["settings"] | undefined): Uc6DraftSettings {
  const d = defaultDraft();
  if (!settings) return d;
  const venue = settings.venue === "uniswapv3" ? "uniswapv3" : "slipstream";
  const reserveMin = n(settings.reservePolicy?.minUsdc ?? settings.reserveMinUsdc, d.reserveMinUsdc);
  const reservePctRatio = n(settings.reservePolicy?.pct ?? settings.reservePct, d.reservePct / 100);
  const reserveMax = n(settings.reservePolicy?.maxUsdc ?? settings.reserveMaxUsdc, d.reserveMaxUsdc);
  const churnEnabled = Boolean(settings.churnProtection?.enabled ?? settings.churnProtectionEnabled ?? d.churnProtectionEnabled);
  const churnRatio = n(settings.churnProtection?.maxCostToFeeRatio ?? settings.churnMaxCostToFeeRatio, d.churnMaxCostToFeeRatio / 100);

  return {
    tradingEnabled: Boolean(settings.tradingEnabled ?? d.tradingEnabled),
    killSwitch: Boolean(settings.killSwitch ?? d.killSwitch),
    venue,
    bandHalfBps: n(settings.bandHalfBps, d.bandHalfBps),
    edgeRebalancePct: n(settings.edgeRebalancePct, d.edgeRebalancePct),
    minRebalanceIntervalSec: n(settings.minRebalanceIntervalSec, d.minRebalanceIntervalSec),
    maxRebalancesPerDay: n(settings.maxRebalancesPerDay, d.maxRebalancesPerDay),
    slippageBps: n(settings.slippageBps, d.slippageBps),
    pollIntervalMs: n(settings.pollIntervalMs, d.pollIntervalMs),
    maxDeployUsdc: n(settings.maxDeployUsdc, d.maxDeployUsdc),
    maxInitialMintUsdc: n(settings.maxInitialMintUsdc, d.maxInitialMintUsdc),
    minTopUpUsd: n(settings.minTopUpUsd, d.minTopUpUsd),
    reserveMinUsdc: reserveMin,
    reservePct: reservePctRatio * 100,
    reserveMaxUsdc: reserveMax,
    compoundMode: settings.compoundMode === "threshold_harvest" ? "threshold_harvest" : "on_rebalance",
    harvestThresholdUsd: n(settings.harvestThresholdUsd, d.harvestThresholdUsd),
    failureCooldownSec: n(settings.failureCooldownSec, d.failureCooldownSec),
    churnProtectionEnabled: churnEnabled,
    churnMaxCostToFeeRatio: churnRatio * 100,
  };
}

function buildPayload(draft: Uc6DraftSettings): OwnerPayload {
  return {
    tradingEnabled: draft.killSwitch ? false : draft.tradingEnabled,
    killSwitch: draft.killSwitch,
    venue: draft.venue,
    bandHalfBps: draft.bandHalfBps,
    edgeRebalancePct: draft.edgeRebalancePct,
    minRebalanceIntervalSec: draft.minRebalanceIntervalSec,
    maxRebalancesPerDay: draft.maxRebalancesPerDay,
    slippageBps: draft.slippageBps,
    pollIntervalMs: draft.pollIntervalMs,
    maxDeployUsdc: draft.maxDeployUsdc,
    maxInitialMintUsdc: draft.maxInitialMintUsdc,
    minTopUpUsd: draft.minTopUpUsd,
    reserveMinUsdc: draft.reserveMinUsdc,
    reservePct: Math.max(0, draft.reservePct) / 100,
    reserveMaxUsdc: draft.reserveMaxUsdc,
    compoundMode: draft.compoundMode,
    harvestThresholdUsd: draft.harvestThresholdUsd,
    failureCooldownSec: draft.failureCooldownSec,
    churnProtectionEnabled: draft.churnProtectionEnabled,
    churnMaxCostToFeeRatio: Math.max(0, draft.churnMaxCostToFeeRatio) / 100,
  };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...(init || {}), cache: "no-store" });
  const txt = await r.text();
  let parsed: unknown = {};
  try {
    parsed = txt ? JSON.parse(txt) : {};
  } catch {
    parsed = {};
  }
  if (!r.ok) {
    const msg =
      parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error?: unknown }).error === "string"
        ? String((parsed as { error?: unknown }).error)
        : `${r.status} ${r.statusText}`;
    throw new Error(msg);
  }
  return parsed as T;
}

function shortAddr(addr?: string | null): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "—";
  return Number(v).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtUsd(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  const n = Number(v);
  if (n !== 0 && Math.abs(n) < 0.01) {
    return n < 0 ? "-<$0.01" : "<$0.01";
  }
  return `$${fmtNum(n, 2)}`;
}

function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${fmtNum(v, digits)}%`;
}

function getEthereum(): EthereumProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { ethereum?: EthereumProvider }).ethereum;
}

function churnTone(ratio: number | null | undefined): "good" | "warn" | "bad" | "muted" {
  if (ratio == null || !Number.isFinite(ratio)) return "muted";
  if (ratio < 0.2) return "good";
  if (ratio <= 0.4) return "warn";
  return "bad";
}

function boolTone(v: boolean | null | undefined): "good" | "bad" | "muted" {
  if (v == null) return "muted";
  return v ? "good" : "bad";
}

export default function Uc6Page() {
  const [status, setStatus] = useState<Uc6Status | null>(null);
  const [draft, setDraft] = useState<Uc6DraftSettings | null>(null);
  const [walletAddress, setWalletAddress] = useState("");
  const [walletChain, setWalletChain] = useState("");
  const [hasMetaMask, setHasMetaMask] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const isBase = walletChain.toLowerCase() === BASE_CHAIN_ID_HEX;
  const isOwner = useMemo(() => {
    if (!walletAddress || !OWNER_ADDRESS) return false;
    return walletAddress.toLowerCase() === OWNER_ADDRESS.toLowerCase();
  }, [walletAddress]);

  const refreshStatus = useCallback(async () => {
    const next = await fetchJson<Uc6Status>("/api/uc6/status");
    setStatus(next);
    setDraft((prev) => prev ?? coerceDraft(next.settings));
  }, []);

  useEffect(() => {
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  useEffect(() => {
    const eth = getEthereum();
    if (!eth?.request) return;
    setHasMetaMask(true);

    const sync = async () => {
      try {
        const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
        setWalletAddress(accounts?.[0] || "");
      } catch {}
      try {
        const chainId = (await eth.request({ method: "eth_chainId" })) as string;
        setWalletChain(chainId || "");
      } catch {}
    };
    void sync();

    const onAccountsChanged = (accounts: string[]) => setWalletAddress(accounts?.[0] || "");
    const onChainChanged = (chainId: string) => setWalletChain(chainId || "");

    eth.on?.("accountsChanged", onAccountsChanged);
    eth.on?.("chainChanged", onChainChanged);
    return () => {
      eth.removeListener?.("accountsChanged", onAccountsChanged);
      eth.removeListener?.("chainChanged", onChainChanged);
    };
  }, []);

  const connectWallet = useCallback(async () => {
    setError("");
    setNotice("");
    const eth = getEthereum();
    if (!eth) {
      setError("MetaMask is not available in this browser.");
      return;
    }
    setBusy("connect");
    try {
      const provider = new BrowserProvider(eth);
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      setWalletAddress(await signer.getAddress());
      const chainId = (await eth.request({ method: "eth_chainId" })) as string;
      setWalletChain(chainId || "");
      setNotice("Wallet connected.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Wallet connection failed.");
    } finally {
      setBusy("");
    }
  }, []);

  const switchToBase = useCallback(async () => {
    setError("");
    setNotice("");
    const eth = getEthereum();
    if (!eth) {
      setError("MetaMask is not available.");
      return;
    }
    setBusy("switch");
    try {
      await eth.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BASE_CHAIN_ID_HEX }],
      });
      setWalletChain(BASE_CHAIN_ID_HEX);
      setNotice("Switched to Base mainnet.");
    } catch (err: unknown) {
      const code = (err as { code?: number }).code;
      if (code === 4902) {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: BASE_CHAIN_ID_HEX,
              chainName: "Base",
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: ["https://mainnet.base.org"],
              blockExplorerUrls: ["https://basescan.org"],
            },
          ],
        });
        await eth.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: BASE_CHAIN_ID_HEX }],
        });
        setWalletChain(BASE_CHAIN_ID_HEX);
        setNotice("Base added and selected in MetaMask.");
      } else {
        setError(err instanceof Error ? err.message : "Failed to switch chain.");
      }
    } finally {
      setBusy("");
    }
  }, []);

  const submitSignedOwnerAction = useCallback(
    async ({
      action,
      payload,
      endpoint,
      successPrefix,
    }: {
      action: OwnerAction;
      payload: unknown;
      endpoint: "/api/uc6/owner/settings" | "/api/uc6/owner/force-rebalance" | "/api/uc6/owner/liquidate-and-pause";
      successPrefix: string;
    }) => {
      if (!walletAddress) throw new Error("Connect MetaMask first.");
      if (!isOwner) throw new Error("Only the configured owner wallet can perform owner actions.");
      const eth = getEthereum();
      if (!eth) throw new Error("MetaMask is unavailable.");

      const challenge = await fetchJson<{ ok: true; message: string; expiresAt: string }>("/api/uc6/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address: walletAddress,
          action,
          payload,
        }),
      });

      const provider = new BrowserProvider(eth);
      const signer = await provider.getSigner();
      const signature = await signer.signMessage(challenge.message);

      const out = await fetchJson<{ ok?: boolean; settings?: Uc6Status["settings"] }>(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: challenge.message, signature, payload }),
      });

      if (out.settings) {
        setDraft(coerceDraft(out.settings));
      }
      setNotice(`${successPrefix}. Challenge expired at ${challenge.expiresAt}.`);
      await refreshStatus();
    },
    [isOwner, refreshStatus, walletAddress]
  );

  const submitOwnerUpdate = useCallback(
    async (payload: OwnerPayload, successPrefix: string) =>
      submitSignedOwnerAction({
        action: "update_settings",
        payload,
        endpoint: "/api/uc6/owner/settings",
        successPrefix,
      }),
    [submitSignedOwnerAction]
  );

  const saveSettings = useCallback(async () => {
    if (!draft) return;
    setError("");
    setNotice("");
    setBusy("save");
    try {
      await submitOwnerUpdate(buildPayload(draft), "Settings updated");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update UC6 settings.");
    } finally {
      setBusy("");
    }
  }, [draft, submitOwnerUpdate]);

  const emergencyStop = useCallback(async () => {
    if (!draft) return;
    setError("");
    setNotice("");
    setBusy("emergency-stop");
    try {
      const payload = buildPayload({ ...draft, tradingEnabled: false, killSwitch: true });
      await submitOwnerUpdate(payload, "Emergency stop activated");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to activate emergency stop.");
    } finally {
      setBusy("");
    }
  }, [draft, submitOwnerUpdate]);

  const enableTrading = useCallback(async () => {
    if (!draft) return;
    setError("");
    setNotice("");
    setBusy("enable-trading");
    try {
      const payload = buildPayload({ ...draft, killSwitch: false, tradingEnabled: true });
      await submitOwnerUpdate(payload, "Trading enabled");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to enable trading.");
    } finally {
      setBusy("");
    }
  }, [draft, submitOwnerUpdate]);

  const forceRebalance = useCallback(async () => {
    setError("");
    setNotice("");
    setBusy("force-rebalance");
    try {
      await submitSignedOwnerAction({
        action: "force_rebalance",
        payload: {},
        endpoint: "/api/uc6/owner/force-rebalance",
        successPrefix: "Force rebalance requested",
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to request force rebalance.");
    } finally {
      setBusy("");
    }
  }, [submitSignedOwnerAction]);

  const liquidateAndPause = useCallback(async () => {
    setError("");
    setNotice("");
    if (!status?.position?.tokenId) {
      setError("No active LP position to liquidate.");
      return;
    }
    const confirmed =
      typeof window === "undefined"
        ? true
        : window.confirm(
            "This will close the entire LP position, return tokens to the wallet, and then enable the kill switch (trading disabled). Continue?"
          );
    if (!confirmed) return;

    setBusy("liquidate-and-pause");
    try {
      await submitSignedOwnerAction({
        action: "liquidate_and_pause",
        payload: {},
        endpoint: "/api/uc6/owner/liquidate-and-pause",
        successPrefix: "LP liquidated and trading disabled",
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to liquidate LP and pause trading.");
    } finally {
      setBusy("");
    }
  }, [status?.position?.tokenId, submitSignedOwnerAction]);

  const updateNumber = useCallback((key: keyof Uc6DraftSettings, value: string) => {
    const num = Number(value);
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, [key]: Number.isFinite(num) ? num : 0 };
    });
  }, []);

  const updateBool = useCallback((key: keyof Uc6DraftSettings, value: boolean) => {
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, [key]: value };
    });
  }, []);

  const decision = (status?.ops?.lastDecision || status?.lastDecision || {}) as Record<string, unknown>;
  const events = (status?.events?.lastN || []).slice(-5).reverse();
  const inRange = Boolean(status?.position?.inRange);
  const cooldownRemaining = Number(status?.ops?.cooldownRemainingSec || 0);
  const bandPct = n(status?.settings?.bandHalfBps, 0) / 100;
  const edgeDistPct = n(status?.position?.distanceToEdge?.pct, 0) * 100;
  const churnRatio = status?.ops?.churnRatioToday;
  const activeLpCount = Number(status?.ops?.positionInventory?.activeCount || 0);
  const hasMultipleActive = activeLpCount > 1;
  const aggregateLpUsd = n(status?.ops?.positionInventory?.totalUsdValue, 0);

  return (
    <>
      <NavBar active={"uc6" as never} />
      <main style={styles.main}>
        <section style={styles.headerCard}>
          <div style={styles.headerRow}>
            <div>
              <h1 style={{ margin: 0, fontSize: 30 }}>UC6: LP Bot Dashboard</h1>
              <p style={styles.subtle}>Operational cockpit for LP performance, costs, risk controls, and owner actions.</p>
            </div>
            <Pill
              label={status?.killSwitch ? "KILL SWITCH ACTIVE" : "KILL SWITCH OFF"}
              tone={status?.killSwitch ? "bad" : "good"}
            />
          </div>

          <div style={styles.row}>
            <button style={styles.button} onClick={connectWallet} disabled={busy !== "" || !hasMetaMask}>
              {walletAddress ? "Reconnect MetaMask" : "Connect MetaMask"}
            </button>
            <button style={styles.buttonSecondary} onClick={switchToBase} disabled={busy !== "" || !walletAddress || isBase}>
              {isBase ? "On Base" : "Switch To Base"}
            </button>
            <button style={styles.buttonSuccess} onClick={enableTrading} disabled={busy !== "" || !isOwner || !draft}>
              Enable Trading
            </button>
            <button style={styles.buttonDanger} onClick={emergencyStop} disabled={busy !== "" || !isOwner || !draft || draft.killSwitch}>
              Emergency Stop
            </button>
          </div>

          <div style={styles.metaGrid}>
            <Metric label="MetaMask" value={hasMetaMask ? "Detected" : "Not found"} />
            <Metric label="Wallet" value={walletAddress ? shortAddr(walletAddress) : "Not connected"} />
            <Metric label="Owner Wallet" value={OWNER_ADDRESS ? shortAddr(OWNER_ADDRESS) : "Missing NEXT_PUBLIC_UC6_OWNER_ADDRESS"} />
            <Metric label="Wallet Chain" value={walletChain ? `${walletChain} (${isBase ? "Base" : "Not Base"})` : "Unknown"} />
            <Metric label="Bot Account" value={shortAddr(status?.account)} mono />
            <Metric label="Owner Session" value={isOwner ? "Authorized" : "Read-only"} />
          </div>

          {!!notice && <p style={{ ...styles.alert, ...styles.alertOk }}>{notice}</p>}
          {!!error && <p style={{ ...styles.alert, ...styles.alertErr }}>{error}</p>}
          {hasMultipleActive && (
            <p style={{ ...styles.alert, ...styles.alertErr }}>
              Multiple active Slipstream positions detected ({activeLpCount}). Bot trading is blocked until positions are consolidated.
            </p>
          )}
        </section>

        <section style={styles.cardGrid}>
          <Card title="Position Overview">
            <div style={styles.metaGrid}>
              <Metric label="Chain" value={`${status?.market?.chain?.name || "Base"} (${status?.market?.chain?.chainId || BASE_CHAIN_ID_DEC})`} />
              <Metric label="Venue Active" value={status?.market?.venueActive || "—"} />
              <Metric label="Pair" value={`${status?.market?.pair?.base || "WETH"}/${status?.market?.pair?.quote || "USDC"}`} />
              <Metric label="Selector" value={`${status?.market?.selector?.type || "—"}: ${String(status?.market?.selector?.value ?? "—")}`} />
              <Metric label="Spot Price" value={fmtUsd(status?.market?.spotPrice?.usdcPerWeth)} />
              <Metric label="Price Updated" value={status?.market?.spotPrice?.updatedAtIso || "—"} />
              <Metric label="Tick" value={String(status?.market?.tick?.current ?? "—")} />
              <Metric label="Tick Spacing" value={String(status?.market?.tick?.spacing ?? "—")} />
              <Metric label="Token Id" value={String(status?.position?.tokenId ?? "—")} mono />
              <Metric label="Active LP NFTs" value={String(activeLpCount || 0)} />
              <Metric label="Total LP (All NFTs)" value={fmtUsd(aggregateLpUsd)} />
              <Metric label="In Range" value={<Pill label={inRange ? "In Range" : "Out of Range"} tone={boolTone(status?.position?.inRange)} />} />
              <Metric label="Band Width" value={`±${fmtPct(bandPct)}`} />
              <Metric label="Band Ticks" value={`${String(status?.position?.tickLower ?? "—")} .. ${String(status?.position?.tickUpper ?? "—")}`} mono />
              <Metric label="Distance To Edge" value={`${String(status?.position?.distanceToEdge?.ticks ?? "—")} ticks (${fmtPct(edgeDistPct)})`} />
              <Metric label="Edge Threshold" value={fmtPct(n(status?.settings?.edgeRebalancePct, 0) * 100)} />
              <Metric label="Time In Range (Trading On)" value={status?.ops?.timeInRange?.pct == null ? "—" : fmtPct(n(status?.ops?.timeInRange?.pct, 0) * 100)} />
              <Metric label="Time In Range Since" value={status?.ops?.timeInRange?.sinceIso || "—"} />
              <Metric label="Min Rebalance Interval" value={`${String(status?.settings?.minRebalanceIntervalSec ?? "—")}s`} />
              <Metric
                label="Cooldown Remaining"
                value={<Pill label={cooldownRemaining > 0 ? `${cooldownRemaining}s` : "ready"} tone={cooldownRemaining > 0 ? "warn" : "good"} />}
              />
            </div>
            <div style={styles.note}>
              Next action: <strong>{String(decision.action || "monitor")}</strong> ({String(decision.reason || "n/a")})
            </div>
          </Card>

          <Card title="Wallet & Allocation">
            <div style={styles.metaGrid}>
              <Metric label="Wallet Total" value={fmtUsd(status?.wallet?.valuesUsd?.total)} />
              <Metric label="USDC" value={`${fmtNum(status?.wallet?.balances?.usdc, 4)} (${fmtUsd(status?.wallet?.valuesUsd?.usdc)})`} />
              <Metric label="WETH" value={`${fmtNum(status?.wallet?.balances?.weth, 6)} (${fmtUsd(status?.wallet?.valuesUsd?.weth)})`} />
              <Metric label="ETH (Gas)" value={`${fmtNum(status?.wallet?.balances?.eth, 6)} (${fmtUsd(status?.wallet?.valuesUsd?.eth)})`} />
              <Metric label="Idle Value" value={fmtUsd(status?.wallet?.allocationUsd?.idle)} />
              <Metric label="LP Deployed" value={fmtUsd(status?.wallet?.allocationUsd?.lpDeployed)} />
              <Metric label="Reserve Target" value={fmtUsd(status?.wallet?.allocationUsd?.reserveTarget)} />
              <Metric label="% Deployed" value={fmtPct(status?.wallet?.deployedPct)} />
              <Metric label="% Idle" value={fmtPct(100 - n(status?.wallet?.deployedPct, 0))} />
            </div>
          </Card>

          <Card title="LP Position Composition">
            {isOwner && (
              <div style={{ ...styles.row, marginBottom: 12 }}>
                <button
                  style={styles.buttonDanger}
                  onClick={liquidateAndPause}
                  disabled={busy !== "" || !status?.position?.tokenId}
                  title={!status?.position?.tokenId ? "No active LP position" : "Close LP and enable kill switch"}
                >
                  Liquidate LP + Pause
                </button>
              </div>
            )}
            <div style={styles.metaGrid}>
              <Metric label="USDC in LP" value={`${fmtNum(status?.position?.amountsInLP?.usdc, 4)} (${fmtUsd(status?.position?.amountsInLP?.sideUsd?.usdc)})`} />
              <Metric label="WETH in LP" value={`${fmtNum(status?.position?.amountsInLP?.weth, 6)} (${fmtUsd(status?.position?.amountsInLP?.sideUsd?.weth)})`} />
              <Metric label="LP Value" value={fmtUsd(status?.position?.amountsInLP?.usdValue)} />
              <Metric
                label="LP Split"
                value={`${fmtPct((n(status?.position?.amountsInLP?.sideUsd?.usdc, 0) / Math.max(1, n(status?.position?.amountsInLP?.usdValue, 0))) * 100)} / ${fmtPct((n(status?.position?.amountsInLP?.sideUsd?.weth, 0) / Math.max(1, n(status?.position?.amountsInLP?.usdValue, 0))) * 100)}`}
              />
              <Metric label="Distance To Edge" value={`${String(status?.position?.distanceToEdge?.ticks ?? "—")} ticks (${fmtPct(edgeDistPct)})`} />
              <Metric label="Liquidity" value={status?.position?.liquidity || "—"} mono />
            </div>
          </Card>

          <Card title="Profitability (Net)">
            <SimpleTable
              headers={["Window", "Fees", "Rewards", "Costs", "Net", "APR"]}
              rows={[
                [
                  "Today",
                  fmtUsd(status?.fees?.collectedTodayUsd),
                  "$0.00",
                  fmtUsd(status?.costs?.totalTodayUsd),
                  fmtUsd(status?.pnl?.netTodayUsd),
                  fmtPct(n(status?.pnl?.aprToday, 0) * 100),
                ],
                [
                  "7D",
                  fmtUsd(status?.fees?.collected7dUsd),
                  "$0.00",
                  fmtUsd(status?.costs?.total7dUsd),
                  fmtUsd(status?.pnl?.net7dUsd),
                  fmtPct(n(status?.pnl?.apr7d, 0) * 100),
                ],
                [
                  "All-time",
                  fmtUsd(status?.fees?.collectedTotalUsd),
                  "$0.00",
                  fmtUsd(status?.costs?.totalTotalUsd),
                  fmtUsd(status?.pnl?.netTotalUsd),
                  status?.pnl?.apr30d == null ? "—" : fmtPct(n(status?.pnl?.apr30d, 0) * 100),
                ],
              ]}
            />
            <div style={styles.note}>
              Collectable now: {fmtUsd(status?.fees?.collectableNow?.usd)}
              {status?.fees?.collectableNow?.isEstimated ? " (simulation fallback)" : ""} | Pending compound: {fmtUsd(status?.fees?.pendingCompoundUsd)}
            </div>
          </Card>

          <Card title="Rebalance & Activity">
            {isOwner && (
              <div style={{ ...styles.row, marginBottom: 12 }}>
                <button
                  style={styles.buttonSecondary}
                  onClick={forceRebalance}
                  disabled={busy !== "" || Boolean(status?.killSwitch) || !status?.tradingEnabled}
                  title={
                    status?.killSwitch
                      ? "Kill switch active"
                      : !status?.tradingEnabled
                        ? "Trading is disabled"
                        : "Request an immediate rebalance (owner-only)"
                  }
                >
                  Force Rebalance
                </button>
              </div>
            )}
            <div style={styles.metaGrid}>
              <Metric label="Rebalances (24h)" value={String(status?.ops?.rebalances24h ?? 0)} />
              <Metric label="Rebalances (7d)" value={String(status?.ops?.rebalances7d ?? 0)} />
              <Metric label="Costs Today" value={fmtUsd(status?.costs?.totalTodayUsd)} />
              <Metric label="Avg Cost / Rebalance" value={fmtUsd(n(status?.costs?.totalTodayUsd, 0) / Math.max(1, n(status?.ops?.rebalances24h, 0)))} />
              <Metric label="Avg Fees / Rebalance" value={fmtUsd(n(status?.fees?.collectedTodayUsd, 0) / Math.max(1, n(status?.ops?.rebalances24h, 0)))} />
              <Metric label="Churn Ratio" value={<Pill label={churnRatio == null ? "n/a" : fmtPct(churnRatio * 100)} tone={churnTone(churnRatio)} />} />
              <Metric label="Churn Protection" value={status?.settings?.churnProtection?.enabled ? "enabled" : "disabled"} />
              <Metric label="Churn Limit" value={fmtPct(n(status?.settings?.churnProtection?.maxCostToFeeRatio, 0) * 100)} />
              <Metric label="Last Rebalance" value={status?.ops?.lastRebalanceAtIso || "—"} />
              <Metric label="Gate" value={status?.counters?.reason || "—"} />
            </div>
          </Card>

          <Card title="Events & Decisions" fullWidth>
            <SimpleTable
              headers={["Time", "Type", "Reason", "Tx", "Gas", "Swap", "Slip", "Fees", "Net"]}
              rows={events.map((ev) => [
                ev.atIso || "—",
                ev.type || "—",
                ev.reason || "—",
                ev.txHashes && ev.txHashes.length > 0 ? shortAddr(ev.txHashes[0]) : "—",
                fmtUsd(ev.gasUsd),
                fmtUsd(ev.swapCostUsd),
                ev.slippageBpsReal == null ? "—" : `${n(ev.slippageBpsReal, 0).toFixed(1)} bps`,
                fmtUsd(ev.feesCollectedUsd),
                fmtUsd(ev.netUsd),
              ])}
            />
            <div style={styles.note}>Swap costs and slippage use quote vs actual wallet balance deltas.</div>
          </Card>
        </section>

        {isOwner && draft && (
          <section style={styles.panel}>
            <h2 style={styles.h2}>Owner Controls</h2>
            <div style={styles.formGrid}>
              <SelectField label="Kill Switch" value={draft.killSwitch ? "true" : "false"} onChange={(v) => updateBool("killSwitch", v === "true")} options={["false", "true"]} />
              <SelectField
                label="Trading Enabled"
                value={draft.tradingEnabled ? "true" : "false"}
                onChange={(v) => updateBool("tradingEnabled", v === "true")}
                options={["true", "false"]}
                disabled={draft.killSwitch}
              />
              <SelectField label="Venue" value={draft.venue} onChange={(v) => setDraft((p) => (p ? { ...p, venue: v as Uc6Venue } : p))} options={["slipstream", "uniswapv3"]} />

              <NumberField label="bandHalfBps" value={draft.bandHalfBps} onChange={(v) => updateNumber("bandHalfBps", v)} />
              <NumberField label="edgeRebalancePct" value={draft.edgeRebalancePct} step="0.01" onChange={(v) => updateNumber("edgeRebalancePct", v)} />
              <NumberField label="minRebalanceIntervalSec" value={draft.minRebalanceIntervalSec} onChange={(v) => updateNumber("minRebalanceIntervalSec", v)} />
              <NumberField label="maxRebalancesPerDay" value={draft.maxRebalancesPerDay} onChange={(v) => updateNumber("maxRebalancesPerDay", v)} />
              <NumberField label="failureCooldownSec" value={draft.failureCooldownSec} onChange={(v) => updateNumber("failureCooldownSec", v)} />

              <NumberField label="slippageBps" value={draft.slippageBps} onChange={(v) => updateNumber("slippageBps", v)} />
              <NumberField label="pollIntervalMs" value={draft.pollIntervalMs} onChange={(v) => updateNumber("pollIntervalMs", v)} />
              <NumberField label="maxDeployUsdc" value={draft.maxDeployUsdc} onChange={(v) => updateNumber("maxDeployUsdc", v)} />
              <NumberField
                label="maxInitialMintUsdc"
                value={draft.maxInitialMintUsdc}
                onChange={(v) => updateNumber("maxInitialMintUsdc", v)}
              />
              <NumberField label="minTopUpUsd" value={draft.minTopUpUsd} onChange={(v) => updateNumber("minTopUpUsd", v)} />

              <NumberField label="reserveMinUsdc" value={draft.reserveMinUsdc} onChange={(v) => updateNumber("reserveMinUsdc", v)} />
              <NumberField label="reservePct (%)" value={draft.reservePct} step="0.1" onChange={(v) => updateNumber("reservePct", v)} />
              <NumberField label="reserveMaxUsdc" value={draft.reserveMaxUsdc} onChange={(v) => updateNumber("reserveMaxUsdc", v)} />

              <SelectField
                label="compoundMode"
                value={draft.compoundMode}
                onChange={(v) => setDraft((p) => (p ? { ...p, compoundMode: v as CompoundMode } : p))}
                options={["on_rebalance", "threshold_harvest"]}
              />
              <NumberField label="harvestThresholdUsd" value={draft.harvestThresholdUsd} onChange={(v) => updateNumber("harvestThresholdUsd", v)} />

              <SelectField
                label="churnProtectionEnabled"
                value={draft.churnProtectionEnabled ? "true" : "false"}
                onChange={(v) => updateBool("churnProtectionEnabled", v === "true")}
                options={["false", "true"]}
              />
              <NumberField
                label="churnMaxCostToFeeRatio (%)"
                value={draft.churnMaxCostToFeeRatio}
                step="0.1"
                onChange={(v) => updateNumber("churnMaxCostToFeeRatio", v)}
              />
            </div>

            <div style={styles.row}>
              <button style={styles.button} onClick={saveSettings} disabled={busy !== ""}>
                Save Settings
              </button>
              <button style={styles.buttonSuccess} onClick={enableTrading} disabled={busy !== "" || draft.tradingEnabled}>
                Enable Trading
              </button>
              <button style={styles.buttonDanger} onClick={emergencyStop} disabled={busy !== "" || draft.killSwitch}>
                Emergency Stop
              </button>
            </div>
          </section>
        )}

        <section style={styles.panel}>
          <h2 style={styles.h2}>Raw Debug</h2>
          <details>
            <summary style={styles.summary}>Show raw /status JSON</summary>
            <pre style={styles.pre}>{JSON.stringify(status, null, 2)}</pre>
          </details>
        </section>
      </main>
    </>
  );
}

function Card({ title, children, fullWidth }: { title: string; children: ReactNode; fullWidth?: boolean }) {
  return (
    <section style={{ ...styles.panel, ...(fullWidth ? styles.fullWidth : undefined) }}>
      <h2 style={styles.h2}>{title}</h2>
      {children}
    </section>
  );
}

function Metric({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div style={styles.statCell}>
      <div style={styles.statLabel}>{label}</div>
      <div style={{ ...styles.statValue, fontFamily: mono ? "monospace" : "inherit" }}>{value}</div>
    </div>
  );
}

function Pill({ label, tone }: { label: string; tone: "good" | "warn" | "bad" | "muted" }) {
  const toneStyle =
    tone === "good"
      ? styles.pillGood
      : tone === "warn"
        ? styles.pillWarn
        : tone === "bad"
          ? styles.pillBad
          : styles.pillMuted;
  return <span style={{ ...styles.pill, ...toneStyle }}>{label}</span>;
}

function NumberField({
  label,
  value,
  onChange,
  step = "1",
}: {
  label: string;
  value: number;
  onChange: (next: string) => void;
  step?: string;
}) {
  return (
    <label style={styles.field}>
      <span>{label}</span>
      <input type="number" step={step} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: string[];
  disabled?: boolean;
}) {
  return (
    <label style={styles.field}>
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}

function SimpleTable({ headers, rows }: { headers: string[]; rows: Array<Array<ReactNode>> }) {
  return (
    <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} style={styles.th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td style={styles.td} colSpan={headers.length}>
                No data
              </td>
            </tr>
          ) : (
            rows.map((r, idx) => (
              <tr key={idx}>
                {r.map((cell, cidx) => (
                  <td key={cidx} style={styles.td}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  main: {
    maxWidth: 1360,
    margin: "0 auto",
    padding: "24px 16px 64px",
    display: "grid",
    gap: 16,
  },
  headerCard: {
    border: "1px solid #d7dce4",
    borderRadius: 14,
    padding: 18,
    background: "#ffffff",
  },
  panel: {
    border: "1px solid #d7dce4",
    borderRadius: 14,
    padding: 18,
    background: "#ffffff",
  },
  fullWidth: {
    gridColumn: "1 / -1",
  },
  cardGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
    gap: 16,
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
    flexWrap: "wrap",
  },
  h2: {
    margin: "0 0 12px",
    fontSize: 20,
  },
  subtle: {
    margin: "8px 0 0",
    color: "#4a5a70",
    fontSize: 14,
  },
  row: {
    marginTop: 12,
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
  },
  button: {
    border: "1px solid #132238",
    background: "#132238",
    color: "#fff",
    borderRadius: 8,
    padding: "8px 14px",
    cursor: "pointer",
    fontWeight: 700,
  },
  buttonSecondary: {
    border: "1px solid #9db3cf",
    background: "#f8fbff",
    color: "#10253f",
    borderRadius: 8,
    padding: "8px 14px",
    cursor: "pointer",
    fontWeight: 700,
  },
  buttonDanger: {
    border: "1px solid #8a1010",
    background: "#b91c1c",
    color: "#fff",
    borderRadius: 8,
    padding: "8px 14px",
    cursor: "pointer",
    fontWeight: 700,
  },
  buttonSuccess: {
    border: "1px solid #0f5132",
    background: "#198754",
    color: "#fff",
    borderRadius: 8,
    padding: "8px 14px",
    cursor: "pointer",
    fontWeight: 700,
  },
  alert: {
    marginTop: 12,
    border: "1px solid",
    borderRadius: 8,
    padding: "8px 10px",
    color: "#203047",
    fontSize: 14,
  },
  alertOk: {
    background: "#e9f9ef",
    borderColor: "#a1ddb4",
  },
  alertErr: {
    background: "#fff1f1",
    borderColor: "#f3b8b8",
  },
  metaGrid: {
    marginTop: 10,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
    gap: 10,
  },
  statCell: {
    border: "1px solid #e5ebf4",
    borderRadius: 10,
    background: "#fbfdff",
    padding: "10px 12px",
  },
  statLabel: {
    fontSize: 12,
    color: "#5b6e8a",
    marginBottom: 4,
  },
  statValue: {
    fontSize: 14,
    fontWeight: 700,
    color: "#10253f",
    wordBreak: "break-word",
  },
  note: {
    marginTop: 10,
    fontSize: 13,
    color: "#42526a",
  },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: 999,
    padding: "2px 9px",
    fontSize: 12,
    fontWeight: 700,
    border: "1px solid transparent",
  },
  pillGood: {
    background: "#e8f8ec",
    color: "#145b2f",
    borderColor: "#9dd8ae",
  },
  pillWarn: {
    background: "#fff7ea",
    color: "#8a4b08",
    borderColor: "#f2c283",
  },
  pillBad: {
    background: "#ffecec",
    color: "#8d1111",
    borderColor: "#f1b1b1",
  },
  pillMuted: {
    background: "#eef2f7",
    color: "#50627c",
    borderColor: "#cfd8e5",
  },
  formGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 10,
  },
  field: {
    display: "grid",
    gap: 6,
    fontSize: 13,
    color: "#2a3c57",
  },
  tableWrap: {
    overflowX: "auto",
    border: "1px solid #e5ebf4",
    borderRadius: 10,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
  },
  th: {
    textAlign: "left",
    padding: "8px 10px",
    background: "#f3f7fc",
    borderBottom: "1px solid #e5ebf4",
    whiteSpace: "nowrap",
  },
  td: {
    padding: "8px 10px",
    borderBottom: "1px solid #eef2f7",
    whiteSpace: "nowrap",
    color: "#1f2f45",
  },
  summary: {
    cursor: "pointer",
    fontWeight: 600,
    color: "#21354f",
  },
  pre: {
    marginTop: 10,
    border: "1px solid #e5ebf4",
    background: "#f7f9fc",
    borderRadius: 10,
    padding: 10,
    fontSize: 12,
    overflowX: "auto",
  },
};
