import exchangeData from "../data/exchange-tiers.json";
import type { ExchangeTier } from "./types";

export type ExchangeRecord = {
  tier: ExchangeTier;
  displayName: string;
  licenses: string[];
  knownAddresses: string[];
  notes: string;
  slug: string;
};

const EXCHANGE_MAP: Record<string, ExchangeRecord> = (() => {
  const out: Record<string, ExchangeRecord> = {};
  for (const [slug, rec] of Object.entries(exchangeData as Record<string, Omit<ExchangeRecord, "slug">>)) {
    out[slug] = { ...rec, slug };
  }
  return out;
})();

// Reverse lookup: address (lowercase) -> exchange slug
const ADDRESS_INDEX: Map<string, string> = (() => {
  const idx = new Map<string, string>();
  for (const [slug, rec] of Object.entries(EXCHANGE_MAP)) {
    for (const addr of rec.knownAddresses) {
      idx.set(addr.toLowerCase(), slug);
    }
  }
  return idx;
})();

export function listExchanges(): ExchangeRecord[] {
  return Object.values(EXCHANGE_MAP);
}

export function getExchange(slug: string): ExchangeRecord | null {
  return EXCHANGE_MAP[slug] ?? null;
}

export function lookupExchangeByAddress(address: string): ExchangeRecord | null {
  const slug = ADDRESS_INDEX.get(address.toLowerCase());
  if (!slug) return null;
  return EXCHANGE_MAP[slug];
}

export function tierDescription(tier: ExchangeTier): string {
  switch (tier) {
    case "A":
      return "FINMA-equivalent supervision. Full reliance on KYC.";
    case "B":
      return "Conditional reliance. Request supplementary documentation from client.";
    case "C":
      return "No reliance. Treat as unattributed source.";
  }
}

export function tierColor(tier: ExchangeTier): string {
  switch (tier) {
    case "A": return "#10b981";
    case "B": return "#f59e0b";
    case "C": return "#ef4444";
  }
}
