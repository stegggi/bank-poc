import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
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

type Uc6Settings = {
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
  keepUsdcReserve: number;
};

type NumericSettingKey = Exclude<keyof Uc6Settings, "tradingEnabled" | "killSwitch" | "venue">;

type Uc6Status = {
  ok?: boolean;
  ts?: string;
  account?: string;
  tradingEnabled?: boolean;
  killSwitch?: boolean;
  settings?: Partial<Uc6Settings>;
  market?: {
    primary?: {
      venue?: string;
      pool?: string;
      tick?: number;
      priceUsdcPerWeth?: number;
      updatedAt?: string;
    };
    fallback?: {
      venue?: string;
      pool?: string;
      tick?: number;
      priceUsdcPerWeth?: number;
      updatedAt?: string;
    };
  };
  position?: {
    tokenId?: string | number | null;
    tickLower?: number | null;
    tickUpper?: number | null;
    centerTick?: number | null;
    liquidity?: string | number | null;
    inRange?: boolean | null;
  };
  counters?: {
    dayKey?: string;
    rebalancesToday?: number;
    lastRebalanceAt?: string | null;
    canRebalanceNow?: boolean;
    reason?: string;
  };
  lastDecision?: unknown;
  lastError?: string | null;
};

function defaultSettings(): Uc6Settings {
  return {
    tradingEnabled: true,
    killSwitch: false,
    venue: "slipstream",
    bandHalfBps: 100,
    edgeRebalancePct: 0.85,
    minRebalanceIntervalSec: 300,
    maxRebalancesPerDay: 20,
    slippageBps: 30,
    pollIntervalMs: 2000,
    maxDeployUsdc: 50_000,
    keepUsdcReserve: 25,
  };
}

function coerceSettings(raw: Partial<Uc6Settings> | undefined): Uc6Settings {
  const defaults = defaultSettings();
  const n = (v: unknown, fallback: number) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : fallback;
  };

  const venue = raw?.venue === "uniswapv3" ? "uniswapv3" : "slipstream";
  return {
    tradingEnabled: raw?.tradingEnabled ?? defaults.tradingEnabled,
    killSwitch: raw?.killSwitch ?? defaults.killSwitch,
    venue,
    bandHalfBps: n(raw?.bandHalfBps, defaults.bandHalfBps),
    edgeRebalancePct: n(raw?.edgeRebalancePct, defaults.edgeRebalancePct),
    minRebalanceIntervalSec: n(raw?.minRebalanceIntervalSec, defaults.minRebalanceIntervalSec),
    maxRebalancesPerDay: n(raw?.maxRebalancesPerDay, defaults.maxRebalancesPerDay),
    slippageBps: n(raw?.slippageBps, defaults.slippageBps),
    pollIntervalMs: n(raw?.pollIntervalMs, defaults.pollIntervalMs),
    maxDeployUsdc: n(raw?.maxDeployUsdc, defaults.maxDeployUsdc),
    keepUsdcReserve: n(raw?.keepUsdcReserve, defaults.keepUsdcReserve),
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

function shortAddr(addr: string): string {
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

function getEthereum(): EthereumProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { ethereum?: EthereumProvider }).ethereum;
}

