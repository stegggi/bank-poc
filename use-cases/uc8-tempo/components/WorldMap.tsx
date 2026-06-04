// use-cases/uc8-tempo/components/WorldMap.tsx
//
// UC8 · Task 4 / Step A — one shared, theme-aware world map used by BOTH acts.
//   mode="corridor"  → Act 1: origin Zürich, one animated route to the active destination, gates.
//   mode="hub"       → Act 2: hub Zürich, spokes to subsidiaries; each route SOLID (rail) to an edge
//                      marker then DASHED (off-chain) to the city; edge teal=liquid / amber=hard.
//
// Real basemap: Natural Earth 110m land (bundled in ../lib/worldLand), plain equirectangular
// projection — no map library, no runtime CDN. Flow = looping CSS motion-path/opacity only,
// wrapped in prefers-reduced-motion. The land is quiet; cities and routes are the bright elements.
import { useId, type CSSProperties } from "react";
import { WORLD_LAND } from "../lib/worldLand";

export type City = "Zürich" | "Lisbon" | "New York" | "Lagos";
export type NodeStatus = "origin" | "hub" | "active" | "inactive" | "funded" | "scheduled" | "belowFloor";
export type MapNode = { city: City; role?: string; status?: NodeStatus };
export type Gate = { t: number; status: "ok" | "warn" | "flag" };
export type EdgeMark = { t: number; type: "liquid" | "hard" };
export type MapRoute = { from: City; to: City; animated?: boolean; gates?: Gate[]; edge?: EdgeMark };

export type WorldMapProps = {
  mode: "corridor" | "hub";
  nodes: MapNode[];
  routes: MapRoute[];
  dark: boolean;
  title?: string;
  desc?: string;
  onSelect?: (city: City) => void;
  height?: number | string;
};

// ── geography ──
const COORD: Record<City, [number, number]> = {
  "Zürich": [8.54, 47.37],
  "Lisbon": [-9.14, 38.72],
  "New York": [-74.01, 40.71],
  "Lagos": [3.38, 6.52],
};
// Equirectangular window framing the Atlantic story (NYC · Europe · W. Africa).
const LON0 = -88, LON1 = 22, LAT0 = -8, LAT1 = 60;
const W = 1000;
const H = Math.round((W * (LAT1 - LAT0)) / (LON1 - LON0)); // 618 — keeps 1°lon ≈ 1°lat

type Pt = [number, number];
function project(lon: number, lat: number): Pt {
  return [((lon - LON0) / (LON1 - LON0)) * W, ((LAT1 - lat) / (LAT1 - LAT0)) * H];
}
const cityPt = (c: City): Pt => project(COORD[c][0], COORD[c][1]);

// Bundled land → one quiet path (computed once).
const LAND_D = WORLD_LAND.map(
  (ring) => "M" + ring.map(([lon, lat]) => { const [x, y] = project(lon, lat); return `${x.toFixed(1)} ${y.toFixed(1)}`; }).join("L") + "Z",
).join(" ");

