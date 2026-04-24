import type { AddressLabel, EntityType } from "./types";
import ofacData from "../data/ofac-sdn-addresses.json";
import dexData from "../data/known-dex-labels.json";
import { lookupExchangeByAddress } from "./exchangeTiers";

type OfacRecord = { listName: string; reason: string; entityNote: string };
type DexRecord = { name: string; entityType: EntityType; exchange?: string };

const OFAC_SET: Map<string, OfacRecord> = new Map(
  Object.entries((ofacData as { addresses: Record<string, OfacRecord> }).addresses ?? {}).map(
    ([a, v]) => [a.toLowerCase(), v]
  )
);

const DEX_SET: Map<string, DexRecord> = new Map(
  Object.entries((dexData as { labels: Record<string, DexRecord> }).labels ?? {}).map(
    ([a, v]) => [a.toLowerCase(), v]
  )
);

type EtherscanLabelCache = { name: string | null; fetchedAt: number };
const etherscanCache = new Map<string, EtherscanLabelCache>();
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

export function isSanctioned(address: string): { sanctioned: boolean; record?: OfacRecord } {
  const rec = OFAC_SET.get(address.toLowerCase());
  return rec ? { sanctioned: true, record: rec } : { sanctioned: false };
}

export function lookupDexLabel(address: string): DexRecord | null {
  return DEX_SET.get(address.toLowerCase()) ?? null;
}

async function fetchEtherscanLabel(
  address: string,
  chainId: number = 1
): Promise<string | null> {
  const cached = etherscanCache.get(address.toLowerCase());
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.name;
  }

  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    return null;
  }

  // Etherscan V2 — name tag lookup is not a stable public endpoint;
  // we rely on getsourcecode as a heuristic for contract name, else return null.
  try {
    const url = new URL("https://api.etherscan.io/v2/api");
    url.searchParams.set("chainid", String(chainId));
    url.searchParams.set("module", "contract");
    url.searchParams.set("action", "getsourcecode");
    url.searchParams.set("address", address);
    url.searchParams.set("apikey", apiKey);

    const res = await fetch(url.toString(), {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) {
      etherscanCache.set(address.toLowerCase(), { name: null, fetchedAt: Date.now() });
      return null;
    }
    const json = (await res.json()) as { status: string; result?: Array<{ ContractName?: string }> };
    const name = json.result?.[0]?.ContractName || null;
    etherscanCache.set(address.toLowerCase(), { name, fetchedAt: Date.now() });
    return name;
  } catch {
    etherscanCache.set(address.toLowerCase(), { name: null, fetchedAt: Date.now() });
    return null;
  }
}

export async function lookupAddress(
  address: string,
  chain: string = "ethereum"
): Promise<AddressLabel> {
  const addr = address.toLowerCase();

  // 1. OFAC sanctions check (hard stop)
  const sanction = isSanctioned(addr);
  if (sanction.sanctioned && sanction.record) {
    return {
      address: addr,
      name: sanction.record.entityNote,
      entityType: "mixer",
      sanctioned: true,
      source: "ofac",
    };
  }

  // 2. Known exchange address
  const exchange = lookupExchangeByAddress(addr);
  if (exchange) {
    return {
      address: addr,
      name: exchange.displayName,
      entityType: "exchange",
      exchangeTier: exchange.tier,
      sanctioned: false,
      source: "manual",
    };
  }

  // 3. Known DEX / bridge / infrastructure
  const dex = lookupDexLabel(addr);
  if (dex) {
    // DEX label may reference an exchange (e.g. Binance 7)
    if (dex.exchange) {
      const ex = lookupExchangeByAddress(addr) || null;
      return {
        address: addr,
        name: dex.name,
        entityType: "exchange",
        exchangeTier: ex?.tier,
        sanctioned: false,
        source: "eth-labels",
      };
    }
    return {
      address: addr,
      name: dex.name,
      entityType: dex.entityType,
      sanctioned: false,
      source: "eth-labels",
    };
  }

  // 4. Etherscan contract name (best-effort, EVM chains only)
  const chainIdMap: Record<string, number> = {
    ethereum: 1, base: 8453, arbitrum: 42161, polygon: 137, bsc: 56, optimism: 10,
  };
  const chainId = chainIdMap[chain.toLowerCase()];
  if (chainId) {
    const name = await fetchEtherscanLabel(addr, chainId);
    if (name) {
      return {
        address: addr,
        name,
        entityType: "contract",
        sanctioned: false,
        source: "etherscan",
      };
    }
  }

  // 5. Unknown
  return {
    address: addr,
    name: null,
    entityType: "unknown",
    sanctioned: false,
    source: "heuristic",
  };
}

export function ofacAddressCount(): number {
  return OFAC_SET.size;
}

export function dexLabelCount(): number {
  return DEX_SET.size;
}
