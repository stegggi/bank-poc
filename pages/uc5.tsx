// pages/uc5.tsx
import { useEffect, useMemo, useState } from "react";
import NavBar from "../components/NavBar";
import { BrowserProvider } from "ethers";
import type { Uc5Config, Uc5Status } from "../lib/uc5/types";
import { buildAdminMessage } from "../lib/uc5/auth";

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function randNonce() {
  // uint64-safe nonce as decimal string: ms + 6 random digits ~ 19 digits < uint64 max
  const r = Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
  return `${Date.now()}${r}`;
}

export default function Uc5Page() {
  const [cfg, setCfg] = useState<Uc5Config | null>(null);
  const [status, setStatus] = useState<Uc5Status | null>(null);

  const [walletAddr, setWalletAddr] = useState<string>("");
  const [isOwner, setIsOwner] = useState<boolean>(false);

  // Admin editable fields
  const [edit, setEdit] = useState<any>(null);

  const [busy, setBusy] = useState<string>("");
  const [msg, setMsg] = useState<string>("");

  // Link signer
  const [signerAddr, setSignerAddr] = useState<string>(""); // bot signer EOA

  useEffect(() => {
    let alive = true;

    async function load() {
      const [c, s] = await Promise.all([
        fetch("/api/uc5/config", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/uc5/status", { cache: "no-store" }).then((r) => r.json()),
      ]);

      if (!alive) return;

      setCfg(c);
      setStatus(s);
      setEdit((prev: any) => prev ?? { ...c });

      // owner detection
      if (walletAddr && c?.ownerAddress) {
        setIsOwner(walletAddr.toLowerCase() === String(c.ownerAddress).toLowerCase());
      } else {
        setIsOwner(false);
      }
    }

    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [walletAddr]);

  const heartbeat = useMemo(() => {
    const t = status?.updatedAt || 0;
    if (!t) return "—";
    const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
    return `${secs}s ago`;
  }, [status?.updatedAt]);

  async function connectWallet() {
    setMsg("");
    try {
      const eth = (window as any).ethereum;
      if (!eth) throw new Error("MetaMask not found in this browser.");

      const provider = new BrowserProvider(eth);
      const accounts = await provider.send("eth_requestAccounts", []);
      const a = accounts?.[0] || "";
      setWalletAddr(a);
    } catch (e: any) {
      setMsg(e?.message || "Failed to connect wallet");
    }
  }

  async function discoverSubaccount() {
    if (!walletAddr) return setMsg("Connect your wallet first.");
    setBusy("discover");
    setMsg("");
    try {
      const r = await fetch(`/api/uc5/ethereal?path=/v1/subaccount&sender=${walletAddr}`, { cache: "no-store" });
      const j = await r.json();
      const first = j?.data?.[0];
      if (!first) throw new Error("No subaccount found for this address on Ethereal.");
      setEdit((p: any) => ({
        ...p,
        subaccountId: first.id,
        subaccountName: first.name,
      }));
      setMsg("Subaccount discovered and filled in (subaccountId + subaccountName).");
    } catch (e: any) {
      setMsg(e?.message || "Discover failed");
    } finally {
      setBusy("");
    }
  }

  async function discoverProduct() {
    setBusy("product");
    setMsg("");
    try {
      const ticker = edit?.ticker || "BTCUSD";
      const r = await fetch(`/api/uc5/ethereal?path=/v1/product&ticker=${encodeURIComponent(ticker)}`, { cache: "no-store" });
      const j = await r.json();
      const first = j?.data?.[0];
      if (!first) throw new Error(`No product found for ticker ${ticker}`);
      setEdit((p: any) => ({ ...p, productId: first.id }));
      setMsg(`Product discovered: ${first.displayTicker || first.ticker} (productId filled).`);
    } catch (e: any) {
      setMsg(e?.message || "Discover product failed");
    } finally {
      setBusy("");
    }
  }

  async function saveConfig() {
    if (!cfg) return;
    if (!walletAddr) return setMsg("Connect your wallet first.");
    if (!isOwner) return setMsg("This wallet is not the owner wallet. Read-only mode.");

    setBusy("save");
    setMsg("");
    try {
      const eth = (window as any).ethereum;
      const provider = new BrowserProvider(eth);
      const signer = await provider.getSigner();

      const nonce = randNonce();
      const issuedAt = nowSec();
      const payload = { ...edit, ownerAddress: cfg.ownerAddress };

      const message = buildAdminMessage({
        action: "SET_CONFIG",
        nonce,
        issuedAt,
        payload,
      });

      const signature = await signer.signMessage(message);

      const r = await fetch("/api/uc5/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: payload,
          auth: { address: walletAddr, signature, nonce, issuedAt },
        }),
      });

      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Save failed");
      setMsg("Saved ✅");
    } catch (e: any) {
      setMsg(e?.message || "Save failed");
    } finally {
      setBusy("");
    }
  }

  async function sendFlatten() {
    if (!walletAddr) return setMsg("Connect your wallet first.");
    if (!isOwner) return setMsg("This wallet is not the owner wallet.");
    setBusy("flatten");
    setMsg("");
    try {
      const eth = (window as any).ethereum;
      const provider = new BrowserProvider(eth);
      const signer = await provider.getSigner();

      const nonce = randNonce();
      const issuedAt = nowSec();
      const payload = { type: "FLATTEN" };

      const message = buildAdminMessage({ action: "CMD_FLATTEN", nonce, issuedAt, payload });
      const signature = await signer.signMessage(message);

      const r = await fetch("/api/uc5/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "FLATTEN",
          auth: { address: walletAddr, signature, nonce, issuedAt },
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Command failed");
      setMsg("Flatten command queued ✅ (bot will close position)");
    } catch (e: any) {
      setMsg(e?.message || "Flatten failed");
    } finally {
      setBusy("");
    }
  }

  async function createLinkSignerRequest() {
    if (!walletAddr) return setMsg("Connect your wallet first.");
    if (!isOwner) return setMsg("This wallet is not the owner wallet.");
    if (!edit?.subaccountId || !edit?.subaccountName) return setMsg("First click: Discover subaccount.");
    if (!signerAddr) return setMsg("Paste the bot signer address first.");

    setBusy("link");
    setMsg("");
    try {
      // fetch ethereal EIP712 domain
      const rpc = await fetch(`/api/uc5/ethereal?path=/v1/rpc/config`, { cache: "no-store" }).then((r) => r.json());
      const domain = rpc?.domain;
      if (!domain) throw new Error("Could not load Ethereal EIP-712 domain.");

      const eth = (window as any).ethereum;
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

      const senderSignature = await (signer as any).signTypedData(domain, types, values);

      const r = await fetch("/api/uc5/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "LINK_SIGNER failed");
      setMsg("Linked signer request queued ✅ (bot will finalize the link with its signature)");
    } catch (e: any) {
      setMsg(e?.message || "Link signer failed");
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <NavBar active={"uc5" as any} />

      <div style={wrap}>
        <div style={panel}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div>
              <h1 style={{ margin: 0, fontSize: 26, letterSpacing: -0.2 }}>UC5 — AI Autopilot Perps Bot</h1>
              <p style={{ margin: "8px 0 0", color: "#555", maxWidth: 900, lineHeight: 1.55 }}>
                Public dashboard is read-only. Owner wallet can change bot settings, pause trading, and flatten the position.
              </p>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {walletAddr ? (
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 12, color: "#666" }}>Connected</div>
                  <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}>
                    {walletAddr.slice(0, 6)}…{walletAddr.slice(-4)}
                    {isOwner ? <span style={{ marginLeft: 8, color: "#111", fontWeight: 700 }}>(owner)</span> : null}
                  </div>
                </div>
              ) : (
                <button onClick={connectWallet} style={btn}>
                  Connect MetaMask
                </button>
              )}
            </div>
          </div>
        </div>

        {/* STATUS */}
        <div style={grid}>
          <div style={card}>
            <div style={cardTitle}>Bot status</div>
            <div style={kvRow}>
              <span style={k}>Heartbeat</span>
              <span style={v}>{heartbeat}</span>
            </div>
            <div style={kvRow}>
              <span style={k}>Alive</span>
              <span style={v}>{status?.bot?.alive ? "✅" : "—"}</span>
            </div>
            <div style={kvRow}>
              <span style={k}>Message</span>
              <span style={v}>{status?.bot?.message || "—"}</span>
            </div>
          </div>

          <div style={card}>
            <div style={cardTitle}>Market</div>
            <div style={kvRow}>
              <span style={k}>Ticker</span>
              <span style={v}>{cfg?.ticker || "—"}</span>
            </div>
            <div style={kvRow}>
              <span style={k}>Price</span>
              <span style={v}>{status?.market?.price != null ? status.market.price.toFixed(2) : "—"}</span>
            </div>
            <div style={kvRow}>
              <span style={k}>Oracle</span>
              <span style={v}>{status?.market?.oraclePrice != null ? status.market.oraclePrice.toFixed(2) : "—"}</span>
            </div>
          </div>

          <div style={card}>
            <div style={cardTitle}>Position</div>
            <div style={kvRow}>
              <span style={k}>Open</span>
              <span style={v}>{status?.position?.open ? "✅" : "No"}</span>
            </div>
            <div style={kvRow}>
              <span style={k}>Side</span>
              <span style={v}>{status?.position?.side || "—"}</span>
            </div>
            <div style={kvRow}>
              <span style={k}>uPnL</span>
              <span style={v}>{status?.position?.unrealizedPnl != null ? status.position.unrealizedPnl.toFixed(2) : "—"}</span>
            </div>
          </div>

          <div style={card}>
            <div style={cardTitle}>Agent</div>
            <div style={kvRow}>
              <span style={k}>Desired</span>
              <span style={v}>{status?.agent?.desired || "—"}</span>
            </div>
            <div style={kvRow}>
              <span style={k}>Confidence</span>
              <span style={v}>{status?.agent?.confidence != null ? status.agent.confidence.toFixed(3) : "—"}</span>
            </div>
            <div style={kvRow}>
              <span style={k}>Reason</span>
              <span style={v}>{status?.agent?.reason || "—"}</span>
            </div>
          </div>
        </div>

        {/* ADMIN */}
        <div style={{ marginTop: 14, ...panel }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Owner controls</h2>
          <p style={{ margin: "8px 0 0", color: "#666", lineHeight: 1.5 }}>
            {isOwner
              ? "You are connected as the owner wallet. Changes here affect the live bot."
              : "Connect the owner wallet to unlock settings. Everyone else stays read-only."}
          </p>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
            <button style={btnSecondary} onClick={discoverSubaccount} disabled={busy !== ""}>
              {busy === "discover" ? "Discovering…" : "Discover subaccount"}
            </button>
            <button style={btnSecondary} onClick={discoverProduct} disabled={busy !== ""}>
              {busy === "product" ? "Discovering…" : "Discover productId"}
            </button>
          </div>

          <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
            <Field label="Trading enabled (bot may trade)" help="If off: bot keeps collecting data but should not enter new trades.">
              <input
                type="checkbox"
                checked={!!edit?.tradingEnabled}
                onChange={(e) => setEdit((p: any) => ({ ...p, tradingEnabled: e.target.checked }))}
                disabled={!isOwner}
              />
            </Field>

            <Field label="Kill switch (pause orders immediately)" help="If on: bot must stop placing orders but keep logging.">
              <input
                type="checkbox"
                checked={!!edit?.killSwitch}
                onChange={(e) => setEdit((p: any) => ({ ...p, killSwitch: e.target.checked }))}
                disabled={!isOwner}
              />
            </Field>

            <Field label="Max leverage" help="Hard cap for the bot when sizing positions.">
              <input
                style={input}
                type="number"
                min={1}
                max={20}
                step={0.5}
                value={edit?.maxLeverage ?? 2}
                onChange={(e) => setEdit((p: any) => ({ ...p, maxLeverage: Number(e.target.value) }))}
                disabled={!isOwner}
              />
            </Field>

            <Field label="Max margin used (USD)" help="Bot won't allocate more margin than this (ex: 100).">
              <input
                style={input}
                type="number"
                min={1}
                step={1}
                value={edit?.maxMarginUsd ?? 100}
                onChange={(e) => setEdit((p: any) => ({ ...p, maxMarginUsd: Number(e.target.value) }))}
                disabled={!isOwner}
              />
            </Field>

            <Field label="Confidence threshold" help="Example 0.60 means: long if p>0.60, short if p<0.40, else do nothing.">
              <input
                style={input}
                type="number"
                min={0.5}
                max={0.95}
                step={0.01}
                value={edit?.confidenceThreshold ?? 0.6}
                onChange={(e) => setEdit((p: any) => ({ ...p, confidenceThreshold: Number(e.target.value) }))}
                disabled={!isOwner}
              />
            </Field>

            <Field label="Min time in market (sec)" help="Bot won't flip/exit before this unless you flatten manually.">
              <input
                style={input}
                type="number"
                min={0}
                step={10}
                value={edit?.minHoldSeconds ?? 60}
                onChange={(e) => setEdit((p: any) => ({ ...p, minHoldSeconds: Number(e.target.value) }))}
                disabled={!isOwner}
              />
            </Field>

            <Field label="Max time in market (sec)" help="After this, bot exits (risk control).">
              <input
                style={input}
                type="number"
                min={30}
                step={30}
                value={edit?.maxHoldSeconds ?? 900}
                onChange={(e) => setEdit((p: any) => ({ ...p, maxHoldSeconds: Number(e.target.value) }))}
                disabled={!isOwner}
              />
            </Field>

            <Field label="Polling interval (sec)" help="How often bot fetches price / updates model. (Start with 3s)">
              <input
                style={input}
                type="number"
                min={1}
                max={60}
                step={1}
                value={edit?.pollIntervalSeconds ?? 3}
                onChange={(e) => setEdit((p: any) => ({ ...p, pollIntervalSeconds: Number(e.target.value) }))}
                disabled={!isOwner}
              />
            </Field>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
            <button style={btn} onClick={saveConfig} disabled={!isOwner || busy !== ""}>
              {busy === "save" ? "Saving…" : "Save settings"}
            </button>

            <button style={btnDanger} onClick={sendFlatten} disabled={!isOwner || busy !== ""}>
              {busy === "flatten" ? "Queueing…" : "Flatten / Liquidate (close position)"}
            </button>
          </div>

          <div style={{ marginTop: 18, borderTop: "1px solid #eee", paddingTop: 14 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Link bot signer (recommended)</h3>
            <p style={{ margin: "8px 0 0", color: "#666", lineHeight: 1.5 }}>
              The bot should NOT use your MetaMask private key. Instead, generate a new EOA key on the VPS (bot signer),
              then link it to your Ethereal subaccount. You only do this once.
            </p>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
              <input
                style={{ ...input, minWidth: 360 }}
                placeholder="Paste bot signer address (0x...)"
                value={signerAddr}
                onChange={(e) => setSignerAddr(e.target.value)}
                disabled={!isOwner}
              />
              <button style={btnSecondary} onClick={createLinkSignerRequest} disabled={!isOwner || busy !== ""}>
                {busy === "link" ? "Signing…" : "Create LINK_SIGNER request"}
              </button>
            </div>
          </div>

          {msg ? (
            <div style={{ marginTop: 12, padding: "10px 12px", border: "1px solid #e6e8eb", borderRadius: 12, background: "#fafafa", color: "#222" }}>
              {msg}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Field(props: { label: string; help?: string; children: any }) {
  return (
    <div style={{ border: "1px solid #e6e8eb", borderRadius: 14, padding: 12, background: "#fff" }}>
      <div style={{ fontWeight: 800, fontSize: 13 }}>{props.label}</div>
      {props.help ? <div style={{ color: "#666", fontSize: 12, marginTop: 4, lineHeight: 1.45 }}>{props.help}</div> : null}
      <div style={{ marginTop: 10 }}>{props.children}</div>
    </div>
  );
}

const wrap: any = { maxWidth: 1150, margin: "0 auto", padding: "18px 16px" };
const panel: any = { border: "1px solid #e6e8eb", background: "#fff", borderRadius: 16, padding: 16, boxShadow: "0 1px 0 rgba(0,0,0,0.02)" };
const grid: any = { marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 };
const card: any = { border: "1px solid #e6e8eb", borderRadius: 16, padding: 14, background: "#fff" };
const cardTitle: any = { fontSize: 13, fontWeight: 900, marginBottom: 10, color: "#111" };
const kvRow: any = { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, padding: "6px 0", borderBottom: "1px dashed #f0f0f0" };
const k: any = { color: "#666" };
const v: any = { color: "#111", fontWeight: 700, maxWidth: 180, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

const input: any = { width: "100%", padding: "10px 10px", borderRadius: 12, border: "1px solid #d8dde3", outline: "none" };
const btn: any = { padding: "10px 12px", borderRadius: 12, border: "1px solid #111", background: "#111", color: "#fff", cursor: "pointer", fontWeight: 800 };
const btnSecondary: any = { padding: "10px 12px", borderRadius: 12, border: "1px solid #d8dde3", background: "#fff", color: "#111", cursor: "pointer", fontWeight: 800 };
const btnDanger: any = { padding: "10px 12px", borderRadius: 12, border: "1px solid #b42318", background: "#b42318", color: "#fff", cursor: "pointer", fontWeight: 900 };
