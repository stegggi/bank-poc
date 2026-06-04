// scripts/tempo-factory-policy.mjs
//
// UC8 · Task 2 — TIP-20 factory + TIP-403 policy (hello-world), end to end.
//
// Proves the REAL Tempo pattern (NOT a plain ERC-20):
//   1. create mUSDC via the canonical TIP20Factory precompile (deterministic addr)
//   2. grant ISSUER_ROLE to A and mint a 6-decimal test supply to A
//   3. create a TIP-403 WHITELIST policy [A,B] and attach it via changeTransferPolicyId
//   4. transferWithMemo A->B (32-byte memo must round-trip exactly)
//   5. transferWithMemo A->C (C not allowlisted) must REVERT with PolicyForbids
//
// ABIs below are transcribed from the installed tempo-std interfaces
// (/tmp/tempo-std/src/interfaces/*.sol — tempoxyz/tempo-std), the authoritative source.
//
// Toolchain note: the task specifies the Tempo Foundry fork (foundryup -n tempo).
// That auto-install was blocked by this environment's safety classifier, so this runs
// on the repo's existing viem. It still calls the real factory/registry precompiles at
// their canonical addresses with the real interfaces; gas settles against the testnet's
// placeholder native balance (no --tempo.fee-token needed). See the handoff for details.
//
// Idempotent: safe to re-run. Run from repo root:  node scripts/tempo-factory-policy.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient, createWalletClient, http,
  keccak256, toBytes, stringToHex, hexToString, trim, parseEventLogs, formatUnits,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

// ── Canonical Tempo Moderato addresses (predeployed system contracts) ──
const RPC = "https://rpc.moderato.tempo.xyz";
const EXPLORER = "https://explore.moderato.tempo.xyz";
const FACTORY = "0x20fc000000000000000000000000000000000000";
const REGISTRY = "0x403c000000000000000000000000000000000000";
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const FEE_MANAGER = "0xfeec000000000000000000000000000000000000";

const SALT = keccak256(toBytes("uc8-mUSDC-v1"));
const TOKEN_NAME = "Mock USDC", TOKEN_SYMBOL = "mUSDC", TOKEN_CURRENCY = "USD";
const SIX = 10n ** 6n;
const MINT_AMOUNT = 1_000_000n * SIX; // 1,000,000 mUSDC test supply
const XFER_AMOUNT = 1_000n * SIX;     // 1,000 mUSDC per transfer
const MEMO_REF = "UC8-INV-2026-0001"; // payment reference packed into 32 bytes

// ── .env.local helpers (read one var; upsert without printing secrets) ──
const ENV_PATH = resolve(process.cwd(), ".env.local");
function readEnv(key) {
  if (!existsSync(ENV_PATH)) return undefined;
  const line = readFileSync(ENV_PATH, "utf8").split("\n").find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}
function upsertEnv(key, value) {
  const cur = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  const next = re.test(cur) ? cur.replace(re, `${key}=${value}`) : cur.replace(/\n*$/, `\n${key}=${value}\n`);
  writeFileSync(ENV_PATH, next, "utf8");
}
/** Ensure a throwaway party wallet exists in .env.local; return its address (key never printed). */
function ensureParty(label) {
  const addrKey = `TEMPO_PARTY_${label}_ADDRESS`, pkKey = `TEMPO_PARTY_${label}_PRIVATE_KEY`;
  let addr = readEnv(addrKey);
  if (!addr) {
    const pk = generatePrivateKey();
    addr = privateKeyToAccount(pk).address;
    upsertEnv(pkKey, pk);
    upsertEnv(addrKey, addr);
  }
  return addr;
}

