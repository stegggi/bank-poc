// shared/lib/tempo-treasury.ts
//
// SERVER-ONLY — Act 2 tokenized-deposit rail. NEVER import from a client component (it reads
// the sub-account private keys from env). Shared by the step-5 setup/test script, the step-6
// console API, and the step-7 agent card.
//
// tCHF is a TIP-20 with currency "CHF" (a NON-USD token). Only USD TIP-20s can pay Tempo fees,
// so every sub-account that MOVES tCHF must (a) hold pathUSD for fees and (b) pin its fee token
// to pathUSD via FeeManager.setUserToken. tCHF itself is only ever the payload, never the fee.
import {
  createWalletClient, http, keccak256, toHex, stringToHex, formatUnits, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoTestnet, TEMPO_RPC_HTTP, TEMPO_SYSTEM, PATH_USD_ADDRESS } from "./tempo";
import { TIP20_ABI, getClients, confirm } from "./tempo-server";

export const TCHF_SALT = keccak256(toHex("uc8-tCHF-v1"));
export const TCHF_NAME = "Limmat tokenized CHF";
export const TCHF_SYMBOL = "tCHF";
export const TCHF_CURRENCY = "CHF";
const DEC = BigInt(1_000_000); // 6 decimals
const FAUCET_MIN = BigInt(1_000) * DEC; // top up fees when pathUSD < 1,000

export type SubId = "HQ" | "FRA" | "NYC" | "LAG";
export type SubAccount = { id: SubId; label: string; city: string; localCcy: string; seed: number };
export const SUB_ACCOUNTS: SubAccount[] = [
  { id: "HQ", label: "HQ Treasury", city: "Zürich", localCcy: "CHF", seed: 8_000_000 },
  { id: "FRA", label: "Lisbon", city: "Lisbon", localCcy: "EUR", seed: 1_000_000 },
  { id: "NYC", label: "New York", city: "New York", localCcy: "USD", seed: 750_000 },
  { id: "LAG", label: "Lagos", city: "Lagos", localCcy: "NGN", seed: 25_000 },
];

const FACTORY_ABI = [
  { name: "createToken", type: "function", stateMutability: "nonpayable", inputs: [{ name: "name", type: "string" }, { name: "symbol", type: "string" }, { name: "currency", type: "string" }, { name: "quoteToken", type: "address" }, { name: "admin", type: "address" }, { name: "salt", type: "bytes32" }], outputs: [{ type: "address" }] },
  { name: "getTokenAddress", type: "function", stateMutability: "pure", inputs: [{ name: "sender", type: "address" }, { name: "salt", type: "bytes32" }], outputs: [{ type: "address" }] },
  { name: "isTIP20", type: "function", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "bool" }] },
] as const;
const FEE_MANAGER_ABI = [
  { name: "setUserToken", type: "function", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }], outputs: [] },
  { name: "userTokens", type: "function", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "address" }] },
] as const;

// ── env-backed identities (the setup script generates + persists these) ──
export const tchfAddress = (): Address => (process.env.TEMPO_TCHF_ADDRESS || "").trim() as Address;
export function subAddress(id: SubId): Address {
  const a = (process.env[`TEMPO_SUB_${id}_ADDRESS`] || "").trim();
  if (!a) throw new Error(`TEMPO_SUB_${id}_ADDRESS not set — run scripts/tempo-act2-setup.mjs`);
  return a as Address;
}
function subAccount(id: SubId) {
  const pk = (process.env[`TEMPO_SUB_${id}_PRIVATE_KEY`] || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error(`TEMPO_SUB_${id}_PRIVATE_KEY missing — run scripts/tempo-act2-setup.mjs`);
  return privateKeyToAccount(pk as Hex);
}
function subWallet(id: SubId) {
  return createWalletClient({ account: subAccount(id), chain: tempoTestnet, transport: http(TEMPO_RPC_HTTP) });
}

// ── one-time provisioning (used by the setup script; idempotent) ──

/** Create tCHF via the factory (idempotent). Sets process.env.TEMPO_TCHF_ADDRESS. */
export async function ensureTCHF(): Promise<{ address: Address; created: boolean }> {
  const { account, wallet, pub } = getClients();
  const factory = TEMPO_SYSTEM.tip20Factory;
  const address = (await pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: "getTokenAddress", args: [account.address, TCHF_SALT] })) as Address;
  const exists = (await pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: "isTIP20", args: [address] })) as boolean;
  if (!exists) {
    // quoteToken must be a USD TIP-20 (pathUSD); A pays the createToken fee in pathUSD.
    const h = await wallet.writeContract({ address: factory, abi: FACTORY_ABI, functionName: "createToken", args: [TCHF_NAME, TCHF_SYMBOL, TCHF_CURRENCY, PATH_USD_ADDRESS, account.address, TCHF_SALT], chain: tempoTestnet, account });
    await confirm(h);
  }
  process.env.TEMPO_TCHF_ADDRESS = address;
  return { address, created: !exists };
}

