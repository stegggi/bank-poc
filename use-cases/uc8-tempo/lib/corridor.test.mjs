// use-cases/uc8-tempo/lib/corridor.test.mjs
//
// UC8 · Task 3 / Step 3 — test table for the Act 1 corridor engine.
// Plain Node (no test runner / no tsx): Node 23+ strips the TS types on import.
// Run from the repo root:  node use-cases/uc8-tempo/lib/corridor.test.mjs
import { getCorridorRules, getSendSequence } from "./corridor.ts";

const CASES = [
  { from: "CH", to: "NG", amt: 2000 },
  { from: "CH", to: "US", amt: 2000 }, // below FinCEN USD 3,000
  { from: "CH", to: "US", amt: 5000 }, // > 3,000 -> the US flip
  { from: "CH", to: "EU", amt: 2000 },
  { from: "CH", to: "US", amt: 500 }, // < CHF 1,000 -> travel rule below_threshold
];

const get = (res, key) => res.rows.find((r) => r.key === key).status;

// ── Print the table ──
for (const c of CASES) {
  const res = getCorridorRules(c.from, c.to, c.amt);
  console.log(`\n${res.tag}  (CHF ${c.amt.toLocaleString("en-US")})`);
  for (const r of res.rows) {
    console.log(`  ${r.key.padEnd(18)} ${String(r.status).padEnd(16)} ${r.meaning.slice(0, 74)}${r.meaning.length > 74 ? "…" : ""}`);
  }
}

// ── Assertions ──
const checks = [];
const expect = (label, actual, want) => checks.push({ label, ok: actual === want, actual, want });

const ng = getCorridorRules("CH", "NG", 2000);
expect("NG travel_rule = applies", get(ng, "travel_rule"), "applies");
expect("NG counterparty = unverified", get(ng, "counterparty"), "unverified");
expect("NG sanctions = cleared", get(ng, "sanctions"), "cleared");
expect("NG recipient_licence = manual_review", get(ng, "recipient_licence"), "manual_review");
expect("NG data_secrecy = restricted", get(ng, "data_secrecy"), "restricted");

const us2k = getCorridorRules("CH", "US", 2000);
expect("US@2000 counterparty = below_threshold", get(us2k, "counterparty"), "below_threshold");
expect("US@2000 recipient_licence = cleared", get(us2k, "recipient_licence"), "cleared");

const us5k = getCorridorRules("CH", "US", 5000);
expect("US@5000 counterparty = applies (the >3,000 flip)", get(us5k, "counterparty"), "applies");

const eu = getCorridorRules("CH", "EU", 2000);
expect("EU counterparty = applies (TFR zero threshold)", get(eu, "counterparty"), "applies");
expect("EU recipient_licence = cleared", get(eu, "recipient_licence"), "cleared");

const usLow = getCorridorRules("CH", "US", 500);
expect("US@500 travel_rule = below_threshold (< CHF 1,000)", get(usLow, "travel_rule"), "below_threshold");

// ── Send sequence: NG must stay held (never auto-settles); US/EU settle live ──
const seqOutcome = (res, key) => getSendSequence(res).find((s) => s.key === key).outcome;
expect("NG confirm step = held (human in the loop)", seqOutcome(ng, "confirm"), "held");
expect("NG settle step = held (does NOT auto-settle)", seqOutcome(ng, "settle"), "held");
expect("US@2000 settle step = done (fires live)", seqOutcome(us2k, "settle"), "done");
expect("US@5000 settle step = done (fires live)", seqOutcome(us5k, "settle"), "done");
expect("EU settle step = done (fires live)", seqOutcome(eu, "settle"), "done");
expect("NG screen step = done (sanctions cleared)", seqOutcome(ng, "screen"), "done");

console.log("\n=== ASSERTIONS ===");
let failed = 0;
for (const c of checks) {
  console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}${c.ok ? "" : `  (got "${c.actual}", want "${c.want}")`}`);
  if (!c.ok) failed++;
}
console.log(`\n${failed === 0 ? `=== ALL ${checks.length} CHECKS PASS ===` : `=== ${failed} / ${checks.length} FAILED ===`}`);
process.exit(failed === 0 ? 0 : 1);
