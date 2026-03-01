// Copied from uc6-lp-bot/lib/regime.mjs on 2026-02-26/aefdb739fb88bf52eba305659f36ca74db2b9f7a. UC5-specific edits below.

const LN_1_0001 = Math.log(1.0001);

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function toFiniteNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function median(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return null;
  const arr = nums.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
}

function inferLogPrice(sample) {
  if (!sample || typeof sample !== "object") return null;
  if (Number.isFinite(Number(sample.logPrice))) return Number(sample.logPrice);
  if (Number.isFinite(Number(sample.tick))) return Number(sample.tick) * LN_1_0001;
  const price = Number(sample.price);
  if (Number.isFinite(price) && price > 0) return Math.log(price);
  return null;
}

export function createRegimeState({ windowSec = 1800, sampleEverySec = 12, minSamples = 60 } = {}) {
  return {
    config: {
      windowSec: Math.max(30, Math.round(toFiniteNumber(windowSec, 1800))),
      sampleEverySec: Math.max(1, Math.round(toFiniteNumber(sampleEverySec, 12))),
      minSamples: Math.max(5, Math.round(toFiniteNumber(minSamples, 60))),
    },
    samples: [],
    lastSampleTsSec: 0,
    lastEstimate: null,
    updatedAtSec: null,
  };
}

export function ingestSample(state, sample) {
  if (!state || typeof state !== "object") return false;
  if (!state.config || typeof state.config !== "object") {
    state.config = createRegimeState({}).config;
  }
  if (!Array.isArray(state.samples)) state.samples = [];
  const tsSec = Math.floor(toFiniteNumber(sample?.tsSec, NaN));
  if (!Number.isFinite(tsSec) || tsSec <= 0) return false;
  const logPrice = inferLogPrice(sample);
  if (!(Number.isFinite(logPrice) && Math.abs(logPrice) < 1e6)) return false;

  const lastTs = Number(state.lastSampleTsSec || 0);
  const minStep = Math.max(1, Number(state.config.sampleEverySec || 1));
  if (lastTs && tsSec - lastTs < minStep) return false;

  if (lastTs && tsSec <= lastTs) {
    return false;
  }

  state.samples.push({ tsSec, logPrice });
  state.lastSampleTsSec = tsSec;
  state.updatedAtSec = tsSec;

  const windowSec = Math.max(30, Number(state.config.windowSec || 1800));
  const cutoff = tsSec - windowSec;
  let trimIdx = 0;
  while (trimIdx < state.samples.length && Number(state.samples[trimIdx]?.tsSec || 0) < cutoff) trimIdx += 1;
  if (trimIdx > 0) state.samples.splice(0, trimIdx);

  return true;
}

