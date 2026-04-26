import type {
  AddressLabel,
  FundFlowEdge,
  FundFlowNode,
  SanctionsHit,
  TraceResult,
  TracedSource,
} from "./types";
import { lookupAddress } from "./labelDatabase";
import { getPrice, etherscanFetch, buildEtherscanUrl, type DualPrice } from "./multiChainScan";

type EvmInflow = {
  from: string;
  to: string;
  valueWei: bigint;
  token: string;
  tokenDecimals: number;
  priceChf: number;
  priceUsd: number;
  valueChf: number;
  valueUsd: number;
  unpriced: boolean;
  timestamp: number;
  txHash: string;
};

const CHAIN_ID_MAP: Record<string, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  polygon: 137,
  bsc: 56,
  optimism: 10,
};

const CHAIN_NATIVE: Record<string, string> = {
  ethereum: "ETH",
  base: "ETH",
  arbitrum: "ETH",
  polygon: "MATIC",
  bsc: "BNB",
  optimism: "ETH",
};

const STABLECOIN_SYMBOLS = new Set([
  "USDC",
  "USDT",
  "DAI",
  "BUSD",
  "FDUSD",
  "PYUSD",
  "USDBC",
  "USDC.E",
]);

// Symbols we will try to look up via getPriceChf (beyond stables/native).
const PRICEABLE_SYMBOLS = new Set([
  "WETH",
  "WBTC",
  "BTCB",
  "CBBTC",
  "WMATIC",
  "WBNB",
  "WSOL",
]);

async function fetchEtherscan<T>(
  params: Record<string, string>,
  chainId: number
): Promise<T | null> {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) return null;
  const url = buildEtherscanUrl(chainId, apiKey, params);
  const json = await etherscanFetch(url);
  if (!json || json.result == null) return null;
  return json.result as T;
}

type RawTx = {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
};

type RawTokenTx = RawTx & {
  tokenSymbol: string;
  tokenDecimal: string;
  contractAddress: string;
};

async function priceForSymbol(sym: string): Promise<{ price: DualPrice; unpriced: boolean }> {
  const upper = sym.toUpperCase();
  if (STABLECOIN_SYMBOLS.has(upper)) {
    const price = await getPrice(upper);
    return {
      price: { chf: price.chf || 0.9, usd: price.usd || 1 },
      unpriced: false,
    };
  }
  if (PRICEABLE_SYMBOLS.has(upper)) {
    const price = await getPrice(upper);
    return { price, unpriced: price.chf === 0 && price.usd === 0 };
  }
  return { price: { chf: 0, usd: 0 }, unpriced: true };
}

async function loadIncomingEvm(address: string, chain: string): Promise<EvmInflow[]> {
  const chainId = CHAIN_ID_MAP[chain];
  if (!chainId) return [];

  const [normal, tokens, internal] = await Promise.all([
    fetchEtherscan<RawTx[]>(
      {
        module: "account",
        action: "txlist",
        address,
        startblock: "0",
        endblock: "99999999",
        page: "1",
        offset: "200",
        sort: "desc",
      },
      chainId
    ),
    fetchEtherscan<RawTokenTx[]>(
      {
        module: "account",
        action: "tokentx",
        address,
        page: "1",
        offset: "200",
        sort: "desc",
      },
      chainId
    ),
    fetchEtherscan<RawTx[]>(
      {
        module: "account",
        action: "txlistinternal",
        address,
        page: "1",
        offset: "200",
        sort: "desc",
      },
      chainId
    ),
  ]);

  const addr = address.toLowerCase();
  const nativeSymbol = CHAIN_NATIVE[chain] || "ETH";
  const nativePrice = await getPrice(nativeSymbol);

  const inflows: EvmInflow[] = [];

  const pushNative = (tx: RawTx) => {
    if (!tx.to || tx.to.toLowerCase() !== addr) return;
    if (!tx.value || tx.value === "0") return;
    const wei = BigInt(tx.value);
    const native = Number(wei) / 1e18;
    inflows.push({
      from: tx.from.toLowerCase(),
      to: addr,
      valueWei: wei,
      token: nativeSymbol,
      tokenDecimals: 18,
      priceChf: nativePrice.chf,
      priceUsd: nativePrice.usd,
      valueChf: native * nativePrice.chf,
      valueUsd: native * nativePrice.usd,
      unpriced: false,
      timestamp: Number(tx.timeStamp) * 1000,
      txHash: tx.hash,
    });
  };

  if (Array.isArray(normal)) normal.forEach(pushNative);
  if (Array.isArray(internal)) internal.forEach(pushNative);

  if (Array.isArray(tokens)) {
    for (const tx of tokens) {
      if (!tx.to || tx.to.toLowerCase() !== addr) continue;
      const dec = Number(tx.tokenDecimal || "18");
      const sym = (tx.tokenSymbol || "").toUpperCase();
      const raw = BigInt(tx.value || "0");
      const amount = Number(raw) / Math.pow(10, dec);
      const { price, unpriced } = await priceForSymbol(sym);
      inflows.push({
        from: tx.from.toLowerCase(),
        to: addr,
        valueWei: raw,
        token: sym,
        tokenDecimals: dec,
        priceChf: price.chf,
        priceUsd: price.usd,
        valueChf: amount * price.chf,
        valueUsd: amount * price.usd,
        unpriced,
        timestamp: Number(tx.timeStamp) * 1000,
        txHash: tx.hash,
      });
    }
  }

  return inflows;
}

