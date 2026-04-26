import { useMemo } from "react";
import type { TraceResult } from "../lib/types";
import { layoutFundFlow } from "../lib/fundFlowGraph";
import type { Currency } from "../lib/format";
import { formatMoney } from "../lib/format";

type Props = {
  trace: TraceResult;
  height?: number;
  currency?: Currency;
};

function shortAddr(addr: string): string {
  return addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

export default function FundFlowDiagram({ trace, height = 420, currency = "CHF" }: Props) {
  const layout = useMemo(
    () => layoutFundFlow(trace, { width: 880, columnWidth: 240, nodeWidth: 180 }),
    [trace]
  );
  const nodeWidth = 180;
  const nodeHeight = 58;

  if (layout.nodes.length === 0) {
    return <div style={{ color: "rgba(255,255,255,0.5)" }}>No trace data available</div>;
  }

  return (
    <div style={{
      width: "100%",
      height,
      background: "#0b1220",
      border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: 12,
      overflow: "auto",
    }}>
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        style={{ display: "block" }}
      >
        <defs>
          <marker id="uc7arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(148,163,184,0.8)" />
          </marker>
        </defs>
        {layout.edges.map((e, i) => {
          const fromX = e.fromPos.x;
          const fromY = e.fromPos.y;
          const toX = e.toPos.x - nodeWidth / 2;
          const toY = e.toPos.y;
          const mx = (fromX + toX) / 2;
          return (
            <path
              key={i}
              d={`M ${fromX} ${fromY} C ${mx} ${fromY}, ${mx} ${toY}, ${toX} ${toY}`}
              stroke="rgba(148,163,184,0.55)"
              strokeWidth="1.6"
              fill="none"
              markerEnd="url(#uc7arrow)"
            />
          );
        })}
        {layout.nodes.map((n) => {
          const tier = n.label?.exchangeTier;
          let fill = "#1f2937";
          let stroke = "#475569";
          if (n.label?.sanctioned) {
            fill = "#7f1d1d";
            stroke = "#ef4444";
          } else if (n.label?.entityType === "exchange") {
            fill = tier === "A" ? "#064e3b" : tier === "B" ? "#78350f" : "#7f1d1d";
            stroke = tier === "A" ? "#10b981" : tier === "B" ? "#f59e0b" : "#ef4444";
          } else if (n.kind === "wallet") {
            fill = "#1e3a8a";
            stroke = "#3b82f6";
          } else if (n.label?.entityType === "dex" || n.label?.entityType === "bridge") {
            fill = "#374151";
            stroke = "#9ca3af";
          }
          const title =
            n.label?.name ||
            (n.kind === "wallet" ? "Client wallet" : "Unknown");
          const value = currency === "USD" ? n.valueUsd : n.valueChf;
          const valLabel = formatMoney(value, currency);
          return (
            <g key={n.id}>
              <title>{`${title}\n${n.address}\n${formatMoney(value, currency, { decimals: 2 })}`}</title>
              <rect
                x={n.x}
                y={n.y}
                width={nodeWidth}
                height={nodeHeight}
                rx={8}
                fill={fill}
                stroke={stroke}
                strokeWidth={1.5}
              />
              <text x={n.x + 10} y={n.y + 20} fill="#ffffff" fontFamily="system-ui,sans-serif" fontSize={12} fontWeight={700}>
                {title.substring(0, 22)}
              </text>
              <text x={n.x + 10} y={n.y + 36} fill="rgba(255,255,255,0.65)" fontFamily="monospace" fontSize={10}>
                {shortAddr(n.address)}
              </text>
              <text x={n.x + 10} y={n.y + 50} fill="rgba(255,255,255,0.85)" fontFamily="system-ui,sans-serif" fontSize={11} fontWeight={600}>
                {valLabel}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
