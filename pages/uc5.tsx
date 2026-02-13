// pages/uc5.tsx
import { useEffect, useMemo, useState } from "react";
import NavBar from "../components/NavBar";
import { BrowserProvider, Wallet, ethers, getAddress } from "ethers";

type BotConfig = {
  enabled: boolean;
  decisionIntervalSec: number; // how often the bot may change direction
  cooldownSec: number; // minimum seconds between trades
  maxLeverage: number; // hard cap set by you (<= exchange max)
  positionUsd: number; // target notional for the position
  signalThreshold: number; // 0..1, higher = fewer trades
  sentimentBias: number; // -1..+1 (manual input for now)
  notes?: string;
};

type JournalEvent =
  | { t: "tick"; ts: number; price: number }
  | { t: "decision"; ts: number; side: "LONG" | "SHORT" | "FLAT"; score: number; reason: string }
  | { t: "trade"; ts: number; side: "BUY" | "SELL"; qty: number; status: string; info?: string };

type Journal = { updatedAt: number; events: JournalEvent[] };

const OWNER = process.env.NEXT_PUBLIC_UC5_OWNER_ADDRESS || "";
const SUBACCOUNT_ID = process.env.NEXT_PUBLIC_UC5_SUBACCOUNT_ID || "";
const SUBACCOUNT_NAME = process.env.NEXT_PUBLIC_UC5_SUBACCOUNT_NAME || "primary";
const TICKER = process.env.NEXT_PUBLIC_UC5_TICKER || "BTCUSD";

const DEFAULT_CONFIG: BotConfig = {
  enabled: false,
  decisionIntervalSec: 30,
  cooldownSec: 45,
  maxLeverage: 2,
  positionUsd: 40, // with 100 USDe, start small
  signalThreshold: 0.18,
  sentimentBias: 0,
  notes: "MVP: momentum + simple online learning. Keep small size.",
};

function shortAddr(a?: string) {
  if (!a) return "";
  return a.slice(0, 6) + "…" + a.slice(-4);
}

function parseSignatureTypeString(sig: string): Array<{ name: string; type: string }> {
  // Example: "address sender,address signer,bytes32 subaccount,uint64 nonce,uint64 signedAt"
  return sig
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const parts = p.split(/\s+/).filter(Boolean);
      return { type: parts[0], name: parts[1] };
    })
    .filter((x) => x.name && x.type);
}

