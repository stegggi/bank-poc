import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { BrowserProvider, type Eip1193Provider } from "ethers";
import NavBar from "../shared/components/NavBar";

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
  trendEscapeEnabled: boolean;
  trendEscapeMinRegimeConfidence: number;
  trendEscapeDirectionLookbackSec: number;
  trendEscapeMinTrendMovePct: number;
  trendEscapeMinTrendConfirmSec: number;
  trendEscapeCooldownAfterEscapeSec: number;
  trendEscapeMinAlphaUsdToEscape: number;
  trendEscapeEmergencyOutOfRangeEdgePct: number;
  trendEscapeEmergencyMinOutOfRangeSec: number;
  trendEscapeUptrendHold: "WETH" | "USDC" | "50_50";
  trendEscapeDowntrendHold: "WETH" | "USDC" | "50_50";
  trendEscapeFallbackHold: "WETH" | "USDC" | "50_50";
  reEntryEnabled: boolean;
  reEntryMinRegimeConfidence: number;
  reEntryMinMeanRevertConfirmSec: number;
  reEntryMaxDistanceFromMuPct: number;
  reEntryMinHoldSec: number;
  reEntryCooldownAfterReEntrySec: number;
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
  trendEscape: {
    enabled: boolean;
    variant: "hybrid";
    requireRegimeLabel: "trending";
    minRegimeConfidence: number;
    directionLookbackSec: number;
    minTrendMovePct: number;
    minTrendConfirmSec: number;
    cooldownAfterEscapeSec: number;
    minAlphaUsdToEscape: number;
    emergencyOutOfRangeEdgePct: number;
    emergencyMinOutOfRangeSec: number;
    uptrendHold: "WETH" | "USDC" | "50_50";
    downtrendHold: "WETH" | "USDC" | "50_50";
    fallbackHold: "WETH" | "USDC" | "50_50";
  };
  reEntry: {
    enabled: boolean;
    requireRegimeLabel: "mean_reverting";
    minRegimeConfidence: number;
    minMeanRevertConfirmSec: number;
    maxDistanceFromMuPct: number;
    minHoldSec: number;
    cooldownAfterReEntrySec: number;
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
    targetBandHalfBps?: number;
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
    requiredFeesToBeatHodlUsd?: number;
    alphaVsHodlUsd?: number;
    netProfitUsd?: number;
    costToFeeRatio?: number;
    avgDeployedUsd?: number;
    feeApr?: number;
    alphaApr?: number;
    absoluteApr?: number;
    apr?: number;
  };
  activity?: {
    rebalances?: number;
    harvests?: number;
    swaps?: number;
    txCount?: number;
    closeGateBlockedCount?: number;
    closeGateOverrideReason?: string | null;
  };
  tx?: {
    openTxHashes?: string[];
    closeTxHashes?: string[];
    allTxHashes?: string[];
  };
  closeReason?: string | null;
  closeHoldTarget?: string | null;
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
    feeIsInferred?: boolean;
    variantLabel?: string | null;
    tickSpacingText?: string | null;
  };
  stats?: {
    tvlUsd?: number;
    tvlAvg7dUsd?: number;
    tvlAvg30dUsd?: number;
    tvlHistoryDays?: number;
    volAvg7dUsd?: number;
    volAvg30dUsd?: number;
    feesDay7dUsd?: number | null;
    feesDay30dUsd?: number | null;
    feePower7d?: number;
    feePower30d?: number;
    dailyRangePct7d?: number;
    volumeStability30d?: number;
    flowTrend?: number | null;
  };
  economics?: {
    expectedFeesDayUsd?: number | null;
    expectedCostsDayUsd?: number;
    expectedNetDayUsd?: number | null;
    expectedRebalancesPerDay?: number;
    expectedCostPerRebalanceUsd?: number;
    gasBaselineUsd?: number;
    rebalanceSwapNotionalPct?: number;
    finalScore?: number | null;
    scoreReason?: string | null;
  };
  scalability?: {
    scalable?: boolean;
    scalableByTvl?: boolean;
    scalableBySize?: boolean;
    tvlMinUsd?: number;
    maxRefCapitalPctOfTvl?: number;
    refCapitalPctOfTvl?: number;
  };
  compareToCurrent?: {
    rating?: "More" | "Similar" | "Less" | string;
    reason?: string;
    expectedNetDiffDayUsd?: number | null;
    switchCostUsd?: number;
    breakEvenDays?: number | null;
  };
};

