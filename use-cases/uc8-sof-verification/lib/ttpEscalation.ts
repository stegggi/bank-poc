import { randomBytes } from "crypto";
import type { FlaggedAddress, TTPReport } from "./types";

export interface TTPProvider {
  name: string;
  screenAddress(address: string, chain: string): Promise<TTPReport>;
}

export class MockTTPProvider implements TTPProvider {
  name = "MockAnalytics";

  async screenAddress(address: string, chain: string): Promise<TTPReport> {
    // Deterministic randomness per address/chain for demo repeatability.
    const seed = hashToInt(`${address}:${chain}`);
    const rand = mulberry32(seed);

    // Generate plausible exposure breakdown
    const categories = [
      "regulated_exchange",
      "decentralized_finance",
      "gambling",
      "darknet_market",
      "sanctioned",
      "mixer",
      "unknown",
    ];
    const raw = categories.map(() => rand());
    const sum = raw.reduce((s, v) => s + v, 0);
    const exposureBreakdown: Record<string, number> = {};
    categories.forEach((c, i) => {
      exposureBreakdown[c] = Number(((raw[i] / sum) * 100).toFixed(2));
    });

    // Weight darknet/sanctioned/mixer into the risk score
    const riskScore = Math.min(
      100,
      Math.round(
        exposureBreakdown.darknet_market * 4 +
          exposureBreakdown.sanctioned * 5 +
          exposureBreakdown.mixer * 3 +
          exposureBreakdown.gambling * 1.5 +
          exposureBreakdown.unknown * 0.5
      )
    );

    const riskLevel: TTPReport["riskLevel"] =
      riskScore >= 80 ? "critical" :
      riskScore >= 60 ? "high" :
      riskScore >= 40 ? "medium" : "low";

    const flagged: FlaggedAddress[] = [];
    if (exposureBreakdown.sanctioned > 3) {
      flagged.push({
        address: `0x${randomBytes(20).toString("hex")}`,
        category: "OFAC SDN",
        riskLevel: "critical",
        note: "Counterparty appears on OFAC sanctioned list",
      });
    }
    if (exposureBreakdown.mixer > 5) {
      flagged.push({
        address: `0x${randomBytes(20).toString("hex")}`,
        category: "Mixer",
        riskLevel: "high",
        note: "Funds traced through mixing service",
      });
    }
    if (exposureBreakdown.darknet_market > 4) {
      flagged.push({
        address: `0x${randomBytes(20).toString("hex")}`,
        category: "Darknet Market",
        riskLevel: "critical",
        note: "Historical connection to darknet market",
      });
    }

    const summary = [
      `Forensic screening completed for ${address} on ${chain}.`,
      `Overall risk: ${riskLevel.toUpperCase()} (score ${riskScore}/100).`,
      flagged.length > 0
        ? `${flagged.length} flagged counterpart${flagged.length === 1 ? "y" : "ies"} identified.`
        : "No high-risk counterparties flagged.",
    ].join(" ");

    return {
      provider: this.name,
      address,
      chain,
      riskScore,
      riskLevel,
      exposureBreakdown,
      flaggedAddresses: flagged,
      summary,
      reportDate: new Date().toISOString(),
      reportId: `MTTP-${Date.now()}-${randomBytes(4).toString("hex")}`,
    };
  }
}

function hashToInt(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function getTTPProvider(): TTPProvider {
  const provider = (process.env.TTP_PROVIDER || "mock").toLowerCase();
  switch (provider) {
    case "mock":
    default:
      return new MockTTPProvider();
  }
}

export async function escalateAddress(address: string, chain: string): Promise<TTPReport> {
  const provider = getTTPProvider();
  return provider.screenAddress(address, chain);
}
