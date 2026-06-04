// use-cases/uc8-tempo/components/Act2.tsx
//
// UC8 · Task 4 / Step C — Act 2 (treasury), redesigned around the shared <WorldMap> (hub mode).
// The working logic is reused UNCHANGED: live moveOnRail (/api/tempo/rail-move), the narrated
// external leg (NarratedExternalLeg behind IExternalLeg), and priceConversion (fxRevenue30d).
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import WorldMap, { type City, type MapNode, type MapRoute } from "./WorldMap";
import { NarratedExternalLeg, type IExternalLeg, type LegStatus } from "../lib/externalLeg";
import { fxRevenue30d } from "../lib/fx";
import { themeOf, pill, type Tokens, type PillKind } from "../lib/theme";

type StepState = "idle" | "active" | "done" | "error";
type TreasurySub = { id: string; label: string; city: string; localCcy: string; address: string; tchf: number };
type TreasuryState = { ok: boolean; token?: string; subs?: TreasurySub[]; totalTchf?: number; error?: string };

// Subsidiaries: map geography + local-bank + the hybrid FX edge type. Local fiat is v1 display state. // VERIFY
type SubCfg = { id: string; city: City; ccy: string; role: string; bank: string; floor: number; initLocal: number; edge: "liquid" | "hard"; scheduled?: boolean };
const SUBS: SubCfg[] = [
  { id: "FRA", city: "Lisbon", ccy: "EUR", role: "manufacturing", bank: "Banco do Tejo", floor: 500_000, initLocal: 1_200_000, edge: "liquid" },
  { id: "NYC", city: "New York", ccy: "USD", role: "software", bank: "Anchor National", floor: 250_000, initLocal: 300_000, edge: "liquid", scheduled: true },
  { id: "LAG", city: "Lagos", ccy: "NGN", role: "field installers", bank: "Baobab", floor: 40_000_000, initLocal: 18_000_000, edge: "hard" },
];

