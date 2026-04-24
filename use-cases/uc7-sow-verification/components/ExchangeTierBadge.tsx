import type { CSSProperties } from "react";
import type { ExchangeTier } from "../lib/types";

const TIER_COLORS: Record<ExchangeTier, { bg: string; fg: string; border: string }> = {
  A: { bg: "rgba(16, 185, 129, 0.15)", fg: "#6ee7b7", border: "rgba(16, 185, 129, 0.45)" },
  B: { bg: "rgba(245, 158, 11, 0.15)", fg: "#fbbf24", border: "rgba(245, 158, 11, 0.45)" },
  C: { bg: "rgba(239, 68, 68, 0.15)", fg: "#fca5a5", border: "rgba(239, 68, 68, 0.45)" },
};

export default function ExchangeTierBadge({ tier, size = "md" }: { tier: ExchangeTier; size?: "sm" | "md" }) {
  const c = TIER_COLORS[tier];
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: size === "sm" ? "1px 6px" : "2px 8px",
    borderRadius: 4,
    fontSize: size === "sm" ? 10 : 11,
    fontWeight: 700,
    letterSpacing: "0.04em",
    background: c.bg,
    color: c.fg,
    border: `1px solid ${c.border}`,
  };
  return <span style={style}>TIER {tier}</span>;
}