export function estimateOU(state) {
  const unknown = {
    ok: false,
    theta: 0,
    mu: 0,
    sigma: 0,
    halfLifeSec: Number.POSITIVE_INFINITY,
    label: "unknown",
    confidence: 0,
  };
  if (!state || typeof state !== "object" || !Array.isArray(state.samples)) return unknown;
  const samples = state.samples.filter(
    (s) => s && Number.isFinite(Number(s.tsSec)) && Number.isFinite(Number(s.logPrice))
  );
  const minSamples = Math.max(5, Number(state.config?.minSamples || 60));
  if (samples.length < minSamples) {
    return {
      ...unknown,
      confidence: clamp(samples.length / Math.max(minSamples, 1), 0, 0.49),
    };
  }

  const xs = [];
  const ys = [];
  const dts = [];
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const next = samples[i];
    const dt = Number(next.tsSec) - Number(prev.tsSec);
    if (!(Number.isFinite(dt) && dt > 0)) continue;
    const x = Number(prev.logPrice);
    const y = Number(next.logPrice);
    if (!(Number.isFinite(x) && Number.isFinite(y))) continue;
    xs.push(x);
    ys.push(y);
    dts.push(dt);
  }
  if (xs.length < minSamples - 1) {
    return {
      ...unknown,
      confidence: clamp(xs.length / Math.max(minSamples - 1, 1), 0, 0.49),
    };
  }

  const dtSec = median(dts);
  if (!(Number.isFinite(dtSec) && dtSec > 0)) return unknown;

  const n = xs.length;
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - xMean;
    const dy = ys[i] - yMean;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (!(Number.isFinite(sxx) && sxx > 1e-18)) return unknown;
  const b = sxy / sxx;
  const a = yMean - b * xMean;
  if (!(Number.isFinite(a) && Number.isFinite(b))) return unknown;

  let theta = 0;
  let mu = 0;
  let halfLifeSec = Number.POSITIVE_INFINITY;
  if (b > 0 && b < 1) {
    theta = -Math.log(b) / dtSec;
    if (Number.isFinite(theta) && theta > 0) {
      halfLifeSec = Math.log(2) / theta;
      const denom = 1 - b;
      if (Math.abs(denom) > 1e-12) {
        mu = a / denom;
      }
    }
  }

  let rss = 0;
  let tss = 0;
  for (let i = 0; i < n; i += 1) {
    const yHat = a + b * xs[i];
    const resid = ys[i] - yHat;
    rss += resid * resid;
    const dy = ys[i] - yMean;
    tss += dy * dy;
  }
  const r2 = tss > 0 ? 1 - rss / tss : 0;
  const residVar = n > 2 ? rss / (n - 2) : 0;
  const sigma = residVar > 0 && dtSec > 0 ? Math.sqrt(residVar / dtSec) : 0;

  let label = "unknown";
  if (b >= 1 || b <= 0) {
    label = "trending";
  } else if (Number.isFinite(halfLifeSec)) {
    if (halfLifeSec <= 180) label = "mean_reverting";
    else if (halfLifeSec >= 900) label = "trending";
  }

  const sampleScore = clamp(n / Math.max(minSamples * 2, 1), 0, 1);
  const fitScore = clamp(Number.isFinite(r2) ? Math.max(r2, 0) : 0, 0, 1);
  const bScore = clamp(1 - Math.min(Math.abs(1 - b), 1), 0, 1);
  let confidence = 0.15 + 0.45 * sampleScore + 0.3 * fitScore + 0.1 * bScore;
  if (!Number.isFinite(confidence)) confidence = 0;
  if (!(Number.isFinite(theta) && theta > 0) && label !== "trending") confidence *= 0.4;
  confidence = clamp(confidence, 0, 1);

  const out = {
    ok: true,
    theta: Number.isFinite(theta) ? theta : 0,
    mu: Number.isFinite(mu) ? mu : 0,
    sigma: Number.isFinite(sigma) ? sigma : 0,
    halfLifeSec: Number.isFinite(halfLifeSec) ? halfLifeSec : Number.POSITIVE_INFINITY,
    label,
    confidence,
    intercept: a,
    slope: b,
    dtSec,
    sampleCount: n + 1,
    r2: Number.isFinite(r2) ? r2 : 0,
  };
  state.lastEstimate = out;
  return out;
}

