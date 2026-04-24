import type {
  AddressLabel,
  FundFlowEdge,
  FundFlowNode,
  SanctionsHit,
  TraceResult,
  TracedSource,
} from "./types";
import { lookupAddress } from "./labelDatabase";
import { getPriceUsd } from "./multiChainScan";

type EvmInflow = {
  from: string;
  to: string;
  valueWei: bigint;
  token: string;
  tokenDecimals: number;
  priceUsd: number;
  valueUsd: number;
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

async function fetchEtherscan<T>(
  params: Record<string, string>,
  chainId: number
): Promise<T | null> {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) return null;
  const url = new URL("https://api.etherscan.io/v2/api");
  url.searchParams.set("chainid", String(chainId));
  url.searchParams.set("apikey", apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  try {
    const res = await fetch(url.toString(), {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { status: string; message?: string; result?: T };
    if (!json.result) return null;
    return json.result as T;
  } catch {
    return null;
  }
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
  const nativePrice = await getPriceUsd(nativeSymbol);

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
      priceUsd: nativePrice,
      valueUsd: native * nativePrice,
      timestamp: Number(tx.timeStamp) * 1000,
      txHash: tx.hash,
    });
  };

  if (Array.isArray(normal)) normal.forEach(pushNative);
  if (Array.isArray(internal)) internal.forEach(pushNative);

  if (Array.isArray(tokens)) {
    const stableSymbols = new Set(["USDC", "USDT", "DAI", "BUSD", "FDUSD", "PYUSD"]);
    for (const tx of tokens) {
      if (!tx.to || tx.to.toLowerCase() !== addr) continue;
      const dec = Number(tx.tokenDecimal || "18");
      const sym = (tx.tokenSymbol || "").toUpperCase();
      const raw = BigInt(tx.value || "0");
      const amount = Number(raw) / Math.pow(10, dec);
      const price = stableSymbols.has(sym) ? 1 : 0;
      inflows.push({
        from: tx.from.toLowerCase(),
        to: addr,
        valueWei: raw,
        token: sym,
        tokenDecimals: dec,
        priceUsd: price,
        valueUsd: amount * price,
        timestamp: Number(tx.timeStamp) * 1000,
        txHash: tx.hash,
      });
    }
  }

  return inflows;
}

function aggregateBySource(inflows: EvmInflow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const inf of inflows) {
    const cur = map.get(inf.from) || 0;
    map.set(inf.from, cur + inf.valueUsd);
  }
  return map;
}

function topSources(agg: Map<string, number>, coveragePct: number = 0.9): {
  sources: Array<{ address: string; valueUsd: number }>;
  total: number;
} {
  const entries = Array.from(agg.entries())
    .map(([address, valueUsd]) => ({ address, valueUsd }))
    .sort((a, b) => b.valueUsd - a.valueUsd);

  const total = entries.reduce((s, e) => s + e.valueUsd, 0);
  if (total <= 0) return { sources: [], total };

  const out: Array<{ address: string; valueUsd: number }> = [];
  let acc = 0;
  for (const e of entries) {
    out.push(e);
    acc += e.valueUsd;
    if (acc >= total * coveragePct) break;
  }
  return { sources: out, total };
}

