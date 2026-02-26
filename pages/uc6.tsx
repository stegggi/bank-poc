import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { BrowserProvider, type Eip1193Provider } from "ethers";
import NavBar from "../components/NavBar";

const BASE_CHAIN_ID_HEX = "0x2105";
const BASE_CHAIN_ID_DEC = 8453;
const OWNER_ADDRESS = String(process.env.NEXT_PUBLIC_UC6_OWNER_ADDRESS || "");
const DEFAULT_STATUS_POLL_MS = 12_000;

type EthereumProvider = Eip1193Provider & {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: any[]) => void) => void;
  removeListener?: (event: string, listener: (...args: any[]) => void) => void;
};

type Uc6Venue = "slipstream" | "uniswapv3";
type CompoundMode = "on_rebalance" | "threshold_harvest";
type OwnerAction = "update_settings" | "force_rebalance" | "liquidate_and_pause";

type Uc6DraftSettings = {
  tradingEnabled: boolean;
  killSwitch: boolean;
  venue: Uc6Venue;
  bandHalfBps: number;
  edgeRebalancePct: number;
  minRebalanceIntervalSec: number;
  maxRebalancesPerDay: number;
  slippageBps: number;
  pollIntervalMs: number;
  wsEnabled: boolean;
  slot0RefreshEverySec: number;
  balancesRefreshEverySec: number;
  positionRefreshEverySec: number;
  inventoryRefreshEverySec: number;
  collectableRefreshEverySec: number;
  dashboardRecommendedPollMs: number;
  maxDeployUsdc: number;
  maxInitialMintUsdc: number;
  minTopUpUsd: number;
  reserveMinUsdc: number;
  reservePct: number; // percentage in UI
  reserveMaxUsdc: number;
  compoundMode: CompoundMode;
  harvestThresholdUsd: number;
  failureCooldownSec: number;
  churnProtectionEnabled: boolean;
  churnMaxCostToFeeRatio: number; // percentage in UI
  regimeEnabled: boolean;
  regimeWindowSec: number;
  regimeSampleEverySec: number;
  regimeMinSamples: number;
  regimeMrHalfLifeMaxSec: number;
  regimeTrendHalfLifeMinSec: number;
  regimeMaxEdgeAdj: number;
  regimeMaxBandAdjBps: number;
  regimeMaxCooldownAdjSec: number;
};

type OwnerPayload = {
  tradingEnabled: boolean;
  killSwitch: boolean;
  venue: Uc6Venue;
  bandHalfBps: number;
  edgeRebalancePct: number;
  minRebalanceIntervalSec: number;
  maxRebalancesPerDay: number;
  slippageBps: number;
  pollIntervalMs: number;
  wsEnabled: boolean;
  slot0RefreshEverySec: number;
  balancesRefreshEverySec: number;
  positionRefreshEverySec: number;
  inventoryRefreshEverySec: number;
  collectableRefreshEverySec: number;
  dashboardRecommendedPollMs: number;
  maxDeployUsdc: number;
  maxInitialMintUsdc: number;
  minTopUpUsd: number;
  reserveMinUsdc: number;
  reservePct: number;
  reserveMaxUsdc: number;
  compoundMode: CompoundMode;
  harvestThresholdUsd: number;
  failureCooldownSec: number;
  churnProtectionEnabled: boolean;
  churnMaxCostToFeeRatio: number;
  regime: {
    enabled: boolean;
    windowSec: number;
    sampleEverySec: number;
    minSamples: number;
    mrHalfLifeMaxSec: number;
    trendHalfLifeMinSec: number;
    maxEdgeAdj: number;
    maxBandAdjBps: number;
    maxCooldownAdjSec: number;
  };
};

type PositionLifecycleRecord = {
  id: string;
  tokenId?: string | null;
  chain?: { name?: string; chainId?: number };
  venue?: Uc6Venue | string;
  poolAddress?: string;
  pair?: { base?: string; quote?: string };
  selector?: { type?: "tickSpacing" | "fee" | string; value?: number; humanLabel?: string };
  band?: {
    bandHalfBps?: number;
    tickLower?: number;
    tickUpper?: number;
  };
  entry?: {
    openedAtIso?: string | null;
    entrySnapshotAtIso?: string | null;
    entryValueUsd?: number;
    entryTokens?: { weth?: number; usdc?: number };
    spotPriceUsdcPerWeth?: number;
    rawMintValueUsd?: number | null;
  };
  exit?: {
    closedAtIso?: string | null;
    exitValueUsd?: number | null;
    exitTokens?: { weth?: number; usdc?: number } | null;
    spotPriceUsdcPerWeth?: number | null;
  };
  duration?: {
    secondsInPosition?: number | null;
    human?: string | null;
  };
  performance?: {
    feesCollectedUsd?: number;
    rewardsUsd?: number;
    gasUsd?: number;
    swapCostUsd?: number;
    mintBurnUsd?: number;
    totalCostsUsd?: number;
    feesNetUsd?: number;
    capitalGainLossUsd?: number;
    impermanentLossUsd?: number;
    divergenceVsHodlUsd?: number;
    alphaVsHodlUsd?: number;
    netProfitUsd?: number;
    costToFeeRatio?: number;
    avgDeployedUsd?: number;
    apr?: number;
  };
  activity?: {
    rebalances?: number;
    harvests?: number;
    swaps?: number;
    txCount?: number;
  };
  tx?: {
    openTxHashes?: string[];
    closeTxHashes?: string[];
    allTxHashes?: string[];
  };
  status?: "OPEN" | "CLOSED" | string;
  notes?: string | null;
  createdAtIso?: string;
  updatedAtIso?: string;
};

