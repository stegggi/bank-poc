import type { ChainActivity, ChainFamily, TokenBalance, WalletScanResult } from "./types";
import { detectChain } from "./chainDetect";

type EvmChainConfig = {
  name: string;
  chainId: number;
  symbol: string; // native token symbol
  cgPlatform: string; // CoinGecko platform id for token-by-contract pricing
};

// Chain metadata. Tokens are discovered dynamically from each wallet's
// transfer history rather than from a hard-coded list, so we can value any
// ERC-20 (stablecoins, governance tokens, memes, custom assets) the wallet
// actually holds.
const EVM_CHAINS: EvmChainConfig[] = [
  { name: "ethereum", chainId: 1, symbol: "ETH", cgPlatform: "ethereum" },
  { name: "base", chainId: 8453, symbol: "ETH", cgPlatform: "base" },
  { name: "arbitrum", chainId: 42161, symbol: "ETH", cgPlatform: "arbitrum-one" },
  { name: "polygon", chainId: 137, symbol: "MATIC", cgPlatform: "polygon-pos" },
  { name: "bsc", chainId: 56, symbol: "BNB", cgPlatform: "binance-smart-chain" },
  { name: "optimism", chainId: 10, symbol: "ETH", cgPlatform: "optimistic-ethereum" },
  { name: "avalanche", chainId: 43114, symbol: "AVAX", cgPlatform: "avalanche" },
  { name: "monad", chainId: 10143, symbol: "MON", cgPlatform: "monad" },
];

// Cap concurrent Etherscan calls to stay within the 5 req/sec free-tier limit.
const TOKEN_BALANCE_CONCURRENCY = 3;
// How many distinct contracts per chain we query balances for (most recent first).
const MAX_TOKENS_PER_CHAIN = 40;
// Etherscan free-tier limit is 5 req/sec. We pace at ~4 req/sec to leave headroom.
const ETHERSCAN_MIN_INTERVAL_MS = 260;
const ETHERSCAN_MAX_RETRIES = 3;

// Global FIFO rate-limiter: every Etherscan request waits its turn so we never
// burst above ~4/sec across all chains and parallel workers.
let etherscanQueueTail: Promise<void> = Promise.resolve();
async function paceEtherscan(): Promise<void> {
  let release: () => void = () => {};
  const slot = new Promise<void>((res) => {
    release = res;
  });
  const previous = etherscanQueueTail;
  etherscanQueueTail = etherscanQueueTail.then(() => slot);
  await previous;
  setTimeout(release, ETHERSCAN_MIN_INTERVAL_MS);
}

type EtherscanResp = { status?: string; message?: string; result?: unknown };

function isRateLimited(json: EtherscanResp): boolean {
  if (typeof json.result === "string" && /Max\s*rate\s*limit/i.test(json.result)) return true;
  if (typeof json.message === "string" && /rate\s*limit/i.test(json.message)) return true;
  return false;
}

async function etherscanFetch(url: string): Promise<EtherscanResp | null> {
  for (let attempt = 0; attempt < ETHERSCAN_MAX_RETRIES; attempt++) {
    await paceEtherscan();
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.status === 429) {
        // Backoff and retry
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      const json = (await res.json()) as EtherscanResp;
      if (isRateLimited(json)) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      return json;
    } catch {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  return null;
}

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
  AVAX: 30,
  WAVAX: 30,
  MON: 0.03,
  WMON: 0.03,
  USDC: 0.9,
  USDT: 0.9,
  DAI: 0.9,
  BUSD: 0.9,
  FDUSD: 0.9,
  PYUSD: 0.9,
  USDBC: 0.9,
  WETH: 3100,
};

function coingeckoHeaders(): HeadersInit {
  const key = process.env.COINGECKO_API_KEY;
  const headers: Record<string, string> = { accept: "application/json" };
  if (key) headers["x-cg-demo-api-key"] = key;
  return headers;
}