async function traceBitcoin(address: string): Promise<TraceResult> {
  // Minimal BTC trace via Blockstream. Focus on Hop 1 source addresses.
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
    const btcPrice = await getPriceUsd("BTC");
    const agg = new Map<string, number>();
    for (const tx of txs) {
      // Inputs contribute to previous-hop source addresses
      for (const vin of tx.vin) {
        const src = vin.prevout?.scriptpubkey_address;
        if (!src || src === address) continue;
        // Distribute input value proportionally to outputs credited to our address
        const ourOut = tx.vout
          .filter((v) => v.scriptpubkey_address === address)
          .reduce((s, v) => s + (v.value ?? 0), 0);
        if (ourOut <= 0) continue;
        const btc = ourOut / 1e8;
        const usd = btc * btcPrice;
        const cur = agg.get(src) || 0;
        agg.set(src, cur + usd);
      }
    }
    const { sources, total } = topSources(agg);
    const tracedSources: TracedSource[] = [];
    const sanctionsHits: SanctionsHit[] = [];
    const nodes: FundFlowNode[] = [
      { id: address, address, label: null, valueUsd: total, hopDepth: 0, kind: "wallet" },
    ];
    const edges: FundFlowEdge[] = [];
    for (const s of sources) {
      const label = await lookupAddress(s.address, "bitcoin");
      tracedSources.push({
        address: s.address,
        valueUsd: s.valueUsd,
        percentage: total > 0 ? s.valueUsd / total : 0,
        label,
        hopDepth: 1,
        path: [address, s.address],
      });
      nodes.push({
        id: s.address,
        address: s.address,
        label,
        valueUsd: s.valueUsd,
        hopDepth: 1,
        kind: "source",
      });
      edges.push({ from: s.address, to: address, valueUsd: s.valueUsd, token: "BTC" });
      if (label.sanctioned) {
        sanctionsHits.push({
          address: s.address,
          listName: "OFAC SDN",
          reason: label.name || "Sanctioned entity",
        });
      }
    }
    const attributed = tracedSources
      .filter((s) => s.label && s.label.entityType !== "unknown")
      .reduce((acc, s) => acc + s.valueUsd, 0);

    return {
      walletAddress: address,
      chain: "bitcoin",
      totalIncomingValueUsd: total,
      attributedValueUsd: attributed,
      attributedPercentage: total > 0 ? attributed / total : 0,
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
    totalIncomingValueUsd: 0,
    attributedValueUsd: 0,
    attributedPercentage: 0,
    sources: [],
    hopsUsed: 0,
    maxHopsConfigured: 0,
    sanctionsHits: [],
    nodes: [{ id: address, address, label: null, valueUsd: 0, hopDepth: 0, kind: "wallet" }],
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
    // For prototype, return empty trace for Solana with a stub note.
    return emptyTrace(address, "solana", tracedAt);
  }

  // EVM trace
  const initialInflows = await loadIncomingEvm(address, chain);
  if (initialInflows.length === 0) {
    return emptyTrace(address, chain, tracedAt);
  }
  const aggHop1 = aggregateBySource(initialInflows);
  const { sources: hop1, total } = topSources(aggHop1);

  const tracedSources: TracedSource[] = [];
  const sanctionsHits: SanctionsHit[] = [];
  const nodes: FundFlowNode[] = [
    { id: address, address, label: null, valueUsd: total, hopDepth: 0, kind: "wallet" },
  ];
  const edges: FundFlowEdge[] = [];
  const seenNodeIds = new Set<string>([address]);

  // Traverse sources BFS up to maxHopDepth
  type Queue = Array<{ src: string; parent: string; valueUsd: number; depth: number; path: string[] }>;
  const queue: Queue = hop1.map((s) => ({
    src: s.address,
    parent: address,
    valueUsd: s.valueUsd,
    depth: 1,
    path: [address, s.address],
  }));

  let hopsUsed = 0;

  while (queue.length > 0) {
    const item = queue.shift()!;
    hopsUsed = Math.max(hopsUsed, item.depth);
    const label = await lookupAddress(item.src, chain);

    if (!seenNodeIds.has(item.src)) {
      nodes.push({
        id: item.src,
        address: item.src,
        label,
        valueUsd: item.valueUsd,
        hopDepth: item.depth,
        kind: "source",
      });
      seenNodeIds.add(item.src);
    }
    edges.push({ from: item.src, to: item.parent, valueUsd: item.valueUsd });

    if (label.sanctioned) {
      sanctionsHits.push({
        address: item.src,
        listName: "OFAC SDN",
        reason: label.name || "Sanctioned entity",
      });
      tracedSources.push({
        address: item.src,
        valueUsd: item.valueUsd,
        percentage: total > 0 ? item.valueUsd / total : 0,
        label,
        hopDepth: item.depth,
        path: item.path,
      });
      continue;
    }

    // Identified exchange -> STOP
    if (label.entityType === "exchange") {
      tracedSources.push({
        address: item.src,
        valueUsd: item.valueUsd,
        percentage: total > 0 ? item.valueUsd / total : 0,
        label,
        hopDepth: item.depth,
        path: item.path,
      });
      continue;
    }

    // DEX/bridge/contract -> neutral, trace one more hop through it (unless at max)
    if (
      (label.entityType === "dex" || label.entityType === "bridge" || label.entityType === "contract") &&
      item.depth < maxHopDepth
    ) {
      const deeper = await loadIncomingEvm(item.src, chain);
      const agg = aggregateBySource(deeper);
      const top = topSources(agg);
      for (const s of top.sources.slice(0, 5)) {
        queue.push({
          src: s.address,
          parent: item.src,
          valueUsd: s.valueUsd,
          depth: item.depth + 1,
          path: [...item.path, s.address],
        });
      }
      // Also record the intermediate neutral node as a passthrough
      continue;
    }

    // Unknown -> continue deeper if hops remaining
    if (label.entityType === "unknown" && item.depth < maxHopDepth) {
      const deeper = await loadIncomingEvm(item.src, chain);
      if (deeper.length === 0) {
        tracedSources.push({
          address: item.src,
          valueUsd: item.valueUsd,
          percentage: total > 0 ? item.valueUsd / total : 0,
          label,
          hopDepth: item.depth,
          path: item.path,
        });
        continue;
      }
      const agg = aggregateBySource(deeper);
      const top = topSources(agg);
      for (const s of top.sources.slice(0, 5)) {
        queue.push({
          src: s.address,
          parent: item.src,
          valueUsd: Math.min(s.valueUsd, item.valueUsd),
          depth: item.depth + 1,
          path: [...item.path, s.address],
        });
      }
      continue;
    }

    // Max hops reached or mixer
    tracedSources.push({
      address: item.src,
      valueUsd: item.valueUsd,
      percentage: total > 0 ? item.valueUsd / total : 0,
      label,
      hopDepth: item.depth,
      path: item.path,
    });
  }

  const attributed = tracedSources
    .filter((s) => s.label && s.label.entityType !== "unknown" && !s.label.sanctioned)
    .reduce((acc, s) => acc + s.valueUsd, 0);

  return {
    walletAddress: address,
    chain,
    totalIncomingValueUsd: total,
    attributedValueUsd: attributed,
    attributedPercentage: total > 0 ? attributed / total : 0,
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