export function getRegimeAdvice({ est, baseSettings, edgeProgress = 0, outOfRange = false, costs = {}, fees = {} }) {
  const unknown = {
    ok: false,
    label: est?.label || "unknown",
    halfLifeSec: Number.isFinite(est?.halfLifeSec) ? est.halfLifeSec : Number.POSITIVE_INFINITY,
    reason: "regime_unavailable",
  };
  if (!est || !est.ok) return unknown;
  if (!baseSettings || typeof baseSettings !== "object") return { ...unknown, reason: "missing_base_settings" };

  const regimeCfg = baseSettings.regime && typeof baseSettings.regime === "object" ? baseSettings.regime : {};
  const mrHalfLifeMaxSec = Math.max(10, Number(regimeCfg.mrHalfLifeMaxSec || 180));
  const trendHalfLifeMinSec = Math.max(mrHalfLifeMaxSec + 1, Number(regimeCfg.trendHalfLifeMinSec || 900));
  const maxEdgeAdj = Math.max(0, Number(regimeCfg.maxEdgeAdj || 0.1));
  const maxBandAdjBps = Math.max(0, Number(regimeCfg.maxBandAdjBps || 50));
  const maxCooldownAdjSec = Math.max(0, Number(regimeCfg.maxCooldownAdjSec || 900));
  const conf = clamp(Number(est.confidence || 0), 0, 1);

  const feesPerHour = Math.max(0, Number(fees.trailingFeesPerHourUsd || 0));
  const expectedActionCostUsd = Math.max(0, Number(costs.estimatedActionCostUsd || 0));
  const horizonSecBase = Number.isFinite(est.halfLifeSec) ? est.halfLifeSec : trendHalfLifeMinSec;
  const horizonSec = clamp(horizonSecBase, 60, 3600);
  const expectedFeesUsd = feesPerHour * (horizonSec / 3600);
  const severeOutOfRange = Boolean(outOfRange) && Number(edgeProgress || 0) >= 1;
  const costGateWait = !severeOutOfRange && expectedActionCostUsd > 0 && expectedFeesUsd < expectedActionCostUsd;

  let edgeAdj = 0;
  let cooldownAdj = 0;
  let bandAdjBps = 0;
  let reasons = [];

  if (est.label === "trending") {
    const strength = conf;
    edgeAdj = -maxEdgeAdj * (0.5 + 0.5 * strength);
    cooldownAdj = -Math.round(maxCooldownAdjSec * (0.3 + 0.4 * strength));
    bandAdjBps = Math.round(maxBandAdjBps * (0.5 + 0.5 * strength));
    reasons.push("trending_regime");
  } else if (est.label === "mean_reverting") {
    const strength = conf;
    edgeAdj = maxEdgeAdj * (0.4 + 0.6 * strength);
    cooldownAdj = Math.round(maxCooldownAdjSec * (0.4 + 0.6 * strength));
    // keep band stable in v1 to avoid frequent width thrash in mean reversion
    bandAdjBps = 0;
    reasons.push("mean_reverting_regime");
  } else {
    reasons.push("uncertain_regime");
  }

  if (costGateWait) {
    // Prefer waiting when expected near-term fees do not cover the action cost.
    edgeAdj = Math.max(edgeAdj, maxEdgeAdj * 0.5);
    cooldownAdj = Math.max(cooldownAdj, Math.round(maxCooldownAdjSec * 0.5));
    if (!severeOutOfRange) bandAdjBps = 0;
    reasons.push("cost_gate_wait");
  }

  const baseEdge = Number(baseSettings.edgeRebalancePct || 0.85);
  const baseCooldown = Math.round(Number(baseSettings.minRebalanceIntervalSec || 300));
  const baseBand = Math.round(Number(baseSettings.bandHalfBps || 100));

  const effectiveEdge = clamp(baseEdge + edgeAdj, 0.6, 0.98);
  const effectiveCooldown = clamp(baseCooldown + cooldownAdj, 60, 7200);
  const effectiveBand = clamp(baseBand + bandAdjBps, 25, 300);

  return {
    ok: true,
    label: est.label,
    halfLifeSec: Number.isFinite(est.halfLifeSec) ? est.halfLifeSec : Number.POSITIVE_INFINITY,
    confidence: conf,
    waitRecommended: costGateWait,
    edgeRebalancePctAdj: effectiveEdge - baseEdge,
    minRebalanceIntervalSecAdj: effectiveCooldown - baseCooldown,
    bandHalfBpsAdj: effectiveBand - baseBand,
    reason: reasons.join(","),
    diagnostics: {
      expectedFeesUsd,
      expectedActionCostUsd,
      horizonSec,
      feesPerHour,
      mrHalfLifeMaxSec,
      trendHalfLifeMinSec,
    },
  };
}

// UC5-specific edits below.

function trendDirectionFromSamples(samples = []) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const first = Number(samples[0]?.logPrice);
  const last = Number(samples[samples.length - 1]?.logPrice);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === last) return null;
  return last > first ? "UP" : "DOWN";
}