/** Faucet pathUSD (for fees) + pin the sub's fee token to pathUSD. Idempotent. */
export async function ensureSubProvisioned(id: SubId): Promise<{ funded: boolean; feeSet: boolean }> {
  const { pub } = getClients();
  const account = subAccount(id);
  const pathBal = (await pub.readContract({ address: PATH_USD_ADDRESS, abi: TIP20_ABI, functionName: "balanceOf", args: [account.address] })) as bigint;
  let funded = false;
  if (pathBal < FAUCET_MIN) {
    const hashes = (await (pub.request as (a: { method: "tempo_fundAddress"; params: [Address] }) => Promise<unknown>)({ method: "tempo_fundAddress", params: [account.address] })) as string[];
    await Promise.allSettled((Array.isArray(hashes) ? hashes : []).map((h) => pub.waitForTransactionReceipt({ hash: h as Hex, timeout: 30_000 })));
    funded = true;
  }
  const cur = (await pub.readContract({ address: TEMPO_SYSTEM.feeManager, abi: FEE_MANAGER_ABI, functionName: "userTokens", args: [account.address] })) as Address;
  let feeSet = false;
  if (cur.toLowerCase() !== PATH_USD_ADDRESS.toLowerCase()) {
    const h = await subWallet(id).writeContract({ address: TEMPO_SYSTEM.feeManager, abi: FEE_MANAGER_ABI, functionName: "setUserToken", args: [PATH_USD_ADDRESS], chain: tempoTestnet, account });
    await confirm(h);
    feeSet = true;
  }
  return { funded, feeSet };
}

/** Mint tCHF (by issuer A) up to `targetWhole` for a sub-account if it is below. Idempotent. */
export async function ensureSeed(id: SubId, targetWhole: number): Promise<{ minted: boolean; balance: bigint }> {
  const { account: A, wallet: wA, pub } = getClients();
  const token = tchfAddress();
  const target = BigInt(targetWhole) * DEC;
  let bal = await tchfBalance(id);
  if (bal >= target) return { minted: false, balance: bal };
  const ISSUER = (await pub.readContract({ address: token, abi: TIP20_ABI, functionName: "ISSUER_ROLE" })) as Hex;
  const hasIssuer = (await pub.readContract({ address: token, abi: TIP20_ABI, functionName: "hasRole", args: [A.address, ISSUER] })) as boolean;
  if (!hasIssuer) {
    const g = await wA.writeContract({ address: token, abi: TIP20_ABI, functionName: "grantRole", args: [ISSUER, A.address], chain: tempoTestnet, account: A });
    await confirm(g);
  }
  const h = await wA.writeContract({ address: token, abi: TIP20_ABI, functionName: "mint", args: [subAddress(id), target - bal], chain: tempoTestnet, account: A });
  await pub.waitForTransactionReceipt({ hash: h, timeout: 90_000 });
  bal = await tchfBalance(id);
  return { minted: true, balance: bal };
}

// ── runtime (used by the script's test, the console API, and the agent card) ──

export type RailMove = { fromId: SubId; toId: SubId; amountWhole: number; units: string; hash: string; status: string; elapsedMs: number; memo: Hex; explorer: string };

/** LIVE internal tCHF transfer between two sub-accounts, with a reconciliation memo. */
export async function moveOnRail(fromId: SubId, toId: SubId, amountWhole: number, ref?: string): Promise<RailMove> {
  const token = tchfAddress();
  const account = subAccount(fromId);
  const to = subAddress(toId);
  const units = BigInt(Math.round(amountWhole)) * DEC;
  const reference = (ref || `RAIL-${fromId}-${toId}-${Date.now().toString(36).toUpperCase()}`).slice(0, 31);
  const memo = stringToHex(reference, { size: 32 });
  const t0 = Date.now();
  const hash = await subWallet(fromId).writeContract({ address: token, abi: TIP20_ABI, functionName: "transferWithMemo", args: [to, units, memo], chain: tempoTestnet, account });
  const r = await confirm(hash);
  return { fromId, toId, amountWhole, units: units.toString(), hash, status: r.status, elapsedMs: Date.now() - t0, memo, explorer: `${tempoTestnet.blockExplorers!.default.url}/tx/${hash}` };
}

export async function tchfBalance(id: SubId): Promise<bigint> {
  const { pub } = getClients();
  return (await pub.readContract({ address: tchfAddress(), abi: TIP20_ABI, functionName: "balanceOf", args: [subAddress(id)] })) as bigint;
}

export type TreasuryState = {
  token: Address;
  subs: { id: SubId; label: string; city: string; localCcy: string; address: Address; tchf: number; tchfRaw: string }[];
  totalTchf: number;
};

/** Live snapshot of all sub-account tCHF balances — for the console + agent card. */
export async function getTreasuryState(): Promise<TreasuryState> {
  const subs = await Promise.all(
    SUB_ACCOUNTS.map(async (s) => {
      const raw = await tchfBalance(s.id);
      return { id: s.id, label: s.label, city: s.city, localCcy: s.localCcy, address: subAddress(s.id), tchf: Number(formatUnits(raw, 6)), tchfRaw: raw.toString() };
    }),
  );
  return { token: tchfAddress(), subs, totalTchf: subs.reduce((a, s) => a + s.tchf, 0) };
}