export default function Uc6Page() {
  const [status, setStatus] = useState<Uc6Status | null>(null);
  const [draft, setDraft] = useState<Uc6Settings | null>(null);
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
    setDraft((prev) => prev ?? coerceSettings(next.settings));
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

  const saveSettings = useCallback(async () => {
    if (!draft) return;
    setError("");
    setNotice("");
    if (!walletAddress) {
      setError("Connect MetaMask first.");
      return;
    }
    if (!isOwner) {
      setError("Only the configured owner wallet can update UC6 settings.");
      return;
    }
    const eth = getEthereum();
    if (!eth) {
      setError("MetaMask is unavailable.");
      return;
    }

    setBusy("save");
    try {
      const payload = draft.killSwitch ? { ...draft, tradingEnabled: false } : { ...draft };
      if (payload.killSwitch && payload.tradingEnabled) {
        payload.tradingEnabled = false;
      }
      const challenge = await fetchJson<{ ok: true; message: string; expiresAt: string }>("/api/uc6/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address: walletAddress,
          action: "update_settings",
          payload,
        }),
      });

      const provider = new BrowserProvider(eth);
      const signer = await provider.getSigner();
      const signature = await signer.signMessage(challenge.message);

      const out = await fetchJson<{ ok?: boolean; settings?: Partial<Uc6Settings> }>("/api/uc6/owner/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: challenge.message,
          signature,
          payload,
        }),
      });

      if (out.settings) {
        setDraft(coerceSettings(out.settings));
      }
      setNotice(`Settings updated. Challenge expired at ${challenge.expiresAt}.`);
      await refreshStatus();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update UC6 settings.");
    } finally {
      setBusy("");
    }
  }, [draft, isOwner, refreshStatus, walletAddress]);

  const emergencyStop = useCallback(async () => {
    if (!draft) return;
    setError("");
    setNotice("");
    if (!walletAddress) {
      setError("Connect MetaMask first.");
      return;
    }
    if (!isOwner) {
      setError("Only the configured owner wallet can update UC6 settings.");
      return;
    }
    const eth = getEthereum();
    if (!eth) {
      setError("MetaMask is unavailable.");
      return;
    }

    setBusy("emergency-stop");
    try {
      const payload: Uc6Settings = {
        ...draft,
        tradingEnabled: false,
        killSwitch: true,
      };
      const challenge = await fetchJson<{ ok: true; message: string; expiresAt: string }>("/api/uc6/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address: walletAddress,
          action: "update_settings",
          payload,
        }),
      });

      const provider = new BrowserProvider(eth);
      const signer = await provider.getSigner();
      const signature = await signer.signMessage(challenge.message);

      const out = await fetchJson<{ ok?: boolean; settings?: Partial<Uc6Settings> }>("/api/uc6/owner/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: challenge.message,
          signature,
          payload,
        }),
      });

      if (out.settings) {
        setDraft(coerceSettings(out.settings));
      }
      setNotice(`Emergency stop activated. Challenge expired at ${challenge.expiresAt}.`);
      await refreshStatus();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to activate emergency stop.");
    } finally {
      setBusy("");
    }
  }, [draft, isOwner, refreshStatus, walletAddress]);

  const updateNumber = useCallback((key: NumericSettingKey, value: string) => {
    const num = Number(value);
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        [key]: Number.isFinite(num) ? num : 0,
      };
    });
  }, []);

  return (
    <>
      <NavBar active={"uc6" as never} />
      <main style={styles.main}>
        <section style={styles.headerCard}>
          <h1 style={{ margin: 0, fontSize: 30 }}>UC6: LP Bot Dashboard</h1>
          <p style={styles.subtle}>
            Base mainnet, Slipstream primary venue with Uniswap v3 fallback monitoring. Owner controls require MetaMask signature.
          </p>
          <div style={styles.row}>
            <button style={styles.button} onClick={connectWallet} disabled={busy !== "" || !hasMetaMask}>
              {walletAddress ? "Reconnect MetaMask" : "Connect MetaMask"}
            </button>
            <button style={styles.buttonSecondary} onClick={switchToBase} disabled={busy !== "" || !walletAddress || isBase}>
              Switch To Base
            </button>
          </div>

          <div style={styles.metaGrid}>
            <StatusCell label="MetaMask" value={hasMetaMask ? "Detected" : "Not found"} />
            <StatusCell label="Wallet" value={walletAddress ? shortAddr(walletAddress) : "Not connected"} />
            <StatusCell label="Owner wallet" value={OWNER_ADDRESS ? shortAddr(OWNER_ADDRESS) : "Missing NEXT_PUBLIC_UC6_OWNER_ADDRESS"} />
            <StatusCell label="Chain" value={walletChain ? `${walletChain} (${isBase ? "Base" : "Not Base"})` : "Unknown"} />
            <StatusCell label="Chain Id" value={String(BASE_CHAIN_ID_DEC)} />
            <StatusCell label="Owner session" value={isOwner ? "Authorized" : "Read-only"} />
          </div>
          {!!notice && <p style={{ ...styles.alert, background: "#e9f9ef", borderColor: "#a1ddb4" }}>{notice}</p>}
          {!!error && <p style={{ ...styles.alert, background: "#fff1f1", borderColor: "#f3b8b8" }}>{error}</p>}
        </section>

        <section style={styles.panel}>
          <h2 style={styles.h2}>Live Bot Status</h2>
          <div style={styles.metaGrid}>
            <StatusCell label="Bot account" value={status?.account || "—"} mono />
            <StatusCell label="Trading enabled" value={String(status?.tradingEnabled ?? status?.settings?.tradingEnabled ?? false)} />
            <StatusCell label="Kill switch" value={String(status?.killSwitch ?? status?.settings?.killSwitch ?? false)} />
            <StatusCell label="Primary venue" value={status?.market?.primary?.venue || status?.settings?.venue || "—"} />
            <StatusCell label="Primary tick" value={String(status?.market?.primary?.tick ?? "—")} />
            <StatusCell label="Primary price" value={fmtNum(status?.market?.primary?.priceUsdcPerWeth, 4)} />
            <StatusCell label="Fallback tick" value={String(status?.market?.fallback?.tick ?? "—")} />
            <StatusCell label="Position tokenId" value={String(status?.position?.tokenId ?? "—")} />
            <StatusCell label="Position in range" value={String(status?.position?.inRange ?? "—")} />
            <StatusCell label="Rebalances today" value={String(status?.counters?.rebalancesToday ?? 0)} />
            <StatusCell label="Can rebalance" value={String(status?.counters?.canRebalanceNow ?? false)} />
            <StatusCell label="Rebalance gate" value={status?.counters?.reason || "—"} />
            <StatusCell label="Last update" value={status?.ts || "—"} />
          </div>
          <pre style={styles.pre}>{JSON.stringify(status?.lastDecision ?? { info: "No decision yet" }, null, 2)}</pre>
          {!!status?.lastError && (
            <p style={{ ...styles.alert, background: "#fff1f1", borderColor: "#f3b8b8" }}>{status.lastError}</p>
          )}
        </section>

        {isOwner && draft && (
          <section style={styles.panel}>
            <h2 style={styles.h2}>Owner Controls</h2>
            <div style={styles.formGrid}>
              <label style={styles.field}>
                <span>killSwitch</span>
                <select
                  value={draft.killSwitch ? "true" : "false"}
                  onChange={(e) =>
                    setDraft((prev) =>
                      prev
                        ? {
                            ...prev,
                            killSwitch: e.target.value === "true",
                            tradingEnabled: e.target.value === "true" ? false : prev.tradingEnabled,
                          }
                        : prev
                    )
                  }
                >
                  <option value="false">false</option>
                  <option value="true">true</option>
                </select>
              </label>

              <label style={styles.field}>
                <span>tradingEnabled</span>
                <select
                  value={draft.tradingEnabled ? "true" : "false"}
                  disabled={draft.killSwitch}
                  onChange={(e) =>
                    setDraft((prev) => (prev ? { ...prev, tradingEnabled: e.target.value === "true" } : prev))
                  }
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              </label>

              <label style={styles.field}>
                <span>venue</span>
                <select
                  value={draft.venue}
                  onChange={(e) =>
                    setDraft((prev) =>
                      prev
                        ? {
                            ...prev,
                            venue: e.target.value === "uniswapv3" ? "uniswapv3" : "slipstream",
                          }
                        : prev
                    )
                  }
                >
                  <option value="slipstream">slipstream</option>
                  <option value="uniswapv3">uniswapv3</option>
                </select>
              </label>

              <NumberField label="bandHalfBps" value={draft.bandHalfBps} onChange={(v) => updateNumber("bandHalfBps", v)} />
              <NumberField
                label="edgeRebalancePct"
                value={draft.edgeRebalancePct}
                step="0.01"
                onChange={(v) => updateNumber("edgeRebalancePct", v)}
              />
              <NumberField
                label="minRebalanceIntervalSec"
                value={draft.minRebalanceIntervalSec}
                onChange={(v) => updateNumber("minRebalanceIntervalSec", v)}
              />
              <NumberField
                label="maxRebalancesPerDay"
                value={draft.maxRebalancesPerDay}
                onChange={(v) => updateNumber("maxRebalancesPerDay", v)}
              />
              <NumberField label="slippageBps" value={draft.slippageBps} onChange={(v) => updateNumber("slippageBps", v)} />
              <NumberField label="pollIntervalMs" value={draft.pollIntervalMs} onChange={(v) => updateNumber("pollIntervalMs", v)} />
              <NumberField label="maxDeployUsdc" value={draft.maxDeployUsdc} onChange={(v) => updateNumber("maxDeployUsdc", v)} />
              <NumberField
                label="keepUsdcReserve"
                value={draft.keepUsdcReserve}
                onChange={(v) => updateNumber("keepUsdcReserve", v)}
              />
            </div>
            {draft.killSwitch && (
              <p style={styles.killSwitchNotice}>
                Kill switch is active. Trading is forcibly blocked in bot tx paths until intentionally reset.
              </p>
            )}
            <div style={styles.row}>
              <button style={styles.button} onClick={saveSettings} disabled={busy !== ""}>
                Save Settings
              </button>
              <button style={styles.buttonDanger} onClick={emergencyStop} disabled={busy !== "" || draft.killSwitch}>
                Emergency Stop
              </button>
            </div>
          </section>
        )}
      </main>
    </>
  );
}

function StatusCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={styles.statCell}>
      <div style={styles.statLabel}>{label}</div>
      <div style={{ ...styles.statValue, fontFamily: mono ? "monospace" : "inherit" }}>{value}</div>
    </div>
  );
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

const styles: Record<string, CSSProperties> = {
  main: {
    maxWidth: 1120,
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
  h2: {
    margin: "0 0 12px",
    fontSize: 22,
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
  alert: {
    marginTop: 12,
    border: "1px solid",
    borderRadius: 8,
    padding: "8px 10px",
    color: "#203047",
    fontSize: 14,
  },
  metaGrid: {
    marginTop: 14,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
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
    wordBreak: "break-all",
  },
  pre: {
    marginTop: 12,
    border: "1px solid #e5ebf4",
    background: "#f7f9fc",
    borderRadius: 10,
    padding: 10,
    fontSize: 12,
    overflowX: "auto",
  },
  formGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
    gap: 10,
  },
  field: {
    display: "grid",
    gap: 6,
    fontSize: 13,
    color: "#2a3c57",
  },
  killSwitchNotice: {
    marginTop: 12,
    border: "1px solid #f2c69d",
    borderRadius: 8,
    padding: "8px 10px",
    fontSize: 13,
    color: "#6b3906",
    background: "#fff7ed",
  },
};
