// scripts/tempo-act2-setup.mjs
//
// UC8 · Task 3 / Step 5 — Act 2 tokenized-deposit rail (internal layer only, no FX/payout).
//
//   1. create tCHF (currency "CHF") via the TIP-20 factory
//   2. generate 4 sub-accounts (HQ, Frankfurt, New York, Lagos)
//   3. provision each for fees in pathUSD (faucet + setUserToken) — tCHF can't pay fees
//   4. seed initial tCHF balances (minted by issuer A)
//   5. test all four-way moveOnRail transfers (LIVE) and check the tCHF deltas
//
// Idempotent. Run from the repo root:  node scripts/tempo-act2-setup.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  SUB_ACCOUNTS, ensureTCHF, ensureSubProvisioned, ensureSeed, moveOnRail, tchfBalance, subAddress, getTreasuryState,
} from "../shared/lib/tempo-treasury.ts";

const ENV_PATH = resolve(process.cwd(), ".env.local");
function loadEnv() {
  if (!existsSync(ENV_PATH)) return;
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}
function upsertEnv(key, value) {
  const cur = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  const next = re.test(cur) ? cur.replace(re, `${key}=${value}`) : cur.replace(/\n*$/, `\n${key}=${value}\n`);
  writeFileSync(ENV_PATH, next, "utf8");
  process.env[key] = value;
}
const fmt = (n) => Number(formatUnits(n, 6)).toLocaleString("en-US");

loadEnv();
if (!process.env.TEMPO_DEV_PRIVATE_KEY) { console.error("Missing TEMPO_DEV_PRIVATE_KEY (run scripts/tempo-keygen.mjs)"); process.exit(1); }

console.log("=== UC8 Task 3 / Step 5 — Act 2 tokenized-deposit rail ===");

// 1) sub-account keypairs (throwaway, gitignored) — generate once
console.log("\n[1] sub-accounts");
for (const s of SUB_ACCOUNTS) {
  const pkKey = `TEMPO_SUB_${s.id}_PRIVATE_KEY`, addrKey = `TEMPO_SUB_${s.id}_ADDRESS`;
  if (!process.env[pkKey]) {
    const pk = generatePrivateKey();
    upsertEnv(pkKey, pk);
    upsertEnv(addrKey, privateKeyToAccount(pk).address);
  }
  console.log(`  ${s.id.padEnd(3)} ${s.label.padEnd(12)} ${process.env[addrKey]}`);
}

// 2) create tCHF
console.log("\n[2] tCHF token (factory)");
const { address: tchf, created } = await ensureTCHF();
upsertEnv("TEMPO_TCHF_ADDRESS", tchf);
console.log(`  tCHF: ${tchf} ${created ? "(created)" : "(reused)"}  currency=CHF decimals=6`);

// 3) provision fees (pathUSD) for every sub-account
console.log("\n[3] provision fees in pathUSD (faucet + setUserToken)");
for (const s of SUB_ACCOUNTS) {
  const r = await ensureSubProvisioned(s.id);
  console.log(`  ${s.id.padEnd(3)} funded=${r.funded} feeTokenSet=${r.feeSet}`);
}

// 4) seed tCHF balances (minted by issuer A)
console.log("\n[4] seed tCHF balances");
for (const s of SUB_ACCOUNTS) {
  const r = await ensureSeed(s.id, s.seed);
  console.log(`  ${s.id.padEnd(3)} ${fmt(r.balance).padStart(12)} tCHF ${r.minted ? "(minted)" : "(already seeded)"}`);
}

// 5) test all four-way moves (LIVE) and verify exact tCHF deltas
console.log("\n[5] four-way moveOnRail tests (LIVE)");
const MOVES = [
  ["HQ", "FRA", 100_000],
  ["HQ", "NYC", 100_000],
  ["HQ", "LAG", 50_000],
  ["FRA", "HQ", 25_000],
];
let failed = 0;
for (const [from, to, amt] of MOVES) {
  const [fromBefore, toBefore] = [await tchfBalance(from), await tchfBalance(to)];
  const m = await moveOnRail(from, to, amt);
  const [fromAfter, toAfter] = [await tchfBalance(from), await tchfBalance(to)];
  const unit = BigInt(amt) * BigInt(1_000_000);
  const ok = m.status === "success" && fromBefore - fromAfter === unit && toAfter - toBefore === unit;
  if (!ok) failed++;
  console.log(`  ${from}->${to} ${amt.toLocaleString("en-US").padStart(8)} tCHF  [${m.status}] ${(m.elapsedMs / 1000).toFixed(1)}s  delta ${ok ? "OK" : "MISMATCH"}  ${m.hash.slice(0, 12)}…`);
}

// final snapshot
console.log("\n=== TREASURY SNAPSHOT ===");
const state = await getTreasuryState();
for (const s of state.subs) console.log(`  ${s.id.padEnd(3)} ${s.label.padEnd(12)} ${s.tchf.toLocaleString("en-US").padStart(12)} tCHF   ${s.address}`);
console.log(`  total on rail: ${state.totalTchf.toLocaleString("en-US")} tCHF`);
console.log(`  tCHF token:    ${state.token}`);

console.log(`\n${failed === 0 ? "=== ALL FOUR-WAY MOVES PASS ===" : `=== ${failed} MOVE(S) FAILED ===`}`);
process.exit(failed === 0 ? 0 : 1);