export default function UC5() {
  const [walletAddr, setWalletAddr] = useState<string>("");
  const [chainId, setChainId] = useState<number | null>(null);
  const [status, setStatus] = useState<string>("");

  const [config, setConfig] = useState<BotConfig>(DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);

  const [botSignerPk, setBotSignerPk] = useState<string>(""); // shown once to copy to VPS
  const [botSignerAddr, setBotSignerAddr] = useState<string>("");
  const [revealPk, setRevealPk] = useState(false);
  const [linking, setLinking] = useState(false);

  const [state, setState] = useState<any>(null);
  const [journal, setJournal] = useState<Journal | null>(null);

  const isOwner = useMemo(() => {
    if (!walletAddr || !OWNER) return false;
    try {
      return getAddress(walletAddr) === getAddress(OWNER);
    } catch {
      return false;
    }
  }, [walletAddr]);

  const connect = async () => {
    try {
      const eth = (window as any).ethereum;
      if (!eth) {
        setStatus("MetaMask not found. Install it and refresh.");
        return;
      }
      const provider = new BrowserProvider(eth);
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      const addr = await signer.getAddress();
      const net = await provider.getNetwork();
      setWalletAddr(addr);
      setChainId(Number(net.chainId));
      setStatus("");
    } catch (e: any) {
      setStatus(e?.message || "Failed to connect MetaMask.");
    }
  };

  // Load config + journal on mount
  useEffect(() => {
    (async () => {
      try {
        const c = await fetch("/api/uc5/config", { cache: "no-store" }).then((r) => r.json());
        if (c?.config) setConfig(c.config);
      } catch {}
      try {
        const j = await fetch("/api/uc5/journal", { cache: "no-store" }).then((r) => r.json());
        if (j?.events) setJournal(j);
      } catch {}
    })();
  }, []);

  // Poll state + journal
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const s = await fetch("/api/uc5/state", { cache: "no-store" }).then((r) => r.json());
        setState(s);
      } catch {}
      try {
        const j = await fetch("/api/uc5/journal", { cache: "no-store" }).then((r) => r.json());
        if (j?.events) setJournal(j);
      } catch {}
    }, 4000);
    return () => clearInterval(id);
  }, []);

  const saveConfig = async () => {
    if (!isOwner) {
      setStatus("Connect your OWNER wallet to change settings.");
      return;
    }
    try {
      setSaving(true);
      const eth = (window as any).ethereum;
      const provider = new BrowserProvider(eth);
      const signer = await provider.getSigner();

      const ts = new Date().toISOString();
      const message =
        `UC5_CONFIG_UPDATE\n` +
        `owner=${getAddress(walletAddr)}\n` +
        `subaccountId=${SUBACCOUNT_ID}\n` +
        `ts=${ts}\n` +
        `config=${JSON.stringify(config)}`;

      const signature = await signer.signMessage(message);

      const resp = await fetch("/api/uc5/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature, config }),
      });

      const out = await resp.json();
      if (!resp.ok) throw new Error(out?.error || "Save failed");

      setStatus("Saved ✅");
      setTimeout(() => setStatus(""), 1500);
    } catch (e: any) {
      setStatus(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const generateBotSigner = () => {
    const w = Wallet.createRandom();
    setBotSignerPk(w.privateKey);
    setBotSignerAddr(w.address);
    setRevealPk(false);
    setStatus("Bot signer generated. Link it, then copy the private key to the VPS.");
  };

  const linkSigner = async () => {
    if (!isOwner) {
      setStatus("Connect your OWNER wallet to link a signer.");
      return;
    }
    if (!botSignerPk || !botSignerAddr) {
      setStatus("Generate a bot signer first.");
      return;
    }
    setLinking(true);
    try {
      // 1) fetch rpc config (domain + signatureTypes)
      const rpc = await fetch("/api/uc5/rpc-config", { cache: "no-store" }).then((r) => r.json());
      const domain = rpc?.domain;
      const sigTypes = rpc?.signatureTypes;
      if (!domain || !sigTypes?.LinkSigner) throw new Error("Missing rpc config (domain/signatureTypes).");

      const types = { LinkSigner: parseSignatureTypeString(sigTypes.LinkSigner) };

      // 2) build message
      const subaccountBytes32 = ethers.encodeBytes32String(SUBACCOUNT_NAME);

      // nonce should be a ns-ish uint64; keep it < 2^64
      const nonce =
        BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));

      const signedAt = Math.floor(Date.now() / 1000);

      const message = {
        sender: getAddress(walletAddr),
        signer: getAddress(botSignerAddr),
        subaccount: subaccountBytes32,
        nonce,
        signedAt,
      };

      // 3) signatures: sender (MetaMask) + signer (bot key)
      const eth = (window as any).ethereum;
      const provider = new BrowserProvider(eth);
      const senderSigner = await provider.getSigner();

      const senderSig = await senderSigner.signTypedData(domain, types, message);

      const botWallet = new Wallet(botSignerPk);
      const signerSig = await botWallet.signTypedData(domain, types, message);

      // 4) submit link request
      const resp = await fetch("/api/uc5/link-signer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subaccountId: SUBACCOUNT_ID,
          sender: message.sender,
          signer: message.signer,
          subaccount: message.subaccount,
          nonce: nonce.toString(),
          signedAt: message.signedAt,
          signature: senderSig,
          signerSignature: signerSig,
        }),
      });

      const out = await resp.json();
      if (!resp.ok) throw new Error(out?.error || "Link signer failed");

      setStatus("Signer linked ✅ You can now run the bot on the VPS.");
    } catch (e: any) {
      setStatus(e?.message || "Link signer failed");
    } finally {
      setLinking(false);
    }
  };

  const lastEvents = useMemo(() => {
    const ev = journal?.events || [];
    return ev.slice(-12).reverse();
  }, [journal]);

  return (
    <div style={{ background: "#fff", minHeight: "100vh" }}>
      <NavBar active="uc5" />

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "22px 16px 60px" }}>
        <h1 style={{ fontSize: 28, margin: 0, letterSpacing: -0.4 }}>UC5: AI Perps Trading Agent</h1>
        <p style={{ marginTop: 8, color: "rgba(0,0,0,0.65)", lineHeight: 1.5 }}>
          Public dashboard is read-only. If you connect the owner wallet, you can update bot settings and link a signer.
          Ethereal supports linked signers, which can trade but cannot withdraw.
        </p>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 14 }}>
          <button onClick={connect} style={btn()}>
            {walletAddr ? `Connected: ${shortAddr(walletAddr)}` : "Connect MetaMask"}
          </button>
          <div style={chip()}>
            Owner: <b style={{ marginLeft: 6 }}>{OWNER ? shortAddr(OWNER) : "missing env"}</b>
          </div>
          <div style={chip()}>
            SubaccountId: <b style={{ marginLeft: 6 }}>{SUBACCOUNT_ID ? SUBACCOUNT_ID.slice(0, 8) + "…" : "missing env"}</b>
          </div>
          <div style={chip()}>
            Ticker: <b style={{ marginLeft: 6 }}>{TICKER}</b>
          </div>
          <div style={chip()}>
            Chain (wallet): <b style={{ marginLeft: 6 }}>{chainId ?? "—"}</b>
          </div>
        </div>

        {status && (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 12, background: "rgba(0,0,0,0.05)" }}>
            {status}
          </div>
        )}

        {/* LIVE STATE */}
        <div style={card()}>
          <h2 style={h2()}>Live State</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={mini()}>
              <div style={lbl()}>Mid / Oracle</div>
              <div style={val()}>{state?.market?.oraclePrice ? Number(state.market.oraclePrice).toFixed(2) : "—"}</div>
              <div style={sub()}>
                bid {state?.market?.bestBidPrice ?? "—"} | ask {state?.market?.bestAskPrice ?? "—"}
              </div>
            </div>
            <div style={mini()}>
              <div style={lbl()}>Points (owner)</div>
              <div style={val()}>{state?.points?.totalPoints ?? "—"}</div>
              <div style={sub()}>{state?.points?.season ?? "—"}</div>
            </div>
          </div>

          <div style={{ marginTop: 12, color: "rgba(0,0,0,0.65)", fontSize: 13, lineHeight: 1.5 }}>
            {"Market prices update about every second on Ethereal. :contentReference[oaicite:5]{index=5}"}
            {"Points programs are season-based; you can verify points after the bot trades by checking your points summary. :contentReference[oaicite:6]{index=6}"}
          </div>
        </div>

        {/* SIGNER */}
        <div style={card()}>
          <h2 style={h2()}>Step 1: Create & Link a Bot Signer (Required)</h2>
          <p style={p()}>
            The bot uses a <b>linked signer</b>. This key can place trades for your subaccount, but it <b>cannot withdraw funds</b>. {" :contentReference[oaicite:7]{index=7}"}
          </p>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button onClick={generateBotSigner} style={btn()}>
              Generate bot signer
            </button>
            <button onClick={linkSigner} style={btnPrimary()} disabled={linking || !isOwner}>
              {linking ? "Linking…" : "Link signer on Ethereal"}
            </button>
          </div>

          {botSignerAddr && (
            <div style={{ marginTop: 12 }}>
              <div style={chip()}>
                Bot signer address: <b style={{ marginLeft: 6 }}>{botSignerAddr}</b>
              </div>

              <div style={{ marginTop: 10, padding: 12, borderRadius: 12, border: "1px solid rgba(0,0,0,0.08)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <div>
                    <div style={lbl()}>Bot signer private key (copy to VPS .env)</div>
                    <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", marginTop: 8 }}>
                      {revealPk ? botSignerPk : "••••••••••••••••••••••••••••••••••••••••"}
                    </div>
                  </div>
                  <button onClick={() => setRevealPk((x) => !x)} style={btn()}>
                    {revealPk ? "Hide" : "Reveal"}
                  </button>
                </div>
                <div style={sub()}><b>Important:</b> anyone with this key can trade your funds. Keep it secret.</div>
              </div>
            </div>
          )}
        </div>

        {/* CONFIG */}
        <div style={card()}>
          <h2 style={h2()}>Step 2: Bot Settings (Owner only)</h2>
          {!isOwner && (
            <div style={{ marginBottom: 10, padding: 10, borderRadius: 12, background: "rgba(255, 193, 7, 0.15)" }}>
              Connect the <b>owner wallet</b> to edit settings.
            </div>
          )}

          <div style={grid()}>
            <Field label="Enabled (bot trades if true)">
              <input
                type="checkbox"
                checked={config.enabled}
                disabled={!isOwner}
                onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
              />
            </Field>

            <Field label="Decision interval (sec)">
              <input
                type="number"
                value={config.decisionIntervalSec}
                disabled={!isOwner}
                onChange={(e) => setConfig({ ...config, decisionIntervalSec: Number(e.target.value || "0") })}
                style={input()}
                min={5}
              />
            </Field>

            <Field label="Cooldown between trades (sec)">
              <input
                type="number"
                value={config.cooldownSec}
                disabled={!isOwner}
                onChange={(e) => setConfig({ ...config, cooldownSec: Number(e.target.value || "0") })}
                style={input()}
                min={0}
              />
            </Field>

            <Field label="Max leverage (your cap)">
              <input
                type="number"
                value={config.maxLeverage}
                disabled={!isOwner}
                onChange={(e) => setConfig({ ...config, maxLeverage: Number(e.target.value || "0") })}
                style={input()}
                min={1}
                max={20}
              />
            </Field>

            <Field label="Target position size (USD notional)">
              <input
                type="number"
                value={config.positionUsd}
                disabled={!isOwner}
                onChange={(e) => setConfig({ ...config, positionUsd: Number(e.target.value || "0") })}
                style={input()}
                min={1}
              />
            </Field>

            <Field label="Signal threshold (0..1)">
              <input
                type="number"
                value={config.signalThreshold}
                disabled={!isOwner}
                onChange={(e) => setConfig({ ...config, signalThreshold: Number(e.target.value || "0") })}
                style={input()}
                min={0}
                max={1}
                step={0.01}
              />
            </Field>

            <Field label="Sentiment bias (-1..+1)">
              <input
                type="number"
                value={config.sentimentBias}
                disabled={!isOwner}
                onChange={(e) => setConfig({ ...config, sentimentBias: Number(e.target.value || "0") })}
                style={input()}
                min={-1}
                max={1}
                step={0.05}
              />
            </Field>

            <Field label="Notes">
              <input
                type="text"
                value={config.notes || ""}
                disabled={!isOwner}
                onChange={(e) => setConfig({ ...config, notes: e.target.value })}
                style={input()}
              />
            </Field>
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button onClick={saveConfig} style={btnPrimary()} disabled={!isOwner || saving}>
              {saving ? "Saving…" : "Save settings"}
            </button>
            <div style={{ color: "rgba(0,0,0,0.6)", fontSize: 13, lineHeight: 1.4 }}>
              The bot reads these settings every few seconds from your app (stored in Vercel Blob).
            </div>
          </div>
        </div>

        {/* JOURNAL */}
        <div style={card()}>
          <h2 style={h2()}>What the bot is doing (public journal)</h2>
          <div style={sub()}>Last update: {journal?.updatedAt ? new Date(journal.updatedAt).toLocaleString() : "—"}</div>

          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            {lastEvents.map((e, idx) => (
              <div
                key={idx}
                style={{
                  padding: 12,
                  borderRadius: 12,
                  border: "1px solid rgba(0,0,0,0.08)",
                  background: "rgba(255,255,255,0.9)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <b style={{ letterSpacing: -0.2 }}>{e.t.toUpperCase()}</b>
                  <span style={{ color: "rgba(0,0,0,0.55)", fontSize: 12 }}>
                    {new Date(e.ts).toLocaleTimeString()}
                  </span>
                </div>
                <div style={{ marginTop: 6, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                  {JSON.stringify(e)}
                </div>
              </div>
            ))}
            {!lastEvents.length && <div style={sub()}>No events yet. Once the VPS bot runs, it will publish here.</div>}
          </div>
        </div>

        <div style={{ color: "rgba(0,0,0,0.55)", fontSize: 13, lineHeight: 1.6 }}>
          <b>Reality check:</b> “AI trading” is not guaranteed profit. This MVP focuses on safe permissions (linked signer),
          repeatable data collection (SQLite), and a transparent journal.
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: any }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ fontSize: 12, fontWeight: 850, color: "rgba(0,0,0,0.7)" }}>{label}</div>
      {children}
    </div>
  );
}

function card() {
  return {
    marginTop: 16,
    padding: 16,
    borderRadius: 16,
    border: "1px solid rgba(0,0,0,0.08)",
    boxShadow: "0 16px 40px rgba(0,0,0,0.06)",
    background: "rgba(250,250,250,0.75)",
  } as const;
}

function h2() {
  return { margin: 0, fontSize: 18, letterSpacing: -0.2 } as const;
}

function p() {
  return { marginTop: 8, marginBottom: 0, color: "rgba(0,0,0,0.65)", lineHeight: 1.5 } as const;
}

function grid() {
  return { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 12 } as const;
}

function btn() {
  return {
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.12)",
    background: "rgba(255,255,255,0.95)",
    cursor: "pointer",
    fontWeight: 850,
  } as const;
}

function btnPrimary() {
  return {
    ...btn(),
    border: "1px solid rgba(0,0,0,0.2)",
    background: "#0b0b0c",
    color: "#fff",
  } as const;
}

function chip() {
  return {
    padding: "10px 12px",
    borderRadius: 999,
    border: "1px solid rgba(0,0,0,0.10)",
    background: "rgba(255,255,255,0.85)",
    fontSize: 13,
  } as const;
}

function mini() {
  return {
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(0,0,0,0.08)",
    background: "rgba(255,255,255,0.85)",
  } as const;
}

function lbl() {
  return { fontSize: 12, fontWeight: 900, color: "rgba(0,0,0,0.65)" } as const;
}

function val() {
  return { fontSize: 20, fontWeight: 950, marginTop: 6 } as const;
}

function sub() {
  return { fontSize: 12, color: "rgba(0,0,0,0.55)", marginTop: 6, lineHeight: 1.4 } as const;
}

function input() {
  return {
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.12)",
    outline: "none",
  } as const;
}