// ── ABIs (from tempo-std interfaces) ──
const FACTORY_ABI = [
  { name: "createToken", type: "function", stateMutability: "nonpayable", inputs: [{ name: "name", type: "string" }, { name: "symbol", type: "string" }, { name: "currency", type: "string" }, { name: "quoteToken", type: "address" }, { name: "admin", type: "address" }, { name: "salt", type: "bytes32" }], outputs: [{ type: "address" }] },
  { name: "getTokenAddress", type: "function", stateMutability: "pure", inputs: [{ name: "sender", type: "address" }, { name: "salt", type: "bytes32" }], outputs: [{ type: "address" }] },
  { name: "isTIP20", type: "function", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "bool" }] },
];
const TOKEN_ABI = [
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "currency", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "pure", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "transferPolicyId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { name: "ISSUER_ROLE", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { name: "hasRole", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }, { name: "role", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { name: "grantRole", type: "function", stateMutability: "nonpayable", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [] },
  { name: "mint", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { name: "changeTransferPolicyId", type: "function", stateMutability: "nonpayable", inputs: [{ name: "newPolicyId", type: "uint64" }], outputs: [] },
  { name: "transferWithMemo", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }, { name: "memo", type: "bytes32" }], outputs: [] },
  { type: "event", name: "TransferWithMemo", inputs: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }, { name: "memo", type: "bytes32", indexed: true }] },
  { type: "error", name: "PolicyForbids", inputs: [] },
];
const REGISTRY_ABI = [
  { name: "createPolicyWithAccounts", type: "function", stateMutability: "nonpayable", inputs: [{ name: "admin", type: "address" }, { name: "policyType", type: "uint8" }, { name: "accounts", type: "address[]" }], outputs: [{ name: "newPolicyId", type: "uint64" }] },
  { name: "modifyPolicyWhitelist", type: "function", stateMutability: "nonpayable", inputs: [{ name: "policyId", type: "uint64" }, { name: "account", type: "address" }, { name: "allowed", type: "bool" }], outputs: [] },
  { name: "policyExists", type: "function", stateMutability: "view", inputs: [{ name: "policyId", type: "uint64" }], outputs: [{ type: "bool" }] },
  { name: "policyData", type: "function", stateMutability: "view", inputs: [{ name: "policyId", type: "uint64" }], outputs: [{ name: "policyType", type: "uint8" }, { name: "admin", type: "address" }] },
  { name: "isAuthorized", type: "function", stateMutability: "view", inputs: [{ name: "policyId", type: "uint64" }, { name: "user", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "event", name: "PolicyCreated", inputs: [{ name: "policyId", type: "uint64", indexed: true }, { name: "updater", type: "address", indexed: true }, { name: "policyType", type: "uint8", indexed: false }] },
];
const FEE_MANAGER_ABI = [
  { name: "setUserToken", type: "function", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }], outputs: [] },
  { name: "userTokens", type: "function", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "address" }] },
];
const WHITELIST = 0; // PolicyType.WHITELIST

// ── Setup ──
const aPk = readEnv("TEMPO_DEV_PRIVATE_KEY");
if (!aPk) { console.error("Missing TEMPO_DEV_PRIVATE_KEY in .env.local (run scripts/tempo-keygen.mjs)"); process.exit(1); }
const A = privateKeyToAccount(aPk);
const B = ensureParty("B"); // allowlisted recipient
const C = ensureParty("C"); // NOT allowlisted (must be blocked)