type PositionRecordsPage = {
  items: PositionLifecycleRecord[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};

type PoolComparisonRow = {
  rank?: number;
  isCurrent?: boolean;
  dex?: { id?: string; name?: string };
  chain?: { id?: string; chainId?: number };
  pool?: { address?: string; name?: string | null };
  pair?: {
    baseSymbol?: string;
    quoteSymbol?: string;
    baseAddress?: string;
    quoteAddress?: string;
    pairKey?: string;
  };
  selector?: {
    type?: "feeTier" | "tickSpacing" | "unknown" | string;
    value?: number | null;
    feeRate?: number;
    feeIsEstimated?: boolean;
  };
  stats?: {
    tvlUsd?: number;
    tvlAvg7dUsd?: number;
    tvlAvg30dUsd?: number;
    tvlHistoryDays?: number;
    volAvg7dUsd?: number;
    volAvg30dUsd?: number;
    feePower7d?: number;
    feePower30d?: number;
    dailyRangePct7d?: number;
    volumeStability30d?: number;
  };
  economics?: {
    expectedFeesDayUsd?: number;
    expectedCostsDayUsd?: number;
    expectedNetDayUsd?: number;
    expectedRebalancesPerDay?: number;
    expectedCostPerRebalanceUsd?: number;
    gasBaselineUsd?: number;
    rebalanceSwapNotionalPct?: number;
  };
  compareToCurrent?: {
    rating?: "More" | "Similar" | "Less" | string;
    reason?: string;
    expectedNetDiffDayUsd?: number;
    switchCostUsd?: number;
    breakEvenDays?: number | null;
  };
};

type PoolComparisonStatus = {
  ok?: boolean;
  computedAtIso?: string | null;
  current?: PoolComparisonRow | null;
  top5?: PoolComparisonRow[];
  ref?: {
    currentPool?: {
      poolAddress?: string | null;
      dexName?: string | null;
      pairKey?: string | null;
      refCapitalUsd?: number;
      band?: { bandHalfBps?: number; edgeRebalancePct?: number };
    };
  };
  network?: { id?: string; name?: string; chainId?: number };
  notes?: { limitations?: string[] } | null;
  lastError?: { atIso?: string | null; message?: string } | null;
};

type Uc6Status = {
  ok?: boolean;
  ts?: string;
  account?: string;
  tradingEnabled?: boolean;
  killSwitch?: boolean;
  market?: {
    chain?: { name?: string; chainId?: number };
    venueActive?: Uc6Venue;
    pair?: { base?: string; quote?: string };
    selector?: { type?: "tickSpacing" | "fee"; value?: number };
    poolAddress?: string | null;
    spotPrice?: { usdcPerWeth?: number; updatedAtIso?: string | null };
    tick?: { current?: number; spacing?: number };
    primary?: unknown;
    fallback?: unknown;
  };
  settings?: {
    tradingEnabled?: boolean;
    killSwitch?: boolean;
    venue?: Uc6Venue;
    bandHalfBps?: number;
    edgeRebalancePct?: number;
    minRebalanceIntervalSec?: number;
    maxRebalancesPerDay?: number;
    slippageBps?: number;
    pollIntervalMs?: number;
    wsEnabled?: boolean;
    slot0RefreshEverySec?: number;
    balancesRefreshEverySec?: number;
    positionRefreshEverySec?: number;
    inventoryRefreshEverySec?: number;
    collectableRefreshEverySec?: number;
    dashboardRecommendedPollMs?: number;
    regime?: {
      enabled?: boolean;
      windowSec?: number;
      sampleEverySec?: number;
      minSamples?: number;
      mrHalfLifeMaxSec?: number;
      trendHalfLifeMinSec?: number;
      maxEdgeAdj?: number;
      maxBandAdjBps?: number;
      maxCooldownAdjSec?: number;
    };
    maxDeployUsdc?: number;
    maxInitialMintUsdc?: number;
    minTopUpUsd?: number;
    reservePolicy?: {
      minUsdc?: number;
      pct?: number;
      maxUsdc?: number;
      effectiveTargetUsdc?: number;
    };
    reserveMinUsdc?: number;
    reservePct?: number;
    reserveMaxUsdc?: number;
    compoundMode?: CompoundMode;
    harvestThresholdUsd?: number;
    failureCooldownSec?: number;
    churnProtection?: {
      enabled?: boolean;
      maxCostToFeeRatio?: number;
      currentRatioToday?: number | null;
    };
    churnProtectionEnabled?: boolean;
    churnMaxCostToFeeRatio?: number;
  };
  position?: {
    tokenId?: string | null;
    tickLower?: number | null;
    tickUpper?: number | null;
    centerTick?: number | null;
    inRange?: boolean;
    distanceToEdge?: { ticks?: number | null; pct?: number | null };
    liquidity?: string | null;
    amountsInLP?: {
      usdc?: number;
      weth?: number;
      usdValue?: number;
      sideUsd?: { usdc?: number; weth?: number };
    };
  };
  wallet?: {
    balances?: { usdc?: number; weth?: number; eth?: number };
    valuesUsd?: { usdc?: number; weth?: number; eth?: number; total?: number };
    allocationUsd?: { idle?: number; lpDeployed?: number; reserveTarget?: number };
    deployedPct?: number;
  };
  fees?: {
    collectableNow?: { usdc?: number; weth?: number; usd?: number; isEstimated?: boolean };
    collectedTodayUsd?: number;
    collected7dUsd?: number;
    collected30dUsd?: number;
    collectedTotalUsd?: number;
    pendingCompoundUsd?: number;
  };
  costs?: {
    gasTodayUsd?: number;
    gas7dUsd?: number;
    gas30dUsd?: number;
    gasTotalUsd?: number;
    swapCostsTodayUsd?: number;
    swapCosts7dUsd?: number;
    swapCosts30dUsd?: number;
    swapCostsTotalUsd?: number;
    mintBurnTodayUsd?: number;
    mintBurn7dUsd?: number;
    mintBurn30dUsd?: number;
    mintBurnTotalUsd?: number;
    totalTodayUsd?: number;
    total7dUsd?: number;
    total30dUsd?: number;
    totalTotalUsd?: number;
  };
  pnl?: {
    netTodayUsd?: number;
    net7dUsd?: number;
    net30dUsd?: number;
    netTotalUsd?: number;
    aprToday?: number | null;
    apr7d?: number | null;
    apr30d?: number | null;
  };
  analytics?: {
    bandPerformance?: Array<{
      bandHalfBps?: number;
      bandHalfPct?: number;
      runs?: number;
      totalFeesUsd?: number;
      avgFeesUsd?: number;
      avgFeeToLpPct?: number | null;
      avgDurationSec?: number | null;
      totalDurationSec?: number;
      totalCostsUsd?: number;
      totalNetUsd?: number;
    }>;
  };
  regime?: {
    enabled?: boolean;
    ok?: boolean;
    label?: "mean_reverting" | "trending" | "unknown" | string;
    theta?: number | null;
    halfLifeSec?: number | null;
    sigma?: number | null;
    mu?: number | null;
    confidence?: number;
    updatedAtIso?: string | null;
    sampleCount?: number;
    windowSec?: number;
  };
  decision?: {
    baseThresholds?: {
      edgeRebalancePct?: number;
      minRebalanceIntervalSec?: number;
      bandHalfBps?: number;
    };
    effectiveThresholds?: {
      edgeRebalancePct?: number;
      minRebalanceIntervalSec?: number;
      bandHalfBps?: number;
    };
    adviceReason?: string;
    waitRecommended?: boolean;
  };
  providers?: {
    http?: {
      active?: string | null;
      providers?: Array<{
        name?: string;
        active?: boolean;
        cooldownRemainingSec?: number;
        failCount?: number;
        successStreak?: number;
        lastError?: string | null;
        last429AtIso?: string | null;
      }>;
    };
    ws?: {
      enabled?: boolean;
      connected?: boolean;
      active?: string | null;
      lastHeadBlock?: number | null;
      lastHeadAtIso?: string | null;
      lastError?: string | null;
    };
  };
  refresh?: {
    slot0AtIso?: string;
    balancesAtIso?: string;
    positionAtIso?: string;
    inventoryAtIso?: string;
    collectableAtIso?: string;
  };
  ops?: {
    rebalancesToday?: number;
    rebalances24h?: number;
    rebalances7d?: number;
    churnRatioToday?: number | null;
    timeInRange?: {
      sinceIso?: string | null;
      eligibleMs?: number;
      inRangeMs?: number;
      pct?: number | null;
    };
    lastRebalanceAtIso?: string | null;
    cooldownRemainingSec?: number | null;
    positionInventory?: {
      ownerNftCount?: number;
      activeCount?: number;
      totalUsdValue?: number;
      active?: Array<{
        tokenId?: string;
        tickLower?: number;
        tickUpper?: number;
        liquidity?: string;
        usdValue?: number;
        inRange?: boolean | null;
      }>;
    } | null;
    lastDecision?: Record<string, unknown> | null;
    lastError?: { atIso?: string | null; message?: string } | null;
  };
  positionsSummary?: PositionLifecycleRecord[];
  positionsTaxSummary?: {
    timezone?: string;
    dateRangeRule?: string;
    totals?: {
      closedPositions?: number;
      feesCollectedUsd?: number;
      totalCostsUsd?: number;
      feesNetUsd?: number;
      capitalGainLossUsd?: number;
      realizedNetProfitUsd?: number;
    };
    years?: Array<{
      year?: number;
      closedPositions?: number;
      feesCollectedUsd?: number;
      totalCostsUsd?: number;
      feesNetUsd?: number;
      capitalGainLossUsd?: number;
      realizedNetProfitUsd?: number;
      firstClosedAtIso?: string | null;
      lastClosedAtIso?: string | null;
    }>;
  };
  activePositionId?: string | null;
  activePositionRecord?: PositionLifecycleRecord | null;
  poolComparison?: PoolComparisonStatus;
  counters?: { reason?: string };
  events?: {
    lastN?: Array<{
      atIso?: string;
      type?: string;
      reason?: string;
      txHashes?: string[];
      gasUsd?: number;
      swapCostUsd?: number;
      slippageBpsReal?: number | null;
      mintBurnUsd?: number;
      feesCollectedUsd?: number;
      netUsd?: number;
      isEstimated?: boolean;
      message?: string;
    }>;
  };
  lastDecision?: unknown;
  lastError?: string | null;
};

function defaultDraft(): Uc6DraftSettings {
  return {
    tradingEnabled: false,
    killSwitch: true,
    venue: "slipstream",
    bandHalfBps: 100,
    edgeRebalancePct: 0.85,
    minRebalanceIntervalSec: 300,
    maxRebalancesPerDay: 20,
    slippageBps: 30,
    pollIntervalMs: 2000,
    wsEnabled: true,
    slot0RefreshEverySec: 12,
    balancesRefreshEverySec: 60,
    positionRefreshEverySec: 60,
    inventoryRefreshEverySec: 300,
    collectableRefreshEverySec: 1800,
    dashboardRecommendedPollMs: 12000,
    maxDeployUsdc: 50_000,
    maxInitialMintUsdc: 50,
    minTopUpUsd: 20,
    reserveMinUsdc: 25,
    reservePct: 0,
    reserveMaxUsdc: 0,
    compoundMode: "on_rebalance",
    harvestThresholdUsd: 30,
    failureCooldownSec: 900,
    churnProtectionEnabled: false,
    churnMaxCostToFeeRatio: 40,
    regimeEnabled: false,
    regimeWindowSec: 1800,
    regimeSampleEverySec: 12,
    regimeMinSamples: 60,
    regimeMrHalfLifeMaxSec: 180,
    regimeTrendHalfLifeMinSec: 900,
    regimeMaxEdgeAdj: 0.1,
    regimeMaxBandAdjBps: 50,
    regimeMaxCooldownAdjSec: 900,
  };
}

function n(v: unknown, fallback: number): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function coerceDraft(settings: Uc6Status["settings"] | undefined): Uc6DraftSettings {
  const d = defaultDraft();
  if (!settings) return d;
  const venue = settings.venue === "uniswapv3" ? "uniswapv3" : "slipstream";
  const reserveMin = n(settings.reservePolicy?.minUsdc ?? settings.reserveMinUsdc, d.reserveMinUsdc);
  const reservePctRatio = n(settings.reservePolicy?.pct ?? settings.reservePct, d.reservePct / 100);
  const reserveMax = n(settings.reservePolicy?.maxUsdc ?? settings.reserveMaxUsdc, d.reserveMaxUsdc);
  const churnEnabled = Boolean(settings.churnProtection?.enabled ?? settings.churnProtectionEnabled ?? d.churnProtectionEnabled);
  const churnRatio = n(settings.churnProtection?.maxCostToFeeRatio ?? settings.churnMaxCostToFeeRatio, d.churnMaxCostToFeeRatio / 100);
  const regime = settings.regime || {};

  return {
    tradingEnabled: Boolean(settings.tradingEnabled ?? d.tradingEnabled),
    killSwitch: Boolean(settings.killSwitch ?? d.killSwitch),
    venue,
    bandHalfBps: n(settings.bandHalfBps, d.bandHalfBps),
    edgeRebalancePct: n(settings.edgeRebalancePct, d.edgeRebalancePct),
    minRebalanceIntervalSec: n(settings.minRebalanceIntervalSec, d.minRebalanceIntervalSec),
    maxRebalancesPerDay: n(settings.maxRebalancesPerDay, d.maxRebalancesPerDay),
    slippageBps: n(settings.slippageBps, d.slippageBps),
    pollIntervalMs: n(settings.pollIntervalMs, d.pollIntervalMs),
    wsEnabled: Boolean(settings.wsEnabled ?? d.wsEnabled),
    slot0RefreshEverySec: n(settings.slot0RefreshEverySec, d.slot0RefreshEverySec),
    balancesRefreshEverySec: n(settings.balancesRefreshEverySec, d.balancesRefreshEverySec),
    positionRefreshEverySec: n(settings.positionRefreshEverySec, d.positionRefreshEverySec),
    inventoryRefreshEverySec: n(settings.inventoryRefreshEverySec, d.inventoryRefreshEverySec),
    collectableRefreshEverySec: n(settings.collectableRefreshEverySec, d.collectableRefreshEverySec),
    dashboardRecommendedPollMs: n(settings.dashboardRecommendedPollMs, d.dashboardRecommendedPollMs),
    maxDeployUsdc: n(settings.maxDeployUsdc, d.maxDeployUsdc),
    maxInitialMintUsdc: n(settings.maxInitialMintUsdc, d.maxInitialMintUsdc),
    minTopUpUsd: n(settings.minTopUpUsd, d.minTopUpUsd),
    reserveMinUsdc: reserveMin,
    reservePct: reservePctRatio * 100,
    reserveMaxUsdc: reserveMax,
    compoundMode: settings.compoundMode === "threshold_harvest" ? "threshold_harvest" : "on_rebalance",
    harvestThresholdUsd: n(settings.harvestThresholdUsd, d.harvestThresholdUsd),
    failureCooldownSec: n(settings.failureCooldownSec, d.failureCooldownSec),
    churnProtectionEnabled: churnEnabled,
    churnMaxCostToFeeRatio: churnRatio * 100,
    regimeEnabled: Boolean(regime.enabled ?? d.regimeEnabled),
    regimeWindowSec: n(regime.windowSec, d.regimeWindowSec),
    regimeSampleEverySec: n(regime.sampleEverySec, d.regimeSampleEverySec),
    regimeMinSamples: n(regime.minSamples, d.regimeMinSamples),
    regimeMrHalfLifeMaxSec: n(regime.mrHalfLifeMaxSec, d.regimeMrHalfLifeMaxSec),
    regimeTrendHalfLifeMinSec: n(regime.trendHalfLifeMinSec, d.regimeTrendHalfLifeMinSec),
    regimeMaxEdgeAdj: n(regime.maxEdgeAdj, d.regimeMaxEdgeAdj),
    regimeMaxBandAdjBps: n(regime.maxBandAdjBps, d.regimeMaxBandAdjBps),
    regimeMaxCooldownAdjSec: n(regime.maxCooldownAdjSec, d.regimeMaxCooldownAdjSec),
  };
}

function buildPayload(draft: Uc6DraftSettings): OwnerPayload {
  return {
    tradingEnabled: draft.killSwitch ? false : draft.tradingEnabled,
    killSwitch: draft.killSwitch,
    venue: draft.venue,
    bandHalfBps: draft.bandHalfBps,
    edgeRebalancePct: draft.edgeRebalancePct,
    minRebalanceIntervalSec: draft.minRebalanceIntervalSec,
    maxRebalancesPerDay: draft.maxRebalancesPerDay,
    slippageBps: draft.slippageBps,
    pollIntervalMs: draft.pollIntervalMs,
    wsEnabled: draft.wsEnabled,
    slot0RefreshEverySec: draft.slot0RefreshEverySec,
    balancesRefreshEverySec: draft.balancesRefreshEverySec,
    positionRefreshEverySec: draft.positionRefreshEverySec,
    inventoryRefreshEverySec: draft.inventoryRefreshEverySec,
    collectableRefreshEverySec: draft.collectableRefreshEverySec,
    dashboardRecommendedPollMs: draft.dashboardRecommendedPollMs,
    maxDeployUsdc: draft.maxDeployUsdc,
    maxInitialMintUsdc: draft.maxInitialMintUsdc,
    minTopUpUsd: draft.minTopUpUsd,
    reserveMinUsdc: draft.reserveMinUsdc,
    reservePct: Math.max(0, draft.reservePct) / 100,
    reserveMaxUsdc: draft.reserveMaxUsdc,
    compoundMode: draft.compoundMode,
    harvestThresholdUsd: draft.harvestThresholdUsd,
    failureCooldownSec: draft.failureCooldownSec,
    churnProtectionEnabled: draft.churnProtectionEnabled,
    churnMaxCostToFeeRatio: Math.max(0, draft.churnMaxCostToFeeRatio) / 100,
    regime: {
      enabled: draft.regimeEnabled,
      windowSec: draft.regimeWindowSec,
      sampleEverySec: draft.regimeSampleEverySec,
      minSamples: draft.regimeMinSamples,
      mrHalfLifeMaxSec: draft.regimeMrHalfLifeMaxSec,
      trendHalfLifeMinSec: draft.regimeTrendHalfLifeMinSec,
      maxEdgeAdj: draft.regimeMaxEdgeAdj,
      maxBandAdjBps: draft.regimeMaxBandAdjBps,
      maxCooldownAdjSec: draft.regimeMaxCooldownAdjSec,
    },
  };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = 8_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let r: Response;
  try {
    r = await fetch(url, { ...(init || {}), cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const txt = await r.text();
  let parsed: unknown = {};
  try {
    parsed = txt ? JSON.parse(txt) : {};
  } catch {
    parsed = {};
  }
  if (!r.ok) {
    const msg =
      parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error?: unknown }).error === "string"
        ? String((parsed as { error?: unknown }).error)
        : `${r.status} ${r.statusText}`;
    throw new Error(msg);
  }
  return parsed as T;
}

function shortAddr(addr?: string | null): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "—";
  return Number(v).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtUsd(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  const n = Number(v);
  if (n !== 0 && Math.abs(n) < 0.01) {
    return n < 0 ? "-<$0.01" : "<$0.01";
  }
  return `$${fmtNum(n, 2)}`;
}

function fmtUsdCompact(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  const x = Number(v);
  const abs = Math.abs(x);
  if (abs >= 1_000_000_000) return `$${(x / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(x / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(x / 1_000).toFixed(1)}k`;
  return fmtUsd(x);
}

function fmtSignedUsd(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  const n = Number(v);
  if (n === 0) return "$0.00";
  const abs = Math.abs(n);
  const core = abs < 0.01 ? "<$0.01" : `$${fmtNum(abs, 2)}`;
  return n < 0 ? `-${core}` : core;
}

function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${fmtNum(v, digits)}%`;
}

function fmtRatioPct(ratio: number | null | undefined): string {
  if (ratio == null || Number.isNaN(ratio)) return "—";
  return fmtPct(Number(ratio) * 100, 2);
}

function fmtDays(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v) || !Number.isFinite(Number(v))) return "—";
  const x = Number(v);
  if (x < 0) return "—";
  if (x === 0) return "0.0d";
  if (x > 9999) return ">9999d";
  return `${fmtNum(x, x < 10 ? 1 : 0)}d`;
}

function poolComparisonSelectorLabel(row?: PoolComparisonRow | null): string {
  const feeRate = n(row?.selector?.feeRate, NaN);
  const selectorType = String(row?.selector?.type || "unknown");
  const selectorValue = row?.selector?.value;
  const feePct = Number.isFinite(feeRate) && feeRate >= 0 ? `${fmtNum(feeRate * 100, 3)}%` : "—";
  if (selectorType === "feeTier" && Number.isFinite(Number(selectorValue))) {
    return `${feePct} (tier ${Number(selectorValue)})`;
  }
  if (selectorType === "tickSpacing" && Number.isFinite(Number(selectorValue))) {
    return `${feePct} (tickSpacing ${Number(selectorValue)})`;
  }
  return feePct;
}

function pairLabel(row?: PoolComparisonRow | null): string {
  const pair = row?.pair;
  if (!pair) return "—";
  return pair.pairKey || `${pair.baseSymbol || "?"}/${pair.quoteSymbol || "?"}`;
}

function ratingTone(rating?: string): "good" | "warn" | "bad" | "muted" {
  if (!rating) return "muted";
  if (rating === "More") return "good";
  if (rating === "Similar") return "warn";
  if (rating === "Less") return "bad";
  return "muted";
}

function fmtIsoLocal(iso?: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString();
}

function selectorHumanLabel(
  selector?: { type?: "tickSpacing" | "fee" | string; value?: number },
  venue?: Uc6Venue
): string {
  const type = String(selector?.type || "");
  const value = Number(selector?.value);
  if (type === "fee" && Number.isFinite(value) && value > 0) {
    const pct = value / 10_000;
    return `Fee tier ${pct.toFixed(value % 100 === 0 ? 2 : 4)}% (${value})`;
  }
  if (type === "tickSpacing" && Number.isFinite(value) && value > 0) {
    return venue === "slipstream"
      ? `Tick spacing ${value} (pool grid)`
      : `Tick spacing ${value}`;
  }
  if (Number.isFinite(value)) return `${type || "selector"} ${value}`;
  return "—";
}

function actualBandHalfPctFromTicks(tickLower?: number | null, tickUpper?: number | null): number | null {
  const lower = Number(tickLower);
  const upper = Number(tickUpper);
  if (!(Number.isFinite(lower) && Number.isFinite(upper) && upper > lower)) return null;
  const halfTicks = (upper - lower) / 2;
  // Concentrated liquidity ranges are linear in log-price (tick space). Convert half-range ticks back to price percent.
  const ratioHalf = Math.exp(Math.log(1.0001) * halfTicks);
  if (!Number.isFinite(ratioHalf) || ratioHalf <= 0) return null;
  return (ratioHalf - 1) * 100;
}

function formatRecordBandLabel(record: Pick<PositionLifecycleRecord, "band">): string {
  const actualPct = actualBandHalfPctFromTicks(record.band?.tickLower, record.band?.tickUpper);
  if (actualPct != null) return `±${fmtPct(actualPct)}`;
  return `±${(n(record.band?.bandHalfBps, 0) / 100).toFixed(2)}%`;
}

function fmtDurationCompact(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  const s = Math.max(0, Math.round(Number(seconds)));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return remM === 0 ? `${h}h` : `${h}h ${remM}m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH === 0 ? `${d}d` : `${d}d ${remH}h`;
}

function getEthereum(): EthereumProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { ethereum?: EthereumProvider }).ethereum;
}

