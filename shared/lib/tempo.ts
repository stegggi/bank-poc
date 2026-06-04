// shared/lib/tempo.ts
//
// UC8 · Task 1 — Tempo Testnet (Moderato) network entry + handshake helpers.
//
// This is ADDITIVE. It sits alongside the Arbitrum Sepolia entry (`arbSepolia` in
// shared/lib/aa.ts), which is left unchanged. Same viem `defineChain` pattern.
//
// Tempo is a stablecoin-payments L1, fully EVM-compatible over standard Ethereum
// JSON-RPC. There is NO native gas token — fees are paid in stablecoins — so the
// native ("USD") balance is a meaningless placeholder and must NOT be used as a
// health check. Use the pathUSD (TIP-20) balance instead.
//
// Connection details: https://docs.tempo.xyz/quickstart/connection-details

import { createPublicClient, http, formatUnits, type Address } from "viem";
import { defineChain } from "viem/utils";
import { ERC20_MIN_ABI } from "./contracts";

// ── Network endpoints (chain ID 42431) ──
export const TEMPO_CHAIN_ID = 42431;
export const TEMPO_RPC_HTTP = (process.env.TEMPO_RPC_URL || "https://rpc.moderato.tempo.xyz").trim();
export const TEMPO_RPC_WS = "wss://rpc.moderato.tempo.xyz";
export const TEMPO_EXPLORER = "https://explore.moderato.tempo.xyz";

// ── Network entry — parallel to `arbSepolia` in ./aa.ts (both kept) ──
export const tempoTestnet = defineChain({
  id: TEMPO_CHAIN_ID,
  name: "Tempo Testnet (Moderato)",
  // Placeholder only: Tempo has no native gas token; fees are paid in stablecoins.
  nativeCurrency: { name: "USD (placeholder)", symbol: "USD", decimals: 18 },
  rpcUrls: { default: { http: [TEMPO_RPC_HTTP], webSocket: [TEMPO_RPC_WS] } },
  blockExplorers: { default: { name: "Tempo Explorer", url: TEMPO_EXPLORER } },
  testnet: true,
});

// ── Predeployed TIP-20 testnet stablecoins (genesis precompiles, ERC-20 compatible) ──
// The faucet (tempo_fundAddress) mints 1,000,000 of each. These are 6-decimal tokens.
export const TEMPO_STABLECOINS = {
  pathUSD: "0x20c0000000000000000000000000000000000000",
  AlphaUSD: "0x20c0000000000000000000000000000000000001",
  BetaUSD: "0x20c0000000000000000000000000000000000002",
  ThetaUSD: "0x20c0000000000000000000000000000000000003",
} as const satisfies Record<string, Address>;

export const PATH_USD_ADDRESS: Address = TEMPO_STABLECOINS.pathUSD;

// ── Predeployed system contracts (used by UC8 task 2: factory + policy) ──
export const TEMPO_SYSTEM = {
  tip20Factory: "0x20fc000000000000000000000000000000000000",
  tip403Registry: "0x403c000000000000000000000000000000000000",
  feeManager: "0xfeec000000000000000000000000000000000000",
  stablecoinDex: "0xdec0000000000000000000000000000000000000",
} as const satisfies Record<string, Address>;

// UC8 Act-1 mock stablecoin (mUSDC), created via the factory in task 2.
// Deterministic from the dev wallet + salt; recorded in .env.local after creation.
export const MUSDC_ADDRESS = (process.env.TEMPO_MUSDC_ADDRESS || "").trim() as Address | "";

// UC8 Act-2 tokenized CHF deposit (tCHF), created via the factory in step 5.
// Currency "CHF" (non-USD) — fees for moving it are paid separately in pathUSD.
export const TCHF_ADDRESS = (process.env.TEMPO_TCHF_ADDRESS || "").trim() as Address | "";

export const tempoPublicClient = createPublicClient({
  chain: tempoTestnet,
  transport: http(TEMPO_RPC_HTTP),
});