async function fetchChfPrice(cgId: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=chf`,
      { headers: coingeckoHeaders(), cache: "no-store" }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, { chf?: number }>;
    return json[cgId]?.chf ?? null;
  } catch {
    return null;
  }
}

// Contract-address price lookup. Cache key is `${platform}:${address}`.
const contractPriceCache: Record<string, PriceCache> = {};

async function fetchTokenPricesByContract(
  platform: string,
  contracts: string[]
): Promise<Record<string, number>> {
  if (contracts.length === 0) return {};
  const out: Record<string, number> = {};
  // Resolve from cache first
  const fresh = Date.now();
  const toFetch: string[] = [];
  for (const c of contracts) {
    const key = `${platform}:${c.toLowerCase()}`;
    const hit = contractPriceCache[key];
    if (hit && fresh - hit.fetchedAt < PRICE_TTL_MS) {
      out[c.toLowerCase()] = hit.price;
    } else {
      toFetch.push(c.toLowerCase());
    }
  }
  if (toFetch.length === 0) return out;

  // CoinGecko allows up to 100 contracts per request; we batch in chunks of 50.
  const chunkSize = 50;
  for (let i = 0; i < toFetch.length; i += chunkSize) {
    const chunk = toFetch.slice(i, i + chunkSize);
    try {
      const url = new URL(`https://api.coingecko.com/api/v3/simple/token_price/${platform}`);
      url.searchParams.set("contract_addresses", chunk.join(","));
      url.searchParams.set("vs_currencies", "chf");
      const res = await fetch(url.toString(), {
        headers: coingeckoHeaders(),
        cache: "no-store",
      });
      if (!res.ok) continue;
      const json = (await res.json()) as Record<string, { chf?: number }>;
      for (const addr of chunk) {
        const price = json[addr]?.chf ?? 0;
        out[addr] = price;
        contractPriceCache[`${platform}:${addr}`] = { price, fetchedAt: Date.now() };
      }
    } catch {
      // ignore — tokens for which we have no price simply stay at 0 (unpriced)
    }
  }
  // Make sure every requested contract has an entry, even if 0.
  for (const c of contracts) {
    const k = c.toLowerCase();
    if (!(k in out)) out[k] = 0;
  }
  return out;
}

// Symbol → CoinGecko coin ID. Only legit, well-known symbols belong here so
// we can confidently fall back to symbol-based pricing when contract lookup
// fails (rate limit, missing platform coverage, etc.). Adding scam-token
// symbols here would risk pricing airdrop spam.
const SYMBOL_TO_CG_ID: Record<string, string> = {
  // Native / wrapped / majors
  ETH: "ethereum",
  WETH: "weth",
  MATIC: "matic-network",
  POL: "matic-network",
  BNB: "binancecoin",
  WBNB: "wbnb",
  BTC: "bitcoin",
  WBTC: "wrapped-bitcoin",
  BTCB: "bitcoin-bep2",
  CBBTC: "coinbase-wrapped-btc",
  SOL: "solana",
  WSOL: "wrapped-solana",
  AVAX: "avalanche-2",
  WAVAX: "wrapped-avax",
  // L2 governance / native
  ARB: "arbitrum",
  OP: "optimism",
  MON: "monad",
  WMON: "monad",
  // DeFi blue chips
  UNI: "uniswap",
  AAVE: "aave",
  LINK: "chainlink",
  CRV: "curve-dao-token",
  COMP: "compound-governance-token",
  MKR: "maker",
  SNX: "havven",
  GRT: "the-graph",
  LDO: "lido-dao",
  "1INCH": "1inch",
  BAL: "balancer",
  SUSHI: "sushi",
  YFI: "yearn-finance",
  ENS: "ethereum-name-service",
  APE: "apecoin",
  RPL: "rocket-pool",
  IMX: "immutable-x",
  // Memes / common holdings
  PEPE: "pepe",
  SHIB: "shiba-inu",
  DOGE: "dogecoin",
  // Liquid staking / wrapped ETH variants
  STETH: "staked-ether",
  WSTETH: "wrapped-steth",
  RETH: "rocket-pool-eth",
  CBETH: "coinbase-wrapped-staked-eth",
  // Cross-chain assets
  FET: "fetch-ai",
};

export function isKnownSymbol(symbol: string): boolean {
  return symbol.toUpperCase() in SYMBOL_TO_CG_ID;
}

