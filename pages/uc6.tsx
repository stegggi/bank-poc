import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { BrowserProvider, type Eip1193Provider } from "ethers";
import NavBar from "../shared/components/NavBar";
import { useBreakpoint } from "../shared/hooks/useBreakpoint";

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
type OwnerAction = "update_settings" | "force_rebalance" | "liquidate_and_pause" | "emissions_stake" | "emissions_unstake" | "emissions_claim";

type Uc6DraftSettings = {
  tradingEnabled: boolean;
  killSwitch: boolean;
  venue: Uc6Venue;
  bandHalfBps: number;
  bandHalfBpsUp: number | null;
  bandHalfBpsDown: number | null;
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
  regimeFastWindowSec: number;
  regimeFastSampleEverySec: number;
  regimeFastMinSamples: number;
  regimeFastWeight: number;
  regimeMrHalfLifeMaxSec: number;
  regimeTrendHalfLifeMinSec: number;
  regimeMaxEdgeAdj: number;
  regimeMaxBandAdjBps: number;
  regimeMaxBandNarrowBps: number;
  regimeMaxCooldownAdjSec: number;
  hodlGateEnabled: boolean;
  trendEscapeEnabled: boolean;
  trendEscapeMinRegimeConfidence: number;
  trendEscapeMinEdgeProgressToConsider: number;
  trendEscapeBaseConfirmSec: number;
  trendEscapeUrgencyThreshold: number;
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
  bandHalfBpsUp: number | null;
  bandHalfBpsDown: number | null;
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
    fastWindowSec: number;
    fastSampleEverySec: number;
    fastMinSamples: number;
    fastWeight: number;
    mrHalfLifeMaxSec: number;
    trendHalfLifeMinSec: number;
    maxEdgeAdj: number;
    maxBandAdjBps: number;
    maxBandNarrowBps: number;
    maxCooldownAdjSec: number;
  };
  hodlGate: {
    enabled: boolean;
  };
  trendEscape: {
    enabled: boolean;
    variant: "tiered" | "hybrid";
    requireRegimeLabel: "trending";
    minRegimeConfidence: number;
    minEdgeProgressToConsider: number;
    baseConfirmSec: number;
    urgencyThreshold: number;
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
    bandHalfBpsUp?: number;
    bandHalfBpsDown?: number;
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
    bandHalfBpsUp?: number | null;
    bandHalfBpsDown?: number | null;
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
      fastWindowSec?: number;
      fastSampleEverySec?: number;
      fastMinSamples?: number;
      fastWeight?: number;
      mrHalfLifeMaxSec?: number;
      trendHalfLifeMinSec?: number;
      maxEdgeAdj?: number;
      maxBandAdjBps?: number;
      maxBandNarrowBps?: number;
      maxCooldownAdjSec?: number;
    };
    trendEscape?: {
      enabled?: boolean;
      variant?: string;
      requireRegimeLabel?: string;
      minRegimeConfidence?: number;
      minEdgeProgressToConsider?: number;
      baseConfirmSec?: number;
      urgencyThreshold?: number;
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
      outOfRangeEmergencyMinSec?: number;
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
    bandHalfBps?: number | null;
    bandHalfBpsUp?: number | null;
    bandHalfBpsDown?: number | null;
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
    rewardsTodayUsd?: number;
    rewards7dUsd?: number;
    rewards30dUsd?: number;
    rewardsTotalUsd?: number;
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
    thetaStrength?: number;
    theta?: number | null;
    halfLifeSec?: number | null;
    sigma?: number | null;
    mu?: number | null;
    confidence?: number;
    updatedAtIso?: string | null;
    sampleCount?: number;
    windowSec?: number;
    fast?: {
      theta?: number | null;
      thetaStrength?: number;
      halfLifeSec?: number | null;
      label?: string;
      confidence?: number;
      sampleCount?: number;
      windowSec?: number;
    } | null;
  };
  strategyMode?: "LP_ACTIVE" | "HOLD_WETH" | "HOLD_USDC" | "HOLD_50_50" | string;
  trend?: {
    movePct?: number | null;
    direction?: string;
    lookbackSec?: number;
    confirmSec?: number;
    meanRevertConfirmSec?: number;
    distanceFromMuPct?: number | null;
    muPriceUsdcPerWeth?: number | null;
  };
  trendEscape?: {
    enabled?: boolean;
    eligible?: boolean;
    holdTargetIfEscape?: string | null;
    reasonIfBlocked?: string;
    cooldownUntilIso?: string | null;
    urgency?: number | null;
    diagnostics?: {
      edgeProgress?: number;
      regimeConfidence?: number;
      trendMovePct?: number;
      actualConfirmSec?: number;
      requiredConfirmSec?: number;
      edgeProgressNorm?: number;
      confidenceNorm?: number;
      trendMagnitudeNorm?: number;
      confirmProgressNorm?: number;
      urgency?: number;
      urgencyThreshold?: number;
      alphaLiveUsd?: number;
      minAlphaUsdToEscape?: number;
      alphaOk?: boolean;
      emergencyAllowed?: boolean;
      minEdgeProgressToConsider?: number;
      baseConfirmSec?: number;
      approachingSide?: "upper" | "lower" | null;
      upperHalfWidth?: number;
      lowerHalfWidth?: number;
    } | null;
  };
  reEntry?: {
    enabled?: boolean;
    eligible?: boolean;
    reasonIfBlocked?: string;
    meanRevertConfirmSec?: number;
    distanceFromMuPct?: number | null;
    eligibleAtIso?: string | null;
    holdElapsedSec?: number;
    holdRequiredSec?: number;
    escapeCooldownUntilIso?: string | null;
    reEntryCooldownUntilIso?: string | null;
    regimeLabel?: string;
    regimeConfidence?: number;
    requiredRegimeLabel?: string;
    requiredMinConfidence?: number;
    requiredMeanRevertConfirmSec?: number;
    maxDistanceFromMuPct?: number;
  };
  decision?: {
    baseThresholds?: {
      edgeRebalancePct?: number;
      minRebalanceIntervalSec?: number;
      bandHalfBps?: number;
      bandHalfBpsUp?: number | null;
      bandHalfBpsDown?: number | null;
    };
    effectiveThresholds?: {
      edgeRebalancePct?: number;
      minRebalanceIntervalSec?: number;
      bandHalfBps?: number;
      bandHalfBpsUp?: number | null;
      bandHalfBpsDown?: number | null;
    };
    adviceReason?: string;
    waitRecommended?: boolean;
  };
  hodlGate?: {
    enabled?: boolean;
    marginUsd?: number;
    alphaLiveUsd?: number;
    feesNetLiveUsd?: number;
    divVsHodlLiveUsd?: number;
    requiredFeesToBeatHodlLiveUsd?: number;
    collectableNowUsd?: number;
    totalCostsToDateUsd?: number;
    feesCollectedUsd?: number;
    rewardsClaimedUsd?: number;
    claimableAeroUsd?: number;
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
      rewardsUsd?: number;
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
      rewardsUsd?: number;
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
  emissions?: {
    enabled?: boolean;
    poolAddress?: string | null;
    gaugeAddress?: string | null;
    gaugeAlive?: boolean | null;
    gaugeMeta?: {
      periodFinish?: number;
      rewardRate?: string;
      left?: string | null;
      checkedAtIso?: string;
    } | null;
    staked?: boolean;
    tokenId?: string | null;
    autoStakeEligible?: boolean | null;
    autoStakeBlockedReason?: string | null;
    rewardToken?: { address?: string; symbol?: string; decimals?: number } | null;
    claimable?: { aero?: number; usd?: number; updatedAtIso?: string | null };
    walletBalance?: { aero?: number; usd?: number; updatedAtIso?: string | null };
    price?: { aeroUsd?: number; updatedAtIso?: string | null; source?: string | null };
    lastStakeAtIso?: string | null;
    lastUnstakeAtIso?: string | null;
    lastClaimAtIso?: string | null;
    settings?: {
      autoStakeOnMint?: boolean;
      autoUnstakeOnRebalance?: boolean;
      autoClaim?: boolean;
      claimMinUsd?: number;
      claimCooldownSec?: number;
      approvalMode?: string;
    };
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
    bandHalfBpsUp: null,
    bandHalfBpsDown: null,
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
    regimeFastWindowSec: 300,
    regimeFastSampleEverySec: 6,
    regimeFastMinSamples: 30,
    regimeFastWeight: 0.4,
    regimeMrHalfLifeMaxSec: 180,
    regimeTrendHalfLifeMinSec: 900,
    regimeMaxEdgeAdj: 0.1,
    regimeMaxBandAdjBps: 50,
    regimeMaxBandNarrowBps: 20,
    regimeMaxCooldownAdjSec: 900,
    hodlGateEnabled: false,
    trendEscapeEnabled: true,
    trendEscapeMinRegimeConfidence: 0.45,
    trendEscapeMinEdgeProgressToConsider: 0.6,
    trendEscapeBaseConfirmSec: 300,
    trendEscapeUrgencyThreshold: 0.7,
    trendEscapeDirectionLookbackSec: 300,
    trendEscapeMinTrendMovePct: 0.01,
    trendEscapeMinTrendConfirmSec: 60,
    trendEscapeCooldownAfterEscapeSec: 600,
    trendEscapeMinAlphaUsdToEscape: -5,
    trendEscapeEmergencyOutOfRangeEdgePct: 1.5,
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
  const hodlGate = settings.hodlGate || {};
  const regime = settings.regime || {};
  const trendEscape = settings.trendEscape || {};
  const reEntry = settings.reEntry || {};

  return {
    tradingEnabled: Boolean(settings.tradingEnabled ?? d.tradingEnabled),
    killSwitch: Boolean(settings.killSwitch ?? d.killSwitch),
    venue,
    bandHalfBps: n(settings.bandHalfBps, d.bandHalfBps),
    bandHalfBpsUp: settings.bandHalfBpsUp != null ? n(settings.bandHalfBpsUp, 0) : d.bandHalfBpsUp,
    bandHalfBpsDown: settings.bandHalfBpsDown != null ? n(settings.bandHalfBpsDown, 0) : d.bandHalfBpsDown,
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
    regimeFastWindowSec: n(regime.fastWindowSec, d.regimeFastWindowSec),
    regimeFastSampleEverySec: n(regime.fastSampleEverySec, d.regimeFastSampleEverySec),
    regimeFastMinSamples: n(regime.fastMinSamples, d.regimeFastMinSamples),
    regimeFastWeight: n(regime.fastWeight, d.regimeFastWeight),
    regimeMrHalfLifeMaxSec: n(regime.mrHalfLifeMaxSec, d.regimeMrHalfLifeMaxSec),
    regimeTrendHalfLifeMinSec: n(regime.trendHalfLifeMinSec, d.regimeTrendHalfLifeMinSec),
    regimeMaxEdgeAdj: n(regime.maxEdgeAdj, d.regimeMaxEdgeAdj),
    regimeMaxBandAdjBps: n(regime.maxBandAdjBps, d.regimeMaxBandAdjBps),
    regimeMaxBandNarrowBps: n(regime.maxBandNarrowBps, d.regimeMaxBandNarrowBps),
    regimeMaxCooldownAdjSec: n(regime.maxCooldownAdjSec, d.regimeMaxCooldownAdjSec),
    hodlGateEnabled: Boolean(hodlGate.enabled ?? d.hodlGateEnabled),
    trendEscapeEnabled: Boolean(trendEscape.enabled ?? d.trendEscapeEnabled),
    trendEscapeMinRegimeConfidence: n(trendEscape.minRegimeConfidence, d.trendEscapeMinRegimeConfidence),
    trendEscapeMinEdgeProgressToConsider: n(trendEscape.minEdgeProgressToConsider, d.trendEscapeMinEdgeProgressToConsider),
    trendEscapeBaseConfirmSec: n(trendEscape.baseConfirmSec, d.trendEscapeBaseConfirmSec),
    trendEscapeUrgencyThreshold: n(trendEscape.urgencyThreshold, d.trendEscapeUrgencyThreshold),
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
    bandHalfBpsUp: draft.bandHalfBpsUp,
    bandHalfBpsDown: draft.bandHalfBpsDown,
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
      fastWindowSec: draft.regimeFastWindowSec,
      fastSampleEverySec: draft.regimeFastSampleEverySec,
      fastMinSamples: draft.regimeFastMinSamples,
      fastWeight: draft.regimeFastWeight,
      mrHalfLifeMaxSec: draft.regimeMrHalfLifeMaxSec,
      trendHalfLifeMinSec: draft.regimeTrendHalfLifeMinSec,
      maxEdgeAdj: draft.regimeMaxEdgeAdj,
      maxBandAdjBps: draft.regimeMaxBandAdjBps,
      maxBandNarrowBps: draft.regimeMaxBandNarrowBps,
      maxCooldownAdjSec: draft.regimeMaxCooldownAdjSec,
    },
    hodlGate: {
      enabled: draft.hodlGateEnabled,
    },
    trendEscape: {
      enabled: draft.trendEscapeEnabled,
      variant: "tiered",
      requireRegimeLabel: "trending",
      minRegimeConfidence: draft.trendEscapeMinRegimeConfidence,
      minEdgeProgressToConsider: draft.trendEscapeMinEdgeProgressToConsider,
      baseConfirmSec: draft.trendEscapeBaseConfirmSec,
      urgencyThreshold: draft.trendEscapeUrgencyThreshold,
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

function bandSidesFromTicks(
  tickLower?: number | null, tickUpper?: number | null, centerTick?: number | null
): { upPct: number | null; downPct: number | null } {
  const lower = Number(tickLower);
  const upper = Number(tickUpper);
  const rawCenter = centerTick != null ? Number(centerTick) : NaN;
  const center = Number.isFinite(rawCenter) ? rawCenter
    : Number.isFinite(lower) && Number.isFinite(upper) ? Math.round((lower + upper) / 2) : NaN;
  if (!(Number.isFinite(lower) && Number.isFinite(upper) && Number.isFinite(center) && upper > lower)) {
    return { upPct: null, downPct: null };
  }
  const upTicks = upper - center;
  const downTicks = center - lower;
  const upPct = (Math.exp(Math.log(1.0001) * upTicks) - 1) * 100;
  const downPct = (1 - Math.exp(-Math.log(1.0001) * downTicks)) * 100;
  return {
    upPct: Number.isFinite(upPct) ? upPct : null,
    downPct: Number.isFinite(downPct) ? downPct : null,
  };
}

function formatBandLabelDirectional(
  tickLower?: number | null, tickUpper?: number | null,
  centerTick?: number | null, fallbackBandHalfBps?: number
): string {
  const { upPct, downPct } = bandSidesFromTicks(tickLower, tickUpper, centerTick);
  if (upPct != null && downPct != null) {
    const ratio = Math.min(upPct, downPct) / Math.max(upPct, downPct);
    if (ratio < 0.9) return `+${upPct.toFixed(1)}% / \u2212${downPct.toFixed(1)}%`;
    return `\u00b1${((upPct + downPct) / 2).toFixed(2)}%`;
  }
  if (fallbackBandHalfBps != null) return `\u00b1${(fallbackBandHalfBps / 100).toFixed(2)}%`;
  return "\u2014";
}

function formatRecordBandLabel(record: Pick<PositionLifecycleRecord, "band">): string {
  const hasAsym = record.band?.bandHalfBpsUp != null || record.band?.bandHalfBpsDown != null;
  if (hasAsym) {
    const upPct = ((record.band?.bandHalfBpsUp ?? record.band?.bandHalfBps ?? 0) / 100).toFixed(2);
    const downPct = ((record.band?.bandHalfBpsDown ?? record.band?.bandHalfBps ?? 0) / 100).toFixed(2);
    return `\u2191${upPct}% \u2193${downPct}%`;
  }
  // Try direction-aware from ticks
  const dir = formatBandLabelDirectional(record.band?.tickLower, record.band?.tickUpper, null, undefined);
  if (dir !== "\u2014") return dir;
  const actualPct = actualBandHalfPctFromTicks(record.band?.tickLower, record.band?.tickUpper);
  if (actualPct != null) return `\u00b1${fmtPct(actualPct)}`;
  return `\u00b1${(n(record.band?.bandHalfBps, 0) / 100).toFixed(2)}%`;
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
  const { isMobile, isTablet, isMobileOrTablet } = useBreakpoint();
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
      endpoint: string;
      successPrefix: string;
    }) => {
      if (!walletAddress) throw new Error("Connect MetaMask first.");
      if (!isOwner) throw new Error("Only the configured owner wallet can perform owner actions.");
      const eth = getEthereum();
      if (!eth) throw new Error("MetaMask is unavailable.");

      const runSignedRequest = async () => {
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
        return out;
      };

      let out: { ok?: boolean; settings?: Uc6Status["settings"] };
      try {
        out = await runSignedRequest();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "";
        const shouldRetry =
          message === "Challenge missing or expired" ||
          message === "Challenge was already used" ||
          message === "Message has expired";
        if (!shouldRetry) throw err;
        out = await runSignedRequest();
      }

      if (out.settings) {
        setDraft(coerceDraft(out.settings));
      }
      setNotice(successPrefix);
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

  const stakeEmissions = useCallback(async () => {
    setError("");
    setNotice("");
    setBusy("emissions-stake");
    try {
      await submitSignedOwnerAction({
        action: "emissions_stake",
        payload: {},
        endpoint: "/api/uc6/owner/emissions-stake",
        successPrefix: "NFT staked into gauge",
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to stake into gauge.");
    } finally {
      setBusy("");
    }
  }, [submitSignedOwnerAction]);

  const unstakeEmissions = useCallback(async () => {
    setError("");
    setNotice("");
    setBusy("emissions-unstake");
    try {
      await submitSignedOwnerAction({
        action: "emissions_unstake",
        payload: {},
        endpoint: "/api/uc6/owner/emissions-unstake",
        successPrefix: "NFT unstaked from gauge",
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to unstake from gauge.");
    } finally {
      setBusy("");
    }
  }, [submitSignedOwnerAction]);

  const claimEmissions = useCallback(async () => {
    setError("");
    setNotice("");
    setBusy("emissions-claim");
    try {
      await submitSignedOwnerAction({
        action: "emissions_claim",
        payload: {},
        endpoint: "/api/uc6/owner/emissions-claim",
        successPrefix: "AERO rewards claimed",
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to claim AERO rewards.");
    } finally {
      setBusy("");
    }
  }, [submitSignedOwnerAction]);

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
  const events = (status?.events?.lastN || []).slice(-50).reverse();
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
  // Always derive "base" from live settings — the cached regimeDecision.baseThresholds can be
  // stale after a settings change and will disagree with status.settings until the next bot cycle.
  const regimeBaseEdgePct = n(status?.settings?.edgeRebalancePct, 0) * 100;
  const regimeEffectiveEdgePct =
    n(regimeDecisionView?.effectiveThresholds?.edgeRebalancePct, n(status?.settings?.edgeRebalancePct, 0)) * 100;
  const regimeBaseCooldown = n(status?.settings?.minRebalanceIntervalSec, 0);
  const regimeEffectiveCooldown = n(
    regimeDecisionView?.effectiveThresholds?.minRebalanceIntervalSec,
    n(status?.settings?.minRebalanceIntervalSec, 0)
  );
  const regimeBaseBandBps = n(status?.settings?.bandHalfBps, 0);
  const regimeEffectiveBandBps = n(
    regimeDecisionView?.effectiveThresholds?.bandHalfBps,
    n(status?.settings?.bandHalfBps, 0)
  );
  const regimeBaseBandBpsUp = status?.settings?.bandHalfBpsUp ?? null;
  const regimeBaseBandBpsDown = status?.settings?.bandHalfBpsDown ?? null;
  const regimeEffectiveBandBpsUp = regimeDecisionView?.effectiveThresholds?.bandHalfBpsUp ?? regimeBaseBandBpsUp;
  const regimeEffectiveBandBpsDown = regimeDecisionView?.effectiveThresholds?.bandHalfBpsDown ?? regimeBaseBandBpsDown;
  const isAsymmetricBand = regimeBaseBandBpsUp != null || regimeBaseBandBpsDown != null;
  const hodlGateView = status?.hodlGate || null;
  const hodlGateAllowed = hodlGateView?.lastGateDecision?.allowed !== false;
  const hodlGateReason = String(hodlGateView?.lastGateDecision?.reason || "—");
  const divVsHodlLiveUsd = n(hodlGateView?.divVsHodlLiveUsd, 0);
  const requiredFeesToBeatHodlLiveUsd = n(hodlGateView?.requiredFeesToBeatHodlLiveUsd, 0);
  // Recompute feesNet and alpha to include AERO rewards (claimed + claimable)
  const _feesCollected = n(hodlGateView?.feesCollectedUsd, 0);
  const _rewardsClaimed = n(hodlGateView?.rewardsClaimedUsd, 0);
  const _claimableAero = n(hodlGateView?.claimableAeroUsd, 0) || n(status?.emissions?.claimable?.usd, 0);
  const _collectableNow = n(hodlGateView?.collectableNowUsd, 0);
  const _totalCosts = n(hodlGateView?.totalCostsToDateUsd, 0);
  const feesNetLiveUsd = _feesCollected + _rewardsClaimed + _claimableAero + _collectableNow - _totalCosts;
  const alphaLiveUsd = feesNetLiveUsd + divVsHodlLiveUsd;
  const strategyMode = status?.strategyMode || "LP_ACTIVE";
  const isHoldMode = strategyMode !== "LP_ACTIVE";
  const trendView = status?.trend || null;
  const trendEscapeView = status?.trendEscape || null;
  const reEntryView = status?.reEntry || null;
  const trendMovePct = trendView?.movePct == null ? null : n(trendView.movePct, 0) * 100;
  const regimeMuPrice = trendView?.muPriceUsdcPerWeth == null ? null : n(trendView.muPriceUsdcPerWeth, 0);
  const collectableNowUsd = n(status?.fees?.collectableNow?.usd, 0);
  const collectableNowEstimated = Boolean(status?.fees?.collectableNow?.isEstimated);
  const activeMintTargetBandBpsRaw = activeLifecycleRecord?.band?.bandHalfBps;
  const activeMintTargetBandBps = Number.isFinite(Number(activeMintTargetBandBpsRaw))
    ? Math.round(Number(activeMintTargetBandBpsRaw))
    : null;
  const activeLpEntryAtIso =
    activeLifecycleRecord?.entry?.openedAtIso ||
    activeLifecycleRecord?.entry?.entrySnapshotAtIso ||
    null;
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


  // ── return ─────────────────────────────────────────────────────────────────
  return (
    <>
      <NavBar active={"uc6" as never} />
      <style>{`
        body { background: #07080f !important; color: #e8e8f0 !important; }
        * { box-sizing: border-box; }
        input, select, textarea {
          background: rgba(255,255,255,0.06) !important;
          color: #e8e8f0 !important;
          border: 1px solid rgba(255,255,255,0.15) !important;
          border-radius: 6px;
          padding: 6px 10px;
          font-size: 13px;
          outline: none;
        }
        input:focus, select:focus { border-color: #06b6d4 !important; }
        details > summary { list-style: none; }
        details > summary::-webkit-details-marker { display: none; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        .uc6-pulse { animation: pulse 2s ease-in-out infinite; }
      `}</style>

      {/* ZONE 1: Hero Strip */}
      <div style={{ position:"sticky", top:0, zIndex:100, background:"#07080f", borderBottom:"1px solid rgba(255,255,255,0.08)", padding:"10px 20px", display:"flex", alignItems:"center", gap:16, flexWrap:"wrap" }}>
        {/* Pulsing dot */}
        <span className="uc6-pulse" style={{ width:10, height:10, borderRadius:"50%", background: status?.killSwitch ? "#ef4444" : (status?.tradingEnabled ? "#22c55e" : "#f59e0b"), display:"inline-block", flexShrink:0 }} />

        {/* Strategy mode */}
        <span style={{ ...strategyModePillStyle(strategyMode) }}>{strategyMode}</span>

        {/* Spot price */}
        <span style={{ fontFamily:"monospace", fontSize:18, fontWeight:700, color:"#e8e8f0" }}>
          {fmtSpotPrice(status?.market?.spotPrice?.usdcPerWeth)}
          <span style={{ fontSize:11, color:"rgba(232,232,240,0.5)", marginLeft:4 }}>WETH/USDC</span>
        </span>

        {/* Separator */}
        <span style={{ flex:1 }} />

        {/* Range pill */}
        {hasActiveLpPosition && (
          <span style={{ padding:"3px 10px", borderRadius:20, fontSize:12, fontWeight:700, background: inRange ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)", color: inRange ? "#22c55e" : "#ef4444", border:`1px solid ${inRange ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}` }}>
            {inRange ? "IN RANGE" : "OUT OF RANGE"}
          </span>
        )}

        {/* Cooldown */}
        {cooldownRemaining > 0 && (
          <span style={{ padding:"3px 10px", borderRadius:20, fontSize:12, fontWeight:700, background:"rgba(245,158,11,0.15)", color:"#f59e0b", border:"1px solid rgba(245,158,11,0.3)" }}>
            COOLDOWN {fmtDurationCompact(cooldownRemaining)}
          </span>
        )}

        {/* Alpha live */}
        <span style={{ fontFamily:"monospace", fontSize:13, color: alphaLiveUsd >= 0 ? "#22c55e" : "#ef4444", fontWeight:600 }}>
          α {fmtSignedUsd(alphaLiveUsd)}
        </span>

        {/* Wallet */}
        {walletAddress ? (
          <span style={{ fontSize:12, color:"rgba(232,232,240,0.6)", fontFamily:"monospace" }}>
            {isOwner ? "OWNER " : ""}{shortAddr(walletAddress)}
          </span>
        ) : (
          <button onClick={connectWallet} disabled={!hasMetaMask || busy !== ""} style={{ padding:"4px 12px", borderRadius:6, background:"transparent", border:"1px solid rgba(6,182,212,0.4)", color:"#06b6d4", fontSize:12, cursor:"pointer" }}>
            Connect Wallet
          </button>
        )}

        {/* Kill switch */}
        {status?.killSwitch && (
          <span style={{ padding:"3px 10px", borderRadius:20, fontSize:12, fontWeight:800, background:"rgba(239,68,68,0.2)", color:"#ef4444", border:"1px solid rgba(239,68,68,0.4)" }}>
            KILL SWITCH ACTIVE
          </span>
        )}

        {/* Emergency stop */}
        {isOwner && !status?.killSwitch && (
          <button onClick={emergencyStop} disabled={busy !== "" || !draft} style={{ padding:"4px 14px", borderRadius:6, background:"rgba(239,68,68,0.15)", border:"1px solid rgba(239,68,68,0.4)", color:"#ef4444", fontSize:12, fontWeight:700, cursor:"pointer" }}>
            STOP
          </button>
        )}
        {isOwner && status?.killSwitch && (
          <button onClick={enableTrading} disabled={busy !== "" || !draft} style={{ padding:"4px 14px", borderRadius:6, background:"rgba(34,197,94,0.15)", border:"1px solid rgba(34,197,94,0.4)", color:"#22c55e", fontSize:12, fontWeight:700, cursor:"pointer" }}>
            ENABLE
          </button>
        )}
      </div>

      <main style={{ maxWidth:1400, margin:"0 auto", padding:"20px 16px 80px", display:"grid", gap:16 }}>
        {/* Notices */}
        {notice && <div style={{ padding:"10px 16px", borderRadius:8, background:"rgba(34,197,94,0.1)", border:"1px solid rgba(34,197,94,0.3)", color:"#22c55e", fontSize:14 }}>{notice}</div>}
        {error && <div style={{ padding:"10px 16px", borderRadius:8, background:"rgba(239,68,68,0.1)", border:"1px solid rgba(239,68,68,0.3)", color:"#ef4444", fontSize:14 }}>{error}</div>}
        {statusError && <div style={{ padding:"10px 16px", borderRadius:8, background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.2)", color:"#ef4444", fontSize:13 }}>Status: {statusError}</div>}
        {hasMultipleActive && <div style={{ padding:"10px 16px", borderRadius:8, background:"rgba(239,68,68,0.1)", border:"1px solid rgba(239,68,68,0.3)", color:"#ef4444", fontSize:14 }}>Multiple active LP positions detected ({activeLpCount}). Bot is blocked.</div>}
        {status?.lastError && (
          <div style={{ padding:"10px 16px", borderRadius:8, background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.2)", color:"#ef4444", fontSize:13, wordBreak:"break-word" }}>
            <strong>Last Error:</strong> {typeof status.lastError === "string" ? status.lastError : (status.ops?.lastError as { message?: string })?.message || JSON.stringify(status.lastError)}
          </div>
        )}

        {/* ZONES 2+3+4: Three-column grid */}
        <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : isTablet ? "1fr 1fr" : "28fr 42fr 30fr", gap: isMobile ? 12 : 16, alignItems:"start" }}>

          {/* ZONE 2: Position Visual */}
          <div style={{ display:"grid", gap:12 }}>
            <Uc6Card title="LP Position" accent>
              <BandVisualizer
                hasPosition={hasActiveLpPosition}
                inRange={inRange}
                tickLower={status?.position?.tickLower ?? null}
                tickUpper={status?.position?.tickUpper ?? null}
                currentTick={status?.market?.tick?.current ?? null}
                spotPrice={n(status?.market?.spotPrice?.usdcPerWeth, 0)}
                bandHalfPct={actualBandHalfPct ?? configuredBandHalfPct}
                timeInRangePct={status?.ops?.timeInRange?.pct != null ? n(status.ops.timeInRange.pct, 0) * 100 : null}
                pairLabel={activePairLabel}
                configuredBandHalfPct={configuredBandHalfPct}
                entryAtIso={activeLpEntryAtIso}
                posBandHalfBpsUp={status?.position?.bandHalfBpsUp ?? null}
                posBandHalfBpsDown={status?.position?.bandHalfBpsDown ?? null}
                centerTick={status?.position?.centerTick ?? null}
              />
            </Uc6Card>

            {hasActiveLpPosition && (
              <Uc6Card title="Liquidity Composition">
                <LiquidityComposition
                  lpUsdcSideUsd={lpUsdcSideUsd}
                  lpWethSideUsd={lpWethSideUsd}
                  lpValueUsd={lpValueUsd}
                  lpSplitUsdcPct={lpSplitUsdcPct}
                  lpSplitWethPct={lpSplitWethPct}
                  collectableNowUsd={collectableNowUsd}
                  collectableNowEstimated={collectableNowEstimated}
                  tokenId={status?.position?.tokenId ?? null}
                  pendingCompoundUsd={n(status?.fees?.pendingCompoundUsd, 0)}
                />
              </Uc6Card>
            )}

            {isHoldMode && (
              <Uc6Card title="Hold State">
                <div style={{ display:"grid", gap:8 }}>
                  <Uc6Metric label="Mode" value={<Pill label={strategyMode} tone="warn" />} />
                  <Uc6Metric label="Holding" value={holdTargetLabel} />
                  <Uc6Metric label="Value" value={fmtUsd(holdInventoryValueUsd)} />
                  <Uc6Metric label="Re-entry" value={<Pill label={reEntryView?.eligible ? "READY" : "WAITING"} tone={reEntryView?.eligible ? "good" : "warn"} />} />
                  {reEntryView?.reasonIfBlocked && <Uc6Metric label="Blocked" value={reEntryView.reasonIfBlocked} />}
                </div>
              </Uc6Card>
            )}

            <Uc6Card title="Operations">
              <OpsGrid
                rebalancesToday={n(status?.ops?.rebalancesToday, 0)}
                rebalances24h={n(status?.ops?.rebalances24h, 0)}
                lastRebalanceAtIso={status?.ops?.lastRebalanceAtIso ?? null}
                churnRatio={churnRatio ?? null}
                churnProtectionEnabled={Boolean(status?.settings?.churnProtection?.enabled ?? status?.settings?.churnProtectionEnabled)}
                compoundMode={status?.settings?.compoundMode ?? "threshold_harvest"}
                harvestThresholdUsd={n(status?.settings?.harvestThresholdUsd, 0)}
                cooldownRemaining={cooldownRemaining}
                hodlGateAllowed={hodlGateAllowed}
                hodlGateReason={hodlGateReason}
              />
            </Uc6Card>

            {status?.emissions?.enabled && (
              <Uc6Card title="AERO Emissions">
                <div style={{ display: "grid", gap: 8 }}>
                  <Uc6Metric
                    label="Status"
                    value={
                      <Pill
                        label={status.emissions.staked ? "STAKED" : "NOT STAKED"}
                        tone={status.emissions.staked ? "good" : "muted"}
                      />
                    }
                  />
                  <Uc6Metric
                    label="Claimable AERO"
                    value={`${(status.emissions.claimable?.aero ?? 0).toFixed(4)} AERO \u00b7 ${fmtUsd(status.emissions.claimable?.usd ?? 0)}`}
                  />
                  <Uc6Metric
                    label="Wallet AERO"
                    value={`${(status.emissions.walletBalance?.aero ?? 0).toFixed(4)} AERO \u00b7 ${fmtUsd(status.emissions.walletBalance?.usd ?? 0)}`}
                  />
                  <Uc6Metric
                    label="AERO Price"
                    value={fmtUsd(status.emissions.price?.aeroUsd ?? 0)}
                  />
                  {status.emissions.gaugeAlive === false && (
                    <div style={{ padding: "6px 10px", borderRadius: 6, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#ef4444", fontSize: 12 }}>
                      Gauge is not alive
                    </div>
                  )}
                  {status.emissions.autoStakeBlockedReason && !status.emissions.staked && (
                    <div style={{ padding: "6px 10px", borderRadius: 6, background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)", color: "#f59e0b", fontSize: 12 }}>
                      Auto-stake blocked: {status.emissions.autoStakeBlockedReason}
                    </div>
                  )}
                  {status.emissions.rewardToken?.symbol === "UNKNOWN" && (
                    <div style={{ padding: "6px 10px", borderRadius: 6, background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)", color: "#f59e0b", fontSize: 12 }}>
                      Reward token is not AERO
                    </div>
                  )}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontSize: 11, color: "#999" }}>
                    <span>Auto-stake: {status.emissions.settings?.autoStakeOnMint ? "ON" : "OFF"}</span>
                    <span>Auto-claim: {status.emissions.settings?.autoClaim ? "ON" : "OFF"}</span>
                  </div>
                  {isOwner && (
                    <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                      <button
                        onClick={stakeEmissions}
                        disabled={!!busy || status.emissions.staked || status.emissions.gaugeAlive === false}
                        style={{
                          padding: "6px 14px",
                          borderRadius: 6,
                          border: "1px solid rgba(6,182,212,0.4)",
                          background: "rgba(6,182,212,0.1)",
                          color: "#06b6d4",
                          fontSize: 12,
                          cursor: !!busy || status.emissions.staked || status.emissions.gaugeAlive === false ? "not-allowed" : "pointer",
                          opacity: !!busy || status.emissions.staked || status.emissions.gaugeAlive === false ? 0.4 : 1,
                        }}
                      >
                        {busy === "emissions-stake" ? "Staking\u2026" : "Stake"}
                      </button>
                      <button
                        onClick={unstakeEmissions}
                        disabled={!!busy || !status.emissions.staked}
                        style={{
                          padding: "6px 14px",
                          borderRadius: 6,
                          border: "1px solid rgba(245,158,11,0.4)",
                          background: "rgba(245,158,11,0.1)",
                          color: "#f59e0b",
                          fontSize: 12,
                          cursor: !!busy || !status.emissions.staked ? "not-allowed" : "pointer",
                          opacity: !!busy || !status.emissions.staked ? 0.4 : 1,
                        }}
                      >
                        {busy === "emissions-unstake" ? "Unstaking\u2026" : "Unstake"}
                      </button>
                      <button
                        onClick={claimEmissions}
                        disabled={!!busy || !status.emissions.staked || (status.emissions.claimable?.aero ?? 0) <= 0}
                        style={{
                          padding: "6px 14px",
                          borderRadius: 6,
                          border: "1px solid rgba(34,197,94,0.4)",
                          background: "rgba(34,197,94,0.1)",
                          color: "#22c55e",
                          fontSize: 12,
                          cursor: !!busy || !status.emissions.staked || (status.emissions.claimable?.aero ?? 0) <= 0 ? "not-allowed" : "pointer",
                          opacity: !!busy || !status.emissions.staked || (status.emissions.claimable?.aero ?? 0) <= 0 ? 0.4 : 1,
                        }}
                      >
                        {busy === "emissions-claim" ? "Claiming\u2026" : "Claim AERO"}
                      </button>
                    </div>
                  )}
                </div>
              </Uc6Card>
            )}
          </div>

          {/* ZONE 3: Live Economics */}
          <div style={{ display:"grid", gap:12 }}>
            <Uc6Card title="Fee Economics (incl. active position)">
              <FeeWaterfall status={status} />
            </Uc6Card>

            <Uc6Card title="Alpha vs HODL">
              <AlphaCard
                alphaLiveUsd={alphaLiveUsd}
                feesNetLiveUsd={feesNetLiveUsd}
                divVsHodlLiveUsd={divVsHodlLiveUsd}
                requiredFeesToBeatHodlLiveUsd={requiredFeesToBeatHodlLiveUsd}
                hodlGateAllowed={hodlGateAllowed}
                hodlGateReason={hodlGateReason}
                alphaTodayUsd={n(status?.pnl?.netTodayUsd, 0)}
                feesCollectedUsd={_feesCollected + _collectableNow}
                rewardsClaimedUsd={_rewardsClaimed + _claimableAero}
                totalCostsUsd={_totalCosts}
              />
            </Uc6Card>

            {/* Event Feed */}
            {events.length > 0 && (
              <Uc6Card title="Recent Events">
                <EventFeed events={events} />
              </Uc6Card>
            )}
          </div>

          {/* ZONE 4: Signals */}
          <div style={{ display:"grid", gap:12 }}>
            <Uc6Card title="Regime">
              <RegimeGauge
                label={regimeStatus?.label ?? null}
                thetaStrength={regimeStatus?.thetaStrength ?? 0}
                confidencePct={regimeConfidencePct}
                halfLifeLabel={regimeHalfLifeLabel}
                theta={regimeStatus?.theta ?? null}
                sigma={regimeStatus?.sigma ?? null}
                muPrice={regimeMuPrice}
                sampleCount={regimeStatus?.sampleCount ?? 0}
                windowSec={regimeStatus?.windowSec ?? n(status?.settings?.regime?.windowSec, 0)}
                enabled={Boolean(status?.settings?.regime?.enabled)}
                baseEdgePct={regimeBaseEdgePct}
                effectiveEdgePct={regimeEffectiveEdgePct}
                baseBandBps={regimeBaseBandBps}
                effectiveBandBps={regimeEffectiveBandBps}
                baseBandBpsUp={regimeBaseBandBpsUp}
                baseBandBpsDown={regimeBaseBandBpsDown}
                effectiveBandBpsUp={regimeEffectiveBandBpsUp}
                effectiveBandBpsDown={regimeEffectiveBandBpsDown}
                fast={regimeStatus?.fast ?? null}
                adviceReason={status?.decision?.adviceReason ?? null}
              />
            </Uc6Card>

            <Uc6Card title="Trend Escape">
              <TrendEscapeCard
                enabled={Boolean(trendEscapeView?.enabled ?? status?.settings?.trendEscape?.enabled)}
                eligible={Boolean(trendEscapeView?.eligible)}
                holdTarget={trendEscapeView?.holdTargetIfEscape ?? null}
                reasonIfBlocked={trendEscapeView?.reasonIfBlocked ?? null}
                cooldownUntilIso={trendEscapeView?.cooldownUntilIso ?? null}
                trendDirection={trendView?.direction ?? "flat"}
                trendMovePct={trendMovePct}
                urgency={trendEscapeView?.urgency ?? null}
                diagnostics={(trendEscapeView?.diagnostics as Record<string, unknown>) ?? null}
              />
            </Uc6Card>

            <Uc6Card title="Re-Entry Gate">
              <ReEntryCard
                enabled={Boolean(reEntryView?.enabled ?? status?.settings?.reEntry?.enabled)}
                eligible={Boolean(reEntryView?.eligible)}
                reasonIfBlocked={reEntryView?.reasonIfBlocked ?? null}
                eligibleAtIso={reEntryView?.eligibleAtIso ?? null}
                distanceFromMuPct={distanceFromMuPctDisplay}
                strategyMode={strategyMode}
                holdElapsedSec={Number(reEntryView?.holdElapsedSec || 0)}
                holdRequiredSec={Number(reEntryView?.holdRequiredSec || 0)}
                escapeCooldownUntilIso={reEntryView?.escapeCooldownUntilIso ?? null}
                reEntryCooldownUntilIso={reEntryView?.reEntryCooldownUntilIso ?? null}
                regimeLabel={String(reEntryView?.regimeLabel || "unknown")}
                regimeConfidence={Number(reEntryView?.regimeConfidence || 0)}
                requiredRegimeLabel={String(reEntryView?.requiredRegimeLabel || "mean_reverting")}
                requiredMinConfidence={Number(reEntryView?.requiredMinConfidence || 0)}
                meanRevertConfirmSec={Number(reEntryView?.meanRevertConfirmSec || 0)}
                requiredMeanRevertConfirmSec={Number(reEntryView?.requiredMeanRevertConfirmSec || 0)}
                maxDistanceFromMuPct={Number(reEntryView?.maxDistanceFromMuPct || 0)}
              />
            </Uc6Card>

            <Uc6Card title="HODL Gate">
              <HodlGateCard
                allowed={hodlGateAllowed}
                reason={hodlGateReason}
                alphaLiveUsd={alphaLiveUsd}
                requiredUsd={requiredFeesToBeatHodlLiveUsd}
                enabled={Boolean(hodlGateView?.enabled)}
                outOfRangeDurationSec={n(hodlGateView?.outOfRangeDurationSec, 0)}
                distanceBeyondEdgePct={n(hodlGateView?.distanceBeyondEdgePct, 0)}
                outOfRangeMaxSec={n(status?.settings?.hodlGate?.outOfRangeMaxSec, 900)}
                outOfRangeEmergencyMinSec={n(status?.settings?.hodlGate?.outOfRangeEmergencyMinSec, 60)}
                outOfRangeEmergencyEdgePct={n(status?.settings?.hodlGate?.outOfRangeEmergencyEdgePct, 1.15)}
                allowCloseIfOutOfRange={Boolean(status?.settings?.hodlGate?.allowCloseIfOutOfRange)}
                inRange={inRange}
              />
            </Uc6Card>
          </div>
        </div>

        {/* ZONE 5: Analytics Row */}
        <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(280px, 1fr))", gap: isMobile ? 12 : 16 }}>
          <Uc6Card title="Net P&L Windows">
            <PnlWindows status={status} />
          </Uc6Card>

          <Uc6Card title="Band Performance">
            {bandPerformanceRows.length === 0 ? (
              <div style={{ color:"rgba(232,232,240,0.4)", fontSize:13, padding:"12px 0" }}>No band performance data yet.</div>
            ) : (
              <DarkTable
                headers={["Band", "Runs", "Alpha (bps)", "Win%", "Cost (bps)", "Avg Time"]}
                rows={bandPerformanceRows}
              />
            )}
          </Uc6Card>

          <Uc6Card title="Pool Comparison">
            <PoolComparisonCard
              current={poolComparisonCurrent}
              top5={poolComparisonTop5}
              computedAtIso={poolComparison?.computedAtIso ?? null}
            />
          </Uc6Card>
        </div>

        {/* ZONE 6: Position History */}
        <Uc6Card title="Position History">
          <details>
            <summary style={{ cursor:"pointer", color:"rgba(232,232,240,0.6)", fontSize:13, padding:"4px 0", marginBottom:8 }}>
              Closed Positions ({positionsPage?.totalItems ?? 0}) · click to expand
            </summary>
            <div>
              {closedPositionRecords.length === 0 ? (
                <div style={{ color:"rgba(232,232,240,0.4)", fontSize:13, padding:"12px 0" }}>No closed positions.</div>
              ) : (
                <>
                  <DarkTable
                    headers={["Opened", "Duration", "Band", "Entry $", "Exit $", "Fees", "AERO", "Costs", "Net", "Alpha vs HODL", "Reason"]}
                    rows={closedPositionRecords.map((rec) => [
                      fmtIsoLocal(rec.entry?.openedAtIso),
                      rec.duration?.human || fmtDurationCompact(rec.duration?.secondsInPosition),
                      formatRecordBandLabel(rec),
                      fmtUsd(rec.entry?.entryValueUsd),
                      fmtUsd(rec.exit?.exitValueUsd),
                      fmtUsd(rec.performance?.feesCollectedUsd),
                      fmtUsd(rec.performance?.rewardsUsd),
                      fmtUsd(rec.performance?.totalCostsUsd),
                      fmtSignedUsd(rec.performance?.feesNetUsd),
                      fmtSignedUsd(rec.performance?.alphaVsHodlUsd),
                      rec.closeReason || "—",
                    ])}
                    onRowClick={(idx) => setSelectedPosition(closedPositionRecords[idx])}
                  />
                  {positionsPageCount > 1 && (
                    <div style={{ display:"flex", gap:8, alignItems:"center", marginTop:12, fontSize:13, color:"rgba(232,232,240,0.6)" }}>
                      <button onClick={() => setPositionsPageNum(Math.max(1, positionsCurrentPage - 1))} disabled={positionsCurrentPage <= 1} style={darkBtnStyle}>Prev</button>
                      <span>{positionsCurrentPage} / {positionsPageCount}</span>
                      <button onClick={() => setPositionsPageNum(Math.min(positionsPageCount, positionsCurrentPage + 1))} disabled={positionsCurrentPage >= positionsPageCount} style={darkBtnStyle}>Next</button>
                    </div>
                  )}
                </>
              )}

              {positionsTaxSummary && (
                <details style={{ marginTop:16 }}>
                  <summary style={{ cursor:"pointer", color:"rgba(232,232,240,0.6)", fontSize:13 }}>Tax Summary (closed positions only)</summary>
                  <TaxSummary taxSummary={positionsTaxSummary} />
                </details>
              )}
            </div>
          </details>
        </Uc6Card>

        {/* ZONE 7: Command Center */}
        {isOwner && draft && (
          <div style={{ borderTop:"2px solid #06b6d4", paddingTop:16 }}>
            <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:16 }}>
              <span style={{ color:"#06b6d4", fontWeight:800, fontSize:16, letterSpacing:1 }}>COMMAND CENTER</span>
              <span style={{ color:"rgba(232,232,240,0.45)", fontSize:12, fontFamily:"monospace" }}>
                {shortAddr(walletAddress)}
              </span>
              {!isBase && (
                <button onClick={switchToBase} style={{ ...darkBtnStyle, borderColor:"rgba(245,158,11,0.4)", color:"#f59e0b" }}>Switch to Base</button>
              )}
            </div>

            <div style={{ display:"grid", gap:10 }}>
              {/* Section 1: Strategy */}
              <details>
                <summary style={cmdSectionStyle}>STRATEGY</summary>
                <div style={{ padding:"16px 0", display:"grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(auto-fill, minmax(200px, 1fr))", gap:10 }}>
                  <NumberField label="bandHalfBps" value={draft.bandHalfBps} onChange={(v) => updateNumber("bandHalfBps", v)} />
                  <NullableNumberField label="bandHalfBpsUp (↑)" value={draft.bandHalfBpsUp} placeholder="= bandHalfBps" onChange={(v) => setDraft((p) => p ? { ...p, bandHalfBpsUp: v } : p)} />
                  <NullableNumberField label="bandHalfBpsDown (↓)" value={draft.bandHalfBpsDown} placeholder="= bandHalfBps" onChange={(v) => setDraft((p) => p ? { ...p, bandHalfBpsDown: v } : p)} />
                  <NumberField label="edgeRebalancePct" value={draft.edgeRebalancePct} step="0.01" onChange={(v) => updateNumber("edgeRebalancePct", v)} />
                  <NumberField label="minRebalanceIntervalSec" value={draft.minRebalanceIntervalSec} onChange={(v) => updateNumber("minRebalanceIntervalSec", v)} />
                  <NumberField label="maxRebalancesPerDay" value={draft.maxRebalancesPerDay} onChange={(v) => updateNumber("maxRebalancesPerDay", v)} />
                  <NumberField label="slippageBps" value={draft.slippageBps} onChange={(v) => updateNumber("slippageBps", v)} />
                  <SelectField label="compoundMode" value={draft.compoundMode} onChange={(v) => setDraft((p) => p ? { ...p, compoundMode: v as "on_rebalance" | "threshold_harvest" } : p)} options={["threshold_harvest", "on_rebalance"]} />
                  <NumberField label="harvestThresholdUsd" value={draft.harvestThresholdUsd} step="0.01" onChange={(v) => updateNumber("harvestThresholdUsd", v)} />
                  <NumberField label="maxDeployUsdc" value={draft.maxDeployUsdc} onChange={(v) => updateNumber("maxDeployUsdc", v)} />
                  <NumberField label="maxInitialMintUsdc" value={draft.maxInitialMintUsdc} onChange={(v) => updateNumber("maxInitialMintUsdc", v)} />
                  <NumberField label="reserveMinUsdc" value={draft.reserveMinUsdc} onChange={(v) => updateNumber("reserveMinUsdc", v)} />
                  <NumberField label="reservePct%" value={draft.reservePct} step="0.1" onChange={(v) => updateNumber("reservePct", v)} />
                  <NumberField label="reserveMaxUsdc" value={draft.reserveMaxUsdc} onChange={(v) => updateNumber("reserveMaxUsdc", v)} />
                  <SelectField label="churnProtection" value={draft.churnProtectionEnabled ? "true" : "false"} onChange={(v) => updateBool("churnProtectionEnabled", v === "true")} options={["false", "true"]} />
                  <NumberField label="churnMaxCostToFeeRatio%" value={draft.churnMaxCostToFeeRatio} step="1" onChange={(v) => updateNumber("churnMaxCostToFeeRatio", v)} />
                  <NumberField label="failureCooldownSec" value={draft.failureCooldownSec} onChange={(v) => updateNumber("failureCooldownSec", v)} />
                </div>
              </details>

              {/* Section 2: Regime Engine */}
              <details>
                <summary style={cmdSectionStyle}>REGIME ENGINE</summary>
                <div style={{ padding:"16px 0", display:"grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(auto-fill, minmax(200px, 1fr))", gap:10 }}>
                  <SelectField label="regime.enabled" value={draft.regimeEnabled ? "true" : "false"} onChange={(v) => updateBool("regimeEnabled", v === "true")} options={["false", "true"]} />
                  <NumberField label="regime.windowSec (slow)" value={draft.regimeWindowSec} onChange={(v) => updateNumber("regimeWindowSec", v)} />
                  <NumberField label="regime.sampleEverySec" value={draft.regimeSampleEverySec} onChange={(v) => updateNumber("regimeSampleEverySec", v)} />
                  <NumberField label="regime.minSamples" value={draft.regimeMinSamples} onChange={(v) => updateNumber("regimeMinSamples", v)} />
                  <NumberField label="regime.fastWindowSec" value={draft.regimeFastWindowSec} onChange={(v) => updateNumber("regimeFastWindowSec", v)} />
                  <NumberField label="regime.fastSampleEverySec" value={draft.regimeFastSampleEverySec} onChange={(v) => updateNumber("regimeFastSampleEverySec", v)} />
                  <NumberField label="regime.fastMinSamples" value={draft.regimeFastMinSamples} onChange={(v) => updateNumber("regimeFastMinSamples", v)} />
                  <NumberField label="regime.fastWeight" value={draft.regimeFastWeight} step="0.05" onChange={(v) => updateNumber("regimeFastWeight", v)} />
                  <NumberField label="regime.mrHalfLifeMaxSec" value={draft.regimeMrHalfLifeMaxSec} onChange={(v) => updateNumber("regimeMrHalfLifeMaxSec", v)} />
                  <NumberField label="regime.trendHalfLifeMinSec" value={draft.regimeTrendHalfLifeMinSec} onChange={(v) => updateNumber("regimeTrendHalfLifeMinSec", v)} />
                  <NumberField label="regime.maxEdgeAdj" value={draft.regimeMaxEdgeAdj} step="0.01" onChange={(v) => updateNumber("regimeMaxEdgeAdj", v)} />
                  <NumberField label="regime.maxBandAdjBps (widen)" value={draft.regimeMaxBandAdjBps} onChange={(v) => updateNumber("regimeMaxBandAdjBps", v)} />
                  <NumberField label="regime.maxBandNarrowBps" value={draft.regimeMaxBandNarrowBps} onChange={(v) => updateNumber("regimeMaxBandNarrowBps", v)} />
                  <NumberField label="regime.maxCooldownAdjSec" value={draft.regimeMaxCooldownAdjSec} onChange={(v) => updateNumber("regimeMaxCooldownAdjSec", v)} />
                </div>
              </details>

              {/* Section 3: HODL Gate */}
              <details>
                <summary style={cmdSectionStyle}>HODL GATE</summary>
                <div style={{ padding:"16px 0", display:"grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(auto-fill, minmax(200px, 1fr))", gap:10 }}>
                  <SelectField label="hodlGate.enabled" value={draft.hodlGateEnabled ? "true" : "false"} onChange={(v) => updateBool("hodlGateEnabled", v === "true")} options={["false", "true"]} />
                </div>
              </details>

              {/* Section 4: Trend Escape */}
              <details>
                <summary style={cmdSectionStyle}>TREND ESCAPE</summary>
                <div style={{ padding:"16px 0", display:"grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(auto-fill, minmax(200px, 1fr))", gap:10 }}>
                  <SelectField label="trendEscape.enabled" value={draft.trendEscapeEnabled ? "true" : "false"} onChange={(v) => updateBool("trendEscapeEnabled", v === "true")} options={["false", "true"]} />
                  <NumberField label="trendEscape.minRegimeConfidence" value={draft.trendEscapeMinRegimeConfidence} step="0.01" onChange={(v) => updateNumber("trendEscapeMinRegimeConfidence", v)} />
                  <NumberField label="trendEscape.minEdgeProgressToConsider" value={draft.trendEscapeMinEdgeProgressToConsider} step="0.05" onChange={(v) => updateNumber("trendEscapeMinEdgeProgressToConsider", v)} />
                  <NumberField label="trendEscape.baseConfirmSec" value={draft.trendEscapeBaseConfirmSec} step="10" onChange={(v) => updateNumber("trendEscapeBaseConfirmSec", v)} />
                  <NumberField label="trendEscape.urgencyThreshold" value={draft.trendEscapeUrgencyThreshold} step="0.05" onChange={(v) => updateNumber("trendEscapeUrgencyThreshold", v)} />
                  <NumberField label="trendEscape.directionLookbackSec" value={draft.trendEscapeDirectionLookbackSec} onChange={(v) => updateNumber("trendEscapeDirectionLookbackSec", v)} />
                  <NumberField label="trendEscape.minTrendMovePct" value={draft.trendEscapeMinTrendMovePct} step="0.0001" onChange={(v) => updateNumber("trendEscapeMinTrendMovePct", v)} />
                  <NumberField label="trendEscape.minTrendConfirmSec" value={draft.trendEscapeMinTrendConfirmSec} onChange={(v) => updateNumber("trendEscapeMinTrendConfirmSec", v)} />
                  <NumberField label="trendEscape.cooldownAfterEscapeSec" value={draft.trendEscapeCooldownAfterEscapeSec} onChange={(v) => updateNumber("trendEscapeCooldownAfterEscapeSec", v)} />
                  <NumberField label="trendEscape.minAlphaUsdToEscape" value={draft.trendEscapeMinAlphaUsdToEscape} step="0.01" onChange={(v) => updateNumber("trendEscapeMinAlphaUsdToEscape", v)} />
                  <NumberField label="trendEscape.emergencyOutOfRangeEdgePct" value={draft.trendEscapeEmergencyOutOfRangeEdgePct} step="0.01" onChange={(v) => updateNumber("trendEscapeEmergencyOutOfRangeEdgePct", v)} />
                  <NumberField label="trendEscape.emergencyMinOutOfRangeSec" value={draft.trendEscapeEmergencyMinOutOfRangeSec} onChange={(v) => updateNumber("trendEscapeEmergencyMinOutOfRangeSec", v)} />
                  <SelectField label="uptrendHold" value={draft.trendEscapeUptrendHold} onChange={(v) => setDraft((p) => p ? { ...p, trendEscapeUptrendHold: v as "WETH"|"USDC"|"50_50" } : p)} options={["WETH","USDC","50_50"]} />
                  <SelectField label="downtrendHold" value={draft.trendEscapeDowntrendHold} onChange={(v) => setDraft((p) => p ? { ...p, trendEscapeDowntrendHold: v as "WETH"|"USDC"|"50_50" } : p)} options={["USDC","WETH","50_50"]} />
                  <SelectField label="fallbackHold" value={draft.trendEscapeFallbackHold} onChange={(v) => setDraft((p) => p ? { ...p, trendEscapeFallbackHold: v as "WETH"|"USDC"|"50_50" } : p)} options={["50_50","WETH","USDC"]} />
                </div>
              </details>

              {/* Section 5: Re-Entry */}
              <details>
                <summary style={cmdSectionStyle}>RE-ENTRY</summary>
                <div style={{ padding:"16px 0", display:"grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(auto-fill, minmax(200px, 1fr))", gap:10 }}>
                  <SelectField label="reEntry.enabled" value={draft.reEntryEnabled ? "true" : "false"} onChange={(v) => updateBool("reEntryEnabled", v === "true")} options={["false", "true"]} />
                  <NumberField label="reEntry.minRegimeConfidence" value={draft.reEntryMinRegimeConfidence} step="0.01" onChange={(v) => updateNumber("reEntryMinRegimeConfidence", v)} />
                  <NumberField label="reEntry.minMeanRevertConfirmSec" value={draft.reEntryMinMeanRevertConfirmSec} onChange={(v) => updateNumber("reEntryMinMeanRevertConfirmSec", v)} />
                  <NumberField label="reEntry.maxDistanceFromMuPct" value={draft.reEntryMaxDistanceFromMuPct} step="0.0001" onChange={(v) => updateNumber("reEntryMaxDistanceFromMuPct", v)} />
                  <NumberField label="reEntry.minHoldSec" value={draft.reEntryMinHoldSec} onChange={(v) => updateNumber("reEntryMinHoldSec", v)} />
                  <NumberField label="reEntry.cooldownAfterReEntrySec" value={draft.reEntryCooldownAfterReEntrySec} onChange={(v) => updateNumber("reEntryCooldownAfterReEntrySec", v)} />
                </div>
              </details>

              {/* Section 5: Execution */}
              <details>
                <summary style={cmdSectionStyle}>EXECUTION & CAPS</summary>
                <div style={{ padding:"16px 0", display:"grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(auto-fill, minmax(200px, 1fr))", gap:10 }}>
                  <SelectField label="venue" value={draft.venue} onChange={(v) => setDraft((p) => p ? { ...p, venue: v as "slipstream"|"uniswapv3" } : p)} options={["slipstream","uniswapv3"]} />
                  <NumberField label="pollIntervalMs" value={draft.pollIntervalMs} onChange={(v) => updateNumber("pollIntervalMs", v)} />
                  <SelectField label="wsEnabled" value={draft.wsEnabled ? "true" : "false"} onChange={(v) => updateBool("wsEnabled", v === "true")} options={["true","false"]} />
                  <NumberField label="minTopUpUsd" value={draft.minTopUpUsd} onChange={(v) => updateNumber("minTopUpUsd", v)} />
                  <NumberField label="dashboardRecommendedPollMs" value={draft.dashboardRecommendedPollMs} onChange={(v) => updateNumber("dashboardRecommendedPollMs", v)} />
                </div>

                <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginTop:8 }}>
                  <button onClick={saveSettings} disabled={busy !== ""} style={{ padding:"8px 20px", borderRadius:6, background:"rgba(6,182,212,0.15)", border:"1px solid rgba(6,182,212,0.4)", color:"#06b6d4", fontWeight:700, cursor:"pointer", fontSize:14, ...(isMobile ? { width:"100%" } : {}) }}>
                    {busy === "save" ? "Saving..." : "Save All Settings"}
                  </button>
                  <button onClick={forceRebalance} disabled={busy !== ""} style={{ padding:"8px 20px", borderRadius:6, background:"rgba(245,158,11,0.15)", border:"1px solid rgba(245,158,11,0.4)", color:"#f59e0b", fontWeight:700, cursor:"pointer", fontSize:14, ...(isMobile ? { width:"100%" } : {}) }}>
                    Force Rebalance
                  </button>
                  {hasActiveLpPosition && (
                    <button onClick={liquidateAndPause} disabled={busy !== ""} style={{ padding:"8px 20px", borderRadius:6, background:"rgba(239,68,68,0.15)", border:"1px solid rgba(239,68,68,0.4)", color:"#ef4444", fontWeight:700, cursor:"pointer", fontSize:14, ...(isMobile ? { width:"100%" } : {}) }}>
                      Liquidate LP + Pause
                    </button>
                  )}
                </div>
              </details>
            </div>
          </div>
        )}

        {/* Debug */}
        <details style={{ marginTop:8 }}>
          <summary style={{ cursor:"pointer", color:"rgba(232,232,240,0.3)", fontSize:12 }}>Raw debug JSON</summary>
          <pre style={{ fontSize:11, color:"rgba(232,232,240,0.5)", overflow:"auto", maxHeight:400, background:"rgba(0,0,0,0.3)", padding:12, borderRadius:6, marginTop:8 }}>
            {JSON.stringify(status, null, 2)}
          </pre>
        </details>
      </main>

      <PositionRecordDrawer record={selectedPosition} onClose={() => setSelectedPosition(null)} />
    </>
  );
}

// ─── module-level style constants ────────────────────────────────────────────

const darkBtnStyle: CSSProperties = { padding:"4px 12px", borderRadius:6, background:"transparent", border:"1px solid rgba(255,255,255,0.15)", color:"rgba(232,232,240,0.7)", fontSize:12, cursor:"pointer" };
const cmdSectionStyle: CSSProperties = { cursor:"pointer", color:"#06b6d4", fontWeight:700, fontSize:13, letterSpacing:1, padding:"8px 0 8px 4px", display:"block", borderBottom:"1px solid rgba(6,182,212,0.2)" };

function strategyModePillStyle(mode: string): CSSProperties {
  const base: CSSProperties = { padding:"3px 12px", borderRadius:20, fontSize:12, fontWeight:800, letterSpacing:0.5 };
  if (mode === "LP_ACTIVE") return { ...base, background:"rgba(6,182,212,0.2)", color:"#06b6d4", border:"1px solid rgba(6,182,212,0.4)" };
  if (mode === "HOLD_WETH") return { ...base, background:"rgba(245,158,11,0.2)", color:"#f59e0b", border:"1px solid rgba(245,158,11,0.4)" };
  if (mode === "HOLD_USDC") return { ...base, background:"rgba(59,130,246,0.2)", color:"#60a5fa", border:"1px solid rgba(59,130,246,0.4)" };
  if (mode === "HOLD_50_50") return { ...base, background:"rgba(168,85,247,0.2)", color:"#c084fc", border:"1px solid rgba(168,85,247,0.4)" };
  return { ...base, background:"rgba(255,255,255,0.08)", color:"rgba(232,232,240,0.6)", border:"1px solid rgba(255,255,255,0.15)" };
}

// ─── sub-components ───────────────────────────────────────────────────────────

function Uc6Card({ title, children, accent }: { title: string; children: ReactNode; accent?: boolean }) {
  return (
    <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:12, padding:16, ...(accent ? { borderTop:"2px solid #06b6d4" } : {}) }}>
      <div style={{ fontSize:11, fontWeight:700, color:"rgba(232,232,240,0.45)", textTransform:"uppercase", letterSpacing:1.2, marginBottom:12 }}>{title}</div>
      {children}
    </div>
  );
}

function Uc6Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display:"grid", gap:2 }}>
      <div style={{ fontSize:10, color:"rgba(232,232,240,0.4)", textTransform:"uppercase", letterSpacing:0.8 }}>{label}</div>
      <div style={{ fontSize:13, color:"#e8e8f0", fontFamily: typeof value === "string" && (value.startsWith("$") || value.includes(".")) ? "monospace" : "inherit" }}>{value}</div>
    </div>
  );
}

function Pill({ label, tone }: { label: string; tone: "good" | "warn" | "bad" | "muted" }) {
  const s: CSSProperties = {
    display:"inline-block", padding:"2px 8px", borderRadius:20, fontSize:11, fontWeight:700, letterSpacing:0.5,
    background: tone==="good" ? "rgba(34,197,94,0.15)" : tone==="warn" ? "rgba(245,158,11,0.15)" : tone==="bad" ? "rgba(239,68,68,0.15)" : "rgba(255,255,255,0.07)",
    color: tone==="good" ? "#22c55e" : tone==="warn" ? "#f59e0b" : tone==="bad" ? "#ef4444" : "rgba(232,232,240,0.45)",
    border: `1px solid ${tone==="good" ? "rgba(34,197,94,0.3)" : tone==="warn" ? "rgba(245,158,11,0.3)" : tone==="bad" ? "rgba(239,68,68,0.3)" : "rgba(255,255,255,0.1)"}`,
  };
  return <span style={s}>{label}</span>;
}

function DarkTable({ headers, rows, onRowClick }: { headers: string[]; rows: Array<Array<ReactNode>>; onRowClick?: (idx: number) => void }) {
  return (
    <div style={{ overflowX:"auto" }}>
      <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} style={{ padding:"6px 8px", textAlign:"left", fontSize:10, color:"rgba(232,232,240,0.4)", fontWeight:600, letterSpacing:0.8, textTransform:"uppercase", borderBottom:"1px solid rgba(255,255,255,0.08)" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={headers.length} style={{ padding:"16px 8px", color:"rgba(232,232,240,0.3)", textAlign:"center" }}>No data</td></tr>
          ) : rows.map((row, i) => (
            <tr key={i} onClick={() => onRowClick?.(i)} style={{ cursor: onRowClick ? "pointer" : "default", borderBottom:"1px solid rgba(255,255,255,0.04)" }}
              onMouseEnter={(e) => { if (onRowClick) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.03)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              {row.map((cell, j) => (
                <td key={j} style={{ padding:"6px 8px", color:"rgba(232,232,240,0.75)", fontFamily:"monospace", verticalAlign:"middle" }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const darkInputStyle: CSSProperties = { background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.12)", borderRadius:6, padding:"4px 8px", color:"#e8e8f0", fontSize:12, width:"100%", boxSizing:"border-box" };
const darkLabelStyle: CSSProperties = { display:"grid", gap:4, fontSize:12 };
const darkLabelSpanStyle: CSSProperties = { fontSize:10, color:"rgba(232,232,240,0.45)", textTransform:"uppercase", letterSpacing:0, lineHeight:1.3, wordBreak:"break-word", overflowWrap:"break-word" };

function NumberField({ label, value, onChange, step = "1" }: { label: string; value: number; onChange: (next: string) => void; step?: string }) {
  return (
    <label style={darkLabelStyle}>
      <span style={darkLabelSpanStyle}>{label}</span>
      <input type="number" step={step} value={value} onChange={(e) => onChange(e.target.value)} style={darkInputStyle} />
    </label>
  );
}

function NullableNumberField({ label, value, onChange, step = "1", placeholder = "inherit" }: { label: string; value: number | null; onChange: (next: number | null) => void; step?: string; placeholder?: string }) {
  return (
    <label style={darkLabelStyle}>
      <span style={darkLabelSpanStyle}>{label}</span>
      <input
        type="number"
        step={step}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value.trim();
          onChange(raw === "" ? null : Number(raw));
        }}
        style={darkInputStyle}
      />
    </label>
  );
}

function SelectField({ label, value, onChange, options, disabled }: { label: string; value: string; onChange: (next: string) => void; options: string[]; disabled?: boolean }) {
  return (
    <label style={darkLabelStyle}>
      <span style={darkLabelSpanStyle}>{label}</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} style={darkInputStyle}>
        {options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    </label>
  );
}

function BandVisualizer({ hasPosition, inRange, tickLower, tickUpper, currentTick, spotPrice, bandHalfPct, timeInRangePct, pairLabel: pairLbl, configuredBandHalfPct, entryAtIso, posBandHalfBpsUp, posBandHalfBpsDown, centerTick }: {
  hasPosition: boolean;
  inRange: boolean;
  tickLower: number | null;
  tickUpper: number | null;
  currentTick: number | null;
  spotPrice: number;
  bandHalfPct: number | null;
  timeInRangePct: number | null;
  pairLabel: string;
  configuredBandHalfPct: number;
  entryAtIso?: string | null;
  posBandHalfBpsUp?: number | null;
  posBandHalfBpsDown?: number | null;
  centerTick?: number | null;
}) {
  if (!hasPosition) return <div style={{ color:"rgba(232,232,240,0.4)", fontSize:13, padding:"20px 0", textAlign:"center" }}>No active LP position</div>;

  const priceDotPct = (() => {
    if (tickLower == null || tickUpper == null || currentTick == null) return 50;
    const total = tickUpper - tickLower;
    if (total <= 0) return 50;
    return Math.max(0, Math.min(100, ((currentTick - tickLower) / total) * 100));
  })();

  const lowerEdgePrice = (() => {
    if (!spotPrice || tickLower == null || currentTick == null) return null;
    return spotPrice * Math.pow(1.0001, tickLower - currentTick);
  })();

  const upperEdgePrice = (() => {
    if (!spotPrice || tickUpper == null || currentTick == null) return null;
    return spotPrice * Math.pow(1.0001, tickUpper - currentTick);
  })();

  const ticksToLower = currentTick != null && tickLower != null ? currentTick - tickLower : null;
  const ticksToUpper = currentTick != null && tickUpper != null ? tickUpper - currentTick : null;

  const actualBandStr = (() => {
    // Show band width at mint (not live distance to edges)
    if (posBandHalfBpsUp != null || posBandHalfBpsDown != null) {
      const upPct = ((posBandHalfBpsUp ?? posBandHalfBpsDown!) / 100).toFixed(2);
      const downPct = ((posBandHalfBpsDown ?? posBandHalfBpsUp!) / 100).toFixed(2);
      return `\u2191${upPct}% \u2193${downPct}%`;
    }
    // Direction-aware from ticks + centerTick
    const dirLabel = formatBandLabelDirectional(tickLower, tickUpper, centerTick, undefined);
    if (dirLabel !== "\u2014") return dirLabel;
    return bandHalfPct != null ? `\u00b1${bandHalfPct.toFixed(2)}%` : `\u00b1${configuredBandHalfPct.toFixed(2)}% (cfg)`;
  })();

  const trackColor = inRange ? "rgba(6,182,212,0.15)" : "rgba(239,68,68,0.1)";
  const dotColor = inRange ? "#06b6d4" : "#ef4444";
  const fillColor = inRange ? "rgba(6,182,212,0.25)" : "rgba(239,68,68,0.2)";

  return (
    <div style={{ display:"grid", gap:12 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <span style={{ fontSize:13, fontWeight:600, color:"rgba(232,232,240,0.8)" }}>{pairLbl}</span>
        <span style={{ fontSize:12, color:"rgba(232,232,240,0.5)", fontFamily:"monospace" }}>{actualBandStr}</span>
      </div>

      {/* Price labels */}
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, fontFamily:"monospace", color:"rgba(232,232,240,0.5)" }}>
        <span>{lowerEdgePrice != null ? `$${lowerEdgePrice.toFixed(0)}` : "\u2014"}</span>
        <span>{upperEdgePrice != null ? `$${upperEdgePrice.toFixed(0)}` : "\u2014"}</span>
      </div>

      {/* Band track */}
      <div style={{ position:"relative", height:28, borderRadius:14, background:trackColor, border:`1px solid ${inRange ? "rgba(6,182,212,0.3)" : "rgba(239,68,68,0.3)"}`, overflow:"visible" }}>
        {/* Fill from left to dot */}
        <div style={{ position:"absolute", top:0, left:0, bottom:0, width:`${priceDotPct}%`, background:fillColor, borderRadius:"14px 0 0 14px" }} />
        {/* Price dot */}
        <div style={{ position:"absolute", top:"50%", left:`${priceDotPct}%`, transform:"translate(-50%, -50%)", width:18, height:18, borderRadius:"50%", background:dotColor, border:"2px solid #07080f", boxShadow:`0 0 10px ${dotColor}`, zIndex:2 }} />
      </div>

      {/* Spot price label */}
      <div style={{ textAlign:"center", fontSize:14, fontFamily:"monospace", fontWeight:700, color:"#e8e8f0" }}>
        {spotPrice > 0 ? `$${spotPrice.toFixed(2)}` : "\u2014"}
        <span style={{ fontSize:11, color:"rgba(232,232,240,0.45)", marginLeft:4 }}>now</span>
      </div>

      <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"rgba(232,232,240,0.55)" }}>
        <span>Entry</span>
        <span style={{ fontFamily:"monospace" }}>{entryAtIso ? fmtIsoLocal(entryAtIso) : "\u2014"}</span>
      </div>

      {/* Tick distances */}
      {(ticksToLower != null || ticksToUpper != null) && (
        <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"rgba(232,232,240,0.5)" }}>
          <span>{ticksToLower != null ? `${ticksToLower} tks to lower` : ""}</span>
          <span>{ticksToUpper != null ? `${ticksToUpper} tks to upper` : ""}</span>
        </div>
      )}

      {/* Time in range */}
      {timeInRangePct != null && (
        <div style={{ display:"grid", gap:4 }}>
          <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"rgba(232,232,240,0.6)" }}>
            <span>Time In Range</span>
            <span style={{ fontFamily:"monospace", fontWeight:600 }}>{timeInRangePct.toFixed(1)}%</span>
          </div>
          <div style={{ height:6, borderRadius:3, background:"rgba(255,255,255,0.08)" }}>
            <div style={{ height:"100%", width:`${Math.min(100, timeInRangePct)}%`, borderRadius:3, background: timeInRangePct >= 80 ? "#22c55e" : timeInRangePct >= 50 ? "#06b6d4" : "#f59e0b" }} />
          </div>
        </div>
      )}
    </div>
  );
}

function LiquidityComposition({ lpUsdcSideUsd, lpWethSideUsd, lpValueUsd, lpSplitUsdcPct, lpSplitWethPct, collectableNowUsd, collectableNowEstimated, tokenId, pendingCompoundUsd }: {
  lpUsdcSideUsd: number; lpWethSideUsd: number; lpValueUsd: number; lpSplitUsdcPct: number; lpSplitWethPct: number; collectableNowUsd: number; collectableNowEstimated: boolean; tokenId: string|null; pendingCompoundUsd: number;
}) {
  return (
    <div style={{ display:"grid", gap:10 }}>
      <div style={{ display:"flex", gap:4, height:16, borderRadius:8, overflow:"hidden" }}>
        <div style={{ flex: lpSplitUsdcPct, background:"rgba(6,182,212,0.5)", minWidth: lpSplitUsdcPct > 0 ? 2 : 0 }} />
        <div style={{ flex: lpSplitWethPct, background:"rgba(245,158,11,0.5)", minWidth: lpSplitWethPct > 0 ? 2 : 0 }} />
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"rgba(232,232,240,0.7)" }}>
        <span>USDC <span style={{ fontFamily:"monospace", color:"#06b6d4" }}>{fmtUsd(lpUsdcSideUsd)}</span></span>
        <span>WETH <span style={{ fontFamily:"monospace", color:"#f59e0b" }}>{fmtUsd(lpWethSideUsd)}</span></span>
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, borderTop:"1px solid rgba(255,255,255,0.06)", paddingTop:8 }}>
        <span style={{ color:"rgba(232,232,240,0.6)" }}>LP Total</span>
        <span style={{ fontFamily:"monospace", fontWeight:700, color:"#e8e8f0" }}>{fmtUsd(lpValueUsd)}</span>
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:12 }}>
        <span style={{ color:"rgba(232,232,240,0.5)" }}>Collectable{collectableNowEstimated ? " (est)" : ""}</span>
        <span style={{ fontFamily:"monospace", color:"#22c55e" }}>{fmtUsd(collectableNowUsd)}</span>
      </div>
      {pendingCompoundUsd > 0 && (
        <div style={{ display:"flex", justifyContent:"space-between", fontSize:12 }}>
          <span style={{ color:"rgba(232,232,240,0.5)" }}>Pending compound</span>
          <span style={{ fontFamily:"monospace", color:"#e8e8f0" }}>{fmtUsd(pendingCompoundUsd)}</span>
        </div>
      )}
      {tokenId && <div style={{ fontSize:11, color:"rgba(6,182,212,0.7)", fontFamily:"monospace" }}>NFT #{tokenId}</div>}
    </div>
  );
}