// ── Helpers ──

/** Current block height. On a live chain this is > 0 and increasing. */
export async function getBlockHeight(): Promise<bigint> {
  return tempoPublicClient.getBlockNumber();
}

/**
 * Fund an address from the Tempo faucet. This is a custom JSON-RPC method
 * (NOT a web form): it mints 1M of each testnet stablecoin to `address` and
 * returns one tx hash per token minted. No signing / private key required.
 */
export async function fundAddress(address: Address): Promise<string[]> {
  const hashes = await (tempoPublicClient.request as (args: {
    method: "tempo_fundAddress";
    params: [Address];
  }) => Promise<unknown>)({ method: "tempo_fundAddress", params: [address] });
  return Array.isArray(hashes) ? (hashes as string[]) : [];
}

/**
 * Wait for faucet mint txs to be mined. The faucet RPC returns tx hashes before
 * they are included in a block, so a balance read immediately after funding races
 * ahead and shows 0. Bounded best-effort: failures/timeouts don't throw.
 */
export async function waitForReceipts(hashes: string[], timeoutMs = 25_000): Promise<void> {
  await Promise.allSettled(
    hashes.map((hash) =>
      tempoPublicClient.waitForTransactionReceipt({
        hash: hash as `0x${string}`,
        timeout: timeoutMs,
      }),
    ),
  );
}

export type StableBalance = {
  raw: string; // base units as a decimal string (bigint-safe for JSON)
  decimals: number;
  symbol: string;
  formatted: string; // human-readable
};

/** Read a TIP-20 / ERC-20 stablecoin balance — the real health check (NOT native). */
export async function readStableBalance(token: Address, owner: Address): Promise<StableBalance> {
  const [raw, decimals, symbol] = await Promise.all([
    tempoPublicClient.readContract({
      address: token,
      abi: ERC20_MIN_ABI,
      functionName: "balanceOf",
      args: [owner],
    }) as Promise<bigint>,
    tempoPublicClient.readContract({
      address: token,
      abi: ERC20_MIN_ABI,
      functionName: "decimals",
    }) as Promise<number>,
    tempoPublicClient.readContract({
      address: token,
      abi: ERC20_MIN_ABI,
      functionName: "symbol",
    }) as Promise<string>,
  ]);
  const d = Number(decimals);
  return { raw: raw.toString(), decimals: d, symbol, formatted: formatUnits(raw, d) };
}

export function readPathUsdBalance(owner: Address): Promise<StableBalance> {
  return readStableBalance(PATH_USD_ADDRESS, owner);
}

export type HandshakeResult = {
  connected: boolean;
  chainId: number;
  blockHeight: string;
  address: Address | null;
  pathUSD: StableBalance | null;
  fundingTxs: string[]; // faucet mint tx hashes from this request (empty unless fund=true)
  explorerUrl: string;
  rpcUrl: string;
  error?: string;
};

/** One-shot connectivity handshake shared by the API route and the CLI script. */
export async function runHandshake(opts: {
  address?: Address | null;
  fund?: boolean;
}): Promise<HandshakeResult> {
  const result: HandshakeResult = {
    connected: false,
    chainId: TEMPO_CHAIN_ID,
    blockHeight: "0",
    address: opts.address ?? null,
    pathUSD: null,
    fundingTxs: [],
    explorerUrl: TEMPO_EXPLORER,
    rpcUrl: TEMPO_RPC_HTTP,
  };
  try {
    const block = await getBlockHeight();
    result.blockHeight = block.toString();
    result.connected = block > BigInt(0);
    if (opts.address) {
      if (opts.fund) {
        result.fundingTxs = await fundAddress(opts.address);
        // Faucet returns hashes before inclusion — wait so the balance read is accurate.
        await waitForReceipts(result.fundingTxs);
      }
      result.pathUSD = await readPathUsdBalance(opts.address);
    }
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    result.error = err?.shortMessage || err?.message || String(e);
  }
  return result;
}
