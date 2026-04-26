import type { CaseFile, TraceResult, WalletRecord } from "../lib/types";
import { renderFundFlowSvg } from "../lib/fundFlowGraph";
import { tierDescription } from "../lib/exchangeTiers";

function chf(n: number): string {
  return `CHF ${n.toLocaleString("de-CH", { maximumFractionDigits: 0 })}`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function short(addr: string): string {
  return addr.length > 14 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr;
}

function chainTraceBlock(trace: TraceResult): string {
  const sourcesRows = trace.sources
    .map((s) => {
      const tier = s.label?.exchangeTier
        ? `<span class="tier tier-${s.label.exchangeTier}">Tier ${s.label.exchangeTier}</span>`
        : "";
      const entity = s.label?.name || "Unknown";
      const type = s.label?.entityType || "unknown";
      return `<tr>
        <td><code>${esc(short(s.address))}</code></td>
        <td>${esc(entity)} ${tier}</td>
        <td>${esc(type)}</td>
        <td>${(s.percentage * 100).toFixed(1)}%</td>
        <td>${chf(s.valueChf)}</td>
        <td>${s.hopDepth}</td>
      </tr>`;
    })
    .join("\n");

  const sanctionsBlock = trace.sanctionsHits.length > 0
    ? `<div class="sanctions">
         <strong>⚠ Sanctions screening hit:</strong>
         <ul>${trace.sanctionsHits
           .map(
             (h) =>
               `<li><code>${esc(h.address)}</code> — ${esc(h.listName)}: ${esc(h.reason)}</li>`
           )
           .join("")}</ul>
       </div>`
    : "";

  const tierRows: Array<[string, number]> = [];
  for (const t of ["A", "B", "C"] as const) {
    const v = trace.sources
      .filter((s) => s.label?.entityType === "exchange" && s.label.exchangeTier === t)
      .reduce((sum, s) => sum + s.valueChf, 0);
    if (v > 0) tierRows.push([`Tier ${t}`, v]);
  }
  const tierBreakdown = tierRows.length > 0
    ? `<div class="tier-breakdown">
        <h5>Exchange tier breakdown</h5>
        <ul>${tierRows.map(([t, v]) => `<li>${t}: ${chf(v)}</li>`).join("")}</ul>
      </div>`
    : "";

  const svg = renderFundFlowSvg(trace, { width: 760 });

  return `<div class="chain-trace">
    <h4 style="text-transform:capitalize;">${esc(trace.chain)} — ${(trace.attributedPercentage * 100).toFixed(1)}% attributed</h4>
    <p class="muted">${chf(trace.attributedValueChf)} of ${chf(trace.totalIncomingValueChf)} inflow · hops ${trace.hopsUsed}/${trace.maxHopsConfigured}</p>
    ${sanctionsBlock}
    ${tierBreakdown}
    ${trace.sources.length > 0
      ? `<table class="sources">
          <thead><tr><th>Address</th><th>Entity</th><th>Type</th><th>Share</th><th>Value (CHF)</th><th>Hop</th></tr></thead>
          <tbody>${sourcesRows}</tbody>
         </table>
         <div class="svg-wrap">${svg}</div>`
      : `<p class="muted">No priced inflows on this chain.</p>`}
  </div>`;
}

function walletSection(wallet: WalletRecord, index: number): string {
  const chainTotal = wallet.scan?.totalValueChf ?? 0;
  // Prefer multi-chain traces; fall back to legacy single trace.
  const traces: TraceResult[] =
    wallet.traces && wallet.traces.length > 0
      ? wallet.traces
      : wallet.trace
        ? [wallet.trace]
        : [];
  const classification = wallet.classification;
  const ttp = wallet.ttp;

  const ownership = wallet.challenge;
  const ownStatus = ownership?.status === "verified"
    ? `<span class="ok">Verified ${esc(ownership.verifiedAt || "")}</span>`
    : ownership?.status === "failed"
    ? `<span class="fail">Failed — ${esc(ownership.failReason || "")}</span>`
    : `<span class="pending">Pending</span>`;

  const totalIncoming = traces.reduce((s, t) => s + t.totalIncomingValueChf, 0);
  const totalAttributed = traces.reduce((s, t) => s + t.attributedValueChf, 0);
  const overallPct = totalIncoming > 0 ? totalAttributed / totalIncoming : 0;

  const tierColor =
    classification?.tier === "GREEN" ? "#10b981" :
    classification?.tier === "AMBER" ? "#f59e0b" : "#ef4444";

  const classificationBlock = classification
    ? `<div class="classification" style="border-color:${tierColor};">
         <div class="classification-tier" style="color:${tierColor};">${classification.tier}</div>
         <ul>${classification.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
         <div class="muted">Thresholds: GREEN ≥ ${(classification.thresholds.green * 100).toFixed(0)}%, AMBER ≥ ${(classification.thresholds.amber * 100).toFixed(0)}%</div>
       </div>`
    : "<p class='muted'>Not yet classified</p>";

  const ttpBlock = ttp
    ? `<div class="ttp">
         <h4>Third-Party Forensic Report (${esc(ttp.provider)})</h4>
         <p><strong>Report ID:</strong> ${esc(ttp.reportId)}</p>
         <p><strong>Risk Score:</strong> ${ttp.riskScore}/100 (${esc(ttp.riskLevel.toUpperCase())})</p>
         <p>${esc(ttp.summary)}</p>
         <h5>Exposure Breakdown</h5>
         <ul>${Object.entries(ttp.exposureBreakdown)
           .map(([k, v]) => `<li>${esc(k.replace(/_/g, " "))}: ${v.toFixed(1)}%</li>`)
           .join("")}</ul>
         ${ttp.flaggedAddresses.length > 0
           ? `<h5>Flagged Counterparties</h5><ul>${ttp.flaggedAddresses
               .map(
                 (f) =>
                   `<li><code>${esc(short(f.address))}</code> — ${esc(f.category)} (${esc(f.riskLevel)}): ${esc(f.note)}</li>`
               )
               .join("")}</ul>`
           : ""}
       </div>`
    : "";

  const chainsList = traces.map((t) => t.chain).join(", ") || "—";

  return `<section class="wallet">
    <h3>Wallet ${index + 1} — <code>${esc(short(wallet.address))}</code></h3>
    <table class="meta">
      <tr><th>Full address</th><td><code>${esc(wallet.address)}</code></td></tr>
      <tr><th>Chain family</th><td>${esc(wallet.chainFamily)}</td></tr>
      <tr><th>Chains traced</th><td>${esc(chainsList)}</td></tr>
      <tr><th>Portfolio value (scan time)</th><td>${chf(chainTotal)}</td></tr>
      <tr><th>Ownership</th><td>${ownStatus}</td></tr>
    </table>
    <h4>Source of Wealth Coverage</h4>
    <p>Attributable coverage:
      <strong>${traces.length > 0 ? (overallPct * 100).toFixed(1) : "—"}%</strong>
      (${chf(totalAttributed)} of ${chf(totalIncoming)} inflow across ${traces.length} chain${traces.length === 1 ? "" : "s"})
    </p>
    ${traces.length > 0
      ? traces.map((t) => chainTraceBlock(t)).join("\n")
      : `<p class="muted">No trace data available.</p>`}
    <h4>Risk Classification</h4>
    ${classificationBlock}
    ${ttpBlock}
  </section>`;
}

export function generateReportHtml(caseFile: CaseFile): string {
  const walletSections = caseFile.wallets
    .map((w, i) => walletSection(w, i))
    .join("\n");

  const totalValue = caseFile.wallets.reduce(
    (s, w) => s + (w.scan?.totalValueChf ?? 0),
    0
  );
  const chains = Array.from(
    new Set(
      caseFile.wallets.flatMap((w) => w.scan?.chains.map((c) => c.chain) ?? [])
    )
  );

  const overallTier = caseFile.overallRisk || "—";
  const overallColor =
    overallTier === "GREEN" ? "#10b981" :
    overallTier === "AMBER" ? "#f59e0b" :
    overallTier === "RED" ? "#ef4444" : "#6b7280";

  const tierDescs = ["A", "B", "C"]
    .map((t) => `<li><strong>Tier ${t}:</strong> ${esc(tierDescription(t as "A" | "B" | "C"))}</li>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>SoW Compliance Report — ${esc(caseFile.caseReference)}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #fff;
    color: #111;
    margin: 0;
    padding: 28px;
    font-size: 12.5px;
    line-height: 1.5;
  }
  header { border-bottom: 3px solid #111; padding-bottom: 12px; margin-bottom: 24px; }
  header h1 { margin: 0 0 4px; font-size: 22px; }
  header .sub { color: #475569; font-size: 12px; }
  header .confidential {
    display: inline-block;
    margin-top: 6px;
    padding: 3px 8px;
    border: 1px solid #dc2626;
    color: #dc2626;
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 0.05em;
  }
  h2 { font-size: 16px; margin: 28px 0 10px; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; }
  h3 { font-size: 14px; margin: 22px 0 6px; color: #111; }
  h4 { font-size: 12.5px; margin: 16px 0 6px; color: #334155; }
  h5 { font-size: 12px; margin: 10px 0 4px; color: #475569; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0 14px; }
  th, td { text-align: left; border-bottom: 1px solid #e2e8f0; padding: 6px 8px; font-size: 11.5px; vertical-align: top; }
  th { color: #475569; font-weight: 600; background: #f8fafc; }
  code { font-family: "SFMono-Regular", Menlo, Consolas, monospace; font-size: 11px; }
  .muted { color: #64748b; font-size: 11.5px; }
  .ok { color: #047857; font-weight: 700; }
  .fail { color: #b91c1c; font-weight: 700; }
  .pending { color: #b45309; font-weight: 700; }
  .overall {
    display: flex; gap: 16px; align-items: center;
    border: 2px solid ${overallColor};
    padding: 14px 16px;
    border-radius: 8px;
    margin: 12px 0;
  }
  .overall .big { font-size: 28px; font-weight: 900; color: ${overallColor}; }
  .sanctions { background: #fee2e2; border: 1px solid #fecaca; padding: 10px 12px; margin: 10px 0; border-radius: 6px; color: #7f1d1d; }
  .classification {
    border: 2px solid;
    padding: 12px 14px;
    border-radius: 6px;
    margin: 8px 0;
    background: #f8fafc;
  }
  .classification-tier { font-size: 22px; font-weight: 900; letter-spacing: 0.05em; }
  .classification ul { margin: 6px 0; padding-left: 18px; }
  .ttp {
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    padding: 12px 14px;
    border-radius: 6px;
    margin: 14px 0;
  }
  .svg-wrap { margin: 10px 0; overflow: hidden; border: 1px solid #e2e8f0; border-radius: 6px; }
  .svg-wrap svg { max-width: 100%; height: auto; display: block; }
  .tier { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 700; margin-left: 4px; }
  .tier-A { background: #d1fae5; color: #065f46; }
  .tier-B { background: #fef3c7; color: #92400e; }
  .tier-C { background: #fee2e2; color: #991b1b; }
  .signoff { margin-top: 40px; border-top: 1px solid #111; padding-top: 20px; }
  .sig-line { display: flex; gap: 40px; margin: 24px 0; }
  .sig-line > div { flex: 1; border-bottom: 1px solid #111; padding: 20px 0 4px; }
  .sig-line .lbl { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
  section.wallet { page-break-inside: avoid; margin-top: 20px; padding: 12px 14px; border: 1px solid #e2e8f0; border-radius: 8px; }
  @media print {
    body { padding: 0; }
    section.wallet { border: none; padding: 0; }
  }
  .print-btn {
    position: fixed; top: 16px; right: 16px;
    background: #111; color: #fff; border: none; padding: 10px 16px;
    border-radius: 6px; font-size: 13px; cursor: pointer;
  }
  @media print { .print-btn { display: none; } }
</style>
</head>
<body>
<button class="print-btn" onclick="window.print()">Save as PDF</button>
<header>
  <h1>Crypto Source of Wealth Compliance Report</h1>
  <div class="sub">Case ${esc(caseFile.caseReference)} · Generated ${esc(new Date().toISOString())}</div>
  <div class="confidential">CONFIDENTIAL — for client file and regulator use only</div>
</header>

<h2>Client Summary</h2>
<table>
  <tr><th>Client name</th><td>${esc(caseFile.clientName)}</td></tr>
  <tr><th>Case reference</th><td><code>${esc(caseFile.caseReference)}</code></td></tr>
  <tr><th>Case status</th><td>${esc(caseFile.status)}</td></tr>
  <tr><th>Created</th><td>${esc(caseFile.createdAt)}</td></tr>
  <tr><th>Wallets submitted</th><td>${caseFile.wallets.length}</td></tr>
  <tr><th>Aggregate portfolio value (scan time)</th><td>${chf(totalValue)}</td></tr>
  <tr><th>Chains involved</th><td>${chains.length > 0 ? esc(chains.join(", ")) : "—"}</td></tr>
</table>

<div class="overall">
  <div class="big">${overallTier}</div>
  <div>
    <div style="font-weight:700;">Overall risk determination</div>
    <div class="muted">Aggregate across all verified wallets</div>
  </div>
</div>

<h4>Exchange tier reliance framework</h4>
<ul>${tierDescs}</ul>

<h2>Per-Wallet Assessment</h2>
${walletSections}

<div class="signoff">
  <h2>Compliance Officer Sign-off</h2>
  <p>I have reviewed the source of wealth evidence attached to this file and confirm the risk determination above is supported by the traceable on-chain evidence.</p>
  <div class="sig-line">
    <div>
      <div class="lbl">Determination</div>
      <div>${esc(caseFile.determination || "")}&nbsp;</div>
    </div>
    <div>
      <div class="lbl">Compliance Officer Name</div>
      <div>${esc(caseFile.signOffName || "")}&nbsp;</div>
    </div>
    <div>
      <div class="lbl">Date</div>
      <div>${esc(caseFile.signOffDate || "")}&nbsp;</div>
    </div>
  </div>
</div>
</body>
</html>`;
}