export default function Act2({ dark }: { dark: boolean }) {
  const t = themeOf(dark);
  const [state, setState] = useState<TreasuryState | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const j = (await (await fetch("/api/tempo/treasury")).json()) as TreasuryState;
      if (!j.ok) { setErr(j.error || "failed to load treasury"); setState(null); return; }
      setState(j);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const [flowFee, setFlowFee] = useState(312.4); // ticking // VERIFY
  useEffect(() => { const i = setInterval(() => setFlowFee((f) => f + 0.03), 1200); return () => clearInterval(i); }, []);
  const [localBal, setLocalBal] = useState<Record<string, number>>(Object.fromEntries(SUBS.map((s) => [s.id, s.initLocal])));
  const fx = useMemo(() => fxRevenue30d(), []);

  const subOf = (id: string) => state?.subs?.find((s) => s.id === id) || null;
  const fmtN = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const red = pill("red", dark);
  const teal = dark ? "#2dd4bf" : "#0d9488";
  const amberC = pill("amber", dark)[1];

  const nodeStatus = (s: SubCfg): MapNode["status"] => (s.scheduled ? "scheduled" : localBal[s.id] < s.floor ? "belowFloor" : "funded");
  const nodes: MapNode[] = [
    { city: "Zürich", role: "Helvolt HQ · Limmat", status: "hub" },
    ...SUBS.map((s): MapNode => ({ city: s.city, role: s.ccy, status: nodeStatus(s) })),
  ];
  const routes: MapRoute[] = SUBS.map((s) => ({ from: "Zürich", to: s.city, animated: s.id === "LAG", edge: { t: s.edge === "hard" ? 0.55 : 0.62, type: s.edge } }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <div style={eyebrow(t)}>Act 2 · Treasury</div>
        <h1 style={h1(t)}>One rail, many currencies</h1>
        <p style={{ ...intro(t), maxWidth: 820, lineHeight: 1.65 }}>Helvolt builds and sells off-grid solar systems across three continents, and every arm of the company has to pay people in their own currency: euros to suppliers in Lisbon, dollars to engineers in New York, naira to installers in Lagos. Holding those local balances is costly, and in Nigeria genuinely risky, yet paying staff late is never an option. So Helvolt keeps its working capital central as a tokenized CHF deposit on Limmat&apos;s rail and lets an agent push money out to each country only at the moment it is needed. Limmat&apos;s part is the rail and the controls around the agent, and what it earns comes from converting currency at each border, never from the deposit itself.</p>
      </div>

      {err && <div style={{ ...errorBox, color: dark ? "#fca5a5" : "#b91c1c", borderColor: red[2], background: red[0] }}><strong>Treasury unavailable:</strong> {err}. Run <code style={mono}>npx tsx scripts/tempo-act2-setup.mjs</code>, then restart the dev server.</div>}

      {/* Helvolt + treasury hub + subsidiaries — one merged section */}
      <section style={panel(t)}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, flexShrink: 0, background: t.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 16 }}>H</div>
          <div style={{ minWidth: 0 }}>
            <h2 style={h2(t)}>Helvolt Treasury</h2>
            <div style={{ fontSize: 11, color: t.faint }}>solar co · HQ Zürich · on Limmat&apos;s rail</div>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ textAlign: "right" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, justifyContent: "flex-end" }}>
              <span style={{ fontSize: 28, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>{state ? fmtN(state.totalTchf || 0) : "—"}</span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: t.muted }}>tCHF on the rail</span>
            </div>
            <div style={{ fontSize: 10.5, color: t.faint }}>instant · programmable · internal{state?.token ? <> · <a href={`https://explore.moderato.tempo.xyz/address/${state.token}`} target="_blank" rel="noreferrer" style={{ color: t.accent, textDecoration: "none" }}>token ↗</a></> : null}</div>
          </div>
          <button onClick={() => void load()} disabled={loading} title="Refresh" style={{ ...iconBtn, background: t.chipBg, border: `1px solid ${t.border}`, color: t.text }}>{loading ? "…" : "⟳"}</button>
        </div>

        {/* hub map */}
        <div style={{ marginTop: 12, borderRadius: 12, overflow: "hidden", border: `1px solid ${t.border}`, padding: 6, background: t.panel2 }}>
          <WorldMap dark={dark} mode="hub" nodes={nodes} routes={routes} title="Treasury hub: Zürich to subsidiaries" />
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", padding: "2px 6px 4px", fontSize: 10.5, color: t.faint, alignItems: "center" }}>
            <LegendLine swatch={<span style={{ width: 15, height: 3, borderRadius: 2, background: teal }} />} label="liquid corridor · tight spread" />
            <LegendLine swatch={<span style={{ width: 15, height: 3, borderRadius: 2, background: amberC }} />} label="hard corridor · thin margin (NGN)" />
            <LegendLine swatch={<span style={{ width: 15, borderTop: `2px solid ${t.muted}` }} />} label="solid = rail" />
            <LegendLine swatch={<span style={{ width: 15, borderTop: `2px dashed ${t.muted}` }} />} label="dashed = off-chain" />
          </div>
        </div>

        {/* subsidiaries — on-chain tCHF (tokenised sub-account) + local-currency amount with the local bank */}
        <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px,1fr))", gap: 10 }}>
          {SUBS.map((s) => <SubCard key={s.id} s={s} tchf={subOf(s.id)?.tchf ?? null} local={localBal[s.id]} t={t} dark={dark} fmtN={fmtN} />)}
        </div>
      </section>

      {/* agent panel */}
      <AgentPanel t={t} dark={dark} onRailMoved={() => void load()} onSettled={(ngn) => setLocalBal((b) => ({ ...b, LAG: b.LAG + ngn }))} />

      {/* revenue strip */}
      <section style={panel(t)}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
          <h2 style={h2(t)}>Where the bank earns</h2>
          <span style={{ fontSize: 11, color: t.faint }}>at the conversion edges, never on float</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
          <RevenueCard t={t} label="FX spread (30d)" value={`CHF ${fmtN(Math.round(fx.limmat))}`} hint="Limmat's share via priceConversion // VERIFY rates" />
          <RevenueCard t={t} label="Flow fees (today)" value={`CHF ${fmtN(flowFee, 2)}`} hint="ticking · sub-cent per transfer // VERIFY" live />
          <RevenueCard t={t} label="Governance fee (monthly)" value={`CHF ${fmtN(25_000)}`} hint="// VERIFY — mandate / platform fee" />
        </div>
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${t.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: t.faint, marginBottom: 8 }}>Hybrid FX (30d) · who does the conversion</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {fx.byCorridor.map((q) => {
              const lp = pill(q.liquidity === "liquid" ? "green" : "amber", dark);
              return (
                <div key={q.toCcy} style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", fontSize: 12 }}>
                  <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontWeight: 700, color: t.heading, minWidth: 70 }}>{q.fromCcy}→{q.toCcy}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: lp[0], color: lp[1], border: `1px solid ${lp[2]}` }}>{q.liquidity}</span>
                  <span style={{ color: t.muted }}>Limmat earns <strong style={{ color: t.heading }}>CHF {fmtN(Math.round(q.limmatEarns))}</strong> <span style={{ color: t.faint }}>({q.limmatBps} bps)</span></span>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 10.5, color: t.faint, marginTop: 8 }}>Full spread to Limmat on liquid corridors; only a thin correspondent margin on the hard CHF→NGN (thin liquidity). // VERIFY rates/spreads</div>
        </div>
      </section>
    </div>
  );
}