function FeeWaterfall({ status: st }: { status: Uc6Status | null }) {
  const [tab, setTab] = useState<"TODAY"|"7D"|"30D"|"ALL">("TODAY");
  const { isMobile: fwIsMobile } = useBreakpoint();
  const nLocal = (v: unknown, fb: number) => { const x = Number(v); return Number.isFinite(x) ? x : fb; };
  // When bot includes live accrual in its stats, don't double-add
  const botIncludesLive = Boolean((st?.fees as any)?.includesLiveAccrual);
  const liveFeesUsd = botIncludesLive ? 0 : nLocal(st?.fees?.collectableNow?.usd, 0);
  const liveRewardsUsd = botIncludesLive ? 0 : nLocal(st?.emissions?.claimable?.usd, 0);
  const liveTotal = liveFeesUsd + liveRewardsUsd;
  const data = {
    TODAY: { fees: nLocal(st?.fees?.collectedTodayUsd,0) + liveFeesUsd, rewards: nLocal(st?.fees?.rewardsTodayUsd,0) + liveRewardsUsd, gas: nLocal(st?.costs?.gasTodayUsd,0), swap: nLocal(st?.costs?.swapCostsTodayUsd,0), mintBurn: nLocal(st?.costs?.mintBurnTodayUsd,0), net: nLocal(st?.pnl?.netTodayUsd,0) + liveTotal },
    "7D": { fees: nLocal(st?.fees?.collected7dUsd,0) + liveFeesUsd, rewards: nLocal(st?.fees?.rewards7dUsd,0) + liveRewardsUsd, gas: nLocal(st?.costs?.gas7dUsd,0), swap: nLocal(st?.costs?.swapCosts7dUsd,0), mintBurn: nLocal(st?.costs?.mintBurn7dUsd,0), net: nLocal(st?.pnl?.net7dUsd,0) + liveTotal },
    "30D": { fees: nLocal(st?.fees?.collected30dUsd,0) + liveFeesUsd, rewards: nLocal(st?.fees?.rewards30dUsd,0) + liveRewardsUsd, gas: nLocal(st?.costs?.gas30dUsd,0), swap: nLocal(st?.costs?.swapCosts30dUsd,0), mintBurn: nLocal(st?.costs?.mintBurn30dUsd,0), net: nLocal(st?.pnl?.net30dUsd,0) + liveTotal },
    ALL: { fees: nLocal(st?.fees?.collectedTotalUsd,0) + liveFeesUsd, rewards: nLocal(st?.fees?.rewardsTotalUsd,0) + liveRewardsUsd, gas: nLocal(st?.costs?.gasTotalUsd,0), swap: nLocal(st?.costs?.swapCostsTotalUsd,0), mintBurn: nLocal(st?.costs?.mintBurnTotalUsd,0), net: nLocal(st?.pnl?.netTotalUsd,0) + liveTotal },
  }[tab];
  const maxVal = Math.max(data.fees + data.rewards, data.gas + data.swap + data.mintBurn, Math.abs(data.net), 0.01);
  const barRow = (lbl: string, val: number, color: string) => (
    <div style={{ display:"grid", gridTemplateColumns: fwIsMobile ? "80px 1fr 70px" : "120px 1fr 80px", gap:8, alignItems:"center" }}>
      <span style={{ fontSize:12, color:"rgba(232,232,240,0.6)" }}>{lbl}</span>
      <div style={{ height:8, borderRadius:4, background:"rgba(255,255,255,0.05)" }}>
        <div style={{ height:"100%", width:`${(Math.abs(val)/maxVal)*100}%`, borderRadius:4, background:color, minWidth: Math.abs(val) > 0 ? 2 : 0 }} />
      </div>
      <span style={{ fontSize:12, fontFamily:"monospace", textAlign:"right", color }}>{val >= 0 ? fmtUsd(val) : `-${fmtUsd(Math.abs(val))}`}</span>
    </div>
  );
  return (
    <div style={{ display:"grid", gap:12 }}>
      <div style={{ display:"flex", gap:4 }}>
        {(["TODAY","7D","30D","ALL"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{ padding:"3px 10px", borderRadius:20, fontSize:11, fontWeight:600, cursor:"pointer", background: tab===t ? "rgba(6,182,212,0.2)" : "transparent", border:`1px solid ${tab===t ? "rgba(6,182,212,0.4)" : "rgba(255,255,255,0.1)"}`, color: tab===t ? "#06b6d4" : "rgba(232,232,240,0.5)" }}>
            {t}
          </button>
        ))}
      </div>
      <div style={{ display:"grid", gap:8 }}>
        {barRow("Fees earned", data.fees, "#06b6d4")}
        {barRow("AERO rewards", data.rewards, "#22c55e")}
        {barRow("Gas", data.gas, "#ef4444")}
        {barRow("Swap costs", data.swap, "#ef4444")}
        {barRow("Mint/burn", data.mintBurn, "#ef4444")}
        <div style={{ height:1, background:"rgba(255,255,255,0.08)", margin:"4px 0" }} />
        {barRow("Net", data.net, data.net >= 0 ? "#22c55e" : "#ef4444")}
      </div>
    </div>
  );
}

