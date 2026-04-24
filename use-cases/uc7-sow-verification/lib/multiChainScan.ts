import type { ChainActivity, ChainFamily, TokenBalance, WalletScanResult } from "./types";
import { detectChain } from "./chainDetect";

type EvmChainConfig = {
  name: string;
  chainId: number;
  symbol: string; // native token symbol for pricing
  tokens: Array<{
    symbol: string;
    address: string; // lowercase
    decimals: number;
  }>;
};

// Tracked token set: stablecoins + major wrapped assets on each chain.
// Addresses are the canonical/native deployments; use lowercase.
const EVM_CHAINS: EvmChainConfig[] = [
  {
    name: "ethereum",
    chainId: 1,
    symbol: "ETH",
    tokens: [
      { symbol: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
      { symbol: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 },
      { symbol: "DAI", address: "0x6b175474e89094c44da98b954eedeac495271d0f", decimals: 18 },
      { symbol: "WETH", address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", decimals: 18 },
      { symbol: "WBTC", address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", decimals: 8 },
    ],
  },
  {
    name: "base",
    chainId: 8453,
    symbol: "ETH",
    tokens: [
      { symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
      { symbol: "USDbC", address: "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", decimals: 6 },
      { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
      { symbol: "cbBTC", address: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", decimals: 8 },
    ],
  },
  {
    name: "arbitrum",
    chainId: 42161,
    symbol: "ETH",
    tokens: [
      { symbol: "USDC", address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6 },
      { symbol: "USDT", address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6 },
      { symbol: "DAI", address: "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", decimals: 18 },
      { symbol: "WETH", address: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", decimals: 18 },
      { symbol: "WBTC", address: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f", decimals: 8 },
    ],
  },
  {
    name: "polygon",
    chainId: 137,
    symbol: "MATIC",
    tokens: [
      { symbol: "USDC", address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6 },
      { symbol: "USDT", address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 },
      { symbol: "DAI", address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
      { symbol: "WETH", address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 },
    ],
  },
  {
    name: "bsc",
    chainId: 56,
    symbol: "BNB",
    tokens: [
      { symbol: "USDT", address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18 },
      { symbol: "USDC", address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18 },
      { symbol: "DAI", address: "0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3", decimals: 18 },
      { symbol: "BTCB", address: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c", decimals: 18 },
    ],
  },
  {
    name: "optimism",
    chainId: 10,
    symbol: "ETH",
    tokens: [
      { symbol: "USDC", address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6 },
      { symbol: "USDT", address: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", decimals: 6 },
      { symbol: "DAI", address: "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", decimals: 18 },
      { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
      { symbol: "WBTC", address: "0x68f180fcce6836688e9084f035309e29bf0a2095", decimals: 8 },
    ],
  },
];

const STABLECOINS = new Set(["USDC", "USDT", "DAI", "BUSD", "FDUSD", "PYUSD", "USDBC"]);

// Price cache in CHF (in-memory, short TTL)
type PriceCache = { price: number; fetchedAt: number };
const priceCache: Record<string, PriceCache> = {};
const PRICE_TTL_MS = 5 * 60 * 1000;

// Static fallback CHF prices (approximate, used when CoinGecko unavailable).
const FALLBACK_CHF: Record<string, number> = {
  ETH: 3100,
  BTC: 58000,
  WBTC: 58000,
  BTCB: 58000,
  CBBTC: 58000,
  SOL: 125,
  MATIC: 0.6,
  BNB: 530,
  USDC: 0.9,
  USDT: 0.9,
  DAI: 0.9,
  BUSD: 0.9,
  FDUSD: 0.9,
  PYUSD: 0.9,
  USDBC: 0.9,
  WETH: 3100,
};

async function fetchChfPrice(cgId: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=chf`,
      { headers: { accept: "application/json" }, cache: "no-store" }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, { chf?: number }>;
    return json[cgId]?.chf ?? null;
  } catch {
    return null;
  }
}

export async function getPriceChf(symbol: string): Promise<number> {
  const key = symbol.toUpperCase();
  const hit = priceCache[key];
  if (hit && Date.now() - hit.fetchedAt < PRICE_TTL_MS) return hit.price;

  // Stablecoins: trust the peg
  if (STABLECOINS.has(key)) {
    const p = FALLBACK_CHF[key] ?? 0.9;
    priceCache[key] = { price: p, fetchedAt: Date.now() };
    return p;
  }

  const idMap: Record<string, string> = {
    ETH: "ethereum",
    WETH: "weth",
    MATIC: "matic-network",
    BNB: "binancecoin",
    BTC: "bitcoin",
    WBTC: "wrapped-bitcoin",
    BTCB: "bitcoin-bep2",
    CBBTC: "coinbase-wrapped-btc",
    SOL: "solana",
  };
  const cgId = idMap[key];
  if (cgId) {
    const chf = await fetchChfPrice(cgId);
    if (chf != null && chf > 0) {
      priceCache[key] = { price: chf, fetchedAt: Date.now() };
      return chf;
    }
  }

  const fallback = FALLBACK_CHF[key] ?? 0;
  priceCache[key] = { price: fallback, fetchedAt: Date.now() };
  return fallback;
}

async function etherscanBalance(
  address: string,
  chainId: number,
  apiKey: string
): Promise<string> {
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

async function etherscanTokenBalance(
  address: string,
  contractAddress: string,
  chainId: number,
  apiKey: string
): Promise<string> {
  const url = new URL("https://api.etherscan.io/v2/api");
  url.searchParams.set("chainid", String(chainId));
  url.searchParams.set("module", "account");
  url.searchParams.set("action", "tokenbalance");
  url.searchParams.set("contractaddress", contractAddress);
  url.searchParams.set("address", address);
  url.searchParams.set("tag", "latest");
  url.searchParams.set("apikey", apiKey);

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) return "0";
  const json = (await res.json()) as { status: string; result: unknown };
  if (typeof json.result !== "string" || !/^\d+$/.test(json.result)) return "0";
  return json.result;
}

async function etherscanTxCount(
  address: string,
  chainId: number,
  apiKey: string
): Promise<number> {
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
  chain: EvmChainConfig,
  apiKey: string
): Promise<ChainActivity> {
  try {
    const nativePromise = etherscanBalance(address, chain.chainId, apiKey);
    const txPromise = etherscanTxCount(address, chain.chainId, apiKey);
    const tokenPromises = chain.tokens.map((t) =>
      etherscanTokenBalance(address, t.address, chain.chainId, apiKey).then((raw) => ({
        symbol: t.symbol,
        address: t.address,
        decimals: t.decimals,
        raw,
      }))
    );

    const [nativeWei, txCount, ...tokenResults] = await Promise.all([
      nativePromise,
      txPromise,
      ...tokenPromises,
    ]);

    const wei = BigInt(nativeWei || "0");
    const nativeAmount = Number(wei) / 1e18;
    const nativePrice = await getPriceChf(chain.symbol);
    const nativeBalanceChf = nativeAmount * nativePrice;

    const tokenBalances: TokenBalance[] = [];
    for (const t of tokenResults as Array<{
      symbol: string;
      address: string;
      decimals: number;
      raw: string;
    }>) {
      const rawBig = BigInt(t.raw || "0");
      if (rawBig === BigInt(0)) continue;
      const amount = Number(rawBig) / Math.pow(10, t.decimals);
      const price = await getPriceChf(t.symbol);
      const chf = amount * price;
      tokenBalances.push({
        symbol: t.symbol,
        contractAddress: t.address,
        amount,
        chf,
      });
    }

    const tokenValueChf = tokenBalances.reduce((s, t) => s + t.chf, 0);
    const totalChf = nativeBalanceChf + tokenValueChf;

    return {
      chain: chain.name,
      chainId: chain.chainId,
      nativeBalance: nativeAmount.toFixed(6),
      nativeBalanceChf,
      tokenBalances,
      tokenValueChf,
      totalChf,
      txCount,
      hasActivity: wei > BigInt(0) || tokenBalances.length > 0 || txCount > 0,
    };
  } catch {
    return {
      chain: chain.name,
      chainId: chain.chainId,
      nativeBalance: "0",
      nativeBalanceChf: 0,
      tokenBalances: [],
      tokenValueChf: 0,
      totalChf: 0,
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
    };
    const funded = json.chain_stats?.funded_txo_sum ?? 0;
    const spent = json.chain_stats?.spent_txo_sum ?? 0;
    const sats = funded - spent;
    const btc = sats / 1e8;
    const priceChf = await getPriceChf("BTC");
    const balanceChf = btc * priceChf;
    return {
      chain: "bitcoin",
      nativeBalance: btc.toFixed(8),
      nativeBalanceChf: balanceChf,
      tokenBalances: [],
      tokenValueChf: 0,
      totalChf: balanceChf,
      txCount: json.chain_stats?.tx_count ?? 0,
      hasActivity: (json.chain_stats?.tx_count ?? 0) > 0,
    };
  } catch {
    return {
      chain: "bitcoin",
      nativeBalance: "0",
      nativeBalanceChf: 0,
      tokenBalances: [],
      tokenValueChf: 0,
      totalChf: 0,
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
    const priceChf = await getPriceChf("SOL");
    const balanceChf = sol * priceChf;

    return {
      chain: "solana",
      nativeBalance: sol.toFixed(6),
      nativeBalanceChf: balanceChf,
      tokenBalances: [],
      tokenValueChf: 0,
      totalChf: balanceChf,
      txCount: Array.isArray(sigJson.result) ? sigJson.result.length : 0,
      hasActivity:
        lamports > 0 || (Array.isArray(sigJson.result) && sigJson.result.length > 0),
    };
  } catch {
    return {
      chain: "solana",
      nativeBalance: "0",
      nativeBalanceChf: 0,
      tokenBalances: [],
      tokenValueChf: 0,
      totalChf: 0,
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
        totalValueChf: 0,
        scannedAt,
        warning:
          "ETHERSCAN_API_KEY not configured on server. Add it to the environment and re-scan.",
      };
    }
    const chains = await Promise.all(
      EVM_CHAINS.map((c) => scanEvmChain(address, c, apiKey))
    );
    const active = chains.filter((c) => c.hasActivity);
    const total = active.reduce((s, c) => s + c.totalChf, 0);
    return {
      address,
      chainFamily: "evm",
      chains: active,
      totalValueChf: total,
      scannedAt,
    };
  }

  if (detection.chainFamily === "bitcoin") {
    const c = await scanBitcoin(address);
    return {
      address,
      chainFamily: "bitcoin",
      chains: [c],
      totalValueChf: c.totalChf,
      scannedAt,
    };
  }

  if (detection.chainFamily === "solana") {
    const c = await scanSolana(address);
    return {
      address,
      chainFamily: "solana",
      chains: [c],
      totalValueChf: c.totalChf,
      scannedAt,
    };
  }

  return {
    address,
    chainFamily: detection.chainFamily as ChainFamily,
    chains: [],
    totalValueChf: 0,
    scannedAt,
  };
}

export { EVM_CHAINS };
