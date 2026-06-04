// scripts/tempo-handshake.mjs
//
// UC8 · Task 1 — Tempo Testnet (Moderato) connectivity handshake (CLI).
//
//   1. checks the chain is reachable (block height > 0 and increasing)
//   2. funds the dev address via the tempo_fundAddress faucet RPC
//   3. reads back the pathUSD (TIP-20) balance to confirm the faucet worked
//
// Prints a "connection OK" block. NEVER reads or prints the private key — the
// faucet and balance reads need no signature, only the public address.
//
// The constants below mirror shared/lib/tempo.ts (the app's source of truth);
// this script is standalone so it runs with plain `node` (no Next.js / tsx).
//
// Run from the repo root:  node scripts/tempo-handshake.mjs
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http, formatUnits } from "viem";

const RPC_HTTP = "https://rpc.moderato.tempo.xyz";
const CHAIN_ID = 42431;
const EXPLORER = "https://explore.moderato.tempo.xyz";
const PATH_USD = "0x20c0000000000000000000000000000000000000"; // predeployed TIP-20

const ERC20_MIN_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
];

// Parse a single key from .env.local without loading other secrets into the process.
function readEnvVar(key) {
  const p = resolve(process.cwd(), ".env.local");
  if (!existsSync(p)) return undefined;
  const line = readFileSync(p, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const group = (s) => {
  const [i, f] = String(s).split(".");
  return (f ? `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${f}` : i.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
};

const devAddress = readEnvVar("TEMPO_DEV_ADDRESS");
const rpcUrl = readEnvVar("TEMPO_RPC_URL") || RPC_HTTP;

if (!devAddress) {
  console.error("No TEMPO_DEV_ADDRESS in .env.local — run: node scripts/tempo-keygen.mjs");
  process.exit(1);
}

const client = createPublicClient({
  chain: { id: CHAIN_ID, name: "Tempo Testnet (Moderato)", nativeCurrency: { name: "USD", symbol: "USD", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
  transport: http(rpcUrl),
});

async function pathUsdBalance(owner) {
  const [raw, decimals, symbol] = await Promise.all([
    client.readContract({ address: PATH_USD, abi: ERC20_MIN_ABI, functionName: "balanceOf", args: [owner] }),
    client.readContract({ address: PATH_USD, abi: ERC20_MIN_ABI, functionName: "decimals" }),
    client.readContract({ address: PATH_USD, abi: ERC20_MIN_ABI, functionName: "symbol" }),
  ]);
  return { raw, decimals: Number(decimals), symbol, formatted: formatUnits(raw, Number(decimals)) };
}

console.log("=== Tempo Testnet (Moderato) handshake ===");
console.log("RPC:       ", rpcUrl);

// 1. reachability + liveness
const chainId = await client.getChainId();
const block1 = await client.getBlockNumber();
console.log(`Chain ID:   ${chainId}  (expected ${CHAIN_ID})  ${chainId === CHAIN_ID ? "OK" : "MISMATCH"}`);
console.log(`Block #1:   ${group(block1.toString())}`);
// Tempo produces blocks in bursts, so poll up to ~20s for an increase.
let block2 = block1;
for (let i = 0; i < 10 && block2 <= block1; i++) {
  await sleep(2000);
  block2 = await client.getBlockNumber();
}
console.log(`Block #2:   ${group(block2.toString())}   (${block2 > block1 ? "increasing OK" : "no increase observed"})`);

// 2. fund + 3. read back
console.log("Dev addr:  ", devAddress);
const before = await pathUsdBalance(devAddress);
console.log(`pathUSD before:  ${group(before.formatted)} ${before.symbol}`);

// The faucet STACKS (+1,000,000 per call), so only fund when below 1,000,000.
const ONE_MILLION = 1_000_000n * 10n ** BigInt(before.decimals);
let list = [];
if (before.raw >= ONE_MILLION) {
  console.log("Already funded (>= 1,000,000 pathUSD) — skipping faucet to avoid stacking.");
} else {
  console.log("Funding via tempo_fundAddress ...");
  const hashes = await client.request({ method: "tempo_fundAddress", params: [devAddress] });
  list = Array.isArray(hashes) ? hashes : [hashes];
  for (const h of list) console.log("  minted tx:", h);
  // The faucet returns hashes before inclusion — wait so the balance read is accurate.
  process.stdout.write("Waiting for mint txs to be mined ... ");
  await Promise.allSettled(list.map((h) => client.waitForTransactionReceipt({ hash: h, timeout: 25_000 })));
  console.log("done");
}

const after = await pathUsdBalance(devAddress);
console.log(`pathUSD ${list.length ? "after: " : "now:   "}  ${group(after.formatted)} ${after.symbol}   (${after.raw.toString()} base units, ${after.decimals} decimals)`);
console.log("Explorer:  ", `${EXPLORER}/address/${devAddress}`);

const connected = block1 > 0n && chainId === CHAIN_ID;
console.log("");
console.log(`connected = ${connected}`);
console.log(connected ? "=== connection OK ===" : "=== connection FAILED ===");
process.exit(connected ? 0 : 1);