function churnTone(ratio: number | null | undefined): "good" | "warn" | "bad" | "muted" {
  if (ratio == null || !Number.isFinite(ratio)) return "muted";
  if (ratio < 0.2) return "good";
  if (ratio <= 0.4) return "warn";
  return "bad";
}

function boolTone(v: boolean | null | undefined): "good" | "bad" | "muted" {
  if (v == null) return "muted";
  return v ? "good" : "bad";
}

export default function Uc6Page() {
  const [status, setStatus] = useState<Uc6Status | null>(null);
  const [positionsPage, setPositionsPage] = useState<PositionRecordsPage | null>(null);
  const [positionsPageNum, setPositionsPageNum] = useState(1);
  const [positionsError, setPositionsError] = useState("");
  const [selectedPosition, setSelectedPosition] = useState<PositionLifecycleRecord | null>(null);
  const [draft, setDraft] = useState<Uc6DraftSettings | null>(null);
  const [walletAddress, setWalletAddress] = useState("");
  const [walletChain, setWalletChain] = useState("");
  const [hasMetaMask, setHasMetaMask] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");

  const isBase = walletChain.toLowerCase() === BASE_CHAIN_ID_HEX;
  const isOwner = useMemo(() => {
    if (!walletAddress || !OWNER_ADDRESS) return false;
    return walletAddress.toLowerCase() === OWNER_ADDRESS.toLowerCase();
  }, [walletAddress]);

  const statusPollMs = useMemo(() => {
    const ms = n(status?.settings?.dashboardRecommendedPollMs, DEFAULT_STATUS_POLL_MS);
    return Math.max(2_000, Math.min(60_000, ms));
  }, [status?.settings?.dashboardRecommendedPollMs]);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await fetchJson<Uc6Status>("/api/uc6/status");
      setStatus(next);
      setDraft((prev) => prev ?? coerceDraft(next.settings));
      setStatusError("");
    } catch (err: unknown) {
      setStatusError(err instanceof Error ? err.message : "Failed to refresh UC6 status");
    }
  }, []);

  const refreshPositions = useCallback(async (page = positionsPageNum) => {
    try {
      const next = await fetchJson<PositionRecordsPage>(`/api/uc6/positions?page=${encodeURIComponent(String(page))}&pageSize=10`);
      setPositionsPage(next);
      setPositionsError("");
    } catch (err: unknown) {
      setPositionsError(err instanceof Error ? err.message : "Failed to refresh position records");
    }
  }, [positionsPageNum]);

  useEffect(() => {
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), statusPollMs);
    return () => clearInterval(timer);
  }, [refreshStatus, statusPollMs]);

  useEffect(() => {
    void refreshPositions(positionsPageNum);
    const timer = setInterval(() => void refreshPositions(positionsPageNum), statusPollMs);
    return () => clearInterval(timer);
  }, [positionsPageNum, refreshPositions, statusPollMs]);

  useEffect(() => {
    const eth = getEthereum();
    if (!eth?.request) return;
    setHasMetaMask(true);

    const sync = async () => {
      try {
        const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
        setWalletAddress(accounts?.[0] || "");
      } catch {}
      try {
        const chainId = (await eth.request({ method: "eth_chainId" })) as string;
        setWalletChain(chainId || "");
      } catch {}
    };
    void sync();

    const onAccountsChanged = (accounts: string[]) => setWalletAddress(accounts?.[0] || "");
    const onChainChanged = (chainId: string) => setWalletChain(chainId || "");

    eth.on?.("accountsChanged", onAccountsChanged);
    eth.on?.("chainChanged", onChainChanged);
    return () => {
      eth.removeListener?.("accountsChanged", onAccountsChanged);
      eth.removeListener?.("chainChanged", onChainChanged);
    };
  }, []);

  const connectWallet = useCallback(async () => {
    setError("");
    setNotice("");
    const eth = getEthereum();
    if (!eth) {
      setError("MetaMask is not available in this browser.");
      return;
    }
    setBusy("connect");
    try {
      const provider = new BrowserProvider(eth);
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      setWalletAddress(await signer.getAddress());
      const chainId = (await eth.request({ method: "eth_chainId" })) as string;
      setWalletChain(chainId || "");
      setNotice("Wallet connected.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Wallet connection failed.");
    } finally {
      setBusy("");
    }
  }, []);

  const switchToBase = useCallback(async () => {
    setError("");
    setNotice("");
    const eth = getEthereum();
    if (!eth) {
      setError("MetaMask is not available.");
      return;
    }
    setBusy("switch");
    try {
      await eth.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BASE_CHAIN_ID_HEX }],
      });
      setWalletChain(BASE_CHAIN_ID_HEX);
      setNotice("Switched to Base mainnet.");
    } catch (err: unknown) {
      const code = (err as { code?: number }).code;
      if (code === 4902) {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: BASE_CHAIN_ID_HEX,
              chainName: "Base",
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: ["https://mainnet.base.org"],
              blockExplorerUrls: ["https://basescan.org"],
            },
          ],
        });
        await eth.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: BASE_CHAIN_ID_HEX }],
        });
        setWalletChain(BASE_CHAIN_ID_HEX);
        setNotice("Base added and selected in MetaMask.");
      } else {
        setError(err instanceof Error ? err.message : "Failed to switch chain.");
      }
    } finally {
      setBusy("");
    }
  }, []);

  const submitSignedOwnerAction = useCallback(
    async ({
      action,
      payload,
      endpoint,
      successPrefix,
    }: {
      action: OwnerAction;
      payload: unknown;
      endpoint: "/api/uc6/owner/settings" | "/api/uc6/owner/force-rebalance" | "/api/uc6/owner/liquidate-and-pause";
      successPrefix: string;
    }) => {
      if (!walletAddress) throw new Error("Connect MetaMask first.");
      if (!isOwner) throw new Error("Only the configured owner wallet can perform owner actions.");
      const eth = getEthereum();
      if (!eth) throw new Error("MetaMask is unavailable.");

      const challenge = await fetchJson<{ ok: true; message: string; expiresAt: string }>("/api/uc6/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address: walletAddress,
          action,
          payload,
        }),
      });

      const provider = new BrowserProvider(eth);
      const signer = await provider.getSigner();
      const signature = await signer.signMessage(challenge.message);

      const out = await fetchJson<{ ok?: boolean; settings?: Uc6Status["settings"] }>(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: challenge.message, signature, payload }),
      });

      if (out.settings) {
        setDraft(coerceDraft(out.settings));
      }
      setNotice(`${successPrefix}. Challenge expired at ${challenge.expiresAt}.`);
      await refreshStatus();
    },
    [isOwner, refreshStatus, walletAddress]
  );

  const submitOwnerUpdate = useCallback(
    async (payload: OwnerPayload, successPrefix: string) =>
      submitSignedOwnerAction({
        action: "update_settings",
        payload,
        endpoint: "/api/uc6/owner/settings",
        successPrefix,
      }),
    [submitSignedOwnerAction]
  );

  const saveSettings = useCallback(async () => {
    if (!draft) return;
    setError("");
    setNotice("");
    setBusy("save");
    try {
      await submitOwnerUpdate(buildPayload(draft), "Settings updated");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update UC6 settings.");
    } finally {
      setBusy("");
    }
  }, [draft, submitOwnerUpdate]);

  const emergencyStop = useCallback(async () => {
    if (!draft) return;
    setError("");
    setNotice("");
    setBusy("emergency-stop");
    try {
      const payload = buildPayload({ ...draft, tradingEnabled: false, killSwitch: true });
      await submitOwnerUpdate(payload, "Emergency stop activated");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to activate emergency stop.");
    } finally {
      setBusy("");
    }
  }, [draft, submitOwnerUpdate]);

  const enableTrading = useCallback(async () => {
    if (!draft) return;
    setError("");
    setNotice("");
    setBusy("enable-trading");
    try {
      const payload = buildPayload({ ...draft, killSwitch: false, tradingEnabled: true });
      await submitOwnerUpdate(payload, "Trading enabled");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to enable trading.");
    } finally {
      setBusy("");
    }
  }, [draft, submitOwnerUpdate]);

  const forceRebalance = useCallback(async () => {
    setError("");
    setNotice("");
    setBusy("force-rebalance");
    try {
      await submitSignedOwnerAction({
        action: "force_rebalance",
        payload: {},
        endpoint: "/api/uc6/owner/force-rebalance",
        successPrefix: "Force rebalance requested",
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to request force rebalance.");
    } finally {
      setBusy("");
    }
  }, [submitSignedOwnerAction]);

  const liquidateAndPause = useCallback(async () => {
    setError("");
    setNotice("");
    if (!status?.position?.tokenId) {
      setError("No active LP position to liquidate.");
      return;
    }
    const confirmed =
      typeof window === "undefined"
        ? true
        : window.confirm(
            "This will close the entire LP position, return tokens to the wallet, and then enable the kill switch (trading disabled). Continue?"
          );
    if (!confirmed) return;

    setBusy("liquidate-and-pause");
    try {
      await submitSignedOwnerAction({
        action: "liquidate_and_pause",
        payload: {},
        endpoint: "/api/uc6/owner/liquidate-and-pause",
        successPrefix: "LP liquidated and trading disabled",
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to liquidate LP and pause trading.");
    } finally {
      setBusy("");
    }
  }, [status?.position?.tokenId, submitSignedOwnerAction]);

  const updateNumber = useCallback((key: keyof Uc6DraftSettings, value: string) => {
    const num = Number(value);
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, [key]: Number.isFinite(num) ? num : 0 };
    });
  }, []);

  const updateBool = useCallback((key: keyof Uc6DraftSettings, value: boolean) => {
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, [key]: value };
    });
  }, []);

  const decision = (status?.ops?.lastDecision || status?.lastDecision || {}) as Record<string, unknown>;
  const regimeStatus = status?.regime || null;
  const regimeDecisionView = status?.decision || null;
  const events = (status?.events?.lastN || []).slice(-5).reverse();
  const inRange = Boolean(status?.position?.inRange);
  const cooldownRemaining = Number(status?.ops?.cooldownRemainingSec || 0);
  const configuredBandHalfPct = n(status?.settings?.bandHalfBps, 0) / 100;
  const actualBandHalfPct = actualBandHalfPctFromTicks(status?.position?.tickLower, status?.position?.tickUpper);
  const edgeDistPct = n(status?.position?.distanceToEdge?.pct, 0) * 100;
  const churnRatio = status?.ops?.churnRatioToday;
  const activeLpCount = Number(status?.ops?.positionInventory?.activeCount || 0);
  const hasMultipleActive = activeLpCount > 1;
  const aggregateLpUsd = n(status?.ops?.positionInventory?.totalUsdValue, 0);
  const selectorLabel = selectorHumanLabel(status?.market?.selector, status?.market?.venueActive);
  const bandPerformanceRows = (status?.analytics?.bandPerformance || []).map((row) => [
    `±${fmtPct(row.bandHalfPct)}`,
    String(Math.round(n(row.runs, 0))),
    fmtUsd(row.totalFeesUsd),
    fmtUsd(row.avgFeesUsd),
    fmtPct(row.avgFeeToLpPct),
    fmtDurationCompact(row.avgDurationSec),
    fmtUsd(row.totalNetUsd),
  ]);
  const activeLifecycleRecord = status?.activePositionRecord || null;
  const positionsTaxSummary = status?.positionsTaxSummary || null;
  const poolComparison = status?.poolComparison || null;
  const poolComparisonCurrent = poolComparison?.current || null;
  const poolComparisonTop5 = poolComparison?.top5 || [];
  const closedPositionRecords = positionsPage?.items || [];
  const positionsPageCount = Math.max(1, Number(positionsPage?.totalPages || 1));
  const positionsCurrentPage = Math.max(1, Number(positionsPage?.page || positionsPageNum));
  const regimeHalfLifeSec = regimeStatus?.halfLifeSec;
  const regimeHalfLifeLabel =
    regimeHalfLifeSec == null || !Number.isFinite(Number(regimeHalfLifeSec))
      ? "—"
      : Number(regimeHalfLifeSec) > 86400
        ? `${Math.round(Number(regimeHalfLifeSec) / 3600)}h`
        : fmtDurationCompact(regimeHalfLifeSec);
  const regimeConfidencePct = regimeStatus?.confidence == null ? null : n(regimeStatus?.confidence, 0) * 100;
  const regimeBaseEdgePct = n(regimeDecisionView?.baseThresholds?.edgeRebalancePct, n(status?.settings?.edgeRebalancePct, 0)) * 100;
  const regimeEffectiveEdgePct =
    n(regimeDecisionView?.effectiveThresholds?.edgeRebalancePct, n(status?.settings?.edgeRebalancePct, 0)) * 100;
  const regimeBaseCooldown = n(
    regimeDecisionView?.baseThresholds?.minRebalanceIntervalSec,
    n(status?.settings?.minRebalanceIntervalSec, 0)
  );
  const regimeEffectiveCooldown = n(
    regimeDecisionView?.effectiveThresholds?.minRebalanceIntervalSec,
    n(status?.settings?.minRebalanceIntervalSec, 0)
  );
  const regimeBaseBandBps = n(regimeDecisionView?.baseThresholds?.bandHalfBps, n(status?.settings?.bandHalfBps, 0));
  const regimeEffectiveBandBps = n(
    regimeDecisionView?.effectiveThresholds?.bandHalfBps,
    n(status?.settings?.bandHalfBps, 0)
  );
  const poolComparisonCurrentRow = poolComparisonCurrent
    ? ([
        poolComparisonCurrent.dex?.name || "—",
        `${poolComparison?.network?.name || "Base"} (${poolComparisonCurrent.chain?.chainId || BASE_CHAIN_ID_DEC})`,
        pairLabel(poolComparisonCurrent),
        <span
          title={poolComparisonCurrent.selector?.feeIsEstimated ? "Fee rate estimated from pool metadata fallback." : undefined}
        >
          {poolComparisonSelectorLabel(poolComparisonCurrent)}
          {poolComparisonCurrent.selector?.feeIsEstimated ? " *" : ""}
        </span>,
        `${fmtUsdCompact(poolComparisonCurrent.stats?.tvlAvg7dUsd)} / ${fmtUsdCompact(poolComparisonCurrent.stats?.tvlAvg30dUsd)}`,
        `${fmtUsdCompact(poolComparisonCurrent.stats?.volAvg7dUsd)} / ${fmtUsdCompact(poolComparisonCurrent.stats?.volAvg30dUsd)}`,
        <span title="Approx fee/day per $TVL = avgVolume * feeRate / avgTVL">
          {`${fmtPct(n(poolComparisonCurrent.stats?.feePower7d, 0) * 100, 3)} / ${fmtPct(
            n(poolComparisonCurrent.stats?.feePower30d, 0) * 100,
            3
          )}`}
        </span>,
        <span title="Heuristic expected net/day for current UC6 capital and current band settings">
          {fmtSignedUsd(poolComparisonCurrent.economics?.expectedNetDayUsd)}
        </span>,
      ] as Array<ReactNode>)
    : null;
  const poolComparisonTopRows = poolComparisonTop5.map((row) => [
    row.dex?.name || "—",
    pairLabel(row),
    <span title={row.selector?.feeIsEstimated ? "Fee rate estimated from pool metadata fallback." : undefined}>
      {poolComparisonSelectorLabel(row)}
      {row.selector?.feeIsEstimated ? " *" : ""}
    </span>,
    `${fmtUsdCompact(row.stats?.tvlAvg7dUsd)} / ${fmtUsdCompact(row.stats?.tvlAvg30dUsd)}`,
    `${fmtUsdCompact(row.stats?.volAvg7dUsd)} / ${fmtUsdCompact(row.stats?.volAvg30dUsd)}`,
    <span title="Approx fee/day per $TVL = avgVolume * feeRate / avgTVL">
      {`${fmtPct(n(row.stats?.feePower7d, 0) * 100, 3)} / ${fmtPct(n(row.stats?.feePower30d, 0) * 100, 3)}`}
    </span>,
    <span title="Heuristic expected net/day for your current UC6 capital, band, and edge threshold">
      {fmtSignedUsd(row.economics?.expectedNetDayUsd)}
    </span>,
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <Pill label={String(row.compareToCurrent?.rating || "—")} tone={ratingTone(row.compareToCurrent?.rating)} />
      <span style={{ color: "#4a5a70", fontSize: 12 }} title={row.compareToCurrent?.reason || ""}>
        {row.compareToCurrent?.reason || "—"}
      </span>
    </div>,
    fmtDays(row.compareToCurrent?.breakEvenDays ?? null),
  ]);

  return (
    <>
      <NavBar active={"uc6" as never} />
      <main style={styles.main}>
        <section style={styles.headerCard}>
          <div style={styles.headerRow}>
            <div>
              <h1 style={{ margin: 0, fontSize: 30 }}>UC6: LP Bot Dashboard</h1>
              <p style={styles.subtle}>Operational cockpit for LP performance, costs, risk controls, and owner actions.</p>
            </div>
            <Pill
              label={status?.killSwitch ? "KILL SWITCH ACTIVE" : "KILL SWITCH OFF"}
              tone={status?.killSwitch ? "bad" : "good"}
            />
          </div>

          <div style={styles.row}>
            <button style={styles.button} onClick={connectWallet} disabled={busy !== "" || !hasMetaMask}>
              {walletAddress ? "Reconnect MetaMask" : "Connect MetaMask"}
            </button>
            <button style={styles.buttonSecondary} onClick={switchToBase} disabled={busy !== "" || !walletAddress || isBase}>
              {isBase ? "On Base" : "Switch To Base"}
            </button>
            <button style={styles.buttonSuccess} onClick={enableTrading} disabled={busy !== "" || !isOwner || !draft}>
              Enable Trading
            </button>
            <button style={styles.buttonDanger} onClick={emergencyStop} disabled={busy !== "" || !isOwner || !draft || draft.killSwitch}>
              Emergency Stop
            </button>
          </div>

          <div style={styles.metaGrid}>
            <Metric label="MetaMask" value={hasMetaMask ? "Detected" : "Not found"} />
            <Metric label="Wallet" value={walletAddress ? shortAddr(walletAddress) : "Not connected"} />
            <Metric label="Owner Wallet" value={OWNER_ADDRESS ? shortAddr(OWNER_ADDRESS) : "Missing NEXT_PUBLIC_UC6_OWNER_ADDRESS"} />
            <Metric label="Wallet Chain" value={walletChain ? `${walletChain} (${isBase ? "Base" : "Not Base"})` : "Unknown"} />
            <Metric label="Bot Account" value={shortAddr(status?.account)} mono />
            <Metric label="Owner Session" value={isOwner ? "Authorized" : "Read-only"} />
          </div>

          {!!notice && <p style={{ ...styles.alert, ...styles.alertOk }}>{notice}</p>}
          {!!error && <p style={{ ...styles.alert, ...styles.alertErr }}>{error}</p>}
          {!!statusError && <p style={{ ...styles.alert, ...styles.alertErr }}>Status refresh error: {statusError}</p>}
          {hasMultipleActive && (
            <p style={{ ...styles.alert, ...styles.alertErr }}>
              Multiple active Slipstream positions detected ({activeLpCount}). Bot trading is blocked until positions are consolidated.
            </p>
          )}
        </section>

        <section style={styles.cardGrid}>
          <Card title="Position Overview">
            <div style={styles.metaGrid}>
              <Metric label="Chain" value={`${status?.market?.chain?.name || "Base"} (${status?.market?.chain?.chainId || BASE_CHAIN_ID_DEC})`} />
              <Metric label="Venue Active" value={status?.market?.venueActive || "—"} />
              <Metric label="Pair" value={`${status?.market?.pair?.base || "WETH"}/${status?.market?.pair?.quote || "USDC"}`} />
              <Metric label="Spot Price" value={fmtUsd(status?.market?.spotPrice?.usdcPerWeth)} />
              <Metric label="Price Updated" value={status?.market?.spotPrice?.updatedAtIso || "—"} />
              <Metric label="Active LP NFTs" value={String(activeLpCount || 0)} />
              <Metric label="Total LP (All NFTs)" value={fmtUsd(aggregateLpUsd)} />
              <Metric label="HTTP Provider" value={status?.providers?.http?.active || "—"} />
              <Metric
                label="WS Provider"
                value={
                  status?.providers?.ws?.enabled
                    ? `${status?.providers?.ws?.active || "—"} (${status?.providers?.ws?.connected ? "connected" : "disconnected"})`
                    : "disabled"
                }
              />
              <Metric label="Last Head" value={status?.providers?.ws?.lastHeadBlock != null ? String(status.providers?.ws?.lastHeadBlock) : "—"} />
              <Metric label="Head Seen" value={status?.providers?.ws?.lastHeadAtIso || "—"} />
              <Metric label="Time In Range (Trading On)" value={status?.ops?.timeInRange?.pct == null ? "—" : fmtPct(n(status?.ops?.timeInRange?.pct, 0) * 100)} />
              <Metric label="Time In Range Since" value={status?.ops?.timeInRange?.sinceIso || "—"} />
              <Metric label="Min Rebalance Interval" value={`${String(status?.settings?.minRebalanceIntervalSec ?? "—")}s`} />
              <Metric label="Dashboard Poll" value={`${statusPollMs}ms`} />
              <Metric
                label="Cooldown Remaining"
                value={<Pill label={cooldownRemaining > 0 ? `${cooldownRemaining}s` : "ready"} tone={cooldownRemaining > 0 ? "warn" : "good"} />}
              />
            </div>
            <div style={styles.note}>
              Next action: <strong>{String(decision.action || "monitor")}</strong> ({String(decision.reason || "n/a")})
            </div>
          </Card>

          <Card title="Wallet & Allocation">
            <div style={styles.metaGrid}>
              <Metric label="Wallet Total" value={fmtUsd(status?.wallet?.valuesUsd?.total)} />
              <Metric label="USDC" value={`${fmtNum(status?.wallet?.balances?.usdc, 4)} (${fmtUsd(status?.wallet?.valuesUsd?.usdc)})`} />
              <Metric label="WETH" value={`${fmtNum(status?.wallet?.balances?.weth, 6)} (${fmtUsd(status?.wallet?.valuesUsd?.weth)})`} />
              <Metric label="ETH (Gas)" value={`${fmtNum(status?.wallet?.balances?.eth, 6)} (${fmtUsd(status?.wallet?.valuesUsd?.eth)})`} />
              <Metric label="Idle Value" value={fmtUsd(status?.wallet?.allocationUsd?.idle)} />
              <Metric label="LP Deployed" value={fmtUsd(status?.wallet?.allocationUsd?.lpDeployed)} />
              <Metric label="Reserve Target" value={fmtUsd(status?.wallet?.allocationUsd?.reserveTarget)} />
              <Metric label="% Deployed" value={fmtPct(status?.wallet?.deployedPct)} />
              <Metric label="% Idle" value={fmtPct(100 - n(status?.wallet?.deployedPct, 0))} />
            </div>
          </Card>

          <Card title="Regime">
            <div style={styles.metaGrid}>
              <Metric
                label="Regime Engine"
                value={
                  <Pill
                    label={status?.settings?.regime?.enabled ? "ON" : "OFF"}
                    tone={status?.settings?.regime?.enabled ? "good" : "muted"}
                  />
                }
              />
              <Metric
                label="Label"
                value={
                  <Pill
                    label={String(regimeStatus?.label || "unknown")}
                    tone={
                      regimeStatus?.label === "trending"
                        ? "warn"
                        : regimeStatus?.label === "mean_reverting"
                          ? "good"
                          : "muted"
                    }
                  />
                }
              />
              <Metric label="Half-life" value={regimeHalfLifeLabel} />
              <Metric label="Confidence" value={regimeConfidencePct == null ? "—" : fmtPct(regimeConfidencePct)} />
              <Metric label="Samples" value={`${String(regimeStatus?.sampleCount ?? 0)} / ${String(regimeStatus?.windowSec ?? status?.settings?.regime?.windowSec ?? "—")}s`} />
              <Metric label="Updated" value={regimeStatus?.updatedAtIso || "—"} />
              <Metric label="Advice" value={String(regimeDecisionView?.adviceReason || "—")} />
              <Metric
                label="Wait Recommended"
                value={<Pill label={regimeDecisionView?.waitRecommended ? "yes" : "no"} tone={regimeDecisionView?.waitRecommended ? "warn" : "muted"} />}
              />
              <Metric label="Edge Threshold (base → effective)" value={`${fmtPct(regimeBaseEdgePct)} → ${fmtPct(regimeEffectiveEdgePct)}`} />
              <Metric label="Cooldown (base → effective)" value={`${Math.round(regimeBaseCooldown)}s → ${Math.round(regimeEffectiveCooldown)}s`} />
              <Metric label="Band Target (base → effective)" value={`±${fmtPct(regimeBaseBandBps / 100)} → ±${fmtPct(regimeEffectiveBandBps / 100)}`} />
            </div>
            <div style={styles.note}>
              Regime uses OU half-life heuristics on cached tick samples only (no extra RPC reads). Effective thresholds apply per decision and do not overwrite stored settings.
            </div>
          </Card>

          <Card title="LP Position Composition" fullWidth wideViewport>
            {isOwner && (
              <div style={{ ...styles.row, marginBottom: 12 }}>
                <button
                  style={styles.buttonDanger}
                  onClick={liquidateAndPause}
                  disabled={busy !== "" || !status?.position?.tokenId}
                  title={!status?.position?.tokenId ? "No active LP position" : "Close LP and enable kill switch"}
                >
                  Liquidate LP + Pause
                </button>
              </div>
            )}
            <div style={styles.metaGrid}>
              <Metric label="Token ID (LP NFT)" value={String(status?.position?.tokenId ?? "—")} mono />
              <Metric label="In Range" value={<Pill label={inRange ? "In Range" : "Out of Range"} tone={boolTone(status?.position?.inRange)} />} />
              <Metric label="Pool Tier / Selector" value={selectorLabel} />
              <Metric label="Current Pool Tick (internal)" value={String(status?.market?.tick?.current ?? "—")} />
              <Metric label="Pool Tick Spacing (grid)" value={String(status?.market?.tick?.spacing ?? "—")} />
              <Metric label="Configured Band Target" value={`±${fmtPct(configuredBandHalfPct)}`} />
              <Metric
                label="Actual Band Width"
                value={
                  actualBandHalfPct == null
                    ? "—"
                    : `±${fmtPct(actualBandHalfPct)}`
                }
              />
              <Metric label="Band Ticks" value={`${String(status?.position?.tickLower ?? "—")} .. ${String(status?.position?.tickUpper ?? "—")}`} mono />
              <Metric label="USDC in LP" value={`${fmtNum(status?.position?.amountsInLP?.usdc, 4)} (${fmtUsd(status?.position?.amountsInLP?.sideUsd?.usdc)})`} />
              <Metric label="WETH in LP" value={`${fmtNum(status?.position?.amountsInLP?.weth, 6)} (${fmtUsd(status?.position?.amountsInLP?.sideUsd?.weth)})`} />
              <Metric label="LP Value" value={fmtUsd(status?.position?.amountsInLP?.usdValue)} />
              <Metric
                label="LP Split"
                value={`${fmtPct((n(status?.position?.amountsInLP?.sideUsd?.usdc, 0) / Math.max(1, n(status?.position?.amountsInLP?.usdValue, 0))) * 100)} / ${fmtPct((n(status?.position?.amountsInLP?.sideUsd?.weth, 0) / Math.max(1, n(status?.position?.amountsInLP?.usdValue, 0))) * 100)}`}
              />
              <Metric label="Distance To Edge" value={`${String(status?.position?.distanceToEdge?.ticks ?? "—")} ticks (${fmtPct(edgeDistPct)})`} />
              <Metric label="Liquidity" value={status?.position?.liquidity || "—"} mono />
            </div>
          </Card>

          <Card title="LP Position Record" fullWidth wideViewport>
            {!!positionsError && <p style={{ ...styles.alert, ...styles.alertErr, marginTop: 0 }}>Positions refresh error: {positionsError}</p>}

            <div style={styles.recordActiveWrap}>
              <div style={styles.recordActiveTitle}>Realized (Closed) Summary for Tax Tracking</div>
              <div style={{ ...styles.note, marginBottom: 10 }}>
                Aggregated from closed LP position records only. Tax years grouped by {positionsTaxSummary?.timezone || "UTC"} ({positionsTaxSummary?.dateRangeRule || "01-01..12-31"}).
              </div>
              <SimpleTable
                headers={["Tax Year", "Closed Positions", "Net Fees", "Capital Gain/Loss"]}
                rows={
                  Array.isArray(positionsTaxSummary?.years) && positionsTaxSummary!.years!.length > 0
                    ? positionsTaxSummary!.years!.map((row) => [
                        String(Math.round(n(row?.year, 0))),
                        String(Math.round(n(row?.closedPositions, 0))),
                        fmtSignedUsd(row?.feesNetUsd),
                        fmtSignedUsd(row?.capitalGainLossUsd),
                      ])
                    : [["—", "0", "—", "—"]]
                }
              />
            </div>

            <div style={styles.recordActiveWrap}>
              <div style={styles.recordActiveTitle}>Active (Open) LP Position</div>
              {activeLifecycleRecord ? (
                <div style={styles.metaGrid}>
                  <Metric
                    label="Token ID (LP NFT)"
                    value={activeLifecycleRecord.tokenId || activeLifecycleRecord.id || status?.activePositionId || "—"}
                    mono
                  />
                  <Metric
                    label="Pair"
                    value={`${activeLifecycleRecord.pair?.base || "WETH"}/${activeLifecycleRecord.pair?.quote || "USDC"}`}
                  />
                  <Metric
                    label="Band"
                    value={
                      <span title={`${activeLifecycleRecord.band?.tickLower ?? "—"} .. ${activeLifecycleRecord.band?.tickUpper ?? "—"}`}>
                        {formatRecordBandLabel(activeLifecycleRecord)}
                      </span>
                    }
                  />
                  <Metric label="Opened" value={fmtIsoLocal(activeLifecycleRecord.entry?.openedAtIso)} />
                  <Metric label="Entry Snapshot" value={fmtIsoLocal(activeLifecycleRecord.entry?.entrySnapshotAtIso)} />
                  <Metric label="Entry Value" value={fmtUsd(activeLifecycleRecord.entry?.entryValueUsd)} />
                  <Metric label="Fees Collected" value={fmtUsd(activeLifecycleRecord.performance?.feesCollectedUsd)} />
                  <Metric label="Total Costs" value={fmtUsd(activeLifecycleRecord.performance?.totalCostsUsd)} />
                  <Metric label="Fees Net" value={fmtSignedUsd(activeLifecycleRecord.performance?.feesNetUsd)} />
                  <Metric label="Capital Gain/Loss" value={fmtSignedUsd(activeLifecycleRecord.performance?.capitalGainLossUsd)} />
                  <Metric label="Divergence vs HODL" value={fmtSignedUsd(activeLifecycleRecord.performance?.divergenceVsHodlUsd)} />
                  <Metric label="Net Profit" value={fmtSignedUsd(activeLifecycleRecord.performance?.netProfitUsd)} />
                  <Metric label="Tx Count" value={String(activeLifecycleRecord.activity?.txCount ?? 0)} />
                  <Metric label="Status" value={activeLifecycleRecord.status || "OPEN"} />
                </div>
              ) : (
                <div style={styles.note}>No active open LP position record.</div>
              )}
            </div>

            <div style={{ ...styles.note, marginTop: 12 }}>
              Closed LP positions only (each row is one LP NFT lifecycle). Newest closed position appears first. Entry value uses the delayed entry snapshot (after initial top-up), not raw mint inputs. Net Profit = Fees Net + Capital Gain/Loss. Divergence vs HODL is a benchmark delta (principal LP vs HODL), not a cash cost.
            </div>

            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    {[
                      "Pair",
                      "Venue",
                      "Fee/Tier",
                      "Band",
                      "Entry Time",
                      "Exit Time",
                      "Duration",
                      "Entry Value",
                      "Fees Collected",
                      "Total Costs",
                      "Fees Net",
                      "Capital G/L",
                      "Div. vs HODL",
                      "Net Profit",
                      "Cost/Fee",
                      "APR",
                      "Actions",
                    ].map((h) => (
                      <th key={h} style={styles.th}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {closedPositionRecords.length === 0 ? (
                    <tr>
                      <td style={styles.td} colSpan={17}>
                        No closed position records yet.
                      </td>
                    </tr>
                  ) : (
                    closedPositionRecords.map((rec) => {
                      const selectorLabel = rec.selector?.humanLabel || `${rec.selector?.type || "—"}:${String(rec.selector?.value ?? "—")}`;
                      const bandLabel = formatRecordBandLabel(rec);
                      const ticksLabel = `${rec.band?.tickLower ?? "—"} .. ${rec.band?.tickUpper ?? "—"}`;
                      const divVsHodlUsd = n(rec.performance?.divergenceVsHodlUsd ?? rec.performance?.impermanentLossUsd, 0);
                      const feesNetUsd = n(rec.performance?.feesNetUsd, 0);
                      const capitalGainLossUsd = n(rec.performance?.capitalGainLossUsd, 0);
                      const netUsd = n(rec.performance?.netProfitUsd, 0);
                      return (
                        <tr key={rec.id}>
                          <td style={styles.td}>{`${rec.pair?.base || "WETH"}/${rec.pair?.quote || "USDC"}`}</td>
                          <td style={styles.td}>{rec.venue === "uniswapv3" ? "Uniswap v3" : "Slipstream"}</td>
                          <td style={styles.td}>{selectorLabel}</td>
                          <td style={styles.td}>
                            <span title={ticksLabel}>{bandLabel}</span>
                          </td>
                          <td style={styles.td} title={rec.entry?.entrySnapshotAtIso || rec.entry?.openedAtIso || ""}>
                            {fmtIsoLocal(rec.entry?.entrySnapshotAtIso || rec.entry?.openedAtIso)}
                          </td>
                          <td style={styles.td} title={rec.exit?.closedAtIso || ""}>
                            {rec.exit?.closedAtIso ? fmtIsoLocal(rec.exit.closedAtIso) : "OPEN"}
                          </td>
                          <td style={styles.td}>{rec.duration?.human || fmtDurationCompact(rec.duration?.secondsInPosition)}</td>
                          <td style={styles.td}>{fmtUsd(rec.entry?.entryValueUsd)}</td>
                          <td style={styles.td}>{fmtUsd(rec.performance?.feesCollectedUsd)}</td>
                          <td style={styles.td}>{fmtUsd(rec.performance?.totalCostsUsd)}</td>
                          <td style={{ ...styles.td, color: feesNetUsd < 0 ? "#8d1111" : "#145b2f" }}>{fmtSignedUsd(rec.performance?.feesNetUsd)}</td>
                          <td style={{ ...styles.td, color: capitalGainLossUsd < 0 ? "#8d1111" : "#145b2f" }}>{fmtSignedUsd(rec.performance?.capitalGainLossUsd)}</td>
                          <td style={{ ...styles.td, color: divVsHodlUsd < 0 ? "#8d1111" : styles.td.color }}>{fmtSignedUsd(rec.performance?.divergenceVsHodlUsd ?? rec.performance?.impermanentLossUsd)}</td>
                          <td style={{ ...styles.td, color: netUsd < 0 ? "#8d1111" : "#145b2f" }}>{fmtSignedUsd(rec.performance?.netProfitUsd)}</td>
                          <td style={styles.td}>{fmtRatioPct(rec.performance?.costToFeeRatio)}</td>
                          <td style={styles.td}>{fmtPct(rec.performance?.apr)}</td>
                          <td style={styles.td}>
                            <button style={styles.tableActionButton} onClick={() => setSelectedPosition(rec)}>
                              View
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div style={styles.paginationRow}>
              <button
                style={styles.buttonSecondary}
                onClick={() => setPositionsPageNum((p) => Math.max(1, p - 1))}
                disabled={positionsCurrentPage <= 1}
              >
                Prev
              </button>
              <span style={styles.paginationLabel}>
                Page {positionsCurrentPage} / {positionsPageCount}
                {positionsPage ? ` (${positionsPage.totalItems} records)` : ""}
              </span>
              <button
                style={styles.buttonSecondary}
                onClick={() => setPositionsPageNum((p) => Math.min(positionsPageCount, p + 1))}
                disabled={positionsCurrentPage >= positionsPageCount}
              >
                Next
              </button>
            </div>
          </Card>

          <Card title="Profitability (Net)">
            <SimpleTable
              headers={["Window", "Fees", "Rewards", "Costs", "Net", "APR"]}
              rows={[
                [
                  "Today",
                  fmtUsd(status?.fees?.collectedTodayUsd),
                  "$0.00",
                  fmtUsd(status?.costs?.totalTodayUsd),
                  fmtUsd(status?.pnl?.netTodayUsd),
                  fmtPct(n(status?.pnl?.aprToday, 0) * 100),
                ],
                [
                  "7D",
                  fmtUsd(status?.fees?.collected7dUsd),
                  "$0.00",
                  fmtUsd(status?.costs?.total7dUsd),
                  fmtUsd(status?.pnl?.net7dUsd),
                  fmtPct(n(status?.pnl?.apr7d, 0) * 100),
                ],
                [
                  "30D",
                  fmtUsd(status?.fees?.collected30dUsd),
                  "$0.00",
                  fmtUsd(status?.costs?.total30dUsd),
                  fmtUsd(status?.pnl?.net30dUsd),
                  status?.pnl?.apr30d == null ? "—" : fmtPct(n(status?.pnl?.apr30d, 0) * 100),
                ],
              ]}
            />
            <div style={{ ...styles.note, marginTop: 8 }}>
              Net = Fees Net (fees + rewards - costs). Divergence vs HODL is shown in LP Position Records as a separate benchmark metric and is not deducted as a cash cost.
            </div>
            <div style={styles.note}>
              Collectable now: {fmtUsd(status?.fees?.collectableNow?.usd)}
              {status?.fees?.collectableNow?.isEstimated ? " (simulation fallback)" : ""} | Pending compound: {fmtUsd(status?.fees?.pendingCompoundUsd)}
            </div>
            <div style={{ ...styles.note, marginTop: 10 }}>
              Band performance (completed runs only; currently grouped by actual placed band width after tick-grid snapping, not configured target).
            </div>
            <SimpleTable
              headers={["Band", "Runs", "Fees Total", "Fees Avg", "Avg Fees / LP", "Avg Time To Rebalance", "Net Total"]}
              rows={
                bandPerformanceRows.length > 0
                  ? bandPerformanceRows
                  : [["—", "0", "—", "—", "—", "—", "—"]]
              }
            />
          </Card>

          <Card title="Rebalance & Activity">
            {isOwner && (
              <div style={{ ...styles.row, marginBottom: 12 }}>
                <button
                  style={styles.buttonSecondary}
                  onClick={forceRebalance}
                  disabled={busy !== "" || Boolean(status?.killSwitch) || !status?.tradingEnabled}
                  title={
                    status?.killSwitch
                      ? "Kill switch active"
                      : !status?.tradingEnabled
                        ? "Trading is disabled"
                        : "Request an immediate rebalance (owner-only)"
                  }
                >
                  Force Rebalance
                </button>
              </div>
            )}
            <div style={styles.metaGrid}>
              <Metric label="Rebalances (24h)" value={String(status?.ops?.rebalances24h ?? 0)} />
              <Metric label="Rebalances (7d)" value={String(status?.ops?.rebalances7d ?? 0)} />
              <Metric label="Costs Today" value={fmtUsd(status?.costs?.totalTodayUsd)} />
              <Metric label="Avg Cost / Rebalance" value={fmtUsd(n(status?.costs?.totalTodayUsd, 0) / Math.max(1, n(status?.ops?.rebalances24h, 0)))} />
              <Metric label="Avg Fees / Rebalance" value={fmtUsd(n(status?.fees?.collectedTodayUsd, 0) / Math.max(1, n(status?.ops?.rebalances24h, 0)))} />
              <Metric label="Churn Ratio" value={<Pill label={churnRatio == null ? "n/a" : fmtPct(churnRatio * 100)} tone={churnTone(churnRatio)} />} />
              <Metric label="Churn Protection" value={status?.settings?.churnProtection?.enabled ? "enabled" : "disabled"} />
              <Metric label="Churn Limit" value={fmtPct(n(status?.settings?.churnProtection?.maxCostToFeeRatio, 0) * 100)} />
              <Metric label="Rebalance Trigger Threshold" value={fmtPct(n(status?.settings?.edgeRebalancePct, 0) * 100)} />
              <Metric label="Last Rebalance" value={status?.ops?.lastRebalanceAtIso || "—"} />
              <Metric label="Gate" value={status?.counters?.reason || "—"} />
            </div>
          </Card>

          <Card title="Events & Decisions" fullWidth>
            <SimpleTable
              headers={["Time", "Type", "Reason", "Tx", "Gas", "Swap", "Slip", "Fees", "Net"]}
              rows={events.map((ev) => [
                ev.atIso || "—",
                ev.type || "—",
                ev.reason || "—",
                ev.txHashes && ev.txHashes.length > 0 ? shortAddr(ev.txHashes[0]) : "—",
                fmtUsd(ev.gasUsd),
                fmtUsd(ev.swapCostUsd),
                ev.slippageBpsReal == null ? "—" : `${n(ev.slippageBpsReal, 0).toFixed(1)} bps`,
                fmtUsd(ev.feesCollectedUsd),
                fmtUsd(ev.netUsd),
              ])}
            />
            <div style={styles.note}>Swap costs and slippage use quote vs actual wallet balance deltas.</div>
          </Card>

          <Card title="Pool Comparison (Base)" fullWidth>
            <div style={styles.note}>
              Daily GeckoTerminal-based comparison for Base majors/stables pools (Aerodrome Slipstream, Uniswap v3, PancakeSwap v3, SushiSwap v3). Heuristic score estimates expected net/day for your current UC6 capital and settings; use as a screening tool, not a guarantee.
            </div>
            {poolComparison?.lastError?.message && (
              <div style={{ ...styles.note, color: "#7a2830", marginTop: 6 }}>
                Last compute warning ({fmtIsoLocal(poolComparison?.lastError?.atIso)}): {poolComparison.lastError.message}
              </div>
            )}
            <div style={{ ...styles.note, marginTop: 6 }}>
              Computed: {fmtIsoLocal(poolComparison?.computedAtIso)} | Network: {poolComparison?.network?.name || "Base"} | Ref capital:{" "}
              {fmtUsd(poolComparison?.ref?.currentPool?.refCapitalUsd)}
            </div>

            <div style={{ marginTop: 10, fontWeight: 600 }}>Current pool</div>
            <SimpleTable
              headers={["Venue", "Chain", "Pair", "Fee/Tier", "TVL (7d / 30d)", "Volume (7d / 30d)", "FeePower (7d / 30d)", "Exp Net/day"]}
              rows={poolComparisonCurrentRow ? [poolComparisonCurrentRow] : [["—", "—", "—", "—", "—", "—", "—", "—"]]}
            />

            <div style={{ marginTop: 12, fontWeight: 600 }}>Top 5 candidate pools</div>
            <SimpleTable
              headers={[
                "Venue",
                "Pair",
                "Fee/Tier",
                "TVL (7d / 30d)",
                "Volume (7d / 30d)",
                "FeePower (7d / 30d)",
                "Exp Net/day",
                "Rating vs current",
                "Break-even",
              ]}
              rows={
                poolComparisonTopRows.length > 0
                  ? poolComparisonTopRows
                  : [["—", "—", "—", "—", "—", "—", "—", "—", "—"]]
              }
            />
            <div style={{ ...styles.note, marginTop: 8 }}>
              Rating compares expected net/day over the next 1–2 weeks vs the current pool using recent 7d/30d volume, TVL, fee-power, and a simple rebalance-cost proxy. “*” marks fee-rate estimates.
            </div>
          </Card>
        </section>

        {isOwner && draft && (
          <section style={styles.panel}>
            <h2 style={styles.h2}>Owner Controls</h2>
            <div style={styles.formGrid}>
              <SelectField label="Kill Switch" value={draft.killSwitch ? "true" : "false"} onChange={(v) => updateBool("killSwitch", v === "true")} options={["false", "true"]} />
              <SelectField
                label="Trading Enabled"
                value={draft.tradingEnabled ? "true" : "false"}
                onChange={(v) => updateBool("tradingEnabled", v === "true")}
                options={["true", "false"]}
                disabled={draft.killSwitch}
              />
              <SelectField label="Venue" value={draft.venue} onChange={(v) => setDraft((p) => (p ? { ...p, venue: v as Uc6Venue } : p))} options={["slipstream", "uniswapv3"]} />

              <NumberField label="bandHalfBps" value={draft.bandHalfBps} onChange={(v) => updateNumber("bandHalfBps", v)} />
              <NumberField label="edgeRebalancePct" value={draft.edgeRebalancePct} step="0.01" onChange={(v) => updateNumber("edgeRebalancePct", v)} />
              <NumberField label="minRebalanceIntervalSec" value={draft.minRebalanceIntervalSec} onChange={(v) => updateNumber("minRebalanceIntervalSec", v)} />
              <NumberField label="maxRebalancesPerDay" value={draft.maxRebalancesPerDay} onChange={(v) => updateNumber("maxRebalancesPerDay", v)} />
              <NumberField label="failureCooldownSec" value={draft.failureCooldownSec} onChange={(v) => updateNumber("failureCooldownSec", v)} />

              <NumberField label="slippageBps" value={draft.slippageBps} onChange={(v) => updateNumber("slippageBps", v)} />
              <NumberField label="pollIntervalMs" value={draft.pollIntervalMs} onChange={(v) => updateNumber("pollIntervalMs", v)} />
              <SelectField
                label="wsEnabled"
                value={draft.wsEnabled ? "true" : "false"}
                onChange={(v) => updateBool("wsEnabled", v === "true")}
                options={["true", "false"]}
              />
              <NumberField label="slot0RefreshEverySec" value={draft.slot0RefreshEverySec} onChange={(v) => updateNumber("slot0RefreshEverySec", v)} />
              <NumberField label="balancesRefreshEverySec" value={draft.balancesRefreshEverySec} onChange={(v) => updateNumber("balancesRefreshEverySec", v)} />
              <NumberField label="positionRefreshEverySec" value={draft.positionRefreshEverySec} onChange={(v) => updateNumber("positionRefreshEverySec", v)} />
              <NumberField label="inventoryRefreshEverySec" value={draft.inventoryRefreshEverySec} onChange={(v) => updateNumber("inventoryRefreshEverySec", v)} />
              <NumberField label="collectableRefreshEverySec" value={draft.collectableRefreshEverySec} onChange={(v) => updateNumber("collectableRefreshEverySec", v)} />
              <NumberField
                label="dashboardRecommendedPollMs"
                value={draft.dashboardRecommendedPollMs}
                onChange={(v) => updateNumber("dashboardRecommendedPollMs", v)}
              />
              <NumberField label="maxDeployUsdc" value={draft.maxDeployUsdc} onChange={(v) => updateNumber("maxDeployUsdc", v)} />
              <NumberField
                label="maxInitialMintUsdc"
                value={draft.maxInitialMintUsdc}
                onChange={(v) => updateNumber("maxInitialMintUsdc", v)}
              />
              <NumberField label="minTopUpUsd" value={draft.minTopUpUsd} onChange={(v) => updateNumber("minTopUpUsd", v)} />

              <NumberField label="reserveMinUsdc" value={draft.reserveMinUsdc} onChange={(v) => updateNumber("reserveMinUsdc", v)} />
              <NumberField label="reservePct (%)" value={draft.reservePct} step="0.1" onChange={(v) => updateNumber("reservePct", v)} />
              <NumberField label="reserveMaxUsdc" value={draft.reserveMaxUsdc} onChange={(v) => updateNumber("reserveMaxUsdc", v)} />

              <SelectField
                label="compoundMode"
                value={draft.compoundMode}
                onChange={(v) => setDraft((p) => (p ? { ...p, compoundMode: v as CompoundMode } : p))}
                options={["on_rebalance", "threshold_harvest"]}
              />
              <NumberField label="harvestThresholdUsd" value={draft.harvestThresholdUsd} onChange={(v) => updateNumber("harvestThresholdUsd", v)} />

              <SelectField
                label="churnProtectionEnabled"
                value={draft.churnProtectionEnabled ? "true" : "false"}
                onChange={(v) => updateBool("churnProtectionEnabled", v === "true")}
                options={["false", "true"]}
              />
              <NumberField
                label="churnMaxCostToFeeRatio (%)"
                value={draft.churnMaxCostToFeeRatio}
                step="0.1"
                onChange={(v) => updateNumber("churnMaxCostToFeeRatio", v)}
              />

              <SelectField
                label="regime.enabled"
                value={draft.regimeEnabled ? "true" : "false"}
                onChange={(v) => updateBool("regimeEnabled", v === "true")}
                options={["false", "true"]}
              />
              <NumberField label="regime.windowSec" value={draft.regimeWindowSec} onChange={(v) => updateNumber("regimeWindowSec", v)} />
              <NumberField
                label="regime.sampleEverySec"
                value={draft.regimeSampleEverySec}
                onChange={(v) => updateNumber("regimeSampleEverySec", v)}
              />
              <NumberField label="regime.minSamples" value={draft.regimeMinSamples} onChange={(v) => updateNumber("regimeMinSamples", v)} />
              <NumberField
                label="regime.mrHalfLifeMaxSec"
                value={draft.regimeMrHalfLifeMaxSec}
                onChange={(v) => updateNumber("regimeMrHalfLifeMaxSec", v)}
              />
              <NumberField
                label="regime.trendHalfLifeMinSec"
                value={draft.regimeTrendHalfLifeMinSec}
                onChange={(v) => updateNumber("regimeTrendHalfLifeMinSec", v)}
              />
              <NumberField
                label="regime.maxEdgeAdj"
                value={draft.regimeMaxEdgeAdj}
                step="0.01"
                onChange={(v) => updateNumber("regimeMaxEdgeAdj", v)}
              />
              <NumberField
                label="regime.maxBandAdjBps"
                value={draft.regimeMaxBandAdjBps}
                onChange={(v) => updateNumber("regimeMaxBandAdjBps", v)}
              />
              <NumberField
                label="regime.maxCooldownAdjSec"
                value={draft.regimeMaxCooldownAdjSec}
                onChange={(v) => updateNumber("regimeMaxCooldownAdjSec", v)}
              />
            </div>

            <div style={styles.row}>
              <button style={styles.button} onClick={saveSettings} disabled={busy !== ""}>
                Save Settings
              </button>
              <button style={styles.buttonSuccess} onClick={enableTrading} disabled={busy !== "" || draft.tradingEnabled}>
                Enable Trading
              </button>
              <button style={styles.buttonDanger} onClick={emergencyStop} disabled={busy !== "" || draft.killSwitch}>
                Emergency Stop
              </button>
            </div>
          </section>
        )}

        <section style={styles.panel}>
          <h2 style={styles.h2}>Raw Debug</h2>
          <details>
            <summary style={styles.summary}>Show raw /status JSON</summary>
            <pre style={styles.pre}>{JSON.stringify(status, null, 2)}</pre>
          </details>
        </section>

        <PositionRecordDrawer record={selectedPosition} onClose={() => setSelectedPosition(null)} />
      </main>
    </>
  );
}

function PositionRecordDrawer({
  record,
  onClose,
}: {
  record: PositionLifecycleRecord | null;
  onClose: () => void;
}) {
  if (!record) return null;
  const perf = record.performance || {};
  const tx = record.tx || {};
  const openTxs = tx.openTxHashes || [];
  const closeTxs = tx.closeTxHashes || [];
  const allTxs = tx.allTxHashes || [];
  return (
    <div style={styles.drawerBackdrop} onClick={onClose}>
      <aside style={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div style={styles.drawerHeader}>
          <div>
            <div style={{ ...styles.statLabel, marginBottom: 2 }}>Position Lifecycle Record</div>
            <div style={{ ...styles.statValue, fontSize: 16 }}>{record.id}</div>
          </div>
          <button style={styles.buttonSecondary} onClick={onClose}>
            Close
          </button>
        </div>

        <div style={styles.drawerSection}>
          <div style={styles.drawerSectionTitle}>Overview</div>
          <div style={styles.metaGrid}>
            <Metric label="Pair" value={`${record.pair?.base || "WETH"}/${record.pair?.quote || "USDC"}`} />
            <Metric label="Venue" value={record.venue === "uniswapv3" ? "Uniswap v3" : "Slipstream"} />
            <Metric
              label="Band"
              value={
                <span title={`${record.band?.tickLower ?? "—"} .. ${record.band?.tickUpper ?? "—"}`}>
                  {formatRecordBandLabel(record)}
                </span>
              }
            />
            <Metric label="Status" value={record.status || "—"} />
            <Metric label="Entry Snapshot" value={fmtIsoLocal(record.entry?.entrySnapshotAtIso || record.entry?.openedAtIso)} />
            <Metric label="Exit" value={fmtIsoLocal(record.exit?.closedAtIso)} />
            <Metric label="Duration" value={record.duration?.human || fmtDurationCompact(record.duration?.secondsInPosition)} />
            <Metric label="Entry Value" value={fmtUsd(record.entry?.entryValueUsd)} />
            <Metric label="Exit Value" value={fmtUsd(record.exit?.exitValueUsd)} />
            <Metric label="Avg Deployed" value={fmtUsd(perf.avgDeployedUsd)} />
          </div>
        </div>

        <div style={styles.drawerSection}>
          <div style={styles.drawerSectionTitle}>Performance</div>
          <div style={styles.metaGrid}>
            <Metric label="Fees Collected" value={fmtUsd(perf.feesCollectedUsd)} />
            <Metric label="Rewards" value={fmtUsd(perf.rewardsUsd)} />
            <Metric label="Gas" value={fmtUsd(perf.gasUsd)} />
            <Metric label="Swap Cost" value={fmtUsd(perf.swapCostUsd)} />
            <Metric label="Mint/Burn (subset)" value={fmtUsd(perf.mintBurnUsd)} />
            <Metric label="Total Costs" value={fmtUsd(perf.totalCostsUsd)} />
            <Metric label="Fees Net" value={fmtSignedUsd(perf.feesNetUsd)} />
            <Metric label="Capital Gain/Loss" value={fmtSignedUsd(perf.capitalGainLossUsd)} />
            <Metric label="Divergence vs HODL" value={fmtSignedUsd(perf.divergenceVsHodlUsd ?? perf.impermanentLossUsd)} />
            <Metric label="Net Profit" value={fmtSignedUsd(perf.netProfitUsd)} />
            <Metric label="Alpha vs HODL" value={fmtSignedUsd(perf.alphaVsHodlUsd)} />
            <Metric label="Cost / Fee" value={fmtRatioPct(perf.costToFeeRatio)} />
            <Metric label="APR" value={fmtPct(perf.apr)} />
          </div>
        </div>

        <div style={styles.drawerSection}>
          <div style={styles.drawerSectionTitle}>Activity</div>
          <div style={styles.metaGrid}>
            <Metric label="Rebalances" value={String(record.activity?.rebalances ?? 0)} />
            <Metric label="Harvests" value={String(record.activity?.harvests ?? 0)} />
            <Metric label="Swaps" value={String(record.activity?.swaps ?? 0)} />
            <Metric label="Tx Count" value={String(record.activity?.txCount ?? 0)} />
          </div>
        </div>

        <div style={styles.drawerSection}>
          <div style={styles.drawerSectionTitle}>Transactions</div>
          <div style={styles.note}>Open: {openTxs.length} | Close: {closeTxs.length} | All: {allTxs.length}</div>
          <div style={styles.drawerTxList}>
            {allTxs.length === 0 ? (
              <div style={styles.note}>No tx hashes recorded.</div>
            ) : (
              allTxs.map((hash) => (
                <div key={hash} style={styles.drawerTxRow}>
                  <code style={styles.drawerMono}>{hash}</code>
                </div>
              ))
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function Card({
  title,
  children,
  fullWidth,
  wideViewport,
}: {
  title: string;
  children: ReactNode;
  fullWidth?: boolean;
  wideViewport?: boolean;
}) {
  return (
    <section
      style={{
        ...styles.panel,
        ...(fullWidth ? styles.fullWidth : undefined),
        ...(wideViewport ? styles.wideViewportPanel : undefined),
      }}
    >
      <h2 style={styles.h2}>{title}</h2>
      {children}
    </section>
  );
}

function Metric({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div style={styles.statCell}>
      <div style={styles.statLabel}>{label}</div>
      <div style={{ ...styles.statValue, fontFamily: mono ? "monospace" : "inherit" }}>{value}</div>
    </div>
  );
}

function Pill({ label, tone }: { label: string; tone: "good" | "warn" | "bad" | "muted" }) {
  const toneStyle =
    tone === "good"
      ? styles.pillGood
      : tone === "warn"
        ? styles.pillWarn
        : tone === "bad"
          ? styles.pillBad
          : styles.pillMuted;
  return <span style={{ ...styles.pill, ...toneStyle }}>{label}</span>;
}

function NumberField({
  label,
  value,
  onChange,
  step = "1",
}: {
  label: string;
  value: number;
  onChange: (next: string) => void;
  step?: string;
}) {
  return (
    <label style={styles.field}>
      <span>{label}</span>
      <input type="number" step={step} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: string[];
  disabled?: boolean;
}) {
  return (
    <label style={styles.field}>
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}

function SimpleTable({ headers, rows }: { headers: string[]; rows: Array<Array<ReactNode>> }) {
  return (
    <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} style={styles.th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td style={styles.td} colSpan={headers.length}>
                No data
              </td>
            </tr>
          ) : (
            rows.map((r, idx) => (
              <tr key={idx}>
                {r.map((cell, cidx) => (
                  <td key={cidx} style={styles.td}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  main: {
    maxWidth: 1360,
    margin: "0 auto",
    padding: "24px 16px 64px",
    display: "grid",
    gap: 16,
  },
  headerCard: {
    border: "1px solid #d7dce4",
    borderRadius: 14,
    padding: 18,
    background: "#ffffff",
  },
  panel: {
    border: "1px solid #d7dce4",
    borderRadius: 14,
    padding: 18,
    background: "#ffffff",
  },
  fullWidth: {
    gridColumn: "1 / -1",
  },
  wideViewportPanel: {
    width: "calc(100vw - 32px)",
    maxWidth: "none",
    marginLeft: "calc(50% - 50vw + 16px)",
  },
  cardGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
    gap: 16,
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
    flexWrap: "wrap",
  },
  h2: {
    margin: "0 0 12px",
    fontSize: 20,
  },
  subtle: {
    margin: "8px 0 0",
    color: "#4a5a70",
    fontSize: 14,
  },
  row: {
    marginTop: 12,
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
  },
  button: {
    border: "1px solid #132238",
    background: "#132238",
    color: "#fff",
    borderRadius: 8,
    padding: "8px 14px",
    cursor: "pointer",
    fontWeight: 700,
  },
  buttonSecondary: {
    border: "1px solid #9db3cf",
    background: "#f8fbff",
    color: "#10253f",
    borderRadius: 8,
    padding: "8px 14px",
    cursor: "pointer",
    fontWeight: 700,
  },
  buttonDanger: {
    border: "1px solid #8a1010",
    background: "#b91c1c",
    color: "#fff",
    borderRadius: 8,
    padding: "8px 14px",
    cursor: "pointer",
    fontWeight: 700,
  },
  buttonSuccess: {
    border: "1px solid #0f5132",
    background: "#198754",
    color: "#fff",
    borderRadius: 8,
    padding: "8px 14px",
    cursor: "pointer",
    fontWeight: 700,
  },
  alert: {
    marginTop: 12,
    border: "1px solid",
    borderRadius: 8,
    padding: "8px 10px",
    color: "#203047",
    fontSize: 14,
  },
  alertOk: {
    background: "#e9f9ef",
    borderColor: "#a1ddb4",
  },
  alertErr: {
    background: "#fff1f1",
    borderColor: "#f3b8b8",
  },
  metaGrid: {
    marginTop: 10,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
    gap: 10,
  },
  statCell: {
    border: "1px solid #e5ebf4",
    borderRadius: 10,
    background: "#fbfdff",
    padding: "10px 12px",
  },
  statLabel: {
    fontSize: 12,
    color: "#5b6e8a",
    marginBottom: 4,
  },
  statValue: {
    fontSize: 14,
    fontWeight: 700,
    color: "#10253f",
    wordBreak: "break-word",
  },
  note: {
    marginTop: 10,
    fontSize: 13,
    color: "#42526a",
  },
  recordActiveWrap: {
    border: "1px solid #e5ebf4",
    borderRadius: 10,
    background: "#fbfdff",
    padding: 12,
  },
  recordActiveTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: "#243850",
    marginBottom: 4,
  },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: 999,
    padding: "2px 9px",
    fontSize: 12,
    fontWeight: 700,
    border: "1px solid transparent",
  },
  pillGood: {
    background: "#e8f8ec",
    color: "#145b2f",
    borderColor: "#9dd8ae",
  },
  pillWarn: {
    background: "#fff7ea",
    color: "#8a4b08",
    borderColor: "#f2c283",
  },
  pillBad: {
    background: "#ffecec",
    color: "#8d1111",
    borderColor: "#f1b1b1",
  },
  pillMuted: {
    background: "#eef2f7",
    color: "#50627c",
    borderColor: "#cfd8e5",
  },
  formGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 10,
  },
  field: {
    display: "grid",
    gap: 6,
    fontSize: 13,
    color: "#2a3c57",
  },
  tableWrap: {
    overflowX: "auto",
    border: "1px solid #e5ebf4",
    borderRadius: 10,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
  },
  tableActionButton: {
    border: "1px solid #9db3cf",
    background: "#f8fbff",
    color: "#10253f",
    borderRadius: 7,
    padding: "4px 9px",
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 12,
  },
  th: {
    textAlign: "left",
    padding: "8px 10px",
    background: "#f3f7fc",
    borderBottom: "1px solid #e5ebf4",
    whiteSpace: "nowrap",
  },
  td: {
    padding: "8px 10px",
    borderBottom: "1px solid #eef2f7",
    whiteSpace: "nowrap",
    color: "#1f2f45",
  },
  paginationRow: {
    marginTop: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap",
  },
  paginationLabel: {
    color: "#42526a",
    fontSize: 13,
    fontWeight: 600,
  },
  drawerBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(15, 23, 42, 0.35)",
    display: "flex",
    justifyContent: "flex-end",
    zIndex: 1000,
  },
  drawer: {
    width: "min(760px, 100vw)",
    height: "100vh",
    overflowY: "auto",
    background: "#ffffff",
    borderLeft: "1px solid #d7dce4",
    boxShadow: "-12px 0 36px rgba(15, 23, 42, 0.12)",
    padding: 16,
    display: "grid",
    gap: 12,
  },
  drawerHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  drawerSection: {
    border: "1px solid #e5ebf4",
    borderRadius: 10,
    padding: 12,
    background: "#fbfdff",
  },
  drawerSectionTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: "#243850",
    marginBottom: 8,
  },
  drawerTxList: {
    maxHeight: 240,
    overflowY: "auto",
    border: "1px solid #e5ebf4",
    borderRadius: 8,
    background: "#fff",
    marginTop: 8,
  },
  drawerTxRow: {
    padding: "8px 10px",
    borderBottom: "1px solid #eef2f7",
  },
  drawerMono: {
    fontSize: 12,
    color: "#243850",
    wordBreak: "break-all",
  },
  summary: {
    cursor: "pointer",
    fontWeight: 600,
    color: "#21354f",
  },
  pre: {
    marginTop: 10,
    border: "1px solid #e5ebf4",
    background: "#f7f9fc",
    borderRadius: 10,
    padding: 10,
    fontSize: 12,
    overflowX: "auto",
  },
};