function AlphaCard({ alphaLiveUsd, feesNetLiveUsd, divVsHodlLiveUsd, requiredFeesToBeatHodlLiveUsd, hodlGateAllowed, hodlGateReason, alphaTodayUsd,
  feesCollectedUsd, rewardsClaimedUsd, totalCostsUsd,
}: {
  alphaLiveUsd: number; feesNetLiveUsd: number; divVsHodlLiveUsd: number; requiredFeesToBeatHodlLiveUsd: number; hodlGateAllowed: boolean; hodlGateReason: string; alphaTodayUsd: number;
  feesCollectedUsd: number; rewardsClaimedUsd: number; totalCostsUsd: number;
}) {
  const beating = alphaLiveUsd >= 0;
  const fillPct = requiredFeesToBeatHodlLiveUsd > 0
    ? Math.max(0, Math.min(100, (feesNetLiveUsd / requiredFeesToBeatHodlLiveUsd) * 100))
    : beating
      ? 100
      : 0;
  const brkStyle: CSSProperties = { display:"flex", justifyContent:"space-between", fontSize:11, padding:"3px 0" };
  const brkLabel: CSSProperties = { color:"rgba(232,232,240,0.45)" };
  const brkVal = (v: number, invert = false): CSSProperties => ({ fontFamily:"monospace", color: invert ? (v > 0 ? "#ef4444" : "#22c55e") : (v >= 0 ? "#22c55e" : "#ef4444") });
  return (
    <div style={{ display:"grid", gap:12 }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:28, fontFamily:"monospace", fontWeight:800, color: alphaLiveUsd >= 0 ? "#22c55e" : "#ef4444" }}>
          {fmtSignedUsd(alphaLiveUsd)}
        </div>
        <div style={{ fontSize:11, color:"rgba(232,232,240,0.45)", marginTop:2 }}>alpha vs HODL (total)</div>
        <div style={{ fontSize:14, fontFamily:"monospace", color: alphaTodayUsd >= 0 ? "#22c55e" : "#ef4444", marginTop:4 }}>
          {fmtSignedUsd(alphaTodayUsd)} today
        </div>
      </div>
      <div style={{ borderTop:"1px solid rgba(255,255,255,0.06)", paddingTop:8 }}>
        <div style={brkStyle}><span style={brkLabel}>Fees</span><span style={brkVal(feesCollectedUsd)}>{fmtUsd(feesCollectedUsd)}</span></div>
        <div style={brkStyle}><span style={brkLabel}>AERO rewards</span><span style={brkVal(rewardsClaimedUsd)}>{fmtUsd(rewardsClaimedUsd)}</span></div>
        <div style={brkStyle}><span style={brkLabel}>Costs</span><span style={brkVal(totalCostsUsd, true)}>-{fmtUsd(totalCostsUsd)}</span></div>
        <div style={brkStyle}><span style={brkLabel}>Divergence vs HODL</span><span style={brkVal(divVsHodlLiveUsd)}>{fmtSignedUsd(divVsHodlLiveUsd)}</span></div>
      </div>
      <div>
        <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"rgba(232,232,240,0.5)", marginBottom:6 }}>
          <span>Required to beat HODL</span>
          <span style={{ fontFamily:"monospace" }}>{fmtUsd(requiredFeesToBeatHodlLiveUsd)}</span>
        </div>
        <div style={{ height:8, borderRadius:4, background:"rgba(255,255,255,0.08)" }}>
          <div style={{ height:"100%", width:`${Math.max(0, fillPct)}%`, borderRadius:4, background: beating ? "#22c55e" : "#f59e0b" }} />
        </div>
        <div style={{ fontSize:11, color: beating ? "#22c55e" : "#f59e0b", marginTop:4, textAlign:"right" }}>
          {beating ? "BEATING HODL" : "BELOW HODL"}
        </div>
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, borderTop:"1px solid rgba(255,255,255,0.06)", paddingTop:8 }}>
        <span style={{ color:"rgba(232,232,240,0.6)" }}>HODL Gate</span>
        <span style={{ color: hodlGateAllowed ? "#22c55e" : "#ef4444", fontWeight:700 }} title={hodlGateReason}>
          {hodlGateAllowed ? "ALLOWED" : "BLOCKED"}
        </span>
      </div>
    </div>
  );
}