const chain = { id: 42431, name: "Tempo Testnet (Moderato)", nativeCurrency: { name: "USD", symbol: "USD", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account: A, chain, transport: http(RPC) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => formatUnits(n, 6);
const errName = (e) => {
  const s = `${e?.cause?.data?.errorName || ""} ${e?.shortMessage || e?.message || ""}`;
  return /PolicyForbids/.test(s) ? "PolicyForbids" : (e?.cause?.data?.errorName || (e?.shortMessage || "").split("\n")[0] || "revert");
};
// Tempo's RPC is load-balanced; a tx that depends on just-written state can hit a
// lagging node and get rejected at submission. retries=N rides out that propagation lag.
const send = async (label, params, retries = 1) => {
  for (let i = 1; i <= retries; i++) {
    try {
      const hash = await wallet.writeContract(params);
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
      console.log(`  ${label}: ${hash} [${r.status}]`);
      if (r.status !== "success") throw new Error(`${label} reverted on-chain`);
      return r;
    } catch (e) {
      if (i >= retries) throw e;
      console.log(`  ${label}: transient (${errName(e)}), retry ${i}/${retries - 1}...`);
      await sleep(3000);
    }
  }
};
const trySim = async (params) => {
  try { await pub.simulateContract({ ...params, account: A }); return true; } catch { return false; }
};
// Poll until a state-dependent call is simulatable (i.e. the node has synced prior writes).
const waitActive = async (params, label, ms = 45_000) => {
  for (let waited = 0; waited <= ms; waited += 2500) {
    if (await trySim(params)) return true;
    console.log(`  waiting for ${label} to become active...`);
    await sleep(2500);
  }
  return false;
};

console.log("=== UC8 Task 2 — TIP-20 factory + TIP-403 policy ===");
console.log("A (issuer/sender):", A.address);
console.log("B (allowlisted)  :", B);
console.log("C (blocked)      :", C);

// ── 0. Fee token: pay tx fees in pathUSD (the predeployed USD stablecoin). ──
// Tempo has no native gas token; fees are charged in a TIP-20. With no preference the
// fee resolves to the token being moved (here mUSDC) — but a brand-new token has no
// FeeAMM liquidity, AND under a whitelist the fee transfer to the validator is itself
// blocked -> transfers fail with "insufficient liquidity in FeeAMM pool" or PolicyForbids.
// Pinning the fee token to pathUSD (liquid + permissive) is the on-chain equivalent of
// forge's --tempo.fee-token flag. Persistent per-account, so this is idempotent.
console.log("\n[0] fee token preference");
const curFee = await pub.readContract({ address: FEE_MANAGER, abi: FEE_MANAGER_ABI, functionName: "userTokens", args: [A.address] });
if (curFee.toLowerCase() !== PATHUSD.toLowerCase()) {
  await send("setUserToken(pathUSD)", { address: FEE_MANAGER, abi: FEE_MANAGER_ABI, functionName: "setUserToken", args: [PATHUSD] });
} else console.log("  fee token already pathUSD");
console.log("  fee token (userTokens[A]):", await pub.readContract({ address: FEE_MANAGER, abi: FEE_MANAGER_ABI, functionName: "userTokens", args: [A.address] }));

// ── 1. Create mUSDC through the factory (idempotent via deterministic salt) ──
console.log("\n[1] createToken via factory");
const token = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: "getTokenAddress", args: [A.address, SALT] });
if (await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: "isTIP20", args: [token] })) {
  console.log("  already exists, reusing:", token);
} else {
  await send("createToken", { address: FACTORY, abi: FACTORY_ABI, functionName: "createToken", args: [TOKEN_NAME, TOKEN_SYMBOL, TOKEN_CURRENCY, PATHUSD, A.address, SALT] });
}
upsertEnv("TEMPO_MUSDC_ADDRESS", token);
const [nm, sym, cur, dec] = await Promise.all([
  pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "name" }),
  pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "symbol" }),
  pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "currency" }),
  pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "decimals" }),
]);
console.log(`  token: ${token}`);
console.log(`  name=${nm} symbol=${sym} currency=${cur} decimals=${dec}`);

// ── 2. Grant ISSUER_ROLE to A, mint test supply to A (under default policy) ──
console.log("\n[2] issuer role + mint");
const ISSUER_ROLE = await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "ISSUER_ROLE" });
if (!(await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "hasRole", args: [A.address, ISSUER_ROLE] }))) {
  await send("grantRole(ISSUER, A)", { address: token, abi: TOKEN_ABI, functionName: "grantRole", args: [ISSUER_ROLE, A.address] });
} else console.log("  A already has ISSUER_ROLE");
let balA = await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [A.address] });
if (balA < XFER_AMOUNT * 3n) {
  await send(`mint ${fmt(MINT_AMOUNT)} mUSDC -> A`, { address: token, abi: TOKEN_ABI, functionName: "mint", args: [A.address, MINT_AMOUNT] });
  balA = await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [A.address] });
} else console.log("  A already funded, skipping mint");
console.log(`  A balance: ${fmt(balA)} mUSDC (${balA} base units)`);

// ── 3. TIP-403 WHITELIST policy [A,B], attach to mUSDC ──
console.log("\n[3] TIP-403 allowlist policy");
let policyId = readEnv("TEMPO_POLICY_ID") ? BigInt(readEnv("TEMPO_POLICY_ID")) : 0n;
const policyValid = policyId > 0n
  && (await pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: "policyExists", args: [policyId] }))
  && (await pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: "isAuthorized", args: [policyId, A.address] }))
  && (await pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: "isAuthorized", args: [policyId, B] }));
