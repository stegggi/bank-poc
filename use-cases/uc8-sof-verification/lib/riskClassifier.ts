import type { RiskClassification, TraceResult } from "./types";

export type ClassifyOptions = {
  greenThreshold?: number; // e.g. 0.9
  amberThreshold?: number; // e.g. 0.6
};

export function classifyTrace(
  trace: TraceResult,
  opts: ClassifyOptions = {}
): RiskClassification {
  const green = opts.greenThreshold ?? 0.9;
  const amber = opts.amberThreshold ?? 0.6;

  const reasons: string[] = [];

  // Hard reds
  if (trace.sanctionsHits.length > 0) {
    reasons.push(
      `Sanctions hit: ${trace.sanctionsHits.map((h) => h.reason).join(", ")}`
    );
    return {
      tier: "RED",
      reasons,
      thresholds: { green, amber },
      requiresTTP: true,
      requiresDocs: true,
    };
  }

  const mixerExposure = trace.sources.some(
    (s) => s.label?.entityType === "mixer"
  );
  if (mixerExposure) {
    reasons.push("Mixer/tumbler exposure detected");
    return {
      tier: "RED",
      reasons,
      thresholds: { green, amber },
      requiresTTP: true,
      requiresDocs: true,
    };
  }

  // Tier breakdown
  const tierAValue = trace.sources
    .filter((s) => s.label?.entityType === "exchange" && s.label.exchangeTier === "A")
    .reduce((sum, s) => sum + s.valueUsd, 0);

  const tierBValue = trace.sources
    .filter((s) => s.label?.entityType === "exchange" && s.label.exchangeTier === "B")
    .reduce((sum, s) => sum + s.valueUsd, 0);

  const tierCValue = trace.sources
    .filter((s) => s.label?.entityType === "exchange" && s.label.exchangeTier === "C")
    .reduce((sum, s) => sum + s.valueUsd, 0);

  const dexBridgeValue = trace.sources
    .filter((s) => s.label?.entityType === "dex" || s.label?.entityType === "bridge")
    .reduce((sum, s) => sum + s.valueUsd, 0);

  const total = trace.totalIncomingValueUsd || 1;
  const tierCShare = tierCValue / total;

  const cov = trace.attributedPercentage;

  // RED thresholds
  if (tierCShare > 0.1) {
    reasons.push(
      `Tier C exchange sources account for ${(tierCShare * 100).toFixed(1)}% of inflows`
    );
    return {
      tier: "RED",
      reasons,
      thresholds: { green, amber },
      requiresTTP: true,
      requiresDocs: true,
    };
  }

  if (cov < amber) {
    reasons.push(
      `Attributable source coverage ${(cov * 100).toFixed(1)}% is below the AMBER threshold of ${(amber * 100).toFixed(0)}%`
    );
    return {
      tier: "RED",
      reasons,
      thresholds: { green, amber },
      requiresTTP: true,
      requiresDocs: true,
    };
  }

  // GREEN
  if (cov >= green && tierBValue === 0 && tierCValue === 0 && dexBridgeValue / total < 0.15) {
    reasons.push(
      `Attributable coverage ${(cov * 100).toFixed(1)}% meets GREEN threshold`
    );
    if (tierAValue / total > 0.8) {
      reasons.push("Dominant sources are Tier A regulated exchanges");
    }
    return {
      tier: "GREEN",
      reasons,
      thresholds: { green, amber },
      requiresTTP: false,
      requiresDocs: false,
    };
  }

  // AMBER
  if (tierBValue > 0) {
    reasons.push(
      `Tier B exchange sources present (${((tierBValue / total) * 100).toFixed(1)}% of inflows) — request supplementary KYC documentation`
    );
  }
  if (dexBridgeValue / total >= 0.15) {
    reasons.push(
      `Significant DEX/bridge activity (${((dexBridgeValue / total) * 100).toFixed(1)}%) adds complexity`
    );
  }
  if (cov < green) {
    reasons.push(
      `Attributable coverage ${(cov * 100).toFixed(1)}% is in the AMBER band (${(amber * 100).toFixed(0)}%–${(green * 100).toFixed(0)}%)`
    );
  }
  if (reasons.length === 0) {
    reasons.push("Mixed or moderate risk indicators present");
  }

  return {
    tier: "AMBER",
    reasons,
    thresholds: { green, amber },
    requiresTTP: false,
    requiresDocs: true,
  };
}

export function aggregateRisk(tiers: Array<RiskClassification | undefined>): "GREEN" | "AMBER" | "RED" {
  let hasRed = false;
  let hasAmber = false;
  for (const t of tiers) {
    if (!t) continue;
    if (t.tier === "RED") hasRed = true;
    if (t.tier === "AMBER") hasAmber = true;
  }
  if (hasRed) return "RED";
  if (hasAmber) return "AMBER";
  return "GREEN";
}