type SourceAgg = {
  chf: number;
  usd: number;
  pricedChf: number; // sum of priced inflows only — used for the "unpriced" badge
};

function aggregateBySource(inflows: EvmInflow[]): {
  values: Map<string, SourceAgg>;
  // A source is "fully unpriced" only if NONE of its inflows had a real price.
  fullyUnpriced: Map<string, boolean>;
} {
  const values = new Map<string, SourceAgg>();
  for (const inf of inflows) {
    const cur = values.get(inf.from) || { chf: 0, usd: 0, pricedChf: 0 };
    cur.chf += inf.valueChf;
    cur.usd += inf.valueUsd;
    if (!inf.unpriced) cur.pricedChf += inf.valueChf;
    values.set(inf.from, cur);
  }
  const fullyUnpriced = new Map<string, boolean>();
  for (const [src, agg] of values) {
    if (agg.pricedChf === 0 && agg.chf === 0) fullyUnpriced.set(src, true);
  }
  return { values, fullyUnpriced };
}

type TopSource = { address: string; chf: number; usd: number };

function topSources(
  values: Map<string, SourceAgg>,
  coveragePct = 0.9
): { sources: TopSource[]; totalChf: number; totalUsd: number } {
  const entries = Array.from(values.entries())
    .map(([address, agg]): TopSource => ({ address, chf: agg.chf, usd: agg.usd }))
    .sort((a, b) => b.chf - a.chf);

  const totalChf = entries.reduce((s, e) => s + e.chf, 0);
  const totalUsd = entries.reduce((s, e) => s + e.usd, 0);
  if (totalChf <= 0) return { sources: [], totalChf, totalUsd };

  const out: TopSource[] = [];
  let acc = 0;
  for (const e of entries) {
    out.push(e);
    acc += e.chf;
    if (acc >= totalChf * coveragePct) break;
  }
  return { sources: out, totalChf, totalUsd };
}

