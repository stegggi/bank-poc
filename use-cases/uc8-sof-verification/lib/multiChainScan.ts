import type { ChainActivity, ChainFamily, WalletScanResult } from "./types";
import { detectChain } from "./chainDetect";

const EVM_CHAINS: Array<{ name: string; chainId: number; symbol: string }> = [
  { name: "ethereum", chainId: 1, symbol: "ETH" },
  { name: "base", chainId: 8453, symbol: "ETH" },
  { name: "arbitrum", chainId: 42161, symbol: "ETH" },
  { name: "polygon", chainId: 137, symbol: "MATIC" },
  { name: "bsc", chainId: 56, symbol: "BNB" },
  { name: "optimism", chainId: 10, symbol: "ETH" },
];

// Price cache (in-memory, short TTL)
type PriceCache = { price: number; fetchedAt: number };
const priceCache: Record<string, PriceCache> = {};
const PRICE_TTL_MS = 5 * 60 * 1000;

async function getPriceUsd(symbol: string): Promise<number> {
  const key = symbol.toUpperCase();
  const hit = priceCache[key];
  if (hit && Date.now() - hit.fetchedAt < PRICE_TTL_MS) return hit.price;

  const idMap: Record<string, string> = {
    ETH: "ethereum",
    MATIC: "matic-network",
    BNB: "binancecoin",
    BTC: "bitcoin",
    SOL: "solana",
  };
  const cgId = idMap[key];
  if (!cgId) return 0;

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd`,
      { headers: { accept: "application/json" }, cache: "no-store" }
    );
    if (!res.ok) throw new Error(`coingecko ${res.status}`);
    const json = (await res.json()) as Record<string, { usd?: number }>;
    const p = json[cgId]?.usd ?? 0;
    priceCache[key] = { price: p, fetchedAt: Date.now() };
    return p;
  } catch {
    // Fallback static prices (approximate, for demo only)
    const fallback: Record<string, number> = {
      ETH: 3500, BTC: 65000, SOL: 140, MATIC: 0.7, BNB: 600,
    };
    const p = fallback[key] ?? 0;
    priceCache[key] = { price: p, fetchedAt: Date.now() };
    return p;
  }
}

async function etherscanBalance(address: string, chainId: number, apiKey: string): Promise<string> {
  const url = new URL("https://api.etherscan.io/v2/api");
  url.searchParams.set("chainid", String(chainId));
  url.searchParams.set("module", "account");
  url.searchParams.set("action", "balance");
  url.searchParams.set("address", address);
  url.searchParams.set("tag", "latest");
  url.searchParams.set("apikey", apiKey);

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) return "0";
  const json = (await res.json()) as { status: string; result: string };
  return json.result ?? "0";
}

async function etherscanTxCount(address: string, chainId: number, apiKey: string): Promise<number> {
  const url = new URL("https://api.etherscan.io/v2/api");
  url.searchParams.set("chainid", String(chainId));
  url.searchParams.set("module", "account");
  url.searchParams.set("action", "txlist");
  url.searchParams.set("address", address);
  url.searchParams.set("page", "1");
  url.searchParams.set("offset", "1");
  url.searchParams.set("sort", "desc");
  url.searchParams.set("apikey", apiKey);

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) return 0;
  const json = (await res.json()) as { status: string; result: unknown };
  if (Array.isArray(json.result)) return json.result.length > 0 ? 1 : 0;
  return 0;
}

async function scanEvmChain(
  address: string,
  chain: { name: string; chainId: number; symbol: string },
  apiKey: string
): Promise<ChainActivity> {
  try {
    const [balanceWei, txCount] = await Promise.all([
      etherscanBalance(address, chain.chainId, apiKey),
      etherscanTxCount(address, chain.chainId, apiKey),
    ]);
    const wei = BigInt(balanceWei || "0");
    const native = Number(wei) / 1e18;
    const priceUsd = await getPriceUsd(chain.symbol);
    const balanceUsd = native * priceUsd;
    return {
      chain: chain.name,
      chainId: chain.chainId,
      nativeBalance: native.toFixed(6),
      nativeBalanceUsd: balanceUsd,
      txCount,
      hasActivity: wei > BigInt(0) || txCount > 0,
    };
  } catch {
    return {
      chain: chain.name,
      chainId: chain.chainId,
      nativeBalance: "0",
      nativeBalanceUsd: 0,
      txCount: 0,
      hasActivity: false,
    };
  }
}

async function scanBitcoin(address: string): Promise<ChainActivity> {
  try {
    const res = await fetch(`https://blockstream.info/api/address/${address}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`blockstream ${res.status}`);
    const json = (await res.json()) as {
      chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number; tx_count?: number };
      mempool_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
    };
    const funded = json.chain_stats?.funded_txo_sum ?? 0;
    const spent = json.chain_stats?.spent_txo_sum ?? 0;
    const sats = funded - spent;
    const btc = sats / 1e8;
    const priceUsd = await getPriceUsd("BTC");
    return {
      chain: "bitcoin",
      nativeBalance: btc.toFixed(8),
      nativeBalanceUsd: btc * priceUsd,
      txCount: json.chain_stats?.tx_count ?? 0,
      hasActivity: (json.chain_stats?.tx_count ?? 0) > 0,
    };
  } catch {
    return {
      chain: "bitcoin",
      nativeBalance: "0",
      nativeBalanceUsd: 0,
      txCount: 0,
      hasActivity: false,
    };
  }
}