// Reject symbols that contain non-ASCII letters (Cyrillic look-alikes used
// in airdrop scam impersonation tokens like "UЅDС") or that contain URLs /
// telegram handles in the symbol itself. When a wallet is dusted with such
// tokens we never want to apply a real-token price to them.
export function isLikelyLegitSymbol(rawSymbol: string): boolean {
  const trimmed = (rawSymbol || "").trim();
  if (!trimmed) return false;
  // Must be ASCII letters/digits/hyphen/underscore/dot/space only.
  if (!/^[A-Za-z0-9._\- ]+$/.test(trimmed)) return false;
  // No URL-ish or "claim" markers.
  if (/(https?:|t\.me|claim|visit|airdrop|reward|🎁|💰)/i.test(trimmed)) return false;
  // Reasonable length.
  if (trimmed.length > 12) return false;
  return true;
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

  const cgId = SYMBOL_TO_CG_ID[key];
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

function buildEtherscanUrl(
  chainId: number,
  apiKey: string,
  params: Record<string, string>
): string {
  const url = new URL("https://api.etherscan.io/v2/api");
  url.searchParams.set("chainid", String(chainId));
  url.searchParams.set("apikey", apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function etherscanBalance(
  address: string,
  chainId: number,
  apiKey: string
): Promise<string> {
  const json = await etherscanFetch(
    buildEtherscanUrl(chainId, apiKey, {
      module: "account",
      action: "balance",
      address,
      tag: "latest",
    })
  );
  if (!json || typeof json.result !== "string") return "0";
  return /^\d+$/.test(json.result) ? json.result : "0";
}

async function etherscanTokenBalance(
  address: string,
  contractAddress: string,
  chainId: number,
  apiKey: string
): Promise<string> {
  const json = await etherscanFetch(
    buildEtherscanUrl(chainId, apiKey, {
      module: "account",
      action: "tokenbalance",
      contractaddress: contractAddress,
      address,
      tag: "latest",
    })
  );
  if (!json || typeof json.result !== "string") return "0";
  return /^\d+$/.test(json.result) ? json.result : "0";
}

type RawTokenTx = {
  contractAddress: string;
  tokenSymbol: string;
  tokenDecimal: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
};

async function etherscanTokenTx(
  address: string,
  chainId: number,
  apiKey: string
): Promise<RawTokenTx[]> {
  const json = await etherscanFetch(
    buildEtherscanUrl(chainId, apiKey, {
      module: "account",
      action: "tokentx",
      address,
      page: "1",
      offset: "300",
      sort: "desc",
    })
  );
  if (!json || !Array.isArray(json.result)) return [];
  return json.result as RawTokenTx[];
}

async function etherscanTxCount(
  address: string,
  chainId: number,
  apiKey: string
): Promise<number> {
  const json = await etherscanFetch(
    buildEtherscanUrl(chainId, apiKey, {
      module: "account",
      action: "txlist",
      address,
      page: "1",
      offset: "1",
      sort: "desc",
    })
  );
  if (!json || !Array.isArray(json.result)) return 0;
  return (json.result as unknown[]).length > 0 ? 1 : 0;
}

type DiscoveredToken = {
  contractAddress: string;
  symbol: string;
  decimals: number;
};

function uniqueRecentTokens(txs: RawTokenTx[], cap: number): DiscoveredToken[] {
  const seen = new Map<string, DiscoveredToken>();
  for (const tx of txs) {
    const addr = (tx.contractAddress || "").toLowerCase();
    if (!addr) continue;
    if (seen.has(addr)) continue;
    const decimals = Number(tx.tokenDecimal || "18");
    if (!Number.isFinite(decimals) || decimals < 0 || decimals > 30) continue;
    seen.set(addr, {
      contractAddress: addr,
      symbol: (tx.tokenSymbol || "").trim() || addr.slice(0, 8),
      decimals,
    });
    if (seen.size >= cap) break;
  }
  return Array.from(seen.values());
}

async function batchTokenBalances(
  address: string,
  tokens: DiscoveredToken[],
  chainId: number,
  apiKey: string
): Promise<Array<DiscoveredToken & { raw: string }>> {
  const out: Array<DiscoveredToken & { raw: string }> = [];
  let i = 0;
  async function worker() {
    while (i < tokens.length) {
      const idx = i++;
      const t = tokens[idx];
      const raw = await etherscanTokenBalance(address, t.contractAddress, chainId, apiKey);
      out[idx] = { ...t, raw };
    }
  }
  const workers = Array.from(
    { length: Math.min(TOKEN_BALANCE_CONCURRENCY, tokens.length) },
    () => worker()
  );
  await Promise.all(workers);
  return out;
}

async function scanEvmChain(
  address: string,
  chain: EvmChainConfig,
  apiKey: string
): Promise<ChainActivity> {
  try {
    // 1. Native balance + tx count + token transfer history in parallel.
    const [nativeWei, txCount, tokenTxs] = await Promise.all([
      etherscanBalance(address, chain.chainId, apiKey),
      etherscanTxCount(address, chain.chainId, apiKey),
      etherscanTokenTx(address, chain.chainId, apiKey),
    ]);

    const wei = BigInt(nativeWei || "0");
    const nativeAmount = Number(wei) / 1e18;
    const nativePrice = await getPriceChf(chain.symbol);
    const nativeBalanceChf = nativeAmount * nativePrice;

    // Short-circuit if there's clearly no activity at all.
    if (wei === BigInt(0) && tokenTxs.length === 0 && txCount === 0) {
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

    // 2. Discover unique token contracts from transfer history (most recent first).
    const discovered = uniqueRecentTokens(tokenTxs, MAX_TOKENS_PER_CHAIN);

    // 3. Fetch current balance for each, with bounded concurrency.
    const withBalances = await batchTokenBalances(address, discovered, chain.chainId, apiKey);

    // 4. Filter to non-zero, then price by contract address via CoinGecko.
    const heldRaw = withBalances.filter((t) => {
      try {
        return BigInt(t.raw || "0") > BigInt(0);
      } catch {
        return false;
      }
    });

    const priceMap = await fetchTokenPricesByContract(
      chain.cgPlatform,
      heldRaw.map((t) => t.contractAddress)
    );

    const tokenBalances: TokenBalance[] = [];
    for (const t of heldRaw) {
      const amount = Number(BigInt(t.raw)) / Math.pow(10, t.decimals);
      let price = priceMap[t.contractAddress.toLowerCase()] ?? 0;
      const upper = t.symbol.toUpperCase();
      const looksLegit = isLikelyLegitSymbol(t.symbol);
      // Fallback chain when contract pricing missed:
      //   1. Stablecoin pegged-to-USD price (only if symbol passes spam check).
      //   2. Known popular symbol (ARB, OP, UNI, …) via CoinGecko by ID.
      if (price === 0 && STABLECOINS.has(upper) && looksLegit) {
        price = await getPriceChf(upper);
      } else if (price === 0 && isKnownSymbol(upper) && looksLegit) {
        price = await getPriceChf(upper);
      }
      const chf = amount * price;
      // Treat tokens that fail the legit-symbol check as airdrop spam.
      // CHF must stay zero — ignoring `chf > 0` defends against price oracles
      // that mistakenly quote impersonation contracts.
      const suspicious = !looksLegit;
      tokenBalances.push({
        symbol: t.symbol,
        contractAddress: t.contractAddress,
        amount,
        chf: suspicious ? 0 : chf,
        suspicious,
      });
    }

    // Sort tokens by CHF descending; suspicious items sink to the bottom.
    tokenBalances.sort((a, b) => {
      if (!!a.suspicious !== !!b.suspicious) return a.suspicious ? 1 : -1;
      return b.chf - a.chf;
    });

    // Total only counts non-suspicious balances.
    const tokenValueChf = tokenBalances
      .filter((t) => !t.suspicious)
      .reduce((s, t) => s + t.chf, 0);
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
    // Scan chains sequentially to keep total throughput under Etherscan's
    // 5 req/sec free-tier limit. Bursting in parallel triggers rate-limit
    // responses that silently zero out balances and missed tokens.
    const chains: ChainActivity[] = [];
    for (const c of EVM_CHAINS) {
      // eslint-disable-next-line no-await-in-loop
      chains.push(await scanEvmChain(address, c, apiKey));
    }
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

export { EVM_CHAINS, etherscanFetch, buildEtherscanUrl };