// ── Agent panel — logic identical to task-3 step 7 (live moveOnRail + narrated external leg + revoke) ──
function AgentPanel({ t, dark, onRailMoved, onSettled }: { t: Tokens; dark: boolean; onRailMoved: () => void; onSettled: (ngn: number) => void }) {
  const DAILY_CAP = 5_000_000;
  const RUN_CHF = 30_000; // ≈ ₦42M // VERIFY ~1,400 NGN/CHF
  const PAYROLL_NGN = 42_000_000;
  const EXPIRY = "2026-12-31";

  const [usedToday, setUsedToday] = useState(1_200_000);
  const [railTx, setRailTx] = useState<{ hash: string; explorer: string; elapsedMs: number } | null>(null);
  const [railState, setRailState] = useState<StepState>("idle");
  const [legStatus, setLegStatus] = useState<LegStatus>("idle");
  const [legNote, setLegNote] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<null | "settled" | "cancelled">(null);
  const legRef = useRef<IExternalLeg | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  useEffect(() => () => unsubRef.current?.(), []);

  const fmtN = (n: number) => n.toLocaleString("en-US");
  const short = (h?: string) => (h ? `${h.slice(0, 10)}…${h.slice(-8)}` : "");
  const remaining = DAILY_CAP - usedToday;
  const inFlight = legStatus === "pending" || legStatus === "converting";
  const convertState: StepState = railState !== "done" ? "idle" : legStatus === "settled" ? "done" : legStatus === "cancelled" ? "error" : "active";
  const topupState: StepState = legStatus === "settled" ? "done" : "idle";

  const run = useCallback(async () => {
    setRunning(true); setError(null); setOutcome(null); setRailTx(null); setLegStatus("idle"); setLegNote("");
    setRailState("active");
    setUsedToday((u) => u + RUN_CHF);
    try {
      const j = await (await fetch("/api/tempo/rail-move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fromId: "HQ", toId: "LAG", amount: RUN_CHF }) })).json();
      if (!j.ok) { setError(j.error || "rail move failed"); setRailState("error"); setUsedToday((u) => u - RUN_CHF); setRunning(false); return; }
      setRailTx({ hash: j.hash, explorer: j.explorer, elapsedMs: j.elapsedMs });
      setRailState("done");
      onRailMoved();
      const leg = new NarratedExternalLeg();
      legRef.current = leg;
      unsubRef.current = leg.subscribe((status, note) => {
        setLegStatus(status); setLegNote(note);
        if (status === "settled") { setOutcome("settled"); setRunning(false); onSettled(PAYROLL_NGN); }
        if (status === "cancelled") { setOutcome("cancelled"); setRunning(false); }
      });
      leg.initiate({ fromCcy: "CHF", toCcy: "NGN", amountFrom: RUN_CHF, amountTo: PAYROLL_NGN, beneficiary: "Lagos payroll" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); setRailState("error"); setUsedToday((u) => u - RUN_CHF); setRunning(false);
    }
  }, [onRailMoved, onSettled]);
  const revoke = useCallback(() => {
    const r = legRef.current?.cancel();
    if (r?.cancelled) setUsedToday((u) => u - RUN_CHF);
  }, []);

  const capRatio = Math.min(1, usedToday / DAILY_CAP);
  const amber = pill("amber", dark), green = pill("green", dark), red = pill("red", dark);

  return (
    <section style={{ ...panel(t), border: `1.5px solid ${t.accent}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h2 style={h2(t)}>Agent · Helvolt</h2>
        <span style={{ fontSize: 11, color: t.faint }}>mandate held by Limmat · bank</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(116px, 1fr))", gap: 10, marginTop: 12 }}>
        <Mini t={t} label="Scope" value="Payroll · Vendor" />
        <Mini t={t} label="Daily cap" value={`CHF ${fmtN(DAILY_CAP)}`} />
        <Mini t={t} label="Used today" value={`CHF ${fmtN(usedToday)}`} />
        <Mini t={t} label="Remaining" value={`CHF ${fmtN(remaining)}`} />
        <Mini t={t} label="Expiry" value={EXPIRY} />
      </div>
      <div style={{ height: 5, borderRadius: 4, background: t.chipBg, marginTop: 10, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${capRatio * 100}%`, background: t.accent, transition: "width 300ms ease" }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 14, padding: "11px 14px", borderRadius: 10, border: `1px solid ${amber[2]}`, background: amber[0] }}>
        <span style={{ fontSize: 13, color: t.text, flex: 1, minWidth: 220 }}><strong style={{ color: t.heading }}>Task:</strong> Lagos payroll ₦{fmtN(PAYROLL_NGN)} due Friday — account below floor.</span>
        <button onClick={() => void run()} disabled={running} style={{ ...sendBtn, width: "auto", padding: "9px 16px", background: t.accent, opacity: running ? 0.55 : 1, cursor: running ? "not-allowed" : "pointer" }}>{running ? "Running…" : outcome ? "Run again" : "Run agent"}</button>
      </div>
      {(railState !== "idle" || outcome) && (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <StepRow t={t} state={railState} tag="live · Tempo" title="1 · Move on rail (HQ → Lagos)"
            detail={railTx ? <>moved {fmtN(RUN_CHF)} tCHF · <a href={railTx.explorer} target="_blank" rel="noreferrer" style={{ color: t.accent, textDecoration: "none" }}><code style={mono}>{short(railTx.hash)}</code> ↗</a> · {(railTx.elapsedMs / 1000).toFixed(1)}s · done &amp; irreversible</> : "Signing the internal tCHF transfer…"} />
          <StepRow t={t} state={convertState} tag="narrated" title="2 · Convert at edge (CHF → NGN)"
            detail={inFlight ? legNote : convertState === "done" ? "FX complete at the local edge." : convertState === "error" ? "Cancelled before conversion — no NGN converted." : "Awaiting rail settlement…"} />
          <StepRow t={t} state={topupState} tag="narrated" title="3 · Top up local account"
            detail={topupState === "done" ? `₦${fmtN(PAYROLL_NGN)} credited to the Lagos local bank.` : "Pending conversion…"} />
          {inFlight && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "10px 13px", borderRadius: 10, border: `1px solid ${t.border}`, background: t.panel2 }}>
              <button onClick={revoke} style={{ ...sendBtn, width: "auto", padding: "8px 14px", background: "transparent", color: red[1], border: `1px solid ${red[2]}` }}>Revoke</button>
              <span style={{ fontSize: 11.5, color: t.muted, flex: 1, minWidth: 220 }}>Cancels the external conversion + top-up while in flight. The on-rail move already happened and can’t be undone.</span>
            </div>
          )}
          {outcome === "settled" && (
            <div style={{ padding: "11px 14px", borderRadius: 10, border: `1px solid ${green[2]}`, background: green[0], fontSize: 12, color: t.text, lineHeight: 1.6 }}>
              <strong style={{ color: green[1] }}>Settled.</strong> Lagos local account topped up ₦{fmtN(PAYROLL_NGN)} (now above floor). Daily allowance used CHF {fmtN(RUN_CHF)} — remaining CHF {fmtN(remaining)}. Both the on-rail move and the external payout completed.
            </div>
          )}
          {outcome === "cancelled" && (
            <div style={{ padding: "11px 14px", borderRadius: 10, border: `1px solid ${amber[2]}`, background: amber[0], fontSize: 12, color: t.text, lineHeight: 1.6 }}>
              <strong style={{ color: amber[1] }}>Revoked.</strong> The external conversion + local top-up were cancelled — no NGN was credited.
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                <li>On-rail move: <strong>done &amp; irreversible</strong> — {fmtN(RUN_CHF)} tCHF is parked on Lagos’s rail account (an on-chain transfer can only be moved back with a new transfer, not reversed).</li>
                <li>Daily allowance: CHF {fmtN(RUN_CHF)} <strong>released</strong> — remaining back to CHF {fmtN(remaining)}.</li>
              </ul>
            </div>
          )}
          {error && <div style={{ ...errorBox, color: dark ? "#fca5a5" : "#b91c1c", borderColor: red[2], background: red[0] }}><strong>Agent error:</strong> {error}</div>}
        </div>
      )}
    </section>
  );
}