function OpsGrid({ rebalancesToday, rebalances24h, lastRebalanceAtIso, churnRatio, churnProtectionEnabled, compoundMode, harvestThresholdUsd, cooldownRemaining, hodlGateAllowed, hodlGateReason }: {
  rebalancesToday: number; rebalances24h: number; lastRebalanceAtIso: string|null; churnRatio: number|null; churnProtectionEnabled: boolean; compoundMode: string; harvestThresholdUsd: number; cooldownRemaining: number; hodlGateAllowed: boolean; hodlGateReason: string;
}) {
  const lastRebStr = (() => {
    if (!lastRebalanceAtIso) return "\u2014";
    const ms = Date.parse(lastRebalanceAtIso);
    if (!Number.isFinite(ms)) return "\u2014";
    const secAgo = Math.round((Date.now() - ms) / 1000);
    return secAgo < 3600 ? `${Math.round(secAgo/60)}m ago` : `${Math.round(secAgo/3600)}h ago`;
  })();
  return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
      <Uc6Metric label="Rebalances today" value={String(rebalancesToday)} />
      <Uc6Metric label="Rebalances 24h" value={String(rebalances24h)} />
      <Uc6Metric label="Last rebalance" value={lastRebStr} />
      <Uc6Metric label="Churn ratio" value={churnRatio != null ? `${(churnRatio*100).toFixed(1)}%` : "\u2014"} />
      <Uc6Metric label="Churn protect" value={churnProtectionEnabled ? "ON" : "OFF"} />
      <Uc6Metric label="Compound" value={compoundMode === "threshold_harvest" ? `harvest $${harvestThresholdUsd}` : "on_rebalance"} />
      <Uc6Metric label="Cooldown" value={cooldownRemaining > 0 ? fmtDurationCompact(cooldownRemaining) : "ready"} />
      <Uc6Metric label="Close gate" value={<span style={{ color: hodlGateAllowed ? "#22c55e" : "#ef4444", fontWeight:700 }} title={hodlGateReason}>{hodlGateAllowed ? "ALLOWED" : "BLOCKED"}</span>} />
    </div>
  );
}