type PoolComparisonStatus = {
  ok?: boolean;
  computedAtIso?: string | null;
  current?: PoolComparisonRow | null;
  top5?: PoolComparisonRow[];
  notRecommended?: PoolComparisonRow[];
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
    trendEscape?: {
      enabled?: boolean;
      variant?: string;
      requireRegimeLabel?: string;
      minRegimeConfidence?: number;
      directionLookbackSec?: number;
      minTrendMovePct?: number;
      minTrendConfirmSec?: number;
      cooldownAfterEscapeSec?: number;
      minAlphaUsdToEscape?: number;
      emergencyOutOfRangeEdgePct?: number;
      emergencyMinOutOfRangeSec?: number;
      uptrendHold?: "WETH" | "USDC" | "50_50";
      downtrendHold?: "WETH" | "USDC" | "50_50";
      fallbackHold?: "WETH" | "USDC" | "50_50";
    };
    reEntry?: {
      enabled?: boolean;
      requireRegimeLabel?: string;
      minRegimeConfidence?: number;
      minMeanRevertConfirmSec?: number;
      maxDistanceFromMuPct?: number;
      minHoldSec?: number;
      cooldownAfterReEntrySec?: number;
    };
    hodlGate?: {
      enabled?: boolean;
      marginUsd?: number;
      useUncollectedFees?: boolean;
      allowCloseIfOutOfRange?: boolean;
      outOfRangeMaxSec?: number;
      outOfRangeEmergencyEdgePct?: number;
    };
    executionCaps?: {
      maxInventorySwapsPerRebalance?: number;
      maxSwapsOnOpen?: number;
      maxTopUpsPerCycle?: number;
      minTopUpUsd?: number;
      targetRatioTolerancePct?: number;
      minSwapUsd?: number;
      useMulticallClose?: boolean;
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
      actualBandKey?: string;
      runs?: number;
      alphaBpsTotal?: number;
      winRate?: number;
      costBpsTotal?: number;
      avgTimeToRebalanceSec?: number | null;
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
  strategyMode?: "LP_ACTIVE" | "HOLD_WETH" | "HOLD_USDC" | "HOLD_50_50" | string;
  trend?: {
    movePct?: number | null;
    direction?: string;
    lookbackSec?: number;
    confirmSec?: number;
    meanRevertConfirmSec?: number;
    distanceFromMuPct?: number | null;
  };
  trendEscape?: {
    enabled?: boolean;
    eligible?: boolean;
    holdTargetIfEscape?: string | null;
    reasonIfBlocked?: string;
    cooldownUntilIso?: string | null;
  };
  reEntry?: {
    enabled?: boolean;
    eligible?: boolean;
    reasonIfBlocked?: string;
    meanRevertConfirmSec?: number;
    distanceFromMuPct?: number | null;
    eligibleAtIso?: string | null;
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
  hodlGate?: {
    enabled?: boolean;
    marginUsd?: number;
    alphaLiveUsd?: number;
    requiredFeesToBeatHodlLiveUsd?: number;
    outOfRangeDurationSec?: number;
    distanceBeyondEdgePct?: number;
    lastGateDecision?: {
      allowed?: boolean;
      reason?: string;
    };
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
      alphaVsHodlUsd?: number;
      realizedNetProfitUsd?: number;
      totalAssetValueTodayUsd?: number;
    };
    years?: Array<{
      year?: number;
      closedPositions?: number;
      feesCollectedUsd?: number;
      totalCostsUsd?: number;
      feesNetUsd?: number;
      capitalGainLossUsd?: number;
      alphaVsHodlUsd?: number;
      realizedNetProfitUsd?: number;
      assetValueStartUsd?: number | null;
      assetValueTodayUsd?: number | null;
      ytdPct?: number | null;
      firstOpenedAtIso?: string | null;
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
    minRebalanceIntervalSec: 7200,
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
    compoundMode: "threshold_harvest",
    harvestThresholdUsd: 0.2,
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
    trendEscapeEnabled: true,
    trendEscapeMinRegimeConfidence: 0.6,
    trendEscapeDirectionLookbackSec: 600,
    trendEscapeMinTrendMovePct: 0.004,
    trendEscapeMinTrendConfirmSec: 120,
    trendEscapeCooldownAfterEscapeSec: 3600,
    trendEscapeMinAlphaUsdToEscape: 0,
    trendEscapeEmergencyOutOfRangeEdgePct: 1.15,
    trendEscapeEmergencyMinOutOfRangeSec: 120,
    trendEscapeUptrendHold: "WETH",
    trendEscapeDowntrendHold: "USDC",
    trendEscapeFallbackHold: "50_50",
    reEntryEnabled: true,
    reEntryMinRegimeConfidence: 0.6,
    reEntryMinMeanRevertConfirmSec: 300,
    reEntryMaxDistanceFromMuPct: 0.006,
    reEntryMinHoldSec: 900,
    reEntryCooldownAfterReEntrySec: 1800,
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
  const trendEscape = settings.trendEscape || {};
  const reEntry = settings.reEntry || {};

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
    trendEscapeEnabled: Boolean(trendEscape.enabled ?? d.trendEscapeEnabled),
    trendEscapeMinRegimeConfidence: n(trendEscape.minRegimeConfidence, d.trendEscapeMinRegimeConfidence),
    trendEscapeDirectionLookbackSec: n(trendEscape.directionLookbackSec, d.trendEscapeDirectionLookbackSec),
    trendEscapeMinTrendMovePct: n(trendEscape.minTrendMovePct, d.trendEscapeMinTrendMovePct),
    trendEscapeMinTrendConfirmSec: n(trendEscape.minTrendConfirmSec, d.trendEscapeMinTrendConfirmSec),
    trendEscapeCooldownAfterEscapeSec: n(trendEscape.cooldownAfterEscapeSec, d.trendEscapeCooldownAfterEscapeSec),
    trendEscapeMinAlphaUsdToEscape: n(trendEscape.minAlphaUsdToEscape, d.trendEscapeMinAlphaUsdToEscape),
    trendEscapeEmergencyOutOfRangeEdgePct: n(
      trendEscape.emergencyOutOfRangeEdgePct,
      d.trendEscapeEmergencyOutOfRangeEdgePct
    ),
    trendEscapeEmergencyMinOutOfRangeSec: n(
      trendEscape.emergencyMinOutOfRangeSec,
      d.trendEscapeEmergencyMinOutOfRangeSec
    ),
    trendEscapeUptrendHold:
      trendEscape.uptrendHold === "USDC"
        ? "USDC"
        : trendEscape.uptrendHold === "50_50"
          ? "50_50"
          : d.trendEscapeUptrendHold,
    trendEscapeDowntrendHold:
      trendEscape.downtrendHold === "WETH"
        ? "WETH"
        : trendEscape.downtrendHold === "50_50"
          ? "50_50"
          : d.trendEscapeDowntrendHold,
    trendEscapeFallbackHold:
      trendEscape.fallbackHold === "WETH"
        ? "WETH"
        : trendEscape.fallbackHold === "USDC"
          ? "USDC"
          : d.trendEscapeFallbackHold,
    reEntryEnabled: Boolean(reEntry.enabled ?? d.reEntryEnabled),
    reEntryMinRegimeConfidence: n(reEntry.minRegimeConfidence, d.reEntryMinRegimeConfidence),
    reEntryMinMeanRevertConfirmSec: n(reEntry.minMeanRevertConfirmSec, d.reEntryMinMeanRevertConfirmSec),
    reEntryMaxDistanceFromMuPct: n(reEntry.maxDistanceFromMuPct, d.reEntryMaxDistanceFromMuPct),
    reEntryMinHoldSec: n(reEntry.minHoldSec, d.reEntryMinHoldSec),
    reEntryCooldownAfterReEntrySec: n(reEntry.cooldownAfterReEntrySec, d.reEntryCooldownAfterReEntrySec),
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
    trendEscape: {
      enabled: draft.trendEscapeEnabled,
      variant: "hybrid",
      requireRegimeLabel: "trending",
      minRegimeConfidence: draft.trendEscapeMinRegimeConfidence,
      directionLookbackSec: draft.trendEscapeDirectionLookbackSec,
      minTrendMovePct: draft.trendEscapeMinTrendMovePct,
      minTrendConfirmSec: draft.trendEscapeMinTrendConfirmSec,
      cooldownAfterEscapeSec: draft.trendEscapeCooldownAfterEscapeSec,
      minAlphaUsdToEscape: draft.trendEscapeMinAlphaUsdToEscape,
      emergencyOutOfRangeEdgePct: draft.trendEscapeEmergencyOutOfRangeEdgePct,
      emergencyMinOutOfRangeSec: draft.trendEscapeEmergencyMinOutOfRangeSec,
      uptrendHold: draft.trendEscapeUptrendHold,
      downtrendHold: draft.trendEscapeDowntrendHold,
      fallbackHold: draft.trendEscapeFallbackHold,
    },
    reEntry: {
      enabled: draft.reEntryEnabled,
      requireRegimeLabel: "mean_reverting",
      minRegimeConfidence: draft.reEntryMinRegimeConfidence,
      minMeanRevertConfirmSec: draft.reEntryMinMeanRevertConfirmSec,
      maxDistanceFromMuPct: draft.reEntryMaxDistanceFromMuPct,
      minHoldSec: draft.reEntryMinHoldSec,
      cooldownAfterReEntrySec: draft.reEntryCooldownAfterReEntrySec,
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

function fmtSignedPct(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "—";
  const n = Number(v);
  if (n === 0) return "0.00%";
  const abs = Math.abs(n);
  return `${n < 0 ? "-" : "+"}${fmtNum(abs, digits)}%`;
}

function fmtRatioPct(ratio: number | null | undefined): string {
  if (ratio == null || Number.isNaN(ratio)) return "—";
  return fmtPct(Number(ratio) * 100, 2);
}

function fmtBps(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${fmtNum(v, digits)} bps`;
}

function bandConfidence(runs: number | null | undefined): { label: string; tone: "good" | "warn" | "muted" } {
  const nRuns = Math.max(0, Math.round(Number(runs || 0)));
  if (nRuns >= 20) return { label: "High", tone: "good" };
  if (nRuns >= 8) return { label: "Medium", tone: "warn" };
  return { label: "Low", tone: "muted" };
}

function fmtSpotPrice(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return fmtUsd(n);
}

function fmtDays(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v) || !Number.isFinite(Number(v))) return "—";
  const x = Number(v);
  if (x < 0) return "—";
  if (x === 0) return "0.0d";
  if (x > 9999) return ">9999d";
  return `${fmtNum(x, x < 10 ? 1 : 0)}d`;
}

function fmtPctOrDash(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v) || !Number.isFinite(Number(v))) return "—";
  return fmtPct(Number(v) * 100, digits);
}

function poolComparisonSelectorLabel(row?: PoolComparisonRow | null): string {
  const feeRate = row?.selector?.feeRate;
  const selectorType = String(row?.selector?.type || "unknown");
  const selectorValue = row?.selector?.value;
  const feePct =
    Number.isFinite(Number(feeRate)) && Number(feeRate) > 0
      ? `${fmtNum(Number(feeRate) * 100, 4)}%${row?.selector?.feeIsInferred ? " (inferred)" : ""}`
      : "Unknown fee";
  if (selectorType === "feeTier" && Number.isFinite(Number(selectorValue))) {
    return `${feePct} (tier ${Number(selectorValue)})`;
  }
  if (selectorType === "tickSpacing") {
    const tickText = row?.selector?.tickSpacingText || (Number.isFinite(Number(selectorValue)) ? String(Number(selectorValue)) : null);
    if (tickText) return `${feePct} (tickSpacing ${tickText})`;
  }
  return feePct;
}

function pairLabel(row?: PoolComparisonRow | null): string {
  const pair = row?.pair;
  if (!pair) return "—";
  return pair.pairKey || `${pair.baseSymbol || "?"}/${pair.quoteSymbol || "?"}`;
}

function poolLink(row?: PoolComparisonRow | null): string | null {
  const raw = String(row?.pool?.address || "").trim();
  if (!raw) return null;
  const poolId = raw.toLowerCase().startsWith("base_") ? raw.slice(5) : raw;
  return `https://www.geckoterminal.com/base/pools/${encodeURIComponent(poolId)}`;
}

function ratingTone(rating?: string): "good" | "warn" | "bad" | "muted" {
  if (!rating) return "muted";
  if (rating === "More") return "good";
  if (rating === "Similar") return "warn";
  if (rating === "Less") return "bad";
  return "muted";
}

function poolVariantLabel(row?: PoolComparisonRow | null): string {
  return String(row?.selector?.variantLabel || "—");
}

function poolScalabilityLabel(row?: PoolComparisonRow | null): string {
  if (row?.scalability?.scalable) return "OK scalable";
  if (row?.scalability?.scalableByTvl === false) return "Warn low_tvl";
  if (row?.scalability?.scalableBySize === false) return "Warn too_large_for_pool";
  return "unknown";
}

function poolScalabilityTone(row?: PoolComparisonRow | null): "good" | "warn" | "muted" {
  if (row?.scalability?.scalable) return "good";
  if (row?.scalability?.scalableByTvl === false || row?.scalability?.scalableBySize === false) return "warn";
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
  const hasActiveLpPosition = Boolean(status?.position?.tokenId);
  const inRange = hasActiveLpPosition && Boolean(status?.position?.inRange);
  const cooldownRemaining = Number(status?.ops?.cooldownRemainingSec || 0);
  const configuredBandHalfPct = n(status?.settings?.bandHalfBps, 0) / 100;
  const actualBandHalfPct = actualBandHalfPctFromTicks(status?.position?.tickLower, status?.position?.tickUpper);
  const edgeDistPct = hasActiveLpPosition ? n(status?.position?.distanceToEdge?.pct, 0) * 100 : null;
  const churnRatio = status?.ops?.churnRatioToday;
  const activeLpCount = Number(status?.ops?.positionInventory?.activeCount || 0);
  const hasMultipleActive = activeLpCount > 1;
  const aggregateLpUsd = n(status?.ops?.positionInventory?.totalUsdValue, 0);
  const selectorLabel = selectorHumanLabel(status?.market?.selector, status?.market?.venueActive);
  const bandPerformanceRows = (status?.analytics?.bandPerformance || []).map((row) => [
    row.actualBandKey || `±${fmtPct(row.bandHalfPct)}`,
    (() => {
      const runs = Math.round(n(row.runs, 0));
      const confidence = bandConfidence(runs);
      return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span>{String(runs)}</span>
          <Pill label={confidence.label} tone={confidence.tone} />
        </span>
      );
    })(),
    fmtBps(row.alphaBpsTotal),
    fmtPct(n(row.winRate, 0) * 100),
    fmtBps(row.costBpsTotal),
    fmtDurationCompact(row.avgTimeToRebalanceSec),
  ]);
  const activeLifecycleRecord = status?.activePositionRecord || null;
  const positionsTaxSummary = status?.positionsTaxSummary || null;
  const poolComparison = status?.poolComparison || null;
  const poolComparisonCurrent = poolComparison?.current || null;
  const poolComparisonTop5 = poolComparison?.top5 || [];
  const poolComparisonNotRecommended = poolComparison?.notRecommended || [];
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
  const hodlGateView = status?.hodlGate || null;
  const hodlGateAllowed = hodlGateView?.lastGateDecision?.allowed !== false;
  const hodlGateReason = String(hodlGateView?.lastGateDecision?.reason || "—");
  const alphaLiveUsd = n(hodlGateView?.alphaLiveUsd, 0);
  const requiredFeesToBeatHodlLiveUsd = n(hodlGateView?.requiredFeesToBeatHodlLiveUsd, 0);
  const strategyMode = status?.strategyMode || "LP_ACTIVE";
  const isHoldMode = strategyMode !== "LP_ACTIVE";
  const trendView = status?.trend || null;
  const trendEscapeView = status?.trendEscape || null;
  const reEntryView = status?.reEntry || null;
  const trendMovePct = trendView?.movePct == null ? null : n(trendView.movePct, 0) * 100;
  const collectableNowUsd = n(status?.fees?.collectableNow?.usd, 0);
  const collectableNowEstimated = Boolean(status?.fees?.collectableNow?.isEstimated);
  const activeMintTargetBandBpsRaw = activeLifecycleRecord?.band?.bandHalfBps;
  const activeMintTargetBandBps = Number.isFinite(Number(activeMintTargetBandBpsRaw))
    ? Math.round(Number(activeMintTargetBandBpsRaw))
    : null;
  const regimeEffectiveBandAtMintBpsRaw = activeLifecycleRecord?.band?.targetBandHalfBps;
  const regimeEffectiveBandAtMintBps = Number.isFinite(Number(regimeEffectiveBandAtMintBpsRaw))
    ? Math.round(Number(regimeEffectiveBandAtMintBpsRaw))
    : activeMintTargetBandBps;
  const lpValueUsd = n(status?.position?.amountsInLP?.usdValue, 0);
  const lpUsdcSideUsd = n(status?.position?.amountsInLP?.sideUsd?.usdc, 0);
  const lpWethSideUsd = n(status?.position?.amountsInLP?.sideUsd?.weth, 0);
  const lpSplitUsdcPct = lpValueUsd > 0 ? (lpUsdcSideUsd / lpValueUsd) * 100 : 0;
  const lpSplitWethPct = lpValueUsd > 0 ? (lpWethSideUsd / lpValueUsd) * 100 : 0;
  const activePairLabel = `${activeLifecycleRecord?.pair?.base || status?.market?.pair?.base || "WETH"}/${activeLifecycleRecord?.pair?.quote || status?.market?.pair?.quote || "USDC"}`;
  const activeBandTicksLabel = `${String(status?.position?.tickLower ?? "—")} .. ${String(status?.position?.tickUpper ?? "—")}`;
  const holdTargetLabel =
    strategyMode === "HOLD_WETH"
      ? "WETH"
      : strategyMode === "HOLD_USDC"
        ? "USDC"
        : strategyMode === "HOLD_50_50"
          ? "50/50"
          : "—";
  const holdInventoryValueUsd =
    strategyMode === "HOLD_WETH"
      ? n(status?.wallet?.valuesUsd?.weth, 0)
      : strategyMode === "HOLD_USDC"
        ? n(status?.wallet?.valuesUsd?.usdc, 0)
        : strategyMode === "HOLD_50_50"
          ? n(status?.wallet?.valuesUsd?.usdc, 0) + n(status?.wallet?.valuesUsd?.weth, 0)
          : 0;
  const distanceFromMuPctDisplay = (
    reEntryView?.distanceFromMuPct != null
      ? n(reEntryView.distanceFromMuPct, 0) * 100
      : trendView?.distanceFromMuPct != null
        ? n(trendView.distanceFromMuPct, 0) * 100
        : null
  );
  const activeCloseGateLabel = (
    <span title={hodlGateReason}>
      <Pill label={hodlGateAllowed ? "Allowed" : "Blocked"} tone={hodlGateAllowed ? "good" : "bad"} />{" "}
      {hodlGateReason}
    </span>
  );
  const poolComparisonCurrentRow = poolComparisonCurrent
    ? ([
        poolComparisonCurrent.dex?.name || "—",
        `${poolComparison?.network?.name || "Base"} (${poolComparisonCurrent.chain?.chainId || BASE_CHAIN_ID_DEC})`,
        (() => {
          const href = poolLink(poolComparisonCurrent);
          const label = pairLabel(poolComparisonCurrent);
          const addr = shortAddr(poolComparisonCurrent.pool?.address || "");
          const content = (
            <span>
              {label}
              {addr !== "—" ? ` (${addr})` : ""}
            </span>
          );
          if (!href) return content;
          return (
            <a href={href} target="_blank" rel="noreferrer noopener" style={styles.link}>
              {content}
            </a>
          );
        })(),
        poolVariantLabel(poolComparisonCurrent),
        <span title={poolComparisonCurrent.selector?.feeIsInferred ? "Fee tier inferred from GeckoTerminal metadata/text." : "Fee tier unavailable from GeckoTerminal metadata."}>
          {poolComparisonSelectorLabel(poolComparisonCurrent)}
        </span>,
        `${fmtUsdCompact(poolComparisonCurrent.stats?.tvlAvg7dUsd)} / ${fmtUsdCompact(poolComparisonCurrent.stats?.tvlAvg30dUsd)}`,
        `${fmtUsdCompact(poolComparisonCurrent.stats?.volAvg7dUsd)} / ${fmtUsdCompact(poolComparisonCurrent.stats?.volAvg30dUsd)}`,
        `${fmtUsdCompact(poolComparisonCurrent.stats?.feesDay7dUsd)} / ${fmtUsdCompact(poolComparisonCurrent.stats?.feesDay30dUsd)}`,
        <Pill label={poolScalabilityLabel(poolComparisonCurrent)} tone={poolScalabilityTone(poolComparisonCurrent)} />,
        <span title="Approx fee/day per $TVL = avgVolume * feeRate / avgTVL">
          {`${fmtPctOrDash(poolComparisonCurrent.stats?.feePower7d, 3)} / ${fmtPctOrDash(
            poolComparisonCurrent.stats?.feePower30d,
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
    (() => {
      const href = poolLink(row);
      const label = pairLabel(row);
      const addr = shortAddr(row.pool?.address || "");
      const content = (
        <span>
          {label}
          {addr !== "—" ? ` (${addr})` : ""}
        </span>
      );
      if (!href) return content;
      return (
        <a href={href} target="_blank" rel="noreferrer noopener" style={styles.link}>
          {content}
        </a>
      );
    })(),
    poolVariantLabel(row),
    <span title={row.selector?.feeIsInferred ? "Fee tier inferred from GeckoTerminal metadata/text." : "Fee tier unavailable from GeckoTerminal metadata."}>
      {poolComparisonSelectorLabel(row)}
    </span>,
    `${fmtUsdCompact(row.stats?.tvlAvg7dUsd)} / ${fmtUsdCompact(row.stats?.tvlAvg30dUsd)}`,
    `${fmtUsdCompact(row.stats?.volAvg7dUsd)} / ${fmtUsdCompact(row.stats?.volAvg30dUsd)}`,
    `${fmtUsdCompact(row.stats?.feesDay7dUsd)} / ${fmtUsdCompact(row.stats?.feesDay30dUsd)}`,
    <Pill label={poolScalabilityLabel(row)} tone={poolScalabilityTone(row)} />,
    <span title="Approx fee/day per $TVL = avgVolume * feeRate / avgTVL">
      {`${fmtPctOrDash(row.stats?.feePower7d, 3)} / ${fmtPctOrDash(row.stats?.feePower30d, 3)}`}
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
  const poolComparisonNotRecommendedRows = poolComparisonNotRecommended.map((row) => [
    row.dex?.name || "—",
    (() => {
      const href = poolLink(row);
      const label = `${pairLabel(row)} (${String(row.pool?.address || "").slice(0, 8)}...)`;
      if (!href) return label;
      return (
        <a href={href} target="_blank" rel="noreferrer noopener" style={styles.link}>
          {label}
        </a>
      );
    })(),
    poolVariantLabel(row),
    poolComparisonSelectorLabel(row),
    `${fmtUsdCompact(row.stats?.tvlAvg7dUsd)} / ${fmtUsdCompact(row.stats?.tvlAvg30dUsd)}`,
    `${fmtUsdCompact(row.stats?.feesDay7dUsd)} / ${fmtUsdCompact(row.stats?.feesDay30dUsd)}`,
    <Pill label={poolScalabilityLabel(row)} tone={poolScalabilityTone(row)} />,
    row.compareToCurrent?.reason || "—",
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
          <Card title="Strategy Overview" fullWidth>
            <div style={styles.overviewHero}>
              <div>
                <div style={styles.overviewEyebrow}>UC6 live operating picture</div>
                <div style={styles.overviewHeadline}>
                  {`${status?.market?.pair?.base || "WETH"}/${status?.market?.pair?.quote || "USDC"} on ${status?.market?.venueActive || "—"}`}
                </div>
                <div style={styles.overviewSubhead}>
                  Market, capital allocation, regime state, and trend-escape gating in one place. All values are current cached bot state.
                </div>
              </div>
              <CompactMetricList
                items={[
                  { label: "Spot Price", value: fmtUsd(status?.market?.spotPrice?.usdcPerWeth) },
                  {
                    label: "Strategy Mode",
                    value: <Pill label={String(strategyMode)} tone={strategyMode === "LP_ACTIVE" ? "good" : "warn"} />,
                  },
                  {
                    label: "Regime Label",
                    value: (
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
                    ),
                  },
                  {
                    label: "Alpha Live",
                    value: (
                      <span style={{ color: alphaLiveUsd >= 0 ? "#145b2f" : "#8d1111", fontWeight: 700 }}>
                        {fmtSignedUsd(alphaLiveUsd)}
                      </span>
                    ),
                  },
                  {
                    label: "Close Gate",
                    value: (
                      <span title={hodlGateReason}>
                        <Pill label={hodlGateAllowed ? "Allowed" : "Blocked"} tone={hodlGateAllowed ? "good" : "bad"} />
                      </span>
                    ),
                  },
                  {
                    label: "Next Action",
                    value: `${String(decision.action || "monitor")} (${String(decision.reason || "n/a")})`,
                  },
                ]}
                dense
              />
            </div>

            <div style={styles.overviewSectionGrid}>
              <div style={styles.overviewBlock}>
                <div style={styles.overviewBlockHeader}>
                  <div style={styles.overviewBlockTitle}>Liquidity Pool Overview</div>
                  <div style={styles.overviewBlockSubtle}>Market, venue, connectivity, and trading cadence.</div>
                </div>
                <CompactMetricList
                  items={[
                    { label: "Pair", value: `${status?.market?.pair?.base || "WETH"}/${status?.market?.pair?.quote || "USDC"}` },
                    { label: "Spot Price", value: fmtUsd(status?.market?.spotPrice?.usdcPerWeth) },
                    { label: "Price Updated", value: status?.market?.spotPrice?.updatedAtIso || "—" },
                    { label: "Venue Active", value: status?.market?.venueActive || "—" },
                    { label: "Chain", value: `${status?.market?.chain?.name || "Base"} (${status?.market?.chain?.chainId || BASE_CHAIN_ID_DEC})` },
                    { label: "Total LP (All NFTs)", value: fmtUsd(aggregateLpUsd) },
                    { label: "Active LP NFTs", value: String(activeLpCount || 0) },
                    {
                      label: "Time In Range",
                      value: status?.ops?.timeInRange?.pct == null ? "—" : fmtPct(n(status?.ops?.timeInRange?.pct, 0) * 100),
                    },
                    { label: "Time In Range Since", value: status?.ops?.timeInRange?.sinceIso || "—" },
                    {
                      label: "Cooldown Remaining",
                      value: <Pill label={cooldownRemaining > 0 ? `${cooldownRemaining}s` : "ready"} tone={cooldownRemaining > 0 ? "warn" : "good"} />,
                    },
                    { label: "Min Rebalance Interval", value: `${String(status?.settings?.minRebalanceIntervalSec ?? "—")}s` },
                    { label: "HTTP Provider", value: status?.providers?.http?.active || "—" },
                    {
                      label: "WS Provider",
                      value: status?.providers?.ws?.enabled
                        ? `${status?.providers?.ws?.active || "—"} (${status?.providers?.ws?.connected ? "connected" : "disconnected"})`
                        : "disabled",
                    },
                    {
                      label: "Last Head",
                      value: status?.providers?.ws?.lastHeadBlock != null ? String(status.providers?.ws?.lastHeadBlock) : "—",
                    },
                    { label: "Head Seen", value: status?.providers?.ws?.lastHeadAtIso || "—" },
                    { label: "Dashboard Poll", value: `${statusPollMs}ms` },
                  ]}
                  dense
                />
              </div>

              <div style={styles.overviewBlock}>
                <div style={styles.overviewBlockHeader}>
                  <div style={styles.overviewBlockTitle}>Wallet & Allocation</div>
                  <div style={styles.overviewBlockSubtle}>Idle capital, deployed value, and gas wallet capacity.</div>
                </div>
                <CompactMetricList
                  items={[
                    { label: "Wallet Total", value: fmtUsd(status?.wallet?.valuesUsd?.total) },
                    { label: "LP Deployed", value: fmtUsd(status?.wallet?.allocationUsd?.lpDeployed) },
                    { label: "Idle Value", value: fmtUsd(status?.wallet?.allocationUsd?.idle) },
                    { label: "Reserve Target", value: fmtUsd(status?.wallet?.allocationUsd?.reserveTarget) },
                    { label: "% Deployed", value: fmtPct(status?.wallet?.deployedPct) },
                    { label: "% Idle", value: fmtPct(100 - n(status?.wallet?.deployedPct, 0)) },
                    { label: "USDC", value: `${fmtNum(status?.wallet?.balances?.usdc, 4)} (${fmtUsd(status?.wallet?.valuesUsd?.usdc)})` },
                    { label: "WETH", value: `${fmtNum(status?.wallet?.balances?.weth, 6)} (${fmtUsd(status?.wallet?.valuesUsd?.weth)})` },
                    { label: "ETH (Gas)", value: `${fmtNum(status?.wallet?.balances?.eth, 6)} (${fmtUsd(status?.wallet?.valuesUsd?.eth)})` },
                  ]}
                  dense
                />
              </div>

              <div style={styles.overviewBlock}>
                <div style={styles.overviewBlockHeader}>
                  <div style={styles.overviewBlockTitle}>Regime</div>
                  <div style={styles.overviewBlockSubtle}>OU half-life classification and effective LP thresholds.</div>
                </div>
                <CompactMetricList
                  items={[
                    {
                      label: "Regime Engine",
                      value: <Pill label={status?.settings?.regime?.enabled ? "ON" : "OFF"} tone={status?.settings?.regime?.enabled ? "good" : "muted"} />,
                    },
                    {
                      label: "Label",
                      value: (
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
                      ),
                    },
                    { label: "Confidence", value: regimeConfidencePct == null ? "—" : fmtPct(regimeConfidencePct) },
                    { label: "Half-life", value: regimeHalfLifeLabel },
                    { label: "Advice", value: String(regimeDecisionView?.adviceReason || "—") },
                    {
                      label: "Wait Recommended",
                      value: <Pill label={regimeDecisionView?.waitRecommended ? "yes" : "no"} tone={regimeDecisionView?.waitRecommended ? "warn" : "muted"} />,
                    },
                    { label: "Edge Threshold", value: `${fmtPct(regimeBaseEdgePct)} → ${fmtPct(regimeEffectiveEdgePct)}` },
                    { label: "Cooldown", value: `${Math.round(regimeBaseCooldown)}s → ${Math.round(regimeEffectiveCooldown)}s` },
                    { label: "Band Target", value: `±${fmtPct(regimeBaseBandBps / 100)} → ±${fmtPct(regimeEffectiveBandBps / 100)}` },
                    {
                      label: "Samples",
                      value: `${String(regimeStatus?.sampleCount ?? 0)} / ${String(regimeStatus?.windowSec ?? status?.settings?.regime?.windowSec ?? "—")}s`,
                    },
                    { label: "Updated", value: regimeStatus?.updatedAtIso || "—" },
                  ]}
                  dense
                />
                <div style={styles.note}>
                  Regime uses OU half-life heuristics on cached tick samples only (no extra RPC reads). Effective thresholds apply per decision and do not overwrite stored settings.
                </div>
              </div>

              <div style={styles.overviewBlock}>
                <div style={styles.overviewBlockHeader}>
                  <div style={styles.overviewBlockTitle}>Trend Escape</div>
                  <div style={styles.overviewBlockSubtle}>Hybrid hold-state gating for trend exits and mean-reversion re-entry.</div>
                </div>
                <CompactMetricList
                  items={[
                    {
                      label: "Mode",
                      value: <Pill label={String(strategyMode)} tone={strategyMode === "LP_ACTIVE" ? "good" : "warn"} />,
                    },
                    {
                      label: "Escape Eligible",
                      value: <Pill label={trendEscapeView?.eligible ? "yes" : "no"} tone={trendEscapeView?.eligible ? "warn" : "muted"} />,
                    },
                    { label: "Escape Block Reason", value: String(trendEscapeView?.reasonIfBlocked || "—") },
                    { label: "Escape Hold Target", value: String(trendEscapeView?.holdTargetIfEscape || "—") },
                    {
                      label: "Re-entry Eligible",
                      value: <Pill label={reEntryView?.eligible ? "yes" : "no"} tone={reEntryView?.eligible ? "good" : "muted"} />,
                    },
                    { label: "Re-entry Block Reason", value: String(reEntryView?.reasonIfBlocked || "—") },
                    { label: "Re-entry Eligible At", value: fmtIsoLocal(reEntryView?.eligibleAtIso) },
                    { label: "Escape Cooldown Until", value: fmtIsoLocal(trendEscapeView?.cooldownUntilIso) },
                    { label: "Trend Direction", value: String(trendView?.direction || "flat") },
                    { label: "Move Over Lookback", value: trendMovePct == null ? "—" : fmtSignedPct(trendMovePct) },
                    { label: "Lookback", value: `${String(trendView?.lookbackSec ?? "—")}s` },
                    { label: "Trend Confirm", value: `${String(trendView?.confirmSec ?? 0)}s` },
                    { label: "Mean-Revert Confirm", value: `${String(trendView?.meanRevertConfirmSec ?? 0)}s` },
                    {
                      label: "Distance From Mu",
                      value: trendView?.distanceFromMuPct == null ? "—" : fmtPct(n(trendView.distanceFromMuPct, 0) * 100),
                    },
                    { label: "Alpha Live", value: fmtSignedUsd(alphaLiveUsd) },
                    { label: "Escape Alpha Min", value: fmtSignedUsd(status?.settings?.trendEscape?.minAlphaUsdToEscape) },
                  ]}
                  dense
                />
                <div style={styles.note}>
                  In trending regimes the bot can close LP and hold inventory directionally. Re-entry requires sustained mean reversion and price proximity to regime mu.
                </div>
              </div>
            </div>
          </Card>

          <Card title={isHoldMode ? "Hold State & Re-entry" : "LP Position Composition"} fullWidth wideViewport>
            {isOwner && hasActiveLpPosition && (
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
            {isHoldMode ? (
              <>
                <div style={styles.lpHero}>
                  <div>
                    <div style={styles.overviewEyebrow}>Hold-state snapshot</div>
                    <div style={styles.lpHeadline}>
                      {`${String(strategyMode)} · ${holdTargetLabel}`}
                    </div>
                    <div style={styles.lpSubhead}>
                      Liquidity is currently withdrawn. This view focuses on hold inventory, regime state, and the re-entry gates that must clear before the bot mints again.
                    </div>
                  </div>
                  <CompactMetricList
                    items={[
                      { label: "Strategy Mode", value: <Pill label={String(strategyMode)} tone="warn" /> },
                      { label: "Hold Target", value: holdTargetLabel },
                      { label: "Hold Inventory Value", value: fmtUsd(holdInventoryValueUsd) },
                      {
                        label: "Re-entry Eligible",
                        value: <Pill label={reEntryView?.eligible ? "Yes" : "No"} tone={reEntryView?.eligible ? "good" : "muted"} />,
                      },
                      { label: "Re-entry Block", value: String(reEntryView?.reasonIfBlocked || "—") },
                      { label: "Eligible At", value: fmtIsoLocal(reEntryView?.eligibleAtIso) },
                    ]}
                    dense
                  />
                </div>

                <div style={styles.lpSectionGrid}>
                  <div style={styles.overviewBlock}>
                    <div style={styles.overviewBlockHeader}>
                      <div style={styles.overviewBlockTitle}>Hold Inventory</div>
                      <div style={styles.overviewBlockSubtle}>Wallet composition that will fund the next re-entry.</div>
                    </div>
                    <CompactMetricList
                      items={[
                        { label: "Wallet Total", value: fmtUsd(status?.wallet?.valuesUsd?.total) },
                        { label: "USDC", value: `${fmtNum(status?.wallet?.balances?.usdc, 4)} (${fmtUsd(status?.wallet?.valuesUsd?.usdc)})` },
                        { label: "WETH", value: `${fmtNum(status?.wallet?.balances?.weth, 6)} (${fmtUsd(status?.wallet?.valuesUsd?.weth)})` },
                        { label: "ETH (Gas)", value: `${fmtNum(status?.wallet?.balances?.eth, 6)} (${fmtUsd(status?.wallet?.valuesUsd?.eth)})` },
                        { label: "Reserve Target", value: fmtUsd(status?.settings?.reservePolicy?.effectiveTargetUsdc) },
                        { label: "Collectable Now", value: "—" },
                      ]}
                      dense
                    />
                  </div>

                  <div style={styles.overviewBlock}>
                    <div style={styles.overviewBlockHeader}>
                      <div style={styles.overviewBlockTitle}>Re-entry Gate</div>
                      <div style={styles.overviewBlockSubtle}>The exact conditions that control when LP can be re-opened.</div>
                    </div>
                    <CompactMetricList
                      items={[
                        { label: "Re-entry Eligible", value: <Pill label={reEntryView?.eligible ? "Yes" : "No"} tone={reEntryView?.eligible ? "good" : "muted"} /> },
                        { label: "Block Reason", value: String(reEntryView?.reasonIfBlocked || "—") },
                        { label: "Eligible At", value: fmtIsoLocal(reEntryView?.eligibleAtIso) },
                        { label: "Escape Cooldown Until", value: fmtIsoLocal(trendEscapeView?.cooldownUntilIso) },
                        { label: "Mean-Revert Confirm", value: `${String(trendView?.meanRevertConfirmSec ?? 0)}s` },
                        { label: "Distance From Mu", value: distanceFromMuPctDisplay == null ? "—" : fmtPct(distanceFromMuPctDisplay) },
                        { label: "Max Distance To Re-enter", value: fmtPct(n(status?.settings?.reEntry?.maxDistanceFromMuPct, 0) * 100) },
                        { label: "Min Hold", value: `${String(status?.settings?.reEntry?.minHoldSec ?? "—")}s` },
                      ]}
                      dense
                    />
                  </div>

                  <div style={styles.overviewBlock}>
                    <div style={styles.overviewBlockHeader}>
                      <div style={styles.overviewBlockTitle}>Market & Regime</div>
                      <div style={styles.overviewBlockSubtle}>Current price action and the regime state used to unlock re-entry.</div>
                    </div>
                    <CompactMetricList
                      items={[
                        { label: "Spot Price", value: fmtUsd(status?.market?.spotPrice?.usdcPerWeth) },
                        {
                          label: "Regime Label",
                          value: (
                            <Pill
                              label={String(regimeStatus?.label || "unknown")}
                              tone={
                                regimeStatus?.label === "mean_reverting"
                                  ? "good"
                                  : regimeStatus?.label === "trending"
                                    ? "warn"
                                    : "muted"
                              }
                            />
                          ),
                        },
                        { label: "Confidence", value: regimeConfidencePct == null ? "—" : fmtPct(regimeConfidencePct) },
                        { label: "Half-life", value: regimeHalfLifeLabel },
                        { label: "Trend Direction", value: String(trendView?.direction || "flat") },
                        { label: "Move Over Lookback", value: trendMovePct == null ? "—" : fmtSignedPct(trendMovePct) },
                        { label: "Lookback", value: `${String(trendView?.lookbackSec ?? "—")}s` },
                        { label: "Trend Confirm", value: `${String(trendView?.confirmSec ?? 0)}s` },
                      ]}
                      dense
                    />
                  </div>

                  <div style={styles.overviewBlock}>
                    <div style={styles.overviewBlockHeader}>
                      <div style={styles.overviewBlockTitle}>Economics & Protection</div>
                      <div style={styles.overviewBlockSubtle}>Live alpha protection, HODL benchmark context, and the most recent LP record.</div>
                    </div>
                    <CompactMetricList
                      items={[
                        { label: "Alpha Live", value: fmtSignedUsd(alphaLiveUsd) },
                        { label: "Required Fees To Beat HODL", value: fmtUsd(requiredFeesToBeatHodlLiveUsd) },
                        { label: "Last Closed Reason", value: closedPositionRecords[0]?.closeReason || activeLifecycleRecord?.closeReason || "—" },
                        { label: "Last Hold Target", value: closedPositionRecords[0]?.closeHoldTarget || "—" },
                        { label: "Close Gate", value: activeCloseGateLabel },
                        { label: "Latest LP P/L", value: fmtSignedUsd(closedPositionRecords[0]?.performance?.netProfitUsd) },
                      ]}
                      dense
                    />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div style={styles.lpHero}>
                  <div>
                    <div style={styles.overviewEyebrow}>Active LP snapshot</div>
                    <div style={styles.lpHeadline}>
                      {hasActiveLpPosition
                        ? `${activePairLabel} · ${String(status?.position?.tokenId)}`
                        : "No active LP position"}
                    </div>
                    <div style={styles.lpSubhead}>
                      {hasActiveLpPosition
                        ? "Live LP structure, inventory mix, collectable fees, and close-gate economics from the current cached bot state."
                        : `The strategy is currently not providing liquidity. Mode: ${String(strategyMode)}.`}
                    </div>
                  </div>
                  <CompactMetricList
                    items={[
                      {
                        label: "Status",
                        value: hasActiveLpPosition
                          ? <Pill label={inRange ? "In Range" : "Out of Range"} tone={boolTone(status?.position?.inRange)} />
                          : "—",
                      },
                      { label: "LP Value", value: hasActiveLpPosition ? fmtUsd(lpValueUsd) : "—" },
                      {
                        label: "Collectable Now",
                        value: hasActiveLpPosition
                          ? `${fmtUsd(collectableNowUsd)}${collectableNowEstimated ? " (est.)" : ""}`
                          : "—",
                      },
                      {
                        label: "Alpha Live",
                        value: hasActiveLpPosition
                          ? (
                            <span style={{ color: alphaLiveUsd >= 0 ? "#145b2f" : "#8d1111", fontWeight: 700 }}>
                              {fmtSignedUsd(alphaLiveUsd)}
                            </span>
                          )
                          : "—",
                      },
                      {
                        label: "Close Gate",
                        value: hasActiveLpPosition
                          ? (
                            <span title={hodlGateReason}>
                              <Pill label={hodlGateAllowed ? "Allowed" : "Blocked"} tone={hodlGateAllowed ? "good" : "bad"} />
                            </span>
                          )
                          : "—",
                      },
                      { label: "Record Status", value: activeLifecycleRecord?.status || "—" },
                    ]}
                    dense
                  />
                </div>

                <div style={styles.lpSectionGrid}>
                  <div style={styles.overviewBlock}>
                    <div style={styles.overviewBlockHeader}>
                      <div style={styles.overviewBlockTitle}>Position</div>
                      <div style={styles.overviewBlockSubtle}>Identity, opening timestamps, and top-level lifecycle state.</div>
                    </div>
                    <CompactMetricList
                      items={[
                        { label: "Token ID (LP NFT)", value: String(status?.position?.tokenId ?? "—"), mono: true },
                        { label: "Pair", value: activePairLabel },
                        { label: "Pool Tier / Selector", value: selectorLabel },
                        { label: "Opened", value: fmtIsoLocal(activeLifecycleRecord?.entry?.openedAtIso) },
                        { label: "Entry Snapshot", value: fmtIsoLocal(activeLifecycleRecord?.entry?.entrySnapshotAtIso) },
                        { label: "Entry Value", value: fmtUsd(activeLifecycleRecord?.entry?.entryValueUsd) },
                        { label: "Tx Count", value: String(activeLifecycleRecord?.activity?.txCount ?? 0) },
                        { label: "Record Status", value: activeLifecycleRecord?.status || "—" },
                      ]}
                      dense
                    />
                  </div>

                  <div style={styles.overviewBlock}>
                    <div style={styles.overviewBlockHeader}>
                      <div style={styles.overviewBlockTitle}>Band & Risk</div>
                      <div style={styles.overviewBlockSubtle}>Placed band, current pool location, and rebalance risk context.</div>
                    </div>
                    <CompactMetricList
                      items={[
                        { label: "Current Pool Tick", value: String(status?.market?.tick?.current ?? "—") },
                        { label: "Pool Tick Spacing", value: String(status?.market?.tick?.spacing ?? "—") },
                        { label: "Base Band Setting", value: `±${fmtPct(configuredBandHalfPct)}` },
                        {
                          label: "Regime Effective Band (at mint)",
                          value: regimeEffectiveBandAtMintBps == null ? "—" : `±${fmtPct(regimeEffectiveBandAtMintBps / 100)}`,
                        },
                        {
                          label: "Mint Target Used",
                          value: activeMintTargetBandBps == null ? "—" : `±${fmtPct(activeMintTargetBandBps / 100)}`,
                        },
                        {
                          label: "Actual Band Width",
                          value: !hasActiveLpPosition || actualBandHalfPct == null ? "—" : `±${fmtPct(actualBandHalfPct)}`,
                        },
                        { label: "Band Ticks", value: activeBandTicksLabel, mono: true },
                        {
                          label: "Distance To Edge",
                          value:
                            !hasActiveLpPosition || edgeDistPct == null
                              ? "—"
                              : `${String(status?.position?.distanceToEdge?.ticks ?? "—")} ticks (${fmtPct(edgeDistPct)})`,
                        },
                        { label: "In Range", value: hasActiveLpPosition ? <Pill label={inRange ? "In Range" : "Out of Range"} tone={boolTone(status?.position?.inRange)} /> : "—" },
                        { label: "Liquidity", value: status?.position?.liquidity || "—", mono: true },
                      ]}
                      dense
                    />
                  </div>

                  <div style={styles.overviewBlock}>
                    <div style={styles.overviewBlockHeader}>
                      <div style={styles.overviewBlockTitle}>Inventory Mix</div>
                      <div style={styles.overviewBlockSubtle}>Current deployed capital split across both LP sides and collectable fees.</div>
                    </div>
                    <CompactMetricList
                      items={[
                        { label: "LP Value", value: hasActiveLpPosition ? fmtUsd(lpValueUsd) : "—" },
                        {
                          label: "USDC in LP",
                          value: hasActiveLpPosition
                            ? `${fmtNum(status?.position?.amountsInLP?.usdc, 4)} (${fmtUsd(status?.position?.amountsInLP?.sideUsd?.usdc)})`
                            : "—",
                        },
                        {
                          label: "WETH in LP",
                          value: hasActiveLpPosition
                            ? `${fmtNum(status?.position?.amountsInLP?.weth, 6)} (${fmtUsd(status?.position?.amountsInLP?.sideUsd?.weth)})`
                            : "—",
                        },
                        {
                          label: "LP Split",
                          value: hasActiveLpPosition ? `${fmtPct(lpSplitUsdcPct)} / ${fmtPct(lpSplitWethPct)}` : "—",
                        },
                        {
                          label: "Collectable Now",
                          value: hasActiveLpPosition
                            ? `${fmtUsd(collectableNowUsd)}${collectableNowEstimated ? " (simulation fallback)" : ""}`
                            : "—",
                        },
                        { label: "Pending Compound", value: hasActiveLpPosition ? fmtUsd(status?.fees?.pendingCompoundUsd) : "—" },
                      ]}
                      dense
                    />
                  </div>

                  <div style={styles.overviewBlock}>
                    <div style={styles.overviewBlockHeader}>
                      <div style={styles.overviewBlockTitle}>Live Economics</div>
                      <div style={styles.overviewBlockSubtle}>Collected fees, realized costs so far, live alpha, and close-gate constraint.</div>
                    </div>
                    <CompactMetricList
                      items={[
                        { label: "Fees Collected", value: fmtUsd(activeLifecycleRecord?.performance?.feesCollectedUsd) },
                        { label: "Total Costs", value: fmtUsd(activeLifecycleRecord?.performance?.totalCostsUsd) },
                        { label: "Fees Net", value: fmtSignedUsd(activeLifecycleRecord?.performance?.feesNetUsd) },
                        { label: "Capital Gain/Loss", value: fmtSignedUsd(activeLifecycleRecord?.performance?.capitalGainLossUsd) },
                        { label: "Divergence vs HODL", value: fmtSignedUsd(activeLifecycleRecord?.performance?.divergenceVsHodlUsd) },
                        {
                          label: "Alpha vs HODL (Live)",
                          value: hasActiveLpPosition
                            ? (
                              <span style={{ color: alphaLiveUsd >= 0 ? "#145b2f" : "#8d1111", fontWeight: 700 }}>
                                {fmtSignedUsd(alphaLiveUsd)} {alphaLiveUsd >= 0 ? "(Beating HODL)" : "(Behind HODL)"}
                              </span>
                            )
                            : "—",
                        },
                        {
                          label: "Required Fees to Beat HODL (Live)",
                          value: hasActiveLpPosition ? fmtUsd(requiredFeesToBeatHodlLiveUsd) : "—",
                        },
                        { label: "LP P/L (absolute)", value: fmtSignedUsd(activeLifecycleRecord?.performance?.netProfitUsd) },
                        { label: "Close Gate Status", value: hasActiveLpPosition ? activeCloseGateLabel : "—" },
                      ]}
                      dense
                    />
                  </div>
                </div>
              </>
            )}
          </Card>

          <Card title="LP Position Record" fullWidth wideViewport>
            {!!positionsError && <p style={{ ...styles.alert, ...styles.alertErr, marginTop: 0 }}>Positions refresh error: {positionsError}</p>}

            <div style={styles.recordActiveWrap}>
              <div style={styles.recordActiveTitle}>Realized (Closed) Summary for Tax Tracking</div>
              <div style={{ ...styles.note, marginBottom: 10 }}>
                Aggregated from closed LP position records only. Tax years grouped by {positionsTaxSummary?.timezone || "UTC"} ({positionsTaxSummary?.dateRangeRule || "01-01..12-31"}). Asset value start uses the oldest closed-record entry value available in that year as a proxy.
              </div>
              <SimpleTable
                headers={["Tax Year", "Closed Positions", "Net Fees", "Capital Gain/Loss", "Alpha vs HODL", "Asset Value Start", "Asset Value Today", "YTD %"]}
                rows={
                  Array.isArray(positionsTaxSummary?.years) && positionsTaxSummary!.years!.length > 0
                    ? positionsTaxSummary!.years!.map((row) => [
                        String(Math.round(n(row?.year, 0))),
                        String(Math.round(n(row?.closedPositions, 0))),
                        fmtSignedUsd(row?.feesNetUsd),
                        fmtSignedUsd(row?.capitalGainLossUsd),
                        fmtSignedUsd(row?.alphaVsHodlUsd),
                        fmtUsd(row?.assetValueStartUsd),
                        row?.assetValueTodayUsd == null ? "—" : fmtUsd(row?.assetValueTodayUsd),
                        row?.ytdPct == null ? "—" : fmtSignedPct(row?.ytdPct),
                      ])
                    : [["—", "0", "—", "—", "—", "—", "—", "—"]]
                }
              />
            </div>

            <div style={{ ...styles.note, marginTop: 12 }}>
              Closed LP positions only (each row is one LP NFT lifecycle). Newest closed position appears first. Entry value uses the delayed entry snapshot (after initial top-up), not raw mint inputs. LP P/L (absolute) = Fees Net + Capital Gain/Loss. Alpha vs HODL = Fees Net + Divergence vs HODL.
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
                      "LP P/L (absolute)",
                      "Alpha vs HODL",
                      "Req Fees to Beat HODL",
                      "Cost/Fee",
                      "Close Reason",
                      "Hold Target",
                      "Entry/Exit Price",
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
                      <td style={styles.td} colSpan={21}>
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
                      const alphaVsHodlUsd = n(rec.performance?.alphaVsHodlUsd, 0);
                      const requiredFeesToBeatHodlUsd = n(rec.performance?.requiredFeesToBeatHodlUsd, 0);
                      const closeReason = String(rec.closeReason || "—")
                        .replaceAll("_", " ")
                        .replace(/\b\w/g, (m) => m.toUpperCase());
                      const closeHoldTarget = rec.closeReason === "trend_escape"
                        ? String(rec.closeHoldTarget || "—")
                        : "—";
                      return (
                        <tr key={rec.id}>
                          <td style={styles.td}>{`${rec.pair?.base || "WETH"}/${rec.pair?.quote || "USDC"}`}</td>
                          <td style={styles.td}>{rec.venue === "uniswapv3" ? "Uniswap v3" : "Slipstream"}</td>
                          <td style={styles.td}>{selectorLabel}</td>
                          <td style={styles.td}>
                            <span title={ticksLabel}>{bandLabel}</span>
                          </td>
                          <td style={styles.td} title={rec.entry?.openedAtIso || rec.entry?.entrySnapshotAtIso || ""}>
                            {fmtIsoLocal(rec.entry?.openedAtIso || rec.entry?.entrySnapshotAtIso)}
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
                          <td style={{ ...styles.td, color: alphaVsHodlUsd < 0 ? "#8d1111" : "#145b2f" }}>{fmtSignedUsd(rec.performance?.alphaVsHodlUsd)}</td>
                          <td style={styles.td}>{fmtUsd(requiredFeesToBeatHodlUsd)}</td>
                          <td style={styles.td}>{fmtRatioPct(rec.performance?.costToFeeRatio)}</td>
                          <td style={styles.td}>{closeReason}</td>
                          <td style={styles.td}>{closeHoldTarget}</td>
                          <td style={styles.td}>
                            {fmtSpotPrice(rec.entry?.spotPriceUsdcPerWeth)} -&gt; {fmtSpotPrice(rec.exit?.spotPriceUsdcPerWeth)}
                          </td>
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

          <Card title="Profitability (Net)" fullWidth wideViewport>
            <div style={styles.profitTablesGrid}>
              <div style={styles.profitTableCol}>
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
              </div>

              <div style={styles.profitTableCol}>
                <div style={{ ...styles.note, marginTop: 0, marginBottom: 8 }}>
                  Band performance (completed runs only; grouped by actual placed band width after tick-grid snapping).
                </div>
                <SimpleTable
                  headers={["Band", "Runs", "Alpha vs HODL / LP (bps)", "Win Rate vs HODL", "Avg Cost / LP (bps)", "Avg Time To Rebalance"]}
                  rows={
                    bandPerformanceRows.length > 0
                      ? bandPerformanceRows
                      : [["—", "0", "—", "—", "—", "—"]]
                  }
                />
              </div>
            </div>

            <div style={{ ...styles.recordActiveWrap, marginTop: 12 }}>
              <div style={styles.recordActiveTitle}>Rebalance & Activity</div>
              {isOwner && (
                <div style={{ ...styles.row, marginTop: 0, marginBottom: 12 }}>
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
              headers={[
                "Venue",
                "Chain",
                "Pair",
                "Variant",
                "Fee/Tier",
                "TVL (7d / 30d)",
                "Volume (7d / 30d)",
                "Fees/day (7d / 30d)",
                "Scalability",
                "FeePower (7d / 30d)",
                "Exp Net/day",
              ]}
              rows={
                poolComparisonCurrentRow
                  ? [poolComparisonCurrentRow]
                  : [["—", "—", "—", "—", "—", "—", "—", "—", "—", "—", "—"]]
              }
            />

            <div style={{ marginTop: 12, fontWeight: 600 }}>Top 5 candidate pools</div>
            <SimpleTable
              headers={[
                "Venue",
                "Pair",
                "Variant",
                "Fee/Tier",
                "TVL (7d / 30d)",
                "Volume (7d / 30d)",
                "Fees/day (7d / 30d)",
                "Scalability",
                "FeePower (7d / 30d)",
                "Exp Net/day",
                "Rating vs current",
                "Break-even",
              ]}
              rows={
                poolComparisonTopRows.length > 0
                  ? poolComparisonTopRows
                  : [["—", "—", "—", "—", "—", "—", "—", "—", "—", "—", "—"]]
              }
            />
            {poolComparisonNotRecommendedRows.length > 0 && (
              <>
                <div style={{ marginTop: 12, fontWeight: 600 }}>Not scalable / experimental pools</div>
                <SimpleTable
                  headers={["Venue", "Pair", "Variant", "Fee/Tier", "TVL (7d / 30d)", "Fees/day (7d / 30d)", "Scalability", "Why not recommended"]}
                  rows={poolComparisonNotRecommendedRows}
                />
              </>
            )}
            <div style={{ ...styles.note, marginTop: 8 }}>
              Ratings use inferred fee tier, absolute fees/day, fee-power, recent flow stability, and TVL scalability for your current capital. Pools with unknown fee or insufficient scalability are excluded from Top 5.
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

              <SelectField
                label="trendEscape.enabled"
                value={draft.trendEscapeEnabled ? "true" : "false"}
                onChange={(v) => updateBool("trendEscapeEnabled", v === "true")}
                options={["false", "true"]}
              />
              <NumberField
                label="trendEscape.minRegimeConfidence"
                value={draft.trendEscapeMinRegimeConfidence}
                step="0.01"
                onChange={(v) => updateNumber("trendEscapeMinRegimeConfidence", v)}
              />
              <NumberField
                label="trendEscape.directionLookbackSec"
                value={draft.trendEscapeDirectionLookbackSec}
                onChange={(v) => updateNumber("trendEscapeDirectionLookbackSec", v)}
              />
              <NumberField
                label="trendEscape.minTrendMovePct"
                value={draft.trendEscapeMinTrendMovePct}
                step="0.0001"
                onChange={(v) => updateNumber("trendEscapeMinTrendMovePct", v)}
              />
              <NumberField
                label="trendEscape.minTrendConfirmSec"
                value={draft.trendEscapeMinTrendConfirmSec}
                onChange={(v) => updateNumber("trendEscapeMinTrendConfirmSec", v)}
              />
              <NumberField
                label="trendEscape.cooldownAfterEscapeSec"
                value={draft.trendEscapeCooldownAfterEscapeSec}
                onChange={(v) => updateNumber("trendEscapeCooldownAfterEscapeSec", v)}
              />
              <NumberField
                label="trendEscape.minAlphaUsdToEscape"
                value={draft.trendEscapeMinAlphaUsdToEscape}
                step="0.01"
                onChange={(v) => updateNumber("trendEscapeMinAlphaUsdToEscape", v)}
              />
              <NumberField
                label="trendEscape.emergencyOutOfRangeEdgePct"
                value={draft.trendEscapeEmergencyOutOfRangeEdgePct}
                step="0.01"
                onChange={(v) => updateNumber("trendEscapeEmergencyOutOfRangeEdgePct", v)}
              />
              <NumberField
                label="trendEscape.emergencyMinOutOfRangeSec"
                value={draft.trendEscapeEmergencyMinOutOfRangeSec}
                onChange={(v) => updateNumber("trendEscapeEmergencyMinOutOfRangeSec", v)}
              />
              <SelectField
                label="trendEscape.uptrendHold"
                value={draft.trendEscapeUptrendHold}
                onChange={(v) => setDraft((p) => (p ? { ...p, trendEscapeUptrendHold: v as "WETH" | "USDC" | "50_50" } : p))}
                options={["WETH", "USDC", "50_50"]}
              />
              <SelectField
                label="trendEscape.downtrendHold"
                value={draft.trendEscapeDowntrendHold}
                onChange={(v) => setDraft((p) => (p ? { ...p, trendEscapeDowntrendHold: v as "WETH" | "USDC" | "50_50" } : p))}
                options={["USDC", "WETH", "50_50"]}
              />
              <SelectField
                label="trendEscape.fallbackHold"
                value={draft.trendEscapeFallbackHold}
                onChange={(v) => setDraft((p) => (p ? { ...p, trendEscapeFallbackHold: v as "WETH" | "USDC" | "50_50" } : p))}
                options={["50_50", "WETH", "USDC"]}
              />

              <SelectField
                label="reEntry.enabled"
                value={draft.reEntryEnabled ? "true" : "false"}
                onChange={(v) => updateBool("reEntryEnabled", v === "true")}
                options={["false", "true"]}
              />
              <NumberField
                label="reEntry.minRegimeConfidence"
                value={draft.reEntryMinRegimeConfidence}
                step="0.01"
                onChange={(v) => updateNumber("reEntryMinRegimeConfidence", v)}
              />
              <NumberField
                label="reEntry.minMeanRevertConfirmSec"
                value={draft.reEntryMinMeanRevertConfirmSec}
                onChange={(v) => updateNumber("reEntryMinMeanRevertConfirmSec", v)}
              />
              <NumberField
                label="reEntry.maxDistanceFromMuPct"
                value={draft.reEntryMaxDistanceFromMuPct}
                step="0.0001"
                onChange={(v) => updateNumber("reEntryMaxDistanceFromMuPct", v)}
              />
              <NumberField
                label="reEntry.minHoldSec"
                value={draft.reEntryMinHoldSec}
                onChange={(v) => updateNumber("reEntryMinHoldSec", v)}
              />
              <NumberField
                label="reEntry.cooldownAfterReEntrySec"
                value={draft.reEntryCooldownAfterReEntrySec}
                onChange={(v) => updateNumber("reEntryCooldownAfterReEntrySec", v)}
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
            <Metric label="LP P/L (absolute)" value={fmtSignedUsd(perf.netProfitUsd)} />
            <Metric label="Alpha vs HODL" value={fmtSignedUsd(perf.alphaVsHodlUsd)} />
            <Metric label="Required Fees to Beat HODL" value={fmtUsd(perf.requiredFeesToBeatHodlUsd)} />
            <Metric label="Cost / Fee" value={fmtRatioPct(perf.costToFeeRatio)} />
            <Metric label="Fee APR" value={fmtPct(perf.feeApr ?? 0)} />
            <Metric label="Alpha APR vs HODL" value={fmtPct(perf.alphaApr ?? 0)} />
            <Metric label="Absolute APR" value={fmtPct(perf.absoluteApr ?? perf.apr ?? 0)} />
          </div>
        </div>

        <div style={styles.drawerSection}>
          <div style={styles.drawerSectionTitle}>Activity</div>
          <div style={styles.metaGrid}>
            <Metric label="Rebalances" value={String(record.activity?.rebalances ?? 0)} />
            <Metric label="Harvests" value={String(record.activity?.harvests ?? 0)} />
            <Metric label="Swaps" value={String(record.activity?.swaps ?? 0)} />
            <Metric label="Tx Count" value={String(record.activity?.txCount ?? 0)} />
            <Metric label="Close Gate Blocks" value={String(record.activity?.closeGateBlockedCount ?? 0)} />
            <Metric label="Close Gate Override" value={record.activity?.closeGateOverrideReason || "—"} />
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

function CompactMetricList({
  items,
  dense,
}: {
  items: Array<{ label: string; value: ReactNode; mono?: boolean }>;
  dense?: boolean;
}) {
  return (
    <div style={{ ...styles.compactList, ...(dense ? styles.compactListDense : undefined) }}>
      {items.map((item) => (
        <div key={item.label} style={styles.compactRow}>
          <div style={styles.compactLabel}>{item.label}</div>
          <div style={{ ...styles.compactValue, fontFamily: item.mono ? "monospace" : "inherit" }}>{item.value}</div>
        </div>
      ))}
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
  link: {
    color: "#0b57d0",
    textDecoration: "underline",
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
  overviewHero: {
    display: "grid",
    gridTemplateColumns: "minmax(280px, 1.1fr) minmax(380px, 1fr)",
    gap: 16,
    alignItems: "start",
    padding: 16,
    border: "1px solid #dde6f2",
    borderRadius: 12,
    background: "linear-gradient(180deg, #f7fbff 0%, #eef5fb 100%)",
  },
  overviewEyebrow: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#5e7392",
    marginBottom: 8,
  },
  overviewHeadline: {
    fontSize: 24,
    lineHeight: 1.2,
    fontWeight: 800,
    color: "#10253f",
  },
  overviewSubhead: {
    marginTop: 10,
    fontSize: 14,
    lineHeight: 1.5,
    color: "#435973",
    maxWidth: 720,
  },
  overviewSectionGrid: {
    marginTop: 16,
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 12,
  },
  overviewBlock: {
    border: "1px solid #e1e8f2",
    borderRadius: 12,
    background: "#fbfdff",
    padding: 12,
  },
  overviewBlockHeader: {
    marginBottom: 8,
  },
  overviewBlockTitle: {
    fontSize: 15,
    fontWeight: 800,
    color: "#14314d",
  },
  overviewBlockSubtle: {
    marginTop: 4,
    fontSize: 12,
    color: "#60748f",
    lineHeight: 1.45,
  },
  lpHero: {
    display: "grid",
    gridTemplateColumns: "minmax(320px, 1.15fr) minmax(340px, 0.95fr)",
    gap: 16,
    alignItems: "start",
    padding: 16,
    border: "1px solid #dde6f2",
    borderRadius: 12,
    background: "linear-gradient(180deg, #fcfeff 0%, #f1f7fb 100%)",
  },
  lpHeadline: {
    fontSize: 24,
    lineHeight: 1.2,
    fontWeight: 800,
    color: "#10253f",
  },
  lpSubhead: {
    marginTop: 10,
    fontSize: 14,
    lineHeight: 1.5,
    color: "#435973",
    maxWidth: 760,
  },
  lpSectionGrid: {
    marginTop: 16,
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 12,
  },
  compactList: {
    display: "grid",
    gap: 0,
    marginTop: 2,
  },
  compactListDense: {
    marginTop: 0,
  },
  compactRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 0.95fr) minmax(0, 1.05fr)",
    gap: 12,
    alignItems: "start",
    padding: "7px 0",
    borderBottom: "1px solid #ebf0f6",
  },
  compactLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.02em",
    textTransform: "uppercase",
    color: "#61748d",
  },
  compactValue: {
    fontSize: 13,
    fontWeight: 600,
    color: "#10253f",
    textAlign: "right",
    wordBreak: "break-word",
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
  profitTablesGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(520px, 1fr))",
    gap: 12,
    alignItems: "start",
  },
  profitTableCol: {
    minWidth: 0,
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