// ── small presentational helpers ──
// Subsidiary card: on-chain tCHF (the tokenised sub-account) + local-currency amount with the local bank.
function SubCard({ s, tchf, local, t, dark, fmtN }: { s: SubCfg; tchf: number | null; local: number; t: Tokens; dark: boolean; fmtN: (n: number, d?: number) => string }) {
  const st = s.scheduled ? { status: "vendor-run scheduled", kind: "info" as PillKind } : local < s.floor ? { status: "below floor", kind: "red" as PillKind } : { status: "funded", kind: "green" as PillKind };
  const [bg, fg, bd] = pill(st.kind, dark);
  const below = !s.scheduled && local < s.floor;
  const ratio = Math.max(0.03, Math.min(1, local / s.floor));
  return (
    <div style={{ background: t.panel2, border: `1px solid ${t.border}`, borderRadius: 12, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: t.heading }}>{s.city}</div>
          <div style={{ fontSize: 10.5, color: t.faint }}>{s.role} · {s.bank}</div>
        </div>
        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: bg, color: fg, border: `1px solid ${bd}`, whiteSpace: "nowrap" }}>{st.status}</span>
      </div>
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${t.border}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10.5, color: t.faint }}>
          <span>On rail · tokenised</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "#22c55e" }}><span style={{ width: 6, height: 6, borderRadius: 3, background: "#22c55e" }} />live</span>
        </div>
        <div style={{ fontSize: 17, fontWeight: 800, color: t.heading }}>{tchf !== null ? fmtN(tchf) : "—"} <span style={{ fontSize: 11.5, fontWeight: 700, color: t.muted }}>tCHF</span></div>
      </div>
      <div style={{ marginTop: 9 }}>
        <div style={{ fontSize: 10.5, color: t.faint, marginBottom: 3 }}>Local · {s.bank} ({s.ccy}) · v1 display</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: below ? fg : t.text }}>{fmtN(local)} {s.ccy}</div>
        <div style={{ height: 5, borderRadius: 4, background: t.chipBg, marginTop: 6, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${ratio * 100}%`, background: below ? fg : "#22c55e", transition: "width 400ms ease" }} />
        </div>
        <div style={{ fontSize: 10, color: t.faint, marginTop: 4 }}>floor {fmtN(s.floor)} {s.ccy}{below ? ` · short ${fmtN(s.floor - local)} ${s.ccy}` : ""}</div>
      </div>
    </div>
  );
}
function LegendLine({ swatch, label }: { swatch: ReactNode; label: string }) {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>{swatch}{label}</span>;
}
function Mini({ t, label, value }: { t: Tokens; label: string; value: string }) {
  return <div><div style={{ fontSize: 10, color: t.faint, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 }}>{label}</div><div style={{ fontSize: 13, fontWeight: 700, color: t.heading }}>{value}</div></div>;
}
function RevenueCard({ t, label, value, hint, live }: { t: Tokens; label: string; value: string; hint: string; live?: boolean }) {
  return (
    <div style={{ background: t.panel2, border: `1px solid ${t.border}`, borderRadius: 12, padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 10.5, color: t.faint, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700 }}>{label}{live && <span style={{ width: 6, height: 6, borderRadius: 3, background: "#22c55e" }} />}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: t.heading, marginTop: 6, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 10.5, color: t.faint, marginTop: 4 }}>{hint}</div>
    </div>
  );
}
function StepRow({ state, tag, title, detail, t }: { state: StepState; tag: string; title: string; detail: ReactNode; t: Tokens }) {
  const mark = state === "done" ? "✓" : state === "error" ? "✕" : state === "active" ? "●" : "○";
  return (
    <div style={{ display: "flex", gap: 11, opacity: state === "idle" ? 0.5 : 1 }}>
      <div style={{ fontSize: 14, lineHeight: "20px", width: 16, textAlign: "center", color: state === "done" ? "#22c55e" : state === "error" ? "#ef4444" : t.muted }}>{mark}</div>
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: t.heading }}>{title}</span>
          <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: t.faint, padding: "1px 6px", borderRadius: 5, border: `1px solid ${t.border}` }}>{tag}</span>
        </div>
        <div style={{ fontSize: 11.5, color: t.muted, lineHeight: 1.5, marginTop: 2 }}>{detail}</div>
      </div>
    </div>
  );
}

const panel = (t: Tokens): CSSProperties => ({ background: t.panel, border: `1px solid ${t.border}`, borderRadius: 16, padding: 16 });
const eyebrow = (t: Tokens): CSSProperties => ({ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: t.accent });
const h1 = (t: Tokens): CSSProperties => ({ margin: "6px 0 8px", fontSize: "clamp(22px,4vw,30px)", fontWeight: 900, color: t.heading, letterSpacing: "-0.02em" });
const h2 = (t: Tokens): CSSProperties => ({ fontSize: 14, fontWeight: 800, color: t.heading, margin: 0, letterSpacing: "-0.01em" });
const intro = (t: Tokens): CSSProperties => ({ margin: 0, fontSize: 14, lineHeight: 1.6, color: t.muted, maxWidth: 760 });
const iconBtn: CSSProperties = { width: 34, height: 34, borderRadius: 9, cursor: "pointer", fontSize: 15, display: "inline-flex", alignItems: "center", justifyContent: "center" };
const sendBtn: CSSProperties = { borderRadius: 10, border: "none", color: "#fff", fontSize: 13.5, fontWeight: 700 };
const mono: CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11 };
const errorBox: CSSProperties = { fontSize: 12, padding: "9px 12px", borderRadius: 9, border: "1px solid", lineHeight: 1.5 };
