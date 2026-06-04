// pages/uc8.tsx
//
// UC8 · Limmat Bank on a stablecoin rail — the main UC8 entry (listed in the concept-bank NavBar
// and on the homepage). Thin shell: NavBar + theme (light/dark) + the act toggle; renders Act 1
// (remittance) or Act 2 (treasury), which share the <WorldMap> and the theme tokens. The
// connection-status diagnostic lives at /uc8-status.
import { useState, type CSSProperties } from "react";
import Link from "next/link";
import NavBar from "../shared/components/NavBar";
import { useTheme } from "../shared/lib/theme-context";
import { useBreakpoint } from "../shared/hooks/useBreakpoint";
import { DARK, LIGHT, type Tokens } from "../use-cases/uc8-tempo/lib/theme";
import Act1 from "../use-cases/uc8-tempo/components/Act1";
import Act2 from "../use-cases/uc8-tempo/components/Act2";

export default function Uc8() {
  const { isMobile, isTablet } = useBreakpoint();
  const stacked = isMobile || isTablet;

  const { dark } = useTheme(); // global theme (toggle lives in the NavBar)
  const t = dark ? DARK : LIGHT;

  const [act, setAct] = useState<"act1" | "act2">("act1");

  return (
    <>
      <NavBar active="uc8" />
      <div style={{ ...page, background: t.bg, color: t.text }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: stacked ? "20px 16px 64px" : "28px 28px 72px" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 22 }}>
          <div style={{ ...logoDot, background: t.accent }} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <strong style={{ fontSize: 16, color: t.heading, letterSpacing: "-0.01em" }}>Limmat Bank</strong>
            <span style={{ fontSize: 11.5, color: t.faint }}>UC8 · Stablecoin rail on Tempo</span>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", gap: 4, padding: 4, borderRadius: 999, background: t.chipBg, border: `1px solid ${t.border}` }}>
            <ActTab label="Remittance" active={act === "act1"} onClick={() => setAct("act1")} t={t} />
            <ActTab label="Treasury" active={act === "act2"} onClick={() => setAct("act2")} t={t} />
          </div>
          <Link href="/uc8-status" style={{ ...ghostLink, border: `1px solid ${t.border}`, color: t.muted }}>Status ↗</Link>
        </header>

        {act === "act2" ? <Act2 dark={dark} /> : <Act1 dark={dark} />}

        <footer style={{ marginTop: 28, fontSize: 11.5, color: t.faint, textAlign: "center" }}>
          Prototype · Tempo testnet (Moderato) · mock tokens · compliance figures confirmed June 2026
        </footer>
      </div>
    </div>
    </>
  );
}

function ActTab({ label, active, onClick, t }: { label: string; active: boolean; onClick: () => void; t: Tokens }) {
  return (
    <button onClick={onClick} style={{ padding: "6px 14px", borderRadius: 999, border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 700, letterSpacing: "0.01em",
      background: active ? t.accent : "transparent", color: active ? "#fff" : t.muted }}>{label}</button>
  );
}

const page: CSSProperties = { minHeight: "100vh", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif", transition: "background 160ms ease, color 160ms ease" };
const logoDot: CSSProperties = { width: 30, height: 30, borderRadius: 9, flexShrink: 0, boxShadow: "0 2px 8px rgba(0,0,0,0.25)" };
const ghostLink: CSSProperties = { fontSize: 12, fontWeight: 600, padding: "7px 12px", borderRadius: 9, textDecoration: "none" };
