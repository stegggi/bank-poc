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

function isKnownFeeRate(feeRate) {
  return Number.isFinite(Number(feeRate)) && Number(feeRate) > 0 && Number(feeRate) < 0.2;
}

export function computeEconomicsAndStats({
  stats,
  selector,
  refCapitalUsd,
  bandHalfBps,
  edgeRebalancePct,
  gasBaselineUsd,
  rebalanceSwapNotionalPct = 0.1,
  minTvlUsd = 2_000_000,
  maxRefCapitalPctOfTvl = 0.0025,
  requireFeeRateInference = true,
}) {
  const feeRate = isKnownFeeRate(selector?.feeRate) ? Number(selector.feeRate) : null;
  const tvlUsd = Math.max(0, num(stats?.tvlUsd, 0));
  const tvlAvg7dUsd = Math.max(num(stats?.tvlAvg7dUsd, tvlUsd), 1e-9);
  const tvlAvg30dUsd = Math.max(num(stats?.tvlAvg30dUsd, tvlUsd), 1e-9);
  const volAvg7dUsd = Math.max(0, num(stats?.volAvg7dUsd, 0));
  const volAvg30dUsd = Math.max(0, num(stats?.volAvg30dUsd, 0));
  const dailyRangePct7d = Math.max(0, num(stats?.dailyRangePct7d, 0));
  const capUsd = Math.max(0, num(refCapitalUsd, 0));
  const gasUsd = Math.max(0, num(gasBaselineUsd, 0.03));
  const swapNotionalPct = clamp(num(rebalanceSwapNotionalPct, 0.1), 0, 1);

  const feesDay7dUsd = feeRate == null ? null : volAvg7dUsd * feeRate;
  const feesDay30dUsd = feeRate == null ? null : volAvg30dUsd * feeRate;
  const feePower7d = feeRate == null ? null : safeDiv(feesDay7dUsd, tvlAvg7dUsd, null);
  const feePower30d = feeRate == null ? null : safeDiv(feesDay30dUsd, tvlAvg30dUsd, null);
  const flowTrend =
    feePower7d != null && feePower30d != null
      ? safeDiv(feePower7d, Math.max(feePower30d, 1e-12), 1)
      : null;

  const bandHalfPct = Math.max(1e-6, num(bandHalfBps, 0) / 10_000);
  const edgePct = clamp(num(edgeRebalancePct, 0.85), 0.1, 0.99);
  const alpha = clamp(safeDiv(dailyRangePct7d, 2 * bandHalfPct, 0.6), 0.2, 0.9);
  const effectiveBoundary = Math.max(1e-6, bandHalfPct * edgePct);
  const expectedRebalancesPerDay = clamp(safeDiv(dailyRangePct7d, effectiveBoundary, 0), 0, 6);

  const expectedFeesDayUsd = feePower7d == null ? null : capUsd * feePower7d * alpha;
  const swapFeeBaselineUsd = feeRate == null ? null : capUsd * swapNotionalPct * feeRate;
  const expectedCostPerRebalanceUsd = gasUsd + Math.max(0, num(swapFeeBaselineUsd, 0));
  const expectedCostsDayUsd = expectedCostPerRebalanceUsd * expectedRebalancesPerDay;
  const expectedNetDayUsd =
    expectedFeesDayUsd == null ? null : expectedFeesDayUsd - expectedCostsDayUsd;

  const refCapitalPctOfTvl = safeDiv(capUsd, Math.max(tvlAvg7dUsd, 1), 0);
  const scalableByTvl = tvlAvg7dUsd >= Math.max(0, num(minTvlUsd, 0));
  const scalableBySize = refCapitalPctOfTvl <= Math.max(0, num(maxRefCapitalPctOfTvl, 0));
  const scalable = scalableByTvl && scalableBySize;

  let finalScore = expectedNetDayUsd == null ? Number.NEGATIVE_INFINITY : expectedNetDayUsd;
  let scoreReason = "ok";
  if (requireFeeRateInference && feeRate == null) {
    finalScore = Number.NEGATIVE_INFINITY;
    scoreReason = "unknown_fee";
  } else {
    if (!scalable) {
      finalScore -= 1e9;
      scoreReason = !scalableByTvl ? "low_tvl" : "too_large_for_pool";
    }
    if (num(stats?.volumeStability30d, 0) > 1) {
      finalScore -= 0.02 * capUsd;
    }
  }

  return {
    stats: {
      ...stats,
      feesDay7dUsd,
      feesDay30dUsd,
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
      gasBaselineUsd: gasUsd,
      rebalanceSwapNotionalPct: swapNotionalPct,
      finalScore,
      scoreReason,
    },
    scalability: {
      scalable,
      scalableByTvl,
      scalableBySize,
      tvlMinUsd: Math.max(0, num(minTvlUsd, 0)),
      maxRefCapitalPctOfTvl: Math.max(0, num(maxRefCapitalPctOfTvl, 0)),
      refCapitalPctOfTvl,
    },
  };
}

