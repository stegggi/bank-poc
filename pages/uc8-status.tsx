// pages/uc8-status.tsx
//
// UC8 · connection-status diagnostic — "connection OK" screen for the Tempo Testnet (Moderato)
// handshake. Linked from the main UC8 demo (/uc8) via "Status ↗".
// Task 1 origin —
// Reads from /api/tempo/handshake and shows: connected, chain id, block height,
// the funded dev address, and its pathUSD (TIP-20) balance. The native "USD"
// balance is a placeholder and is intentionally NOT used as a health check.
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import NavBar from "../shared/components/NavBar";
import type { HandshakeResult } from "../shared/lib/tempo";

const ACCENT = "var(--a-22d3a8)"; // Tempo / stablecoin green

function groupThousands(s: string): string {
  const [intPart, frac] = s.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

export default function Uc8() {
  const [data, setData] = useState<HandshakeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [funding, setFunding] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (fund: boolean) => {
    if (fund) setFunding(true);
    else setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/tempo/handshake${fund ? "?fund=1" : ""}`);
      const json = (await res.json()) as HandshakeResult;
      setData(json);
      if (json.error) setErr(json.error);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setFunding(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const connected = !!data?.connected;
  const busy = loading || funding;

  return (
    <>
      <NavBar active="uc8" />
      <div style={pageRoot}>
        <div style={inner}>
          <div style={eyebrow}>UC8 · Tempo Testnet (Moderato)</div>
          <h1 style={h1}>Connection handshake</h1>
          <p style={subtitle}>
            A boring, verifiable connection to the Tempo stablecoin-payments L1 (chain
            ID 42431). Health is the pathUSD balance — the native &ldquo;USD&rdquo;
            balance is a placeholder and is ignored.
          </p>

          {/* Status pill */}
          <div
            style={{
              ...statusPill,
              borderColor: connected ? "rgba(34,211,168,0.4)" : "rgba(239,68,68,0.4)",
              background: connected ? "rgba(34,211,168,0.08)" : "rgba(239,68,68,0.08)",
              color: connected ? ACCENT : "var(--a-f87171)",
            }}
          >
            <span style={{ fontSize: 18, lineHeight: 1 }}>{connected ? "●" : "✕"}</span>
            {loading
              ? "Connecting…"
              : connected
              ? "connected = true"
              : "connected = false"}
          </div>

          {/* Stat grid */}
          <div style={card}>
            <Stat label="Chain ID" value={data ? String(data.chainId) : "—"} />
            <Stat
              label="Block height"
              value={data && data.blockHeight !== "0" ? groupThousands(data.blockHeight) : "—"}
              hint="must be > 0 and increasing"
            />
            <Stat
              label="Dev address (funded)"
              value={data?.address ?? "—"}
              mono
              link={
                data?.address
                  ? `${data.explorerUrl}/address/${data.address}`
                  : undefined
              }
            />
            <Stat
              label="pathUSD balance"
              value={
                data?.pathUSD
                  ? `${groupThousands(data.pathUSD.formatted)} ${data.pathUSD.symbol}`
                  : "—"
              }
              hint={
                data?.pathUSD
                  ? `${groupThousands(data.pathUSD.raw)} base units · ${data.pathUSD.decimals} decimals`
                  : "fund the address to populate"
              }
              accent
            />
          </div>

          {/* Actions */}
          <div style={actions}>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={busy}
              style={{ ...btn, ...(busy ? btnDisabled : null), background: ACCENT, color: "#04130d" }}
            >
              {funding ? "Funding from faucet…" : "Fund dev address (faucet)"}
            </button>
            <button
              type="button"
              onClick={() => void load(false)}
              disabled={busy}
              style={{ ...btn, ...btnGhost, ...(busy ? btnDisabled : null) }}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {err && (
            <div style={errorBox}>
              <strong>Error:</strong> {err}
            </div>
          )}

          {/* Footnote */}
          <div style={note}>
            <div style={noteRow}>
              <span style={noteKey}>RPC</span>
              <code style={codeStyle}>{data?.rpcUrl ?? "https://rpc.moderato.tempo.xyz"}</code>
            </div>
            <div style={noteRow}>
              <span style={noteKey}>Explorer</span>
              <a
                href={data?.explorerUrl ?? "https://explore.moderato.tempo.xyz"}
                target="_blank"
                rel="noreferrer"
                style={linkStyle}
              >
                {data?.explorerUrl ?? "https://explore.moderato.tempo.xyz"}
              </a>
            </div>
            <p style={noteText}>
              No native gas token: fees on Tempo are paid in stablecoins. Any native
              balance a wallet shows is a meaningless placeholder — this screen uses the
              pathUSD (TIP-20) balance as the real health check.
            </p>
          </div>
        </div>
      </div>

      <style jsx global>{`
        html,
        body {
          background: var(--bg);
          margin: 0;
          padding: 0;
          -webkit-font-smoothing: antialiased;
        }
      `}</style>
    </>
  );
}

function Stat({
  label,
  value,
  hint,
  mono,
  link,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
  link?: string;
  accent?: boolean;
}) {
  return (
    <div style={statBox}>
      <div style={statLabel}>{label}</div>
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          style={{ ...statValue, ...(mono ? monoFont : null), color: ACCENT, textDecoration: "none", wordBreak: "break-all" }}
        >
          {value}
        </a>
      ) : (
        <div
          style={{
            ...statValue,
            ...(mono ? monoFont : null),
            ...(accent ? { color: ACCENT } : null),
            wordBreak: mono ? "break-all" : "normal",
          }}
        >
          {value}
        </div>
      )}
      {hint && <div style={statHint}>{hint}</div>}
    </div>
  );
}

/* ── Styles ── */
const pageRoot: CSSProperties = {
  background: "var(--bg)",
  minHeight: "100vh",
  color: "var(--text)",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
};
const inner: CSSProperties = { maxWidth: 760, margin: "0 auto", padding: "48px 24px 80px" };
const eyebrow: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color: ACCENT,
  marginBottom: 12,
};
const h1: CSSProperties = { margin: 0, fontSize: "clamp(28px, 5vw, 40px)", fontWeight: 900, color: "var(--heading)", letterSpacing: "-0.02em" };
const subtitle: CSSProperties = { margin: "16px 0 28px", fontSize: 15, lineHeight: 1.65, color: "rgba(var(--ink),0.6)", maxWidth: 620 };
const statusPill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 18px",
  borderRadius: 999,
  border: "1px solid",
  fontSize: 15,
  fontWeight: 700,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
  marginBottom: 24,
};
const card: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: 1,
  background: "rgba(var(--ink),0.08)",
  border: "1px solid rgba(var(--ink),0.08)",
  borderRadius: 16,
  overflow: "hidden",
};
const statBox: CSSProperties = { background: "var(--bg)", padding: "20px 22px" };
const statLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "rgba(var(--ink),0.4)",
  marginBottom: 10,
};
const statValue: CSSProperties = { fontSize: 20, fontWeight: 800, color: "var(--heading)", lineHeight: 1.25 };
const statHint: CSSProperties = { marginTop: 8, fontSize: 12, color: "rgba(var(--ink),0.4)" };
const monoFont: CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace", fontSize: 14, fontWeight: 600 };
const actions: CSSProperties = { display: "flex", gap: 12, marginTop: 24, flexWrap: "wrap" };
const btn: CSSProperties = {
  padding: "11px 20px",
  borderRadius: 10,
  fontSize: 14,
  fontWeight: 700,
  border: "1px solid transparent",
  cursor: "pointer",
};
const btnGhost: CSSProperties = { background: "transparent", border: "1px solid rgba(var(--ink),0.16)", color: "rgba(var(--ink),0.8)" };
const btnDisabled: CSSProperties = { opacity: 0.5, cursor: "not-allowed" };
const errorBox: CSSProperties = {
  marginTop: 20,
  padding: "12px 16px",
  borderRadius: 10,
  border: "1px solid rgba(239,68,68,0.3)",
  background: "rgba(239,68,68,0.08)",
  color: "var(--a-fca5a5)",
  fontSize: 13,
};
const note: CSSProperties = { marginTop: 32, paddingTop: 24, borderTop: "1px solid rgba(var(--ink),0.06)" };
const noteRow: CSSProperties = { display: "flex", gap: 12, alignItems: "center", marginBottom: 10, flexWrap: "wrap" };
const noteKey: CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "rgba(var(--ink),0.35)", minWidth: 64 };
const codeStyle: CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace", fontSize: 13, color: "rgba(var(--ink),0.7)" };
const linkStyle: CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace", fontSize: 13, color: ACCENT, textDecoration: "none" };
const noteText: CSSProperties = { marginTop: 14, fontSize: 13, lineHeight: 1.6, color: "rgba(var(--ink),0.45)" };
