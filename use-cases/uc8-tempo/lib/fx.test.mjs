// use-cases/uc8-tempo/lib/fx.test.mjs
//
// UC8 — test the FX accounting (Limmat does all FX; thinner margin on the hard NGN corridor).
// Plain Node (Node 23+ strips TS types). Run: node use-cases/uc8-tempo/lib/fx.test.mjs
import { priceConversion, fxRevenue30d } from "./fx.ts";

const checks = [];
const expect = (label, actual, want) => checks.push({ label, ok: actual === want, actual, want });

// Liquid corridor: full spread to Limmat.
const eur = priceConversion("CHF", "EUR", 1_000_000);
console.log("CHF→EUR 1,000,000:", JSON.stringify({ rate: eur.rate, liquidity: eur.liquidity, limmat: eur.limmatEarns, bps: eur.limmatBps }));
expect("CHF→EUR is liquid", eur.liquidity, "liquid");
expect("CHF→EUR Limmat full spread (25 bps = 2,500)", eur.limmatEarns, 2_500);
expect("CHF→EUR rate = 1.05", eur.rate, 1.05);

// Hard corridor: thin margin, no partner.
const ngn = priceConversion("CHF", "NGN", 1_000_000);
console.log("CHF→NGN 1,000,000:", JSON.stringify({ rate: ngn.rate, liquidity: ngn.liquidity, limmat: ngn.limmatEarns, bps: ngn.limmatBps }));
expect("CHF→NGN is hard", ngn.liquidity, "hard");
expect("CHF→NGN Limmat thin margin (15 bps = 1,500)", ngn.limmatEarns, 1_500);
expect("CHF→NGN has no partner field", "partner" in ngn, false);
expect("CHF→NGN Limmat earns FEWER bps than a liquid corridor", ngn.limmatBps < eur.limmatBps, true);

// 30-day aggregate fed to the revenue strip.
const rev = fxRevenue30d();
console.log("30d FX revenue (Limmat):", JSON.stringify({ limmat: rev.limmat }));
expect("30d Limmat = 10,500 + 7,000 + 1,350 = 18,850", rev.limmat, 18_850);
expect("no partner total in the aggregate", "partner" in rev, false);

console.log("\n=== ASSERTIONS ===");
let failed = 0;
for (const c of checks) {
  console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}${c.ok ? "" : `  (got ${c.actual}, want ${c.want})`}`);
  if (!c.ok) failed++;
}
console.log(`\n${failed === 0 ? `=== ALL ${checks.length} CHECKS PASS ===` : `=== ${failed} / ${checks.length} FAILED ===`}`);
process.exit(failed === 0 ? 0 : 1);