function EventFeed({ events: evs }: { events: Array<{ atIso?: string; type?: string; reason?: string; message?: string; gasUsd?: number; feesCollectedUsd?: number; rewardsUsd?: number; netUsd?: number; txHashes?: string[] }> }) {
  const PAGE_SIZE = 10;
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(evs.length / PAGE_SIZE));
  const pageEvs = evs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const eventColor = (t?: string): string => {
    switch (t) {
      case "harvest": case "claim": return "#22c55e";
      case "recenter": case "reentry": return "#06b6d4";
      case "topup": case "gas_topup": return "#8b5cf6";
      case "stake": case "unstake": return "#3b82f6";
      case "trend_escape": case "liquidate": return "#ef4444";
      case "action": return "#a78bfa";
      case "blocked": return "rgba(232,232,240,0.35)";
      case "error": return "#ef4444";
      default: return "#f59e0b";
    }
  };
  const eventLabel = (type?: string, reason?: string): string => {
    const t = type || "";
    const r = reason || "";
    const key = `${t}:${r}`;
    const labels: Record<string, string> = {
      "recenter:no_position": "Rebalanced (no position)",
      "recenter:edge_distance": "Rebalanced (edge distance)",
      "recenter:time_threshold": "Rebalanced (time)",
      "recenter:manual_force": "Rebalanced (manual)",
      "recenter:recovery_retry": "Rebalanced (recovery)",
      "reentry:mean_reversion_reentry": "Re-entered position",
      "topup:idle_deploy": "Topped up liquidity",
      "harvest:threshold": "Harvested fees",
      "gas_topup:eth_wallet_low": "Topped up ETH gas",
      "trend_escape:trend_escape": "Exited (trend escape)",
      "liquidate:owner_liquidate_and_pause": "Liquidated & paused",
      "stake:auto_stake": "Staked into gauge",
      "unstake:close_position": "Unstaked for rebalance",
      "unstake:top_up": "Unstaked for top-up",
      "unstake:collect_fees": "Unstaked for fee harvest",
      "unstake:owner_unstake": "Unstaked (manual)",
      "claim:auto_claim": "Claimed AERO rewards",
      "action:force_rebalance_requested": "Force rebalance requested",
      "action:settings_updated": "Settings updated",
      "blocked:kill_switch_active": "Blocked (kill switch)",
      "blocked:trading_disabled": "Blocked (trading off)",
      "error:idle_deploy_failed": "Top-up failed",
      "error:harvest_failed": "Harvest failed",
      "error:reentry_failed": "Re-entry failed",
      "error:trend_escape_failed": "Trend escape failed",
      "error:gas_topup_failed": "ETH top-up failed",
      "error:auto_stake_failed": "Auto-stake failed",
      "error:owner_liquidate_and_pause_failed": "Liquidation failed",
    };
    if (labels[key]) return labels[key];
    for (const [k, v] of Object.entries(labels)) {
      if (key.startsWith(k)) return v;
    }
    if (r.startsWith("failure_cooldown")) return "Waiting (cooldown)";
    return t.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) + (r ? ` (${r})` : "");
  };
  const timeAgo = (iso?: string) => {
    if (!iso) return "\u2014";
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return "\u2014";
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s/60)}m ago`;
    if (s < 86400) return `${Math.round(s/3600)}h ago`;
    return `${Math.round(s/86400)}d ago`;
  };
  const financialBadge = (ev: typeof evs[0]): string | null => {
    const fees = Number(ev.feesCollectedUsd || 0);
    const rewards = Number(ev.rewardsUsd || 0);
    const gas = Number(ev.gasUsd || 0);
    if (ev.type === "harvest" && fees > 0) return `+$${fees.toFixed(2)} fees`;
    if (ev.type === "claim" && rewards > 0) return `+$${rewards.toFixed(2)}`;
    if ((ev.type === "recenter" || ev.type === "reentry" || ev.type === "trend_escape") && gas > 0) return `gas $${gas.toFixed(2)}`;
    if (ev.type === "topup" && gas > 0) return `gas $${gas.toFixed(2)}`;
    if (ev.type === "stake" && gas > 0) return `gas $${gas.toFixed(4)}`;
    if (ev.type === "unstake" && rewards > 0) return `+$${rewards.toFixed(2)} claimed`;
    return null;
  };
  return (
    <div style={{ display:"grid", gap:6 }}>
      {pageEvs.map((ev, i) => {
        const badge = financialBadge(ev);
        const txHash = ev.txHashes?.[0];
        return (
          <div key={page * PAGE_SIZE + i} style={{ display:"grid", gap:2 }}>
            <div style={{ display:"flex", gap:8, alignItems:"baseline", fontSize:12 }}>
              <span style={{ color:"rgba(232,232,240,0.35)", whiteSpace:"nowrap", minWidth:54 }}>{timeAgo(ev.atIso)}</span>
              <span style={{ color:eventColor(ev.type), fontWeight:600, whiteSpace:"nowrap" }}>{eventLabel(ev.type, ev.reason)}</span>
              {badge && <span style={{ color:"rgba(232,232,240,0.4)", fontSize:11, whiteSpace:"nowrap" }}>{badge}</span>}
              {txHash && (
                <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
                  style={{ color:"rgba(232,232,240,0.3)", fontSize:10, textDecoration:"none", whiteSpace:"nowrap" }}
                  onMouseOver={e => (e.currentTarget.style.color = "#06b6d4")}
                  onMouseOut={e => (e.currentTarget.style.color = "rgba(232,232,240,0.3)")}>
                  tx
                </a>
              )}
            </div>
            {ev.type === "error" && ev.message && (
              <div style={{ fontSize:11, color:"rgba(239,68,68,0.6)", paddingLeft:62, wordBreak:"break-word", maxWidth:360 }}>
                {ev.message.length > 200 ? ev.message.slice(0, 200) + "\u2026" : ev.message}
              </div>
            )}
          </div>
        );
      })}
      {totalPages > 1 && (
        <div style={{ display:"flex", gap:8, alignItems:"center", marginTop:8, paddingTop:8, borderTop:"1px solid rgba(255,255,255,0.06)", fontSize:12, color:"rgba(232,232,240,0.5)" }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={darkBtnStyle}>Prev</button>
          <span>{page + 1} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={darkBtnStyle}>Next</button>
          <span style={{ marginLeft:"auto", fontSize:11, color:"rgba(232,232,240,0.3)" }}>{evs.length} events</span>
        </div>
      )}
    </div>
  );
}

function RegimeGauge({ label, thetaStrength, confidencePct, halfLifeLabel, theta, sigma, muPrice, sampleCount, windowSec, enabled, baseEdgePct, effectiveEdgePct, baseBandBps, effectiveBandBps, baseBandBpsUp, baseBandBpsDown, effectiveBandBpsUp, effectiveBandBpsDown, fast, adviceReason }: {
  label: string|null; thetaStrength: number; confidencePct: number|null; halfLifeLabel: string; theta: number|null; sigma: number|null; muPrice: number|null; sampleCount: number; windowSec: number; enabled: boolean; baseEdgePct: number; effectiveEdgePct: number; baseBandBps: number; effectiveBandBps: number; baseBandBpsUp?: number|null; baseBandBpsDown?: number|null; effectiveBandBpsUp?: number|null; effectiveBandBpsDown?: number|null; fast?: { theta?: number|null; thetaStrength?: number; halfLifeSec?: number|null; label?: string; confidence?: number; sampleCount?: number; windowSec?: number } | null; adviceReason?: string | null;
}) {
  if (!enabled) {
    return <div style={{ color:"rgba(232,232,240,0.4)", fontSize:13, textAlign:"center", padding:"16px 0" }}>Regime engine disabled</div>;
  }
  const arcR = 50;
  const arcLen = Math.PI * arcR;
  const conf01 = (confidencePct ?? 0) / 100;
  const arcFilled = conf01 * arcLen;
  const regimeColor = label === "mean_reverting" ? "#06b6d4" : label === "trending" ? "#f59e0b" : "rgba(255,255,255,0.2)";
  return (
    <div style={{ display:"grid", gap:12 }}>
      <div style={{ display:"flex", justifyContent:"center" }}>
        <svg viewBox="0 0 120 70" width={140} height={82}>
          <path d="M10,65 A50,50 0 0,1 110,65" stroke="rgba(255,255,255,0.08)" fill="none" strokeWidth={9} strokeLinecap="round" />
          <path d="M10,65 A50,50 0 0,1 110,65" stroke={regimeColor} fill="none" strokeWidth={9}
            strokeDasharray={`${arcFilled} ${arcLen}`} strokeLinecap="round" />
          <text x={60} y={55} textAnchor="middle" fontSize={18} fontWeight={800} fill="#e8e8f0">
            {confidencePct != null ? `${Math.round(confidencePct)}%` : "\u2014"}
          </text>
        </svg>
      </div>
      <div style={{ textAlign:"center" }}>
        <span style={{ fontSize:13, fontWeight:700, color:regimeColor, textTransform:"uppercase" }}>
          {label || "unknown"}
        </span>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
        <Uc6Metric label="Half-life" value={halfLifeLabel} />
        <Uc6Metric label="Samples" value={`${sampleCount}/${windowSec}s`} />
        <Uc6Metric label="Mean-Revert Speed" value={
          label === "trending"
            ? <span style={{ color:"rgba(232,232,240,0.3)" }}>N/A</span>
            : theta != null ? theta.toFixed(4) : "\u2014"
        } />
        {sigma != null && (() => {
          const annualPct = sigma * Math.sqrt(365.25 * 24 * 3600) * 100;
          return <Uc6Metric label="Volatility (ann.)" value={`${annualPct.toFixed(1)}%`} />;
        })()}
        <Uc6Metric label="Mean Price" value={
          label === "trending"
            ? <span style={{ color:"rgba(232,232,240,0.3)" }}>N/A</span>
            : muPrice != null ? fmtUsd(muPrice) : "\u2014"
        } />
        <Uc6Metric label="Theta Strength" value={
          <span style={{ color: thetaStrength >= 0.7 ? "#22c55e" : thetaStrength >= 0.3 ? "#f59e0b" : "rgba(232,232,240,0.5)" }}>
            {(thetaStrength * 100).toFixed(0)}%
          </span>
        } />
      </div>
      {fast && (
        <div style={{ borderTop:"1px solid rgba(255,255,255,0.05)", paddingTop:8, marginTop:4 }}>
          <div style={{ fontSize:10, fontWeight:700, color:"rgba(232,232,240,0.3)", textTransform:"uppercase", letterSpacing:1, marginBottom:4 }}>Fast window ({fast.windowSec ?? 300}s)</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:4 }}>
            <Uc6Metric label="Label" value={<span style={{ color: fast.label === "mean_reverting" ? "#06b6d4" : fast.label === "trending" ? "#f59e0b" : "rgba(232,232,240,0.4)", fontSize:11 }}>{fast.label || "?"}</span>} />
            <Uc6Metric label="Theta Str" value={`${((fast.thetaStrength ?? 0) * 100).toFixed(0)}%`} />
            <Uc6Metric label="Conf" value={`${((fast.confidence ?? 0) * 100).toFixed(0)}%`} />
          </div>
        </div>
      )}

      {/* Threshold adjustments — show configured vs what regime is actually using */}
      <div style={{ borderTop:"1px solid rgba(255,255,255,0.07)", paddingTop:10, display:"grid", gap:6 }}>
        <div style={{ fontSize:10, fontWeight:700, color:"rgba(232,232,240,0.3)", textTransform:"uppercase", letterSpacing:1, marginBottom:2 }}>Regime threshold adjustments</div>

        {/* Band */}
        {(() => {
          const asymmetric = baseBandBpsUp != null || baseBandBpsDown != null;
          if (asymmetric) {
            const renderBandRow = (dir: string, baseBps: number, effBps: number) => {
              const adjBps = Math.round(effBps - baseBps);
              const basePct = (baseBps / 100).toFixed(2);
              const effPct = (effBps / 100).toFixed(2);
              const sameVal = Math.abs(adjBps) < 1;
              return (
                <div key={dir} style={{ display:"flex", alignItems:"baseline", justifyContent:"space-between", fontSize:12 }}>
                  <span style={{ color:"rgba(232,232,240,0.45)" }}>Band {dir}</span>
                  <span style={{ fontFamily:"monospace" }}>
                    <span style={{ color:"rgba(232,232,240,0.55)" }}>{basePct}%</span>
                    {!sameVal && (
                      <>
                        <span style={{ color:"rgba(232,232,240,0.3)", margin:"0 4px" }}>{"\u2192"}</span>
                        <span style={{ color: adjBps > 0 ? "#f59e0b" : "#06b6d4", fontWeight:700 }}>{effPct}%</span>
                        <span style={{ fontSize:10, marginLeft:4, color: adjBps > 0 ? "#f59e0b" : "#06b6d4" }}>
                          ({adjBps > 0 ? "+" : ""}{adjBps})
                        </span>
                      </>
                    )}
                    {sameVal && <span style={{ color:"rgba(232,232,240,0.3)", marginLeft:6, fontSize:11 }}>no adj</span>}
                  </span>
                </div>
              );
            };
            return (
              <>
                {renderBandRow("\u2191", baseBandBpsUp ?? baseBandBps, effectiveBandBpsUp ?? effectiveBandBps)}
                {renderBandRow("\u2193", baseBandBpsDown ?? baseBandBps, effectiveBandBpsDown ?? effectiveBandBps)}
              </>
            );
          }
          const adjBps = effectiveBandBps - baseBandBps;
          const basePct = (baseBandBps / 100).toFixed(2);
          const effPct  = (effectiveBandBps / 100).toFixed(2);
          const sameVal = Math.abs(adjBps) < 1;
          return (
            <div style={{ display:"flex", alignItems:"baseline", justifyContent:"space-between", fontSize:12 }}>
              <span style={{ color:"rgba(232,232,240,0.45)" }}>Band half-width</span>
              <span style={{ fontFamily:"monospace" }}>
                <span style={{ color:"rgba(232,232,240,0.55)" }}>{"\u00b1"}{basePct}%</span>
                {!sameVal && (
                  <>
                    <span style={{ color:"rgba(232,232,240,0.3)", margin:"0 4px" }}>{"\u2192"}</span>
                    <span style={{ color: adjBps > 0 ? "#f59e0b" : "#06b6d4", fontWeight:700 }}>{"\u00b1"}{effPct}%</span>
                    <span style={{ fontSize:10, marginLeft:4, color: adjBps > 0 ? "#f59e0b" : "#06b6d4" }}>
                      ({adjBps > 0 ? "+" : ""}{adjBps} bps)
                    </span>
                  </>
                )}
                {sameVal && <span style={{ color:"rgba(232,232,240,0.3)", marginLeft:6, fontSize:11 }}>no adj</span>}
              </span>
            </div>
          );
        })()}

        {/* Edge */}
        {(() => {
          const adjPct = effectiveEdgePct - baseEdgePct;
          const sameVal = Math.abs(adjPct) < 0.001;
          return (
            <div style={{ display:"flex", alignItems:"baseline", justifyContent:"space-between", fontSize:12 }}>
              <span style={{ color:"rgba(232,232,240,0.45)" }}>Edge threshold</span>
              <span style={{ fontFamily:"monospace" }}>
                <span style={{ color:"rgba(232,232,240,0.55)" }}>{baseEdgePct.toFixed(2)}%</span>
                {!sameVal && (
                  <>
                    <span style={{ color:"rgba(232,232,240,0.3)", margin:"0 4px" }}>{"→"}</span>
                    <span style={{ color: adjPct > 0 ? "#22c55e" : "#f59e0b", fontWeight:700 }}>{effectiveEdgePct.toFixed(2)}%</span>
                    <span style={{ fontSize:10, marginLeft:4, color:"rgba(232,232,240,0.45)" }}>
                      ({adjPct > 0 ? "+" : ""}{adjPct.toFixed(2)} pp)
                    </span>
                  </>
                )}
                {sameVal && <span style={{ color:"rgba(232,232,240,0.3)", marginLeft:6, fontSize:11 }}>no adj</span>}
              </span>
            </div>
          );
        })()}
        {adviceReason && (
          <div style={{ fontSize:10, color:"rgba(232,232,240,0.35)", marginTop:4, fontStyle:"italic" }}>
            {adviceReason.includes("cost_gate_wait")
              ? "Cost gate — expected fees over horizon < rebalance cost, deferring"
              : adviceReason.replace(/_/g, " ").replace(/,/g, " · ")}
          </div>
        )}
      </div>
    </div>
  );
}

function TrendEscapeCard({ enabled, eligible, holdTarget, reasonIfBlocked, cooldownUntilIso, trendDirection, trendMovePct, urgency, diagnostics }: {
  enabled: boolean; eligible: boolean; holdTarget: string|null; reasonIfBlocked: string|null; cooldownUntilIso: string|null; trendDirection: string; trendMovePct: number|null;
  urgency: number|null; diagnostics: Record<string, unknown>|null;
}) {
  if (!enabled) return <div style={{ color:"rgba(232,232,240,0.4)", fontSize:13, textAlign:"center", padding:"8px 0" }}>DISABLED</div>;
  const borderColor = eligible ? "#22c55e" : "transparent";
  const diag = diagnostics as any;
  return (
    <div style={{ border:`1px solid ${borderColor}`, borderRadius:8, padding:"10px", display:"grid", gap:8 }}>
      <div style={{ fontSize:14, fontWeight:800, color: eligible ? "#22c55e" : "rgba(232,232,240,0.5)" }}>
        {eligible ? "ESCAPE ELIGIBLE" : "NOT ELIGIBLE"}
      </div>
      {eligible && holdTarget && <Uc6Metric label="Hold target" value={holdTarget} />}
      {!eligible && reasonIfBlocked && <div style={{ fontSize:12, color:"rgba(232,232,240,0.45)" }}>{reasonIfBlocked}</div>}
      {urgency != null && (
        <div style={{ display:"grid", gap:4 }}>
          <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"rgba(232,232,240,0.5)" }}>
            <span>Urgency</span>
            <span style={{ fontFamily:"monospace" }}>{(urgency * 100).toFixed(1)}% / {((diag?.urgencyThreshold ?? 0.7) * 100).toFixed(0)}%</span>
          </div>
          <div style={{ height:5, borderRadius:3, background:"rgba(255,255,255,0.08)" }}>
            <div style={{ height:"100%", width:`${Math.max(0, Math.min(100, urgency * 100))}%`, borderRadius:3, background: urgency >= (diag?.urgencyThreshold ?? 0.7) ? "#22c55e" : "#f59e0b" }} />
          </div>
        </div>
      )}
      {diag && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
          <Uc6Metric label="Edge progress" value={`${((diag.edgeProgress ?? 0) * 100).toFixed(1)}%${diag.approachingSide ? ` (${diag.approachingSide})` : ""}`} />
          <Uc6Metric label="Confidence" value={`${((diag.regimeConfidence ?? 0) * 100).toFixed(1)}%`} />
          <Uc6Metric label="Confirm" value={`${diag.actualConfirmSec ?? 0}s / ${diag.requiredConfirmSec ?? 0}s`} />
          <Uc6Metric label="Trend move" value={`${((diag.trendMovePct ?? 0) * 100).toFixed(2)}%`} />
        </div>
      )}
      {cooldownUntilIso && Date.parse(cooldownUntilIso) > Date.now() && <Uc6Metric label="Cooldown until" value={fmtIsoLocal(cooldownUntilIso)} />}
      {!diag && trendDirection !== "flat" && (
        <Uc6Metric label="Trend" value={`${trendDirection} ${trendMovePct != null ? `${trendMovePct > 0 ? "+" : ""}${trendMovePct.toFixed(2)}%` : ""}`} />
      )}
    </div>
  );
}

function ReEntryCard({ enabled, eligible, reasonIfBlocked, eligibleAtIso, distanceFromMuPct,
  strategyMode, holdElapsedSec, holdRequiredSec, escapeCooldownUntilIso, reEntryCooldownUntilIso,
  regimeLabel, regimeConfidence, requiredRegimeLabel, requiredMinConfidence,
  meanRevertConfirmSec, requiredMeanRevertConfirmSec, maxDistanceFromMuPct,
}: {
  enabled: boolean; eligible: boolean; reasonIfBlocked: string|null; eligibleAtIso: string|null; distanceFromMuPct: number|null;
  strategyMode: string; holdElapsedSec: number; holdRequiredSec: number;
  escapeCooldownUntilIso: string|null; reEntryCooldownUntilIso: string|null;
  regimeLabel: string; regimeConfidence: number; requiredRegimeLabel: string; requiredMinConfidence: number;
  meanRevertConfirmSec: number; requiredMeanRevertConfirmSec: number; maxDistanceFromMuPct: number;
}) {
  if (!enabled) return <div style={{ color:"rgba(232,232,240,0.4)", fontSize:13, textAlign:"center", padding:"8px 0" }}>DISABLED</div>;

  // Mode A: position active — gate is irrelevant
  if (!strategyMode.startsWith("HOLD_")) {
    return <div style={{ color:"rgba(232,232,240,0.3)", fontSize:12, textAlign:"center", padding:"10px 0" }}>N/A — Position active</div>;
  }

  // Mode B: hold mode — show condition checklist
  const nowMs = Date.now();
  const fmtSec = (s: number) => {
    const r = Math.round(s);
    if (r < 60) return `${r}s`;
    const m = Math.floor(r / 60);
    if (m < 60) return `${m}m ${r % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };
  const isoInPast = (iso: string | null) => !iso || Date.parse(iso) <= nowMs;

  const holdOk = holdElapsedSec >= holdRequiredSec;
  const escapeOk = isoInPast(escapeCooldownUntilIso);
  const reentryOk = isoInPast(reEntryCooldownUntilIso);
  const cooldownOk = escapeOk && reentryOk;
  const regimeOk = regimeLabel === requiredRegimeLabel && regimeConfidence >= requiredMinConfidence;
  const confirmOk = meanRevertConfirmSec >= requiredMeanRevertConfirmSec;
  const distOk = distanceFromMuPct != null && maxDistanceFromMuPct > 0 && distanceFromMuPct <= maxDistanceFromMuPct * 100;

  const condRowStyle: CSSProperties = { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"4px 0", borderBottom:"1px solid rgba(255,255,255,0.04)" };
  const labelStyle: CSSProperties = { fontSize:11, color:"rgba(232,232,240,0.5)" };
  const valStyle = (ok: boolean): CSSProperties => ({ fontSize:11, fontWeight:600, color: ok ? "#22c55e" : "#f59e0b", fontVariantNumeric:"tabular-nums", textAlign:"right" });

  return (
    <div style={{ display:"grid", gap:6 }}>
      <div style={{ fontSize:14, fontWeight:800, color: eligible ? "#22c55e" : "#f59e0b", marginBottom:2 }}>
        {eligible ? "READY" : "WAITING"}
      </div>

      <div style={condRowStyle}>
        <span style={labelStyle}>Hold timer</span>
        <span style={valStyle(holdOk)}>{holdOk ? `${fmtSec(holdElapsedSec)} elapsed` : `${fmtSec(holdElapsedSec)} / ${fmtSec(holdRequiredSec)}`}</span>
      </div>

      <div style={condRowStyle}>
        <span style={labelStyle}>Cooldowns</span>
        <span style={valStyle(cooldownOk)}>{cooldownOk ? "expired" : !escapeOk ? `escape til ${fmtIsoLocal(escapeCooldownUntilIso)}` : `reentry til ${fmtIsoLocal(reEntryCooldownUntilIso)}`}</span>
      </div>

      <div style={condRowStyle}>
        <span style={labelStyle}>Regime</span>
        <span style={{ ...valStyle(regimeOk), color: regimeOk ? "#22c55e" : "#ef4444" }}>
          {regimeLabel === "unknown" ? "no data" : `${regimeLabel} (${(regimeConfidence * 100).toFixed(0)}%)`}
        </span>
      </div>

      <div style={condRowStyle}>
        <span style={labelStyle}>Mean-revert confirmed</span>
        <span style={valStyle(confirmOk)}>{confirmOk ? `${fmtSec(meanRevertConfirmSec)}` : `${fmtSec(meanRevertConfirmSec)} / ${fmtSec(requiredMeanRevertConfirmSec)}`}</span>
      </div>

      <div style={condRowStyle}>
        <span style={labelStyle}>Distance from mean</span>
        <span style={{ ...valStyle(distOk), color: distanceFromMuPct == null ? "rgba(232,232,240,0.3)" : distOk ? "#22c55e" : "#ef4444" }}>
          {distanceFromMuPct != null ? `${distanceFromMuPct.toFixed(2)}%${maxDistanceFromMuPct > 0 ? ` / ${(maxDistanceFromMuPct * 100).toFixed(1)}%` : ""}` : "no data"}
        </span>
      </div>

      {eligibleAtIso && !isoInPast(eligibleAtIso) && (
        <div style={{ marginTop:4 }}>
          <Uc6Metric label="Eligible at" value={fmtIsoLocal(eligibleAtIso)} />
        </div>
      )}
    </div>
  );
}