if (!policyValid) {
  const r = await send("createPolicyWithAccounts(WHITELIST,[A,B])", { address: REGISTRY, abi: REGISTRY_ABI, functionName: "createPolicyWithAccounts", args: [A.address, WHITELIST, [A.address, B]] });
  const ev = parseEventLogs({ abi: REGISTRY_ABI, eventName: "PolicyCreated", logs: r.logs })[0];
  policyId = ev.args.policyId;
  upsertEnv("TEMPO_POLICY_ID", policyId.toString());
} else console.log("  reusing existing policy");
console.log(`  policyId: ${policyId}`);
const curPolicy = await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "transferPolicyId" });
if (curPolicy !== policyId) {
  await send(`changeTransferPolicyId(${policyId})`, { address: token, abi: TOKEN_ABI, functionName: "changeTransferPolicyId", args: [policyId] });
} else console.log("  policy already attached");
const [authA, authB, authC] = await Promise.all([
  pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: "isAuthorized", args: [policyId, A.address] }),
  pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: "isAuthorized", args: [policyId, B] }),
  pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: "isAuthorized", args: [policyId, C] }),
]);
console.log(`  authorized? A=${authA} B=${authB} C=${authC} (token.transferPolicyId=${await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "transferPolicyId" })})`);

// ── 4. A -> B transferWithMemo; verify 32-byte memo round-trips ──
console.log("\n[4] A -> B transferWithMemo");
const memoSent = stringToHex(MEMO_REF, { size: 32 }); // right-padded to 32 bytes
const abParams = { address: token, abi: TOKEN_ABI, functionName: "transferWithMemo", args: [B, XFER_AMOUNT, memoSent] };
await waitActive(abParams, "A->B (policy propagation)"); // ride out RPC read-after-write lag
const rAB = await send(`transferWithMemo(B, ${fmt(XFER_AMOUNT)}, memo)`, abParams, 5);
const memoEv = parseEventLogs({ abi: TOKEN_ABI, eventName: "TransferWithMemo", logs: rAB.logs })[0];
const memoReadBack = memoEv.args.memo;
const memoMatch = memoReadBack.toLowerCase() === memoSent.toLowerCase();
console.log(`  memo sent     : ${memoSent}  ("${MEMO_REF}")`);
console.log(`  memo read back: ${memoReadBack}  ("${hexToString(trim(memoReadBack, { dir: "right" }))}")`);
console.log(`  match: ${memoMatch}`);
console.log(`  B balance: ${fmt(await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [B] }))} mUSDC`);

// ── 5. A -> C (not allowlisted) must be blocked by policy (PolicyForbids) ──
console.log("\n[5] A -> C must be blocked by policy");
const acParams = { address: token, abi: TOKEN_ABI, functionName: "transferWithMemo", args: [C, XFER_AMOUNT, memoSent] };
let blocked = { reverted: false, submitRejected: false, reason: "" };
try {
  await pub.simulateContract({ ...acParams, account: A });
} catch (e) {
  blocked.reverted = true;
  blocked.reason = errName(e);
}
// Tempo pre-validates on submission and refuses to include a guaranteed-revert tx,
// so attempting the real broadcast is itself the on-chain block proof.
try {
  const h = await wallet.writeContract(acParams);
  console.log("  UNEXPECTED: A->C was accepted:", h);
} catch (e) {
  blocked.submitRejected = true;
  blocked.reason = blocked.reason || errName(e);
}
console.log(`  blocked: sim-revert=${blocked.reverted}, submit-rejected=${blocked.submitRejected}, reason=${blocked.reason}`);

// ── Report ──
console.log("\n=== REPORT ===");
console.log("mUSDC token address :", token);
console.log("TIP-403 policy id   :", policyId.toString());
console.log("A -> B tx hash      :", rAB.transactionHash);
console.log(`memo sent / readback : ${memoSent} / ${memoReadBack} | match: ${memoMatch}`);
console.log(`A -> C blocked       : sim-revert=${blocked.reverted}, submit-rejected=${blocked.submitRejected}, reason=${blocked.reason}`);
console.log("explorer (token)    :", `${EXPLORER}/address/${token}`);

const pass = sym === TOKEN_SYMBOL && Number(dec) === 6 && memoMatch && blocked.reverted && authA && authB && !authC;
console.log(`\n${pass ? "=== ALL CHECKS PASS ===" : "=== CHECKS FAILED ==="}`);
process.exit(pass ? 0 : 1);
