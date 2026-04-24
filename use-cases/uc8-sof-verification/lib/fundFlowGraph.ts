import type { FundFlowEdge, FundFlowNode, TraceResult } from "./types";

export type LayoutNode = FundFlowNode & {
  x: number;
  y: number;
};

export type LayoutEdge = FundFlowEdge & {
  fromPos: { x: number; y: number };
  toPos: { x: number; y: number };
};

export type FundFlowLayout = {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
};

export type LayoutOptions = {
  width?: number;
  rowHeight?: number;
  columnWidth?: number;
  nodeWidth?: number;
  nodeHeight?: number;
  paddingX?: number;
  paddingY?: number;
};

export function layoutFundFlow(
  trace: TraceResult,
  opts: LayoutOptions = {}
): FundFlowLayout {
  const nodeWidth = opts.nodeWidth ?? 180;
  const nodeHeight = opts.nodeHeight ?? 58;
  const rowHeight = opts.rowHeight ?? 76;
  const columnWidth = opts.columnWidth ?? 260;
  const paddingX = opts.paddingX ?? 20;
  const paddingY = opts.paddingY ?? 20;

  const maxDepth = trace.nodes.reduce((m, n) => Math.max(m, n.hopDepth), 0);

  const byDepth = new Map<number, FundFlowNode[]>();
  for (const n of trace.nodes) {
    const list = byDepth.get(n.hopDepth) || [];
    list.push(n);
    byDepth.set(n.hopDepth, list);
  }

  const maxPerColumn = Math.max(
    1,
    ...Array.from(byDepth.values()).map((a) => a.length)
  );
  const height = paddingY * 2 + maxPerColumn * rowHeight;
  const width = paddingX * 2 + (maxDepth + 1) * columnWidth;

  const layoutNodes: LayoutNode[] = [];
  const positions = new Map<string, { x: number; y: number }>();

  for (let depth = 0; depth <= maxDepth; depth++) {
    const column = byDepth.get(depth) || [];
    // Wallet is at depth 0 (rightmost in LTR backward trace view);
    // sources grow left. We'll render leftmost = deepest, rightmost = wallet.
    const col = maxDepth - depth;
    const totalCol = column.length;
    column.forEach((node, i) => {
      const x = paddingX + col * columnWidth;
      const y =
        paddingY +
        (maxPerColumn - totalCol) * (rowHeight / 2) +
        i * rowHeight;
      layoutNodes.push({ ...node, x, y });
      positions.set(node.id, { x: x + nodeWidth / 2, y: y + nodeHeight / 2 });
    });
  }

  const layoutEdges: LayoutEdge[] = [];
  for (const e of trace.edges) {
    const from = positions.get(e.from);
    const to = positions.get(e.to);
    if (!from || !to) continue;
    layoutEdges.push({
      ...e,
      fromPos: from,
      toPos: to,
    });
  }

  return { nodes: layoutNodes, edges: layoutEdges, width, height };
}

/**
 * Render the fund flow as SVG string — usable in PDF report.
 */
export function renderFundFlowSvg(
  trace: TraceResult,
  opts: LayoutOptions = {}
): string {
  const layout = layoutFundFlow(trace, opts);
  const nodeWidth = opts.nodeWidth ?? 180;
  const nodeHeight = opts.nodeHeight ?? 58;

  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const short = (addr: string): string =>
    addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;

  const edgeSvg = layout.edges
    .map((e) => {
      const fromX = e.fromPos.x;
      const fromY = e.fromPos.y;
      const toX = e.toPos.x - nodeWidth / 2;
      const toY = e.toPos.y;
      const mx = (fromX + toX) / 2;
      return `<path d="M ${fromX} ${fromY} C ${mx} ${fromY}, ${mx} ${toY}, ${toX} ${toY}" stroke="rgba(100,116,139,0.5)" stroke-width="1.6" fill="none" marker-end="url(#arrow)" />`;
    })
    .join("\n");

  const nodeSvg = layout.nodes
    .map((n) => {
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

      const title = n.label?.name || (n.kind === "wallet" ? "Client wallet" : "Unknown");
      const valLabel = `$${n.valueUsd.toLocaleString(undefined, {
        maximumFractionDigits: 0,
      })}`;

      return `
<g>
  <rect x="${n.x}" y="${n.y}" width="${nodeWidth}" height="${nodeHeight}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.5" />
  <text x="${n.x + 10}" y="${n.y + 20}" fill="#ffffff" font-family="system-ui,sans-serif" font-size="12" font-weight="700">${esc(title.substring(0, 22))}</text>
  <text x="${n.x + 10}" y="${n.y + 36}" fill="rgba(255,255,255,0.65)" font-family="monospace" font-size="10">${esc(short(n.address))}</text>
  <text x="${n.x + 10}" y="${n.y + 50}" fill="rgba(255,255,255,0.85)" font-family="system-ui,sans-serif" font-size="11" font-weight="600">${esc(valLabel)}</text>
</g>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(100,116,139,0.7)" />
    </marker>
  </defs>
  <rect x="0" y="0" width="${layout.width}" height="${layout.height}" fill="#0b1220" />
  ${edgeSvg}
  ${nodeSvg}
</svg>`;
}