function HodlGateCard({ allowed, reason, alphaLiveUsd, requiredUsd, enabled: _enabled,
  outOfRangeDurationSec, distanceBeyondEdgePct, outOfRangeMaxSec, outOfRangeEmergencyMinSec, outOfRangeEmergencyEdgePct, allowCloseIfOutOfRange, inRange,
}: {
  allowed: boolean; reason: string; alphaLiveUsd: number; requiredUsd: number; enabled: boolean;
  outOfRangeDurationSec: number; distanceBeyondEdgePct: number;
  outOfRangeMaxSec: number; outOfRangeEmergencyMinSec: number; outOfRangeEmergencyEdgePct: number;
  allowCloseIfOutOfRange: boolean; inRange: boolean;
}) {
  const isBlocked = !allowed;
  const isOutOfRange = !inRange && outOfRangeDurationSec > 0;

  // Override 1: out of range for outOfRangeMaxSec
  const timeoutPct = isOutOfRange ? Math.min(100, (outOfRangeDurationSec / outOfRangeMaxSec) * 100) : 0;
  const timeoutRemaining = Math.max(0, outOfRangeMaxSec - outOfRangeDurationSec);

  // Override 2: emergency — out of range for emergencyMinSec AND beyond emergencyEdgePct
  const emergencyTimePct = isOutOfRange ? Math.min(100, (outOfRangeDurationSec / outOfRangeEmergencyMinSec) * 100) : 0;
  const emergencyTimeMet = outOfRangeDurationSec >= outOfRangeEmergencyMinSec;
  const emergencyEdgeMet = distanceBeyondEdgePct >= outOfRangeEmergencyEdgePct;

  const showOverrides = isBlocked && allowCloseIfOutOfRange && isOutOfRange;

  return (
    <div style={{ display:"grid", gap:8 }}>
      <div style={{ fontSize:14, fontWeight:800, color: allowed ? "#22c55e" : "#ef4444" }} title={reason}>
        {allowed ? "ALLOWED" : "BLOCKED"}
      </div>
      <div style={{ fontSize:12, color:"rgba(232,232,240,0.45)" }}>{reason}</div>
      {requiredUsd > 0 && (
        <div style={{ display:"grid", gap:4 }}>
          <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"rgba(232,232,240,0.5)" }}>
            <span>Alpha / Required</span>
            <span style={{ fontFamily:"monospace" }}>{fmtUsd(alphaLiveUsd)} / {fmtUsd(requiredUsd)}</span>
          </div>
          <div style={{ height:5, borderRadius:3, background:"rgba(255,255,255,0.08)" }}>
            <div style={{ height:"100%", width:`${Math.max(0, Math.min(100, (alphaLiveUsd/requiredUsd)*100))}%`, borderRadius:3, background: alphaLiveUsd >= requiredUsd ? "#22c55e" : "#f59e0b" }} />
          </div>
        </div>
      )}

      {showOverrides && (
        <div style={{ display:"grid", gap:8, marginTop:4, padding:"8px 0", borderTop:"1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ fontSize:11, fontWeight:700, color:"rgba(232,232,240,0.6)", textTransform:"uppercase", letterSpacing:0.5 }}>
            Out-of-range overrides
          </div>

          {/* Timeout override */}
          <div style={{ display:"grid", gap:4 }}>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"rgba(232,232,240,0.5)" }}>
              <span>Timeout ({fmtDurationCompact(outOfRangeMaxSec)})</span>
              <span style={{ fontFamily:"monospace", color: timeoutPct >= 100 ? "#22c55e" : "rgba(232,232,240,0.7)" }}>
                {timeoutPct >= 100 ? "READY" : `${fmtDurationCompact(outOfRangeDurationSec)} / ${fmtDurationCompact(outOfRangeMaxSec)}`}
              </span>
            </div>
            <div style={{ height:5, borderRadius:3, background:"rgba(255,255,255,0.08)" }}>
              <div style={{ height:"100%", width:`${timeoutPct}%`, borderRadius:3, background: timeoutPct >= 100 ? "#22c55e" : "#f59e0b", transition:"width 0.3s" }} />
            </div>
          </div>

          {/* Emergency override */}
          <div style={{ display:"grid", gap:4 }}>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"rgba(232,232,240,0.5)" }}>
              <span>Emergency</span>
              <span style={{ fontFamily:"monospace", color: emergencyTimeMet && emergencyEdgeMet ? "#22c55e" : "rgba(232,232,240,0.7)" }}>
                {emergencyTimeMet && emergencyEdgeMet ? "READY" : ""}
              </span>
            </div>
            <div style={{ display:"flex", gap:12, fontSize:11 }}>
              <div style={{ flex:1, display:"grid", gap:2 }}>
                <div style={{ display:"flex", justifyContent:"space-between", color:"rgba(232,232,240,0.45)" }}>
                  <span>Time ({fmtDurationCompact(outOfRangeEmergencyMinSec)})</span>
                  <span style={{ fontFamily:"monospace", color: emergencyTimeMet ? "#22c55e" : "rgba(232,232,240,0.7)" }}>
                    {emergencyTimeMet ? "OK" : fmtDurationCompact(outOfRangeDurationSec)}
                  </span>
                </div>
                <div style={{ height:4, borderRadius:2, background:"rgba(255,255,255,0.08)" }}>
                  <div style={{ height:"100%", width:`${emergencyTimePct}%`, borderRadius:2, background: emergencyTimeMet ? "#22c55e" : "#f59e0b", transition:"width 0.3s" }} />
                </div>
              </div>
              <div style={{ flex:1, display:"grid", gap:2 }}>
                <div style={{ display:"flex", justifyContent:"space-between", color:"rgba(232,232,240,0.45)" }}>
                  <span>Edge ({(outOfRangeEmergencyEdgePct * 100).toFixed(0)}%)</span>
                  <span style={{ fontFamily:"monospace", color: emergencyEdgeMet ? "#22c55e" : "rgba(232,232,240,0.7)" }}>
                    {(distanceBeyondEdgePct * 100).toFixed(1)}%
                  </span>
                </div>
                <div style={{ height:4, borderRadius:2, background:"rgba(255,255,255,0.08)" }}>
                  <div style={{ height:"100%", width:`${Math.min(100, (distanceBeyondEdgePct / outOfRangeEmergencyEdgePct) * 100)}%`, borderRadius:2, background: emergencyEdgeMet ? "#22c55e" : "#f59e0b", transition:"width 0.3s" }} />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PnlWindows({ status: st }: { status: Uc6Status | null }) {
  const n2 = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const nn = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : null; };

  // APR values from bot are raw ratios (0.365 = 36.5%) — multiply by 100 for display
  const fmtApr = (v: unknown) => { const x = nn(v); return x == null ? "—" : fmtPct(x * 100); };

  const walletUsd = n2(st?.wallet?.valuesUsd?.total);
  const lpUsd = n2(st?.position?.amountsInLP?.usdValue);
  const portfolioNow = walletUsd + lpUsd;

  // Entry value of active LP position as "start" proxy (best available)
  const activeEntryUsd = nn(st?.activePositionRecord?.entry?.entryValueUsd);
  // Wallet reserve at entry isn't tracked, so we show LP-only change
  const lpChange = activeEntryUsd != null && activeEntryUsd > 0
    ? lpUsd - activeEntryUsd
    : null;
  const lpChangePct = lpChange != null && activeEntryUsd! > 0
    ? (lpChange / activeEntryUsd!) * 100
    : null;

  const rows = [
    ["Fees", fmtUsd(n2(st?.fees?.collectedTodayUsd)), fmtUsd(n2(st?.fees?.collected7dUsd)), fmtUsd(n2(st?.fees?.collected30dUsd)), fmtUsd(n2(st?.fees?.collectedTotalUsd))],
    ["Costs", fmtUsd(n2(st?.costs?.totalTodayUsd)), fmtUsd(n2(st?.costs?.total7dUsd)), fmtUsd(n2(st?.costs?.total30dUsd)), fmtUsd(n2(st?.costs?.totalTotalUsd))],
    ["Net", fmtSignedUsd(n2(st?.pnl?.netTodayUsd)), fmtSignedUsd(n2(st?.pnl?.net7dUsd)), fmtSignedUsd(n2(st?.pnl?.net30dUsd)), fmtSignedUsd(n2(st?.pnl?.netTotalUsd))],
    ["APR (ann.)", fmtApr(st?.pnl?.aprToday), fmtApr(st?.pnl?.apr7d), fmtApr(st?.pnl?.apr30d), "—"],
  ];

  const valColor = (v: number) => v >= 0 ? "#22c55e" : "#ef4444";

  return (
    <div style={{ display:"grid", gap:16 }}>
      <DarkTable headers={["\u00a0", "Today", "7D", "30D", "Total"]} rows={rows} />

      {/* Portfolio snapshot */}
      <div style={{ borderTop:"1px solid rgba(255,255,255,0.07)", paddingTop:14 }}>
        <div style={{ fontSize:10, fontWeight:700, color:"rgba(232,232,240,0.35)", textTransform:"uppercase", letterSpacing:1, marginBottom:10 }}>Portfolio Snapshot</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
          <Uc6Metric label="LP position" value={<span style={{ fontFamily:"monospace" }}>{fmtUsd(lpUsd)}</span>} />
          <Uc6Metric label="Wallet (idle)" value={<span style={{ fontFamily:"monospace" }}>{fmtUsd(walletUsd)}</span>} />
          <Uc6Metric label="Total portfolio" value={<span style={{ fontFamily:"monospace", fontWeight:700, color:"#e8e8f0" }}>{fmtUsd(portfolioNow)}</span>} />
        </div>
        {activeEntryUsd != null && activeEntryUsd > 0 && (
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginTop:10 }}>
            <Uc6Metric label="LP at entry" value={<span style={{ fontFamily:"monospace", color:"rgba(232,232,240,0.55)" }}>{fmtUsd(activeEntryUsd)}</span>} />
            <Uc6Metric label="LP change" value={
              <span style={{ fontFamily:"monospace", color: lpChange! >= 0 ? "#22c55e" : "#ef4444" }}>
                {fmtSignedUsd(lpChange)}
              </span>
            } />
            <Uc6Metric label="LP change %" value={
              lpChangePct != null
                ? <span style={{ fontFamily:"monospace", color:valColor(lpChangePct), fontWeight:700 }}>{fmtSignedPct(lpChangePct)}</span>
                : <span style={{ color:"rgba(232,232,240,0.35)" }}>—</span>
            } />
          </div>
        )}
      </div>
    </div>
  );
}