async function scanSolana(address: string): Promise<ChainActivity> {
  const heliusKey = process.env.HELIUS_API_KEY;
  try {
    const rpcUrl = heliusKey
      ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
      : "https://api.mainnet-beta.solana.com";

    const balanceReq = fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBalance",
        params: [address],
      }),
      cache: "no-store",
    });

    const sigReq = fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "getSignaturesForAddress",
        params: [address, { limit: 1 }],
      }),
      cache: "no-store",
    });

    const [balRes, sigRes] = await Promise.all([balanceReq, sigReq]);
    const balJson = (await balRes.json()) as { result?: { value?: number } };
    const sigJson = (await sigRes.json()) as { result?: unknown[] };

    const lamports = balJson.result?.value ?? 0;
    const sol = lamports / 1e9;
    const priceUsd = await getPriceUsd("SOL");

    return {
      chain: "solana",
      nativeBalance: sol.toFixed(6),
      nativeBalanceUsd: sol * priceUsd,
      txCount: Array.isArray(sigJson.result) ? sigJson.result.length : 0,
      hasActivity: lamports > 0 || (Array.isArray(sigJson.result) && sigJson.result.length > 0),
    };
  } catch {
    return {
      chain: "solana",
      nativeBalance: "0",
      nativeBalanceUsd: 0,
      txCount: 0,
      hasActivity: false,
    };
  }
}

export async function scanWallet(address: string): Promise<WalletScanResult> {
  const detection = detectChain(address);
  const scannedAt = new Date().toISOString();

  if (detection.chainFamily === "evm") {
    const apiKey = process.env.ETHERSCAN_API_KEY;
    if (!apiKey) {
      return {
        address,
        chainFamily: "evm",
        chains: [],
        totalValueUsd: 0,
        scannedAt,
      };
    }
    const chains = await Promise.all(
      EVM_CHAINS.map((c) => scanEvmChain(address, c, apiKey))
    );
    const active = chains.filter((c) => c.hasActivity);
    const total = active.reduce((s, c) => s + c.nativeBalanceUsd, 0);
    return { address, chainFamily: "evm", chains: active, totalValueUsd: total, scannedAt };
  }

  if (detection.chainFamily === "bitcoin") {
    const c = await scanBitcoin(address);
    return {
      address,
      chainFamily: "bitcoin",
      chains: [c],
      totalValueUsd: c.nativeBalanceUsd,
      scannedAt,
    };
  }

  if (detection.chainFamily === "solana") {
    const c = await scanSolana(address);
    return {
      address,
      chainFamily: "solana",
      chains: [c],
      totalValueUsd: c.nativeBalanceUsd,
      scannedAt,
    };
  }

  return {
    address,
    chainFamily: detection.chainFamily as ChainFamily,
    chains: [],
    totalValueUsd: 0,
    scannedAt,
  };
}

export { getPriceUsd, EVM_CHAINS };
