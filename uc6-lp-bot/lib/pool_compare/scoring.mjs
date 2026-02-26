function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeDiv(a, b, fallback = 0) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb) || nb === 0) return fallback;
  return na / nb;
}

export function mean(values) {
  const arr = (Array.isArray(values) ? values : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function stdev(values) {
  const arr = (Array.isArray(values) ? values : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((acc, x) => acc + (x - m) ** 2, 0) / arr.length;
  return Math.sqrt(Math.max(0, variance));
}

export function computeEconomicsAndStats({
  stats,
  selector,
  refCapitalUsd,
  bandHalfBps,
  edgeRebalancePct,
  gasBaselineUsd,
  rebalanceSwapNotionalPct = 0.1,
}) {
  const feeRate = Math.max(0, num(selector?.feeRate, 0));
  const tvlAvg7dUsd = Math.max(num(stats?.tvlAvg7dUsd, num(stats?.tvlUsd, 0)), 1e-9);
  const tvlAvg30dUsd = Math.max(num(stats?.tvlAvg30dUsd, num(stats?.tvlUsd, 0)), 1e-9);
  const volAvg7dUsd = Math.max(0, num(stats?.volAvg7dUsd, 0));
  const volAvg30dUsd = Math.max(0, num(stats?.volAvg30dUsd, 0));
  const dailyRangePct7d = Math.max(0, num(stats?.dailyRangePct7d, 0));

  const feePower7d = safeDiv(volAvg7dUsd * feeRate, tvlAvg7dUsd, 0);
  const feePower30d = safeDiv(volAvg30dUsd * feeRate, tvlAvg30dUsd, 0);
  const flowTrend = safeDiv(feePower7d, Math.max(feePower30d, 1e-12), 1);

  const bandHalfPct = Math.max(1e-6, num(bandHalfBps, 0) / 10_000);
  const edgePct = clamp(num(edgeRebalancePct, 0.85), 0.1, 0.99);
  const alpha = clamp(safeDiv(dailyRangePct7d, 2 * bandHalfPct, 0.6), 0.2, 0.9);
  const effectiveBoundary = Math.max(1e-6, bandHalfPct * edgePct);
  const expectedRebalancesPerDay = clamp(safeDiv(dailyRangePct7d, effectiveBoundary, 0), 0, 10);

  const capUsd = Math.max(0, num(refCapitalUsd, 0));
  const expectedFeesDayUsd = capUsd * feePower7d * alpha;
  const swapFeeBaselineUsd = capUsd * clamp(num(rebalanceSwapNotionalPct, 0.1), 0, 1) * feeRate;
  const expectedCostPerRebalanceUsd = Math.max(0, num(gasBaselineUsd, 0.03)) + Math.max(0, swapFeeBaselineUsd);
  const expectedCostsDayUsd = expectedCostPerRebalanceUsd * expectedRebalancesPerDay;
  const expectedNetDayUsd = expectedFeesDayUsd - expectedCostsDayUsd;

  return {
    stats: {
      ...stats,
      feePower7d,
      feePower30d,
      flowTrend,
    },
    economics: {
      expectedFeesDayUsd,
      expectedCostsDayUsd,
      expectedNetDayUsd,
      expectedRebalancesPerDay,
      expectedCostPerRebalanceUsd,
      gasBaselineUsd: Math.max(0, num(gasBaselineUsd, 0.03)),
      rebalanceSwapNotionalPct: clamp(num(rebalanceSwapNotionalPct, 0.1), 0, 1),
    },
  };
}

function ratingReason({ row, current, rating }) {
  const reasons = [];
  const rowStats = row?.stats || {};
  const curStats = current?.stats || {};
  if (num(rowStats.feePower7d, 0) > num(curStats.feePower7d, 0) * 1.05) reasons.push("higher FeePower7d");
  else if (num(rowStats.feePower7d, 0) < num(curStats.feePower7d, 0) * 0.95) reasons.push("lower FeePower7d");

  if (num(rowStats.flowTrend, 1) >= 0.9) reasons.push("stable 7d/30d flow");
  else reasons.push("weaker recent flow");

  const rowStab = num(rowStats.volumeStability30d, 0);
  const curStab = Math.max(1e-9, num(curStats.volumeStability30d, rowStab || 1));
  if (rowStab <= curStab * 0.9) reasons.push("more stable volume");
  else if (rowStab > curStab * 1.25) reasons.push("more volatile volume");

  if (row?.selector?.feeIsEstimated) reasons.push("fee estimated");
  if (reasons.length === 0) {
    if (rating === "Similar") return "Comparable fee-power and cost profile";
    return rating === "More" ? "Higher expected net/day" : "Lower expected net/day";
  }
  return reasons.slice(0, 2).join("; ");
}

export function compareToCurrentPool(row, currentRow, { switchCostUsd = 0.1 } = {}) {
  if (!currentRow) {
    return {
      rating: "Similar",
      reason: "Current pool baseline unavailable",
      expectedNetDiffDayUsd: 0,
      switchCostUsd,
      breakEvenDays: null,
    };
  }

  const rowNet = num(row?.economics?.expectedNetDayUsd, 0);
  const currentNet = num(currentRow?.economics?.expectedNetDayUsd, 0);
  const diff = rowNet - currentNet;
  const ratio = safeDiv(rowNet, Math.max(currentNet, 1e-9), currentNet > 0 ? 1 : 0);
  const within10Pct = currentNet > 0 ? Math.abs(rowNet - currentNet) <= Math.abs(currentNet) * 0.1 : Math.abs(diff) <= 0.01;
  const rowFlowTrend = num(row?.stats?.flowTrend, 1);
  const rowStability = num(row?.stats?.volumeStability30d, 0);
  const currentStability = Math.max(1e-9, num(currentRow?.stats?.volumeStability30d, rowStability || 1));

  let rating = "Less";
  if (within10Pct) {
    rating = "Similar";
  } else if (
    currentNet > 0 &&
    ratio >= 1.15 &&
    rowFlowTrend >= 0.9 &&
    rowStability <= currentStability * 1.25
  ) {
    rating = "More";
  } else if (currentNet <= 0 && rowNet > currentNet) {
    rating = rowNet > 0 ? "More" : "Similar";
  }

  const switchCost = Math.max(0, num(switchCostUsd, 0));
  const breakEvenDays = diff > 1e-9 ? switchCost / diff : null;
  return {
    rating,
    reason: ratingReason({ row, current: currentRow, rating }),
    expectedNetDiffDayUsd: diff,
    switchCostUsd: switchCost,
    breakEvenDays,
  };
}