function PoolComparisonCard({ current, top5, computedAtIso }: { current: PoolComparisonRow|null; top5: PoolComparisonRow[]; computedAtIso: string|null }) {
  if (!current && top5.length === 0) {
    return <div style={{ color:"rgba(232,232,240,0.4)", fontSize:13 }}>No pool comparison data.</div>;
  }
  const rowStyle = (isCurrent: boolean): CSSProperties => ({
    display:"grid", gridTemplateColumns:"1fr auto auto", gap:8, padding:"8px 0", borderBottom:"1px solid rgba(255,255,255,0.05)",
    ...(isCurrent ? { borderLeft:"2px solid #06b6d4", paddingLeft:8 } : {})
  });
  return (
    <div style={{ display:"grid", gap:4 }}>
      {computedAtIso && <div style={{ fontSize:11, color:"rgba(232,232,240,0.3)", marginBottom:8 }}>Updated: {fmtIsoLocal(computedAtIso)}</div>}
      {current && (
        <div style={rowStyle(true)}>
          <div>
            <div style={{ fontSize:12, fontWeight:700, color:"#e8e8f0" }}>{current.dex?.name || "\u2014"} {pairLabel(current)}</div>
            <div style={{ fontSize:11, color:"rgba(232,232,240,0.45)" }}>{poolComparisonSelectorLabel(current)} \u00b7 CURRENT</div>
          </div>
          <div style={{ textAlign:"right", fontSize:12 }}>
            <div style={{ color: (current.economics?.expectedNetDayUsd ?? 0) >= 0 ? "#22c55e" : "#ef4444", fontFamily:"monospace" }}>{fmtSignedUsd(current.economics?.expectedNetDayUsd)}/d</div>
          </div>
          <div />
        </div>
      )}
      {top5.slice(0,3).map((row, i) => {
        const href = poolLink(row);
        return (
          <div key={i} style={rowStyle(false)}>
            <div>
              <div style={{ fontSize:12, fontWeight:600, color:"rgba(232,232,240,0.8)" }}>
                {href ? <a href={href} target="_blank" rel="noreferrer noopener" style={{ color:"rgba(6,182,212,0.8)", textDecoration:"none" }}>{row.dex?.name} {pairLabel(row)}</a> : `${row.dex?.name} ${pairLabel(row)}`}
              </div>
              <div style={{ fontSize:11, color:"rgba(232,232,240,0.4)" }}>{poolComparisonSelectorLabel(row)}</div>
            </div>
            <div style={{ textAlign:"right", fontSize:12 }}>
              <div style={{ color:(row.economics?.expectedNetDayUsd ?? 0) >= 0 ? "#22c55e" : "#ef4444", fontFamily:"monospace" }}>{fmtSignedUsd(row.economics?.expectedNetDayUsd)}/d</div>
            </div>
            <div>
              {row.compareToCurrent?.rating && (
                <span style={{ fontSize:11, padding:"2px 6px", borderRadius:10, background: row.compareToCurrent.rating==="More" ? "rgba(34,197,94,0.15)" : row.compareToCurrent.rating==="Less" ? "rgba(239,68,68,0.15)" : "rgba(255,255,255,0.05)", color: row.compareToCurrent.rating==="More" ? "#22c55e" : row.compareToCurrent.rating==="Less" ? "#ef4444" : "rgba(232,232,240,0.5)" }}>
                  {row.compareToCurrent.rating}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TaxSummary({ taxSummary }: { taxSummary: NonNullable<Uc6Status["positionsTaxSummary"]> }) {
  const totals = taxSummary.totals;
  const signColor = (v: number | null | undefined) => (v ?? 0) >= 0 ? "#22c55e" : "#ef4444";

  return (
    <div style={{ display:"grid", gap:16, marginTop:12 }}>

      {/* All-time totals */}
      <div>
        <div style={{ fontSize:10, fontWeight:700, color:"rgba(232,232,240,0.35)", textTransform:"uppercase", letterSpacing:1, marginBottom:10 }}>All-time totals</div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(140px, 1fr))", gap:10 }}>
          <Uc6Metric label="Fees collected" value={<span style={{ fontFamily:"monospace", color:"#06b6d4" }}>{fmtUsd(totals?.feesCollectedUsd)}</span>} />
          <Uc6Metric label="Total costs" value={<span style={{ fontFamily:"monospace", color:"#ef4444" }}>{fmtUsd(totals?.totalCostsUsd)}</span>} />
          <Uc6Metric label="Net fees" value={<span style={{ fontFamily:"monospace", color:signColor(totals?.feesNetUsd) }}>{fmtSignedUsd(totals?.feesNetUsd)}</span>} />
          <Uc6Metric label="AERO rewards" value={<span style={{ fontFamily:"monospace", color:"#22c55e" }}>{fmtUsd(totals?.rewardsUsd)}</span>} />
          <Uc6Metric label="Alpha vs HODL" value={<span style={{ fontFamily:"monospace", color:signColor(totals?.alphaVsHodlUsd) }}>{fmtSignedUsd(totals?.alphaVsHodlUsd)}</span>} />
          <Uc6Metric label="Closed positions" value={String(totals?.closedPositions ?? 0)} />
          {totals?.totalAssetValueTodayUsd != null && (
            <Uc6Metric label="Total assets today" value={<span style={{ fontFamily:"monospace", fontWeight:700, color:"#e8e8f0" }}>{fmtUsd(totals.totalAssetValueTodayUsd)}</span>} />
          )}
        </div>
      </div>

      {/* Per-year breakdown */}
      {(taxSummary.years || []).length > 0 && (
        <div style={{ display:"grid", gap:12 }}>
          <div style={{ fontSize:10, fontWeight:700, color:"rgba(232,232,240,0.35)", textTransform:"uppercase", letterSpacing:1 }}>By year</div>
          {(taxSummary.years || []).map((yr) => {
            const ytdPct = yr.ytdPct ?? null;
            const startUsd = yr.assetValueStartUsd ?? null;
            const endUsd = yr.assetValueTodayUsd ?? null;
            const hasPortfolioData = startUsd != null || endUsd != null;
            return (
              <div key={yr.year} style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.06)", borderRadius:8, padding:"12px 14px" }}>
                {/* Year header */}
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
                  <span style={{ fontSize:16, fontWeight:800, color:"#e8e8f0" }}>{yr.year}</span>
                  <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                    <span style={{ fontSize:11, color:"rgba(232,232,240,0.45)" }}>{yr.closedPositions ?? 0} positions closed</span>
                    {ytdPct != null && (
                      <span style={{ fontSize:13, fontFamily:"monospace", fontWeight:700, color:signColor(ytdPct), padding:"2px 8px", borderRadius:20, background: ytdPct >= 0 ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)" }}>
                        {ytdPct >= 0 ? "+" : ""}{ytdPct.toFixed(2)}%
                      </span>
                    )}
                  </div>
                </div>

                {/* Portfolio start → end */}
                {hasPortfolioData && (
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:12, padding:"8px 10px", background:"rgba(255,255,255,0.03)", borderRadius:6 }}>
                    <Uc6Metric label="Start value" value={
                      startUsd != null
                        ? <span style={{ fontFamily:"monospace" }}>{fmtUsd(startUsd)}</span>
                        : <span style={{ color:"rgba(232,232,240,0.3)" }}>—</span>
                    } />
                    <Uc6Metric label="End value" value={
                      endUsd != null
                        ? <span style={{ fontFamily:"monospace", color:"#e8e8f0", fontWeight:700 }}>{fmtUsd(endUsd)}</span>
                        : <span style={{ color:"rgba(232,232,240,0.3)" }}>—</span>
                    } />
                    <Uc6Metric label="Change" value={
                      startUsd != null && endUsd != null && startUsd > 0
                        ? <span style={{ fontFamily:"monospace", fontWeight:700, color:signColor(endUsd - startUsd) }}>
                            {fmtSignedUsd(endUsd - startUsd)}
                          </span>
                        : <span style={{ color:"rgba(232,232,240,0.3)" }}>—</span>
                    } />
                  </div>
                )}

                {/* P&L details */}
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(120px, 1fr))", gap:8 }}>
                  <Uc6Metric label="Fees collected" value={<span style={{ fontFamily:"monospace", color:"#06b6d4" }}>{fmtUsd(yr.feesCollectedUsd)}</span>} />
                  <Uc6Metric label="Total costs" value={<span style={{ fontFamily:"monospace", color:"#ef4444" }}>{fmtUsd(yr.totalCostsUsd)}</span>} />
                  <Uc6Metric label="Net fees" value={<span style={{ fontFamily:"monospace", color:signColor(yr.feesNetUsd) }}>{fmtSignedUsd(yr.feesNetUsd)}</span>} />
                  <Uc6Metric label="AERO rewards" value={<span style={{ fontFamily:"monospace", color:"#22c55e" }}>{fmtUsd(yr.rewardsUsd)}</span>} />
                  <Uc6Metric label="Alpha vs HODL" value={<span style={{ fontFamily:"monospace", color:signColor(yr.alphaVsHodlUsd) }}>{fmtSignedUsd(yr.alphaVsHodlUsd)}</span>} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
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
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.7)", display:"flex", justifyContent:"flex-end", zIndex:1000, backdropFilter:"blur(4px)" }} onClick={onClose}>
      <aside style={{ width:"min(420px, 100vw)", height:"100vh", overflowY:"auto", background:"#0e0f1a", borderLeft:"1px solid rgba(255,255,255,0.1)", boxShadow:"-16px 0 48px rgba(0,0,0,0.6)", padding:20, display:"grid", gap:0, alignContent:"start" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:12, marginBottom:16 }}>
          <div>
            <div style={{ fontSize:10, color:"rgba(232,232,240,0.4)", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Position Lifecycle Record</div>
            <div style={{ fontFamily:"monospace", fontSize:15, fontWeight:700, color:"#e8e8f0" }}>{record.id}</div>
          </div>
          <button style={{ padding:"4px 12px", borderRadius:6, background:"transparent", border:"1px solid rgba(255,255,255,0.15)", color:"rgba(232,232,240,0.7)", fontSize:12, cursor:"pointer" }} onClick={onClose}>Close</button>
        </div>

        <DrawerSection title="Overview">
          <DRow label="Pair" value={`${record.pair?.base || "WETH"}/${record.pair?.quote || "USDC"}`} />
          <DRow label="Venue" value={record.venue === "uniswapv3" ? "Uniswap v3" : "Slipstream"} />
          <DRow label="Band" value={<span title={`${record.band?.tickLower ?? "\u2014"} .. ${record.band?.tickUpper ?? "\u2014"}`}>{formatRecordBandLabel(record)}</span>} />
          <DRow label="Status" value={record.status || "\u2014"} />
          <DRow label="Entry Snapshot" value={fmtIsoLocal(record.entry?.entrySnapshotAtIso || record.entry?.openedAtIso)} />
          <DRow label="Exit" value={fmtIsoLocal(record.exit?.closedAtIso)} />
          <DRow label="Duration" value={record.duration?.human || fmtDurationCompact(record.duration?.secondsInPosition)} />
          <DRow label="Entry Value" value={fmtUsd(record.entry?.entryValueUsd)} />
          <DRow label="Exit Value" value={fmtUsd(record.exit?.exitValueUsd)} />
          <DRow label="Avg Deployed" value={fmtUsd(perf.avgDeployedUsd)} />
        </DrawerSection>

        <DrawerSection title="Performance">
          <DRow label="Fees Collected" value={fmtUsd(perf.feesCollectedUsd)} />
          <DRow label="AERO Rewards" value={fmtUsd(perf.rewardsUsd)} />
          <DRow label="Gas" value={fmtUsd(perf.gasUsd)} />
          <DRow label="Swap Cost" value={fmtUsd(perf.swapCostUsd)} />
          <DRow label="Mint/Burn" value={fmtUsd(perf.mintBurnUsd)} />
          <DRow label="Total Costs" value={fmtUsd(perf.totalCostsUsd)} />
          <DRow label="Fees Net" value={fmtSignedUsd(perf.feesNetUsd)} />
          <DRow label="Capital Gain/Loss" value={fmtSignedUsd(perf.capitalGainLossUsd)} />
          <DRow label="Divergence vs HODL" value={fmtSignedUsd(perf.divergenceVsHodlUsd ?? perf.impermanentLossUsd)} />
          <DRow label="LP P/L (absolute)" value={fmtSignedUsd(perf.netProfitUsd)} />
          <DRow label="Alpha vs HODL" value={fmtSignedUsd(perf.alphaVsHodlUsd)} />
          <DRow label="Required Fees to Beat HODL" value={fmtUsd(perf.requiredFeesToBeatHodlUsd)} />
          <DRow label="Cost / Fee" value={fmtRatioPct(perf.costToFeeRatio)} />
          <DRow label="Fee APR" value={fmtPct(perf.feeApr ?? 0)} />
          <DRow label="Alpha APR vs HODL" value={fmtPct(perf.alphaApr ?? 0)} />
          <DRow label="Absolute APR" value={fmtPct(perf.absoluteApr ?? perf.apr ?? 0)} />
        </DrawerSection>

        <DrawerSection title="Activity">
          <DRow label="Rebalances" value={String(record.activity?.rebalances ?? 0)} />
          <DRow label="Harvests" value={String(record.activity?.harvests ?? 0)} />
          <DRow label="Swaps" value={String(record.activity?.swaps ?? 0)} />
          <DRow label="Tx Count" value={String(record.activity?.txCount ?? 0)} />
          <DRow label="Close Gate Blocks" value={String(record.activity?.closeGateBlockedCount ?? 0)} />
          <DRow label="Close Gate Override" value={record.activity?.closeGateOverrideReason || "\u2014"} />
        </DrawerSection>

        <DrawerSection title="Transactions">
          <div style={{ fontSize:12, color:"rgba(232,232,240,0.4)", marginBottom:8 }}>
            Open: {openTxs.length} | Close: {closeTxs.length} | All: {allTxs.length}
          </div>
          <div style={{ maxHeight:200, overflowY:"auto" }}>
            {allTxs.length === 0 ? (
              <div style={{ fontSize:12, color:"rgba(232,232,240,0.3)" }}>No tx hashes recorded.</div>
            ) : (
              allTxs.map((hash) => (
                <div key={hash} style={{ padding:"5px 0", borderBottom:"1px solid rgba(255,255,255,0.05)" }}>
                  <code style={{ fontSize:11, color:"#06b6d4", wordBreak:"break-all" }}>{hash}</code>
                </div>
              ))
            )}
          </div>
        </DrawerSection>
      </aside>
    </div>
  );
}

function DrawerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ border:"1px solid rgba(255,255,255,0.07)", borderRadius:10, padding:14, background:"rgba(255,255,255,0.02)", marginBottom:12 }}>
      <div style={{ fontSize:11, fontWeight:700, color:"#06b6d4", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:10 }}>{title}</div>
      {children}
    </div>
  );
}

function DRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, padding:"5px 0", borderBottom:"1px solid rgba(255,255,255,0.04)", alignItems:"start" }}>
      <span style={{ fontSize:11, color:"rgba(232,232,240,0.4)", textTransform:"uppercase", letterSpacing:"0.04em" }}>{label}</span>
      <span style={{ fontSize:12, color:"#e8e8f0", fontWeight:600, wordBreak:"break-word", textAlign:"right" }}>{value}</span>
    </div>
  );
}

// keep styles alias referenced by poolComparisonCurrentRow/poolComparisonTopRows link elements
const styles: Record<string, CSSProperties> = {
  link: { color: "#06b6d4", textDecoration: "underline" },
};

// suppress unused-variable warning (styles IS used in poolComparisonCurrentRow computed above line 1695)
void styles;
