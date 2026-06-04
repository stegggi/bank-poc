// shared/lib/tempo-server.ts
//
// SERVER-ONLY Tempo write helpers (reads TEMPO_DEV_PRIVATE_KEY). NEVER import this from a
// client component — only from API routes (pages/api/**). It signs TIP-20 transactions for
// the demo dev wallet (A) and is shared by Act 1 (mUSDC) and Act 2 (tCHF) on-chain legs.
//
// Fees: Tempo charges tx fees in a TIP-20; we pin A's fee token to pathUSD (liquid + permissive)
// via FeeManager.setUserToken — the on-chain equivalent of forge's --tempo.fee-token. Without it,
// fees default to the token being moved (a fresh token has no FeeAMM liquidity) and transfers fail.
import {
  createPublicClient, createWalletClient, http, keccak256, toHex, type Address, type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { tempoTestnet, TEMPO_RPC_HTTP, TEMPO_EXPLORER, TEMPO_SYSTEM, PATH_USD_ADDRESS } from "./tempo";

// Minimal TIP-20 ABI (transcribed from tempo-std ITIP20 / ITIP20RolesAuth).
export const TIP20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "decimals", type: "function", stateMutability: "pure", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "transferPolicyId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { name: "ISSUER_ROLE", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { name: "hasRole", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }, { name: "role", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { name: "grantRole", type: "function", stateMutability: "nonpayable", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [] },
  { name: "mint", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { name: "transferWithMemo", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }, { name: "memo", type: "bytes32" }], outputs: [] },
  { name: "changeTransferPolicyId", type: "function", stateMutability: "nonpayable", inputs: [{ name: "newPolicyId", type: "uint64" }], outputs: [] },
  { type: "event", name: "TransferWithMemo", inputs: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }, { name: "memo", type: "bytes32", indexed: true }] },
] as const;

const FEE_MANAGER_ABI = [
  { name: "setUserToken", type: "function", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }], outputs: [] },
  { name: "userTokens", type: "function", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "address" }] },
] as const;

export const explorerTx = (hash: string) => `${TEMPO_EXPLORER}/tx/${hash}`;
export const explorerAddr = (addr: string) => `${TEMPO_EXPLORER}/address/${addr}`;

let _cached: { account: PrivateKeyAccount; wallet: ReturnType<typeof createWalletClient>; pub: ReturnType<typeof createPublicClient> } | null = null;

export function getClients() {
  if (_cached) return _cached;
  const pk = (process.env.TEMPO_DEV_PRIVATE_KEY || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("TEMPO_DEV_PRIVATE_KEY missing/invalid in env (run scripts/tempo-keygen.mjs)");
  const account = privateKeyToAccount(pk as Hex);
  const pub = createPublicClient({ chain: tempoTestnet, transport: http(TEMPO_RPC_HTTP) });
  const wallet = createWalletClient({ account, chain: tempoTestnet, transport: http(TEMPO_RPC_HTTP) });
  _cached = { account, wallet, pub };
  return _cached;
}

/**
 * Patient receipt confirmation. Tempo can be slow to surface a receipt under burst load —
 * well past viem's default waitForTransactionReceipt timeout — even though the tx lands.
 * Polls getTransactionReceipt, tolerating not-found / transient RPC errors.
 */
export async function confirm(hash: Hex, tries = 75, intervalMs = 4000): Promise<{ status: string; blockNumber: bigint }> {
  const { pub } = getClients();
  for (let i = 0; i < tries; i++) {
    try {
      const r = await pub.getTransactionReceipt({ hash });
      return { status: r.status, blockNumber: r.blockNumber };
    } catch {
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  }
  throw new Error(`receipt not found after ${Math.round((tries * intervalMs) / 1000)}s: ${hash}`);
}

/** Pin A's fee token to pathUSD (idempotent — a no-op read once set). */
export async function ensureFeeToken(): Promise<void> {
  const { account, wallet, pub } = getClients();
  const cur = (await pub.readContract({ address: TEMPO_SYSTEM.feeManager, abi: FEE_MANAGER_ABI, functionName: "userTokens", args: [account.address] })) as Address;
  if (cur.toLowerCase() !== PATH_USD_ADDRESS.toLowerCase()) {
    const h = await wallet.writeContract({ address: TEMPO_SYSTEM.feeManager, abi: FEE_MANAGER_ABI, functionName: "setUserToken", args: [PATH_USD_ADDRESS], chain: tempoTestnet, account });
    await confirm(h);
  }
}

/** Ensure A holds at least `minUnits` of `token`, minting (A must be issuer) if short. */
export async function ensureBalance(token: Address, minUnits: bigint): Promise<void> {
  const { account, wallet, pub } = getClients();
  const bal = (await pub.readContract({ address: token, abi: TIP20_ABI, functionName: "balanceOf", args: [account.address] })) as bigint;
  if (bal < minUnits) {
    const h = await wallet.writeContract({ address: token, abi: TIP20_ABI, functionName: "mint", args: [account.address, minUnits * BigInt(5)], chain: tempoTestnet, account });
    await confirm(h);
  }
}

/** keccak256 commitment of an off-chain object — used as the 32-byte transfer memo. */
export function commitMemo(obj: unknown): Hex {
  return keccak256(toHex(JSON.stringify(obj)));
}

export type SendResult = { hash: string; status: string; elapsedMs: number; blockNumber: string };

/** Live TIP-20 transferWithMemo from A. Ensures fee token + balance first. */
export async function sendWithMemo(token: Address, to: Address, units: bigint, memo: Hex): Promise<SendResult> {
  const { account, wallet } = getClients();
  await ensureFeeToken();
  await ensureBalance(token, units);
  const t0 = Date.now();
  const hash = await wallet.writeContract({ address: token, abi: TIP20_ABI, functionName: "transferWithMemo", args: [to, units, memo], chain: tempoTestnet, account });
  const r = await confirm(hash);
  return { hash, status: r.status, elapsedMs: Date.now() - t0, blockNumber: r.blockNumber.toString() };
}

/** Read a TIP-20 balance in base units. */
export async function balanceOf(token: Address, owner: Address): Promise<bigint> {
  const { pub } = getClients();
  return (await pub.readContract({ address: token, abi: TIP20_ABI, functionName: "balanceOf", args: [owner] })) as bigint;
}