function fmtUsdCompactReason(v) {
  if (v == null || Number.isNaN(v)) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(n < 10 ? 2 : 1)}`;
}

function fmtPctReason(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

function ratingReason({ row, current, rating, requireFeeRateInference }) {
  const rowStats = row?.stats || {};
  const currentStats = current?.stats || {};
  const rowScale = row?.scalability || {};
  const currentScale = current?.scalability || {};
  const rowFeeKnown = isKnownFeeRate(row?.selector?.feeRate);
  const currentFeeKnown = isKnownFeeRate(current?.selector?.feeRate);

  if (requireFeeRateInference && !rowFeeKnown) {
    return "unknown fee tier";
  }
  if (!rowScale.scalable) {
    return !rowScale.scalableByTvl
      ? "not scalable (low TVL for your size)"
      : "not scalable (your size is too large for pool TVL)";
  }
  if (!currentScale.scalable) {
    return "current pool baseline not scalable";
  }

  const parts = [];
  const rowFeesDay = num(rowStats.feesDay7dUsd, NaN);
  const curFeesDay = num(currentStats.feesDay7dUsd, NaN);
  if (Number.isFinite(rowFeesDay) && Number.isFinite(curFeesDay)) {
    parts.push(`fees/day ${fmtUsdCompactReason(rowFeesDay)} vs ${fmtUsdCompactReason(curFeesDay)}`);
  }

  const rowFeePower7d = num(rowStats.feePower7d, NaN);
  const rowFeePower30d = num(rowStats.feePower30d, NaN);
  if (Number.isFinite(rowFeePower7d) && Number.isFinite(rowFeePower30d)) {
    parts.push(`feePower ${fmtPctReason(rowFeePower7d)} / ${fmtPctReason(rowFeePower30d)}`);
  }

  const rowStab = num(rowStats.volumeStability30d, 0);
  const curStab = num(currentStats.volumeStability30d, rowStab);
  if (rowStab <= curStab * 1.1) parts.push("stable volume");
  else parts.push("unstable volume");

  if (rating === "More") parts.push("scalable");
  return parts.slice(0, 3).join("; ");
}

export function compareToCurrentPool(
  row,
  currentRow,
  { switchCostUsd = 0.1, requireFeeRateInference = true } = {}
) {
  const rowScale = row?.scalability || {};
  const currentScale = currentRow?.scalability || {};
  const rowFeeKnown = isKnownFeeRate(row?.selector?.feeRate);
  const currentFeeKnown = isKnownFeeRate(currentRow?.selector?.feeRate);

  if (!currentRow) {
    return {
      rating: "Less",
      reason: "current pool baseline unavailable",
      expectedNetDiffDayUsd: 0,
      switchCostUsd,
      breakEvenDays: null,
    };
  }

  const rowNet = row?.economics?.expectedNetDayUsd;
  const currentNet = currentRow?.economics?.expectedNetDayUsd;
  const rowNetNum = Number(rowNet);
  const currentNetNum = Number(currentNet);
  const diff =
    Number.isFinite(rowNetNum) && Number.isFinite(currentNetNum) ? rowNetNum - currentNetNum : null;

  let rating = "Less";
  if (!rowScale.scalable) {
    rating = "Less";
  } else if (!currentScale.scalable) {
    rating = "Less";
  } else if (requireFeeRateInference && (!rowFeeKnown || !currentFeeKnown)) {
    rating = "Less";
  } else if (Number.isFinite(rowNetNum) && Number.isFinite(currentNetNum)) {
    const within10Pct =
      currentNetNum !== 0
        ? Math.abs(rowNetNum - currentNetNum) <= Math.abs(currentNetNum) * 0.1
        : Math.abs(rowNetNum - currentNetNum) <= 0.01;
    const rowFlowTrend = num(row?.stats?.flowTrend, NaN);
    const rowStability = num(row?.stats?.volumeStability30d, 0);
    const currentStability = Math.max(1e-9, num(currentRow?.stats?.volumeStability30d, rowStability || 1));
    const ratio = safeDiv(rowNetNum, Math.max(currentNetNum, 1e-9), currentNetNum > 0 ? 1 : 0);

    if (within10Pct) {
      rating = "Similar";
    } else if (
      currentNetNum > 0 &&
      ratio >= 1.15 &&
      rowFlowTrend >= 0.9 &&
      rowStability <= currentStability * 1.25
    ) {
      rating = "More";
    } else if (currentNetNum <= 0 && rowNetNum > currentNetNum && rowScale.scalable && currentScale.scalable) {
      rating = rowNetNum > 0 ? "More" : "Similar";
    }
  }

  const switchCost = Math.max(0, num(switchCostUsd, 0));
  const breakEvenDays =
    Number.isFinite(diff) && diff > 1e-9 ? switchCost / diff : null;
  return {
    rating,
    reason: ratingReason({ row, current: currentRow, rating, requireFeeRateInference }),
    expectedNetDiffDayUsd: Number.isFinite(diff) ? diff : null,
    switchCostUsd: switchCost,
    breakEvenDays,
  };
}