async function traceBitcoin(address: string): Promise<TraceResult> {
  const tracedAt = new Date().toISOString();
  try {
    const res = await fetch(`https://blockstream.info/api/address/${address}/txs`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) {
      return emptyTrace(address, "bitcoin", tracedAt);
    }
    const txs = (await res.json()) as Array<{
      vin: Array<{ prevout?: { scriptpubkey_address?: string; value?: number } }>;
      vout: Array<{ scriptpubkey_address?: string; value?: number }>;
    }>;
    const btcPrice = await getPrice("BTC");
    const agg = new Map<string, SourceAgg>();
    for (const tx of txs) {
      for (const vin of tx.vin) {
        const src = vin.prevout?.scriptpubkey_address;
        if (!src || src === address) continue;
        const ourOut = tx.vout
          .filter((v) => v.scriptpubkey_address === address)
          .reduce((s, v) => s + (v.value ?? 0), 0);
        if (ourOut <= 0) continue;
        const btc = ourOut / 1e8;
        const cur = agg.get(src) || { chf: 0, usd: 0, pricedChf: 0 };
        cur.chf += btc * btcPrice.chf;
        cur.usd += btc * btcPrice.usd;
        cur.pricedChf += btc * btcPrice.chf;
        agg.set(src, cur);
      }
    }
    const { sources, totalChf, totalUsd } = topSources(agg);
    const tracedSources: TracedSource[] = [];
    const sanctionsHits: SanctionsHit[] = [];
    const nodes: FundFlowNode[] = [
      {
        id: address,
        address,
        label: null,
        valueChf: totalChf,
        valueUsd: totalUsd,
        hopDepth: 0,
        kind: "wallet",
      },
    ];
    const edges: FundFlowEdge[] = [];
    for (const s of sources) {
      const label = await lookupAddress(s.address, "bitcoin");
      tracedSources.push({
        address: s.address,
        valueChf: s.chf,
        valueUsd: s.usd,
        percentage: totalChf > 0 ? s.chf / totalChf : 0,
        label,
        hopDepth: 1,
        path: [address, s.address],
      });
      nodes.push({
        id: s.address,
        address: s.address,
        label,
        valueChf: s.chf,
        valueUsd: s.usd,
        hopDepth: 1,
        kind: "source",
      });
      edges.push({
        from: s.address,
        to: address,
        valueChf: s.chf,
        valueUsd: s.usd,
        token: "BTC",
      });
      if (label.sanctioned) {
        sanctionsHits.push({
          address: s.address,
          listName: "OFAC SDN",
          reason: label.name || "Sanctioned entity",
        });
      }
    }
    const attributedChf = tracedSources
      .filter((s) => s.label && s.label.entityType !== "unknown")
      .reduce((acc, s) => acc + s.valueChf, 0);
    const attributedUsd = tracedSources
      .filter((s) => s.label && s.label.entityType !== "unknown")
      .reduce((acc, s) => acc + s.valueUsd, 0);

    return {
      walletAddress: address,
      chain: "bitcoin",
      totalIncomingValueChf: totalChf,
      totalIncomingValueUsd: totalUsd,
      attributedValueChf: attributedChf,
      attributedValueUsd: attributedUsd,
      attributedPercentage: totalChf > 0 ? attributedChf / totalChf : 0,
      sources: tracedSources,
      hopsUsed: 1,
      maxHopsConfigured: 1,
      sanctionsHits,
      nodes,
      edges,
      tracedAt,
    };
  } catch {
    return emptyTrace(address, "bitcoin", tracedAt);
  }
}

function emptyTrace(address: string, chain: string, tracedAt: string): TraceResult {
  return {
    walletAddress: address,
    chain,
    totalIncomingValueChf: 0,
    totalIncomingValueUsd: 0,
    attributedValueChf: 0,
    attributedValueUsd: 0,
    attributedPercentage: 0,
    sources: [],
    hopsUsed: 0,
    maxHopsConfigured: 0,
    sanctionsHits: [],
    nodes: [
      {
        id: address,
        address,
        label: null,
        valueChf: 0,
        valueUsd: 0,
        hopDepth: 0,
        kind: "wallet",
      },
    ],
    edges: [],
    tracedAt,
  };
}