export function evaluateUc5Regime({
  bars = [],
  windowSec = 1800,
  sampleEverySec = 1,
  minSamples = 60,
  trendHalfLifeMinSec = 900,
} = {}) {
  const state = createRegimeState({ windowSec, sampleEverySec, minSamples });
  const normalizedBars = Array.isArray(bars) ? bars : [];
  for (const bar of normalizedBars) {
    const tsMs = Number(bar?.t ?? bar?.ts ?? 0);
    const close = Number(bar?.c ?? bar?.close);
    if (!Number.isFinite(tsMs) || tsMs <= 0 || !(Number.isFinite(close) && close > 0)) continue;
    ingestSample(state, {
      tsSec: Math.floor(tsMs / 1000),
      price: close,
    });
  }

  const est = estimateOU(state);
  const ts = normalizedBars.length > 0 ? Number(normalizedBars[normalizedBars.length - 1]?.t || Date.now()) : Date.now();
  const direction = trendDirectionFromSamples(state.samples);
  const estimateConfidence = clamp(Number(est?.confidence || 0), 0, 1);
  const sampleCount = Array.isArray(state.samples) ? state.samples.length : 0;
  const logPrices = Array.isArray(state.samples)
    ? state.samples.map((s) => Number(s?.logPrice)).filter((v) => Number.isFinite(v))
    : [];
  const minLogPrice = logPrices.length ? Math.min(...logPrices) : null;
  const maxLogPrice = logPrices.length ? Math.max(...logPrices) : null;
  const priceRangeBps =
    minLogPrice != null && maxLogPrice != null ? Math.abs(maxLogPrice - minLogPrice) * 10000 : 0;
  const coverageSec =
    sampleCount >= 2
      ? Math.max(0, Number(state.samples[sampleCount - 1]?.tsSec || 0) - Number(state.samples[0]?.tsSec || 0))
      : 0;
  const baseDiagnostics = {
    windowSec,
    sampleEverySec,
    minSamples,
    barsProvided: normalizedBars.length,
    sampleCount,
    coverageSec,
    priceRangeBps,
    direction,
    estimate: est,
  };

  if (!est?.ok) {
    let failureCode = "ou_estimate_unavailable";
    if (sampleCount < minSamples) failureCode = "insufficient_samples";
    else if (!(priceRangeBps > 0.01)) failureCode = "flat_price_window";
    else if (coverageSec < Math.max(sampleEverySec, 1) * Math.max(minSamples - 1, 1)) failureCode = "insufficient_window_coverage";
    return {
      state: "UNKNOWN",
      direction: null,
      strength: 0,
      reason: `regime unavailable: ${failureCode} | label=${String(est?.label || "unknown")} | samples=${sampleCount}/${minSamples} | sampleEvery=${sampleEverySec}s | coverage=${coverageSec}s | range=${priceRangeBps.toFixed(2)}bps`,
      ts,
      diagnostics: {
        ...baseDiagnostics,
        failureCode,
      },
    };
  }

  if (String(est.label || "") === "trending" && Number(est.halfLifeSec || 0) >= Number(trendHalfLifeMinSec || 900) && direction) {
    return {
      state: "TREND",
      direction,
      strength: estimateConfidence,
      reason: `trending ${direction.toLowerCase()} | halfLife=${Math.round(Number(est.halfLifeSec || 0))}s | confidence=${estimateConfidence.toFixed(2)} | samples=${Number(est.sampleCount || 0)}`,
      ts,
      diagnostics: {
        ...baseDiagnostics,
        sampleCount: Number(est.sampleCount || 0),
        halfLifeSec: Number(est.halfLifeSec || 0),
        slope: Number(est.slope || 0),
        r2: Number(est.r2 || 0),
        estimateConfidence,
      },
    };
  }

  if (String(est.label || "") === "mean_reverting") {
    return {
      state: "RANGE",
      direction: null,
      strength: 0,
      reason: `mean reversion | halfLife=${Math.round(Number(est.halfLifeSec || 0))}s | confidence=${estimateConfidence.toFixed(2)} | samples=${Number(est.sampleCount || 0)}`,
      ts,
      diagnostics: {
        ...baseDiagnostics,
        sampleCount: Number(est.sampleCount || 0),
        halfLifeSec: Number(est.halfLifeSec || 0),
        slope: Number(est.slope || 0),
        r2: Number(est.r2 || 0),
        estimateConfidence,
      },
    };
  }

  const halfLifeSec = Number(est.halfLifeSec || 0);
  const halfLifeText = Number.isFinite(halfLifeSec) && halfLifeSec > 0 ? `${Math.round(halfLifeSec)}s` : "n/a";
  let failureCode = "uncertain_regime";
  if (String(est.label || "") === "trending" && !(halfLifeSec >= Number(trendHalfLifeMinSec || 900))) {
    failureCode = "trend_half_life_below_threshold";
  } else if (String(est.label || "") === "trending" && !direction) {
    failureCode = "trend_direction_unavailable";
  }
  return {
    state: "UNKNOWN",
    direction: null,
    strength: 0,
    reason: `uncertain regime: ${failureCode} | label=${String(est.label || "unknown")} | halfLife=${halfLifeText} | trendHalfLifeMin=${Math.round(Number(trendHalfLifeMinSec || 900))}s | confidence=${estimateConfidence.toFixed(2)} | samples=${sampleCount}/${minSamples} | range=${priceRangeBps.toFixed(2)}bps`,
    ts,
    diagnostics: {
      ...baseDiagnostics,
      sampleCount: Number(est.sampleCount || 0),
      halfLifeSec: Number.isFinite(halfLifeSec) ? halfLifeSec : null,
      slope: Number(est.slope || 0),
      r2: Number(est.r2 || 0),
      estimateConfidence,
      failureCode,
      trendHalfLifeMinSec,
    },
  };
}