// ── curve helpers (quadratic; gentle bow "outward") ──
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
function controlPt(a: Pt, b: Pt): Pt {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const off = Math.min(len * 0.17, 130);
  return [mx + (dy / len) * off, my - (dx / len) * off];
}
const quad = (a: Pt, c: Pt, b: Pt) => `M${a[0].toFixed(1)} ${a[1].toFixed(1)} Q${c[0].toFixed(1)} ${c[1].toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
const pointOnQuad = (a: Pt, c: Pt, b: Pt, t: number): Pt => {
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
};
function splitQuad(a: Pt, c: Pt, b: Pt, t: number) {
  const c1 = lerp(a, c, t), m = lerp(c, b, t), p = lerp(c1, m, t);
  return { solid: quad(a, c1, p), dashed: quad(p, m, b), at: p };
}

function palette(dark: boolean) {
  return {
    land: dark ? "rgba(255,255,255,0.055)" : "rgba(15,17,26,0.06)",
    landStroke: dark ? "rgba(255,255,255,0.09)" : "rgba(15,17,26,0.09)",
    route: dark ? "rgba(255,255,255,0.22)" : "rgba(15,17,26,0.24)",
    text: dark ? "rgba(255,255,255,0.82)" : "rgba(15,17,26,0.82)",
    halo: dark ? "#07080f" : "#f4f5f8",
    accent: dark ? "#818cf8" : "#4f46e5",
    green: dark ? "#4ade80" : "#16a34a",
    amber: dark ? "#fbbf24" : "#d97706",
    red: dark ? "#f87171" : "#dc2626",
    blue: dark ? "#60a5fa" : "#2563eb",
    teal: dark ? "#2dd4bf" : "#0d9488",
    muted: dark ? "rgba(255,255,255,0.34)" : "rgba(15,17,26,0.4)",
  };
}
type Pal = ReturnType<typeof palette>;
function nodeColor(p: Pal, s?: NodeStatus): string {
  switch (s) {
    case "funded": return p.green;
    case "scheduled": return p.blue;
    case "belowFloor": return p.red;
    case "active": return p.accent;
    case "origin": case "hub": return p.accent;
    default: return p.muted;
  }
}

export default function WorldMap({ mode, nodes, routes, dark, title, desc, onSelect, height = "auto" }: WorldMapProps) {
  const p = palette(dark);
  const uid = useId().replace(/:/g, "");

  return (
    <div style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={height} role="img" aria-label={title} style={{ display: "block" }} preserveAspectRatio="xMidYMid meet">
        {title && <title>{title}</title>}
        {desc && <desc>{desc}</desc>}

        {/* basemap — quiet land */}
        <path d={LAND_D} fill={p.land} stroke={p.landStroke} strokeWidth={0.6} fillRule="evenodd" />

        {/* routes */}
        {routes.map((r, i) => {
          const a = cityPt(r.from), b = cityPt(r.to), c = controlPt(a, b);
          const full = quad(a, c, b);
          const edgeColor = r.edge?.type === "hard" ? p.amber : p.teal;
          return (
            <g key={`route-${i}`}>
              {mode === "hub" && r.edge ? (
                (() => { const s = splitQuad(a, c, b, r.edge.t); return (
                  <>
                    <path d={s.solid} fill="none" stroke={edgeColor} strokeWidth={2.4} strokeLinecap="round" opacity={0.85} />
                    <path d={s.dashed} fill="none" stroke={edgeColor} strokeWidth={2} strokeLinecap="round" strokeDasharray="2 7" opacity={0.7} />
                  </>
                ); })()
              ) : (
                <path d={full} fill="none" stroke={p.route} strokeWidth={2} strokeLinecap="round" opacity={0.9} />
              )}
              {/* flow dots — value moving along the route */}
              {r.animated && [0, 1, 2].map((k) => (
                <circle key={k} className={`flow-${uid}`} r={3.4} cx={0} cy={0} fill={mode === "hub" ? edgeColor : p.accent}
                  style={{ offsetPath: `path('${full}')`, animationDelay: `${(-k * 1.6) / 3}s` } as CSSProperties} />
              ))}
            </g>
          );
        })}

        {/* hub edge markers */}
        {mode === "hub" && routes.map((r, i) => {
          if (!r.edge) return null;
          const a = cityPt(r.from), b = cityPt(r.to), c = controlPt(a, b);
          const at = pointOnQuad(a, c, b, r.edge.t);
          const col = r.edge.type === "hard" ? p.amber : p.teal;
          return <g key={`edge-${i}`}><circle cx={at[0]} cy={at[1]} r={4.5} fill={col} stroke={p.halo} strokeWidth={1.5} /></g>;
        })}

        {/* corridor gates */}
        {mode === "corridor" && routes.map((r, i) =>
          (r.gates || []).map((g, j) => {
            const a = cityPt(r.from), b = cityPt(r.to), c = controlPt(a, b);
            const at = pointOnQuad(a, c, b, g.t);
            const col = g.status === "ok" ? p.green : g.status === "warn" ? p.amber : p.red;
            const icon = g.status === "ok" ? "✓" : g.status === "warn" ? "!" : "✕";
            return (
              <g key={`gate-${i}-${j}`}>
                <circle cx={at[0]} cy={at[1]} r={8} fill={dark ? "#07080f" : "#fff"} stroke={col} strokeWidth={2.4} />
                <text x={at[0]} y={at[1] + 0.5} textAnchor="middle" dominantBaseline="middle" fontSize={9} fontWeight={800} fill={col}>{icon}</text>
              </g>
            );
          }),
        )}

        {/* nodes */}
        {nodes.map((n) => {
          const [x, y] = cityPt(n.city);
          const col = nodeColor(p, n.status);
          const isBig = n.status === "origin" || n.status === "hub";
          const ring = isBig || n.status === "belowFloor";
          const ly = y + 20; // labels sit below the marker, clear of routes
          return (
            <g key={n.city} onClick={onSelect ? () => onSelect(n.city) : undefined} style={{ cursor: onSelect ? "pointer" : "default" }}>
              {ring && <circle className={`pulse-${uid}`} cx={x} cy={y} r={isBig ? 13 : 11} fill="none" stroke={col} strokeWidth={1.5} style={{ transformOrigin: `${x}px ${y}px` }} />}
              <circle cx={x} cy={y} r={isBig ? 8 : 6} fill={col} stroke={p.halo} strokeWidth={1.6} />
              {isBig && <circle cx={x} cy={y} r={3} fill={p.halo} />}
              <text x={x} y={ly} textAnchor="middle" fontSize={13} fontWeight={700} fill={p.text}
                style={{ paintOrder: "stroke", stroke: p.halo, strokeWidth: 3.5, strokeLinejoin: "round" } as CSSProperties}>{n.city}</text>
              {n.role && <text x={x} y={ly + 13} textAnchor="middle" fontSize={9.5} fontWeight={600} fill={p.muted}
                style={{ paintOrder: "stroke", stroke: p.halo, strokeWidth: 3, strokeLinejoin: "round" } as CSSProperties}>{n.role}</text>}
              {onSelect && <circle cx={x} cy={y} r={16} fill="transparent" />}
            </g>
          );
        })}

        <style jsx>{`
          @keyframes flow-${uid} { 0% { offset-distance: 0%; opacity: 0; } 12% { opacity: 0.85; } 88% { opacity: 0.85; } 100% { offset-distance: 100%; opacity: 0; } }
          @keyframes pulse-${uid} { 0% { transform: scale(0.75); opacity: 0.7; } 70% { transform: scale(1.5); opacity: 0; } 100% { transform: scale(1.5); opacity: 0; } }
          .flow-${uid} { opacity: 0; }
          @media (prefers-reduced-motion: no-preference) {
            .flow-${uid} { animation: flow-${uid} 1.6s linear infinite; }
            .pulse-${uid} { animation: pulse-${uid} 2.4s ease-out infinite; }
          }
        `}</style>
      </svg>
    </div>
  );
}