export async function traceBackward(
  address: string,
  chain: string,
  opts: { maxHopDepth?: number } = {}
): Promise<TraceResult> {
  const tracedAt = new Date().toISOString();
  const maxHopDepth = opts.maxHopDepth ?? Number(process.env.MAX_HOP_DEPTH || 3);

  if (chain === "bitcoin") {
    return traceBitcoin(address);
  }
  if (chain === "solana") {
    return emptyTrace(address, "solana", tracedAt);
  }

  const initialInflows = await loadIncomingEvm(address, chain);
  if (initialInflows.length === 0) {
    return emptyTrace(address, chain, tracedAt);
  }
  const aggHop1 = aggregateBySource(initialInflows);
  const { sources: hop1, totalChf, totalUsd } = topSources(aggHop1.values);

  const tracedSources: TracedSource[] = [];
  const sanctionsHits: SanctionsHit[] = [];
  const nodes: FundFlowNode[] = [
    {
      id: address,
      address,
      label: null,
      valueChf: totalChf,
      valueUsd: totalUsd,
      hopDepth: 0,
      kind: "wallet",
    },
  ];
  const edges: FundFlowEdge[] = [];
  const seenNodeIds = new Set<string>([address]);

  type Queue = Array<{
    src: string;
    parent: string;
    valueChf: number;
    valueUsd: number;
    depth: number;
    path: string[];
    unpriced: boolean;
  }>;
  const queue: Queue = hop1.map((s) => ({
    src: s.address,
    parent: address,
    valueChf: s.chf,
    valueUsd: s.usd,
    depth: 1,
    path: [address, s.address],
    unpriced: !!aggHop1.fullyUnpriced.get(s.address),
  }));

  let hopsUsed = 0;

  function pushTraced(item: Queue[number], label: AddressLabel) {
    tracedSources.push({
      address: item.src,
      valueChf: item.valueChf,
      valueUsd: item.valueUsd,
      percentage: totalChf > 0 ? item.valueChf / totalChf : 0,
      label,
      hopDepth: item.depth,
      path: item.path,
      unpriced: item.unpriced,
    });
  }

  while (queue.length > 0) {
    const item = queue.shift()!;
    hopsUsed = Math.max(hopsUsed, item.depth);
    const label = await lookupAddress(item.src, chain);

    if (!seenNodeIds.has(item.src)) {
      nodes.push({
        id: item.src,
        address: item.src,
        label,
        valueChf: item.valueChf,
        valueUsd: item.valueUsd,
        hopDepth: item.depth,
        kind: "source",
      });
      seenNodeIds.add(item.src);
    }
    edges.push({
      from: item.src,
      to: item.parent,
      valueChf: item.valueChf,
      valueUsd: item.valueUsd,
    });

    if (label.sanctioned) {
      sanctionsHits.push({
        address: item.src,
        listName: "OFAC SDN",
        reason: label.name || "Sanctioned entity",
      });
      pushTraced(item, label);
      continue;
    }

    if (label.entityType === "exchange") {
      pushTraced(item, label);
      continue;
    }

    if (
      (label.entityType === "dex" ||
        label.entityType === "bridge" ||
        label.entityType === "contract") &&
      item.depth < maxHopDepth
    ) {
      const deeper = await loadIncomingEvm(item.src, chain);
      const agg = aggregateBySource(deeper);
      const top = topSources(agg.values);
      for (const s of top.sources.slice(0, 5)) {
        queue.push({
          src: s.address,
          parent: item.src,
          valueChf: s.chf,
          valueUsd: s.usd,
          depth: item.depth + 1,
          path: [...item.path, s.address],
          unpriced: !!agg.fullyUnpriced.get(s.address),
        });
      }
      continue;
    }

    if (label.entityType === "unknown" && item.depth < maxHopDepth) {
      const deeper = await loadIncomingEvm(item.src, chain);
      if (deeper.length === 0) {
        pushTraced(item, label);
        continue;
      }
      const agg = aggregateBySource(deeper);
      const top = topSources(agg.values);
      for (const s of top.sources.slice(0, 5)) {
        queue.push({
          src: s.address,
          parent: item.src,
          valueChf: Math.min(s.chf, item.valueChf),
          valueUsd: Math.min(s.usd, item.valueUsd),
          depth: item.depth + 1,
          path: [...item.path, s.address],
          unpriced: !!agg.fullyUnpriced.get(s.address),
        });
      }
      continue;
    }

    pushTraced(item, label);
  }

  const attributedChf = tracedSources
    .filter((s) => s.label && s.label.entityType !== "unknown" && !s.label.sanctioned)
    .reduce((acc, s) => acc + s.valueChf, 0);
  const attributedUsd = tracedSources
    .filter((s) => s.label && s.label.entityType !== "unknown" && !s.label.sanctioned)
    .reduce((acc, s) => acc + s.valueUsd, 0);

  return {
    walletAddress: address,
    chain,
    totalIncomingValueChf: totalChf,
    totalIncomingValueUsd: totalUsd,
    attributedValueChf: attributedChf,
    attributedValueUsd: attributedUsd,
    attributedPercentage: totalChf > 0 ? attributedChf / totalChf : 0,
    sources: tracedSources,
    hopsUsed,
    maxHopsConfigured: maxHopDepth,
    sanctionsHits,
    nodes,
    edges,
    tracedAt,
  };
}

export { loadIncomingEvm };
export type { AddressLabel };
