#!/usr/bin/env node
/**
 * Generates corrections.json from events.jsonl to repair historical data issues.
 *
 * Usage:
 *   node generate-corrections.mjs /path/to/events.jsonl [--aero-price 0.32] [--out corrections.json]
 *
 * Corrections applied:
 *   1. bandHalfBps > 5000: recompute from tickLower/tickUpper
 *   2. feesCollectedUsd === 0 on REBALANCE_CLOSE/CLOSE_POSITION with feesOut: recompute from feesOut
 *   3. rewardsUsd === 0 on EMISSIONS_UNSTAKE/EMISSIONS_CLAIM with aeroClaimed > 0: backfill with AERO price
 */

import { readFileSync, writeFileSync } from "fs";

const args = process.argv.slice(2);
const eventsPath = args.find((a) => !a.startsWith("--")) || "events.jsonl";
const aeroPriceIdx = args.indexOf("--aero-price");
const aeroPrice = aeroPriceIdx >= 0 ? Number(args[aeroPriceIdx + 1] || 0) : 0.32;
const outIdx = args.indexOf("--out");
const outPath = outIdx >= 0 ? args[outIdx + 1] : "corrections.json";

function estimateBandHalfBpsFromTicks(tickLower, tickUpper) {
  const lower = Number(tickLower);
  const upper = Number(tickUpper);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) return null;
  const halfTicks = Math.max(1, Math.round((upper - lower) / 2));
  const priceFactor = Math.pow(1.0001, halfTicks);
  if (!Number.isFinite(priceFactor) || priceFactor <= 1) return null;
  const bps = Math.round((priceFactor - 1) * 10000);
  return bps > 0 ? bps : null;
}

const raw = readFileSync(eventsPath, "utf-8");
const lines = raw.split("\n").filter((l) => l.trim());
const events = lines.map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

console.log(`Loaded ${events.length} events from ${eventsPath}`);
console.log(`AERO price for backfill: $${aeroPrice}`);

const corrections = {};
let bandFixes = 0;
let feeFixes = 0;
let aeroFixes = 0;

for (const ev of events) {
  if (!ev.id) continue;
  const corr = {};

  // 1. Band fix
  if (ev.band && Number(ev.band.bandHalfBps || 0) > 5000) {
    const fixed = estimateBandHalfBpsFromTicks(ev.band.tickLower, ev.band.tickUpper);
    if (fixed && fixed > 0 && fixed <= 5000) {
      corr.band = { bandHalfBps: fixed };
      bandFixes++;
    }
  }

  // 2. Fee fix
  const type = String(ev.type || "");
  if ((type === "REBALANCE_CLOSE" || type === "CLOSE_POSITION") &&
      Number(ev.accounting?.feesCollectedUsd || 0) === 0 &&
      ev.details?.feesOut && typeof ev.details.feesOut === "object") {
    const feesUsdc = Number(ev.details.feesOut.usdc || 0);
    const feesWeth = Number(ev.details.feesOut.weth || 0);
    const spot = Number(ev.spotPriceUsdcPerWeth || 0);
    const feesUsd = feesUsdc + feesWeth * spot;
    if (feesUsd > 0.001) {
      corr.accounting = { ...(corr.accounting || {}), feesCollectedUsd: feesUsd };
      feeFixes++;
    }
  }

  // 3. AERO rewards fix
  if ((type === "EMISSIONS_UNSTAKE" || type === "EMISSIONS_CLAIM") &&
      Number(ev.accounting?.rewardsUsd || 0) === 0 &&
      Number(ev.details?.aeroClaimed || 0) > 0) {
    const priceToUse = Number(ev.details?.aeroPrice || 0) || aeroPrice;
    if (priceToUse > 0) {
      const rewardsUsd = Number(ev.details.aeroClaimed) * priceToUse;
      corr.accounting = { ...(corr.accounting || {}), rewardsUsd };
      aeroFixes++;
    }
  }

  if (Object.keys(corr).length > 0) {
    corrections[ev.id] = corr;
  }
}

const output = { version: 1, generatedAtIso: new Date().toISOString(), corrections };
writeFileSync(outPath, JSON.stringify(output, null, 2));

console.log(`\nCorrections generated:`);
console.log(`  Band fixes: ${bandFixes}`);
console.log(`  Fee fixes: ${feeFixes}`);
console.log(`  AERO reward fixes: ${aeroFixes}`);
console.log(`  Total corrections: ${Object.keys(corrections).length}`);
console.log(`\nWritten to ${outPath}`);
