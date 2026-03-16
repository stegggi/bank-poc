// lib/uc5/types.ts
import { z } from "zod";

export const Uc5ConfigSchema = z.object({
  version: z.number().int().positive().default(1),

  ownerAddress: z.string().default(""), // your MetaMask address (admin)

  // Ethereal (mainnet by default)
  etherealApiBase: z.string().url().default("https://api.ethereal.trade"),
  etherealArchiveBase: z.string().url().default("https://archive.ethereal.trade"),

  // What we trade
  ticker: z.string().min(1).default("BTCUSD"),
  productId: z.string().optional().default(""), // optional UUID (discovered)
  subaccountId: z.string().optional().default(""), // UUID (discovered)
  subaccountName: z.union([z.literal(""), z.string().regex(/^0x[0-9a-fA-F]{64}$/)]).optional().default(""), // bytes32 hex (e.g. primary)
  botSignerAddress: z.string().default(""),
  botSignerLinked: z.boolean().default(false),

  // Bot runtime knobs
  ingestionEnabled: z.boolean().default(true),
  tradingEnabled: z.boolean().default(true),
  killSwitch: z.boolean().default(false), // legacy compat
  ingestIntervalSec: z.number().min(0.2).max(60).default(0.5),
  regimeLookbackSeconds: z.number().int().min(60).max(86400).default(1800),
  regimeBarSeconds: z.number().int().min(1).max(60).default(1),
  regimeSampleEverySec: z.number().int().min(1).max(300).default(12),
  trendHalfLifeMinSec: z.number().int().min(60).max(7200).default(450),
  trendEntryStrength: z.number().min(0.5).max(0.99).default(0.7),
  flipCooldownSec: z.number().int().min(0).max(600).default(15),
  reassessIntervalSec: z.number().int().min(5).max(86400).default(8), // legacy alias
  decisionLoopIntervalSec: z.number().int().min(3).max(60).default(4),
  inPositionReassessIntervalSec: z.number().int().min(5).max(300).default(8),
  riskLoopIntervalSec: z.number().int().min(1).max(5).default(1),
  metricsLoopIntervalSec: z.number().int().min(30).max(300).default(45),

  // legacy compat
  pollIntervalSeconds: z.number().int().min(1).max(60).default(1),
  predictionHorizonSeconds: z.number().int().min(10).max(259200).default(30),

  // Risk & behavior
  maxLeverage: z.number().min(1).max(20).default(2),
  maxMarginPct: z.number().min(0).max(100).default(25),
  maxMarginUsd: z.number().min(1).max(100000).default(100), // max margin to use
  confidenceThreshold: z.number().min(0.5).max(0.95).default(0.65), // legacy alias
  openConfidenceThreshold: z.number().min(0.5).max(0.95).default(0.65),
  closeConfidenceThreshold: z.number().min(0.45).max(0.9).default(0.55),

  minHoldSeconds: z.number().int().min(0).max(259200).default(5),
  maxHoldSeconds: z.number().int().min(5).max(259200).default(7200),
  exitOnRegimeEnd: z.boolean().default(true),
  regimeExitEnabled: z.boolean().default(false),

  // Execution guardrails (simple)
  maxOrdersPerHour: z.number().int().min(1).max(2000).default(120),
  smartEntryTimeoutMs: z.number().int().min(200).max(5000).default(900),
  orderGuardMs: z.number().int().min(200).max(5000).default(200),
  maxSpreadBpsForTrade: z.number().min(1).max(100).default(12),
  tpMaxSpreadMult: z.number().min(1).max(20).default(3),
  exitSpreadInsaneBps: z.number().min(5).max(300).default(28),
  feeEstimateBps: z.number().min(0).max(100).default(3),
  slippageBufferBps: z.number().min(0).max(100).default(4),
  minExpectedMoveBps: z.number().min(0).max(500).default(0),
  edgeCostMultiplier: z.number().min(0).max(5).default(0),
  fastFillEnabled: z.boolean().default(true),
  entryMakerPreferred: z.boolean().default(true),
  entryMarketFallbackEnabled: z.boolean().default(false),
  entryMarketFallbackMinProb: z.number().min(0.5).max(0.99).default(0.9),
  cooldownAfterCloseSec: z.number().int().min(0).max(600).default(5),
  emergencyBreakoutEnabled: z.boolean().default(false),
  emergencyBreakoutMinProb: z.number().min(0.5).max(0.99).default(0.94),
  emergencyBreakoutMinMoveBps: z.number().min(1).max(1000).default(35),
  emergencyBreakoutMinAtrPercentile: z.number().min(0).max(1).default(0.85),
  entryChaseMaxSec: z.number().min(0.5).max(30).optional().default(10),
  exitChaseMaxSec: z.number().min(0.5).max(30).optional().default(5),
  executionRepriceMs: z.number().int().min(100).max(5000).optional().default(350),
  makerOrderGtdSec: z.number().int().min(1).max(30).optional().default(2),
  makerMinRestMs: z.number().int().min(100).max(5000).optional().default(700),
  makerReplaceOnlyOnTouchMove: z.boolean().optional().default(true),
  makerImproveOneTickOnWideSpread: z.boolean().optional().default(true),
  makerImproveMinSpreadTicks: z.number().min(1).max(20).optional().default(3),
  entryMinFillRatio: z.number().min(0.1).max(1).optional().default(0.5),

  stopLossPct: z.number().positive().max(1).nullable().optional().default(0.003),
  stopLossAtrMult: z.number().positive().max(20).nullable().optional().default(null),
  atrStopLossConfirmSec: z.number().int().min(0).max(900).optional().default(120),
  takeProfitPct: z.number().positive().max(1).nullable().optional().default(0.006),
  takeProfitAtrMult: z.number().positive().max(20).nullable().optional().default(null),
  trailingStopPct: z.number().positive().max(1).nullable().optional().default(null),
  maxDailyLossUsd: z.number().min(0).max(10000000).default(0),
  tapeCvdEnabled: z.boolean().default(false),

  // Profitability controls
  fundingRateLimitPct: z.number().min(0).max(1).default(0),   // max hourly funding rate to allow entry (0 = disabled)
  maxDailyTrades: z.number().int().min(0).max(100).default(0), // max trades per day (0 = unlimited)
});

export type Uc5Config = z.infer<typeof Uc5ConfigSchema>;

export type Uc5Command =
  | { id: string; type: "FLATTEN"; createdAt: number; status: "NEW" | "DONE" | "ERROR"; result?: unknown }
  | {
      id: string;
      type: "LINK_SIGNER";
      createdAt: number;
      status: "NEW" | "DONE" | "ERROR";
      payload: {
        // Ethereal LinkSigner typed-data values
        subaccountId: string;
        sender: string; // owner
        subaccount: string; // bytes32
        signer: string; // bot signer address
        nonce: string; // uint64 as string
        signedAt: number; // seconds
        senderSignature: string; // EIP-712 signature from MetaMask (owner)
      };
      result?: unknown;
    };

export type Uc5Status = {
  updatedAt: number;
  bot: {
    alive: boolean;
    lastLoopAt?: number;
    message?: string;
    version?: string;
  };
  market?: {
    ticker?: string;
    price?: number;
    oraclePrice?: number;
    bestBid?: number;
    bestAsk?: number;
  };
  account?: {
    owner?: string;
    subaccountId?: string;
    subaccountName?: string;
    marginAvailableUsd?: number;
    marginUsedUsd?: number;
    totalBalanceUsd?: number;
  };
  runtime?: {
    ingestionEnabled?: boolean;
    tradingEnabled?: boolean;
    ingestIntervalSec?: number;
    regimeLookbackSeconds?: number;
    regimeBarSeconds?: number;
    regimeSampleEverySec?: number;
    trendHalfLifeMinSec?: number;
    trendEntryStrength?: number;
    flipCooldownSec?: number;
    riskLoopIntervalSec?: number;
    decisionLoopIntervalSec?: number;
    inPositionReassessIntervalSec?: number;
    metricsLoopIntervalSec?: number;
    reassessIntervalSec?: number;
    predictionHorizonSeconds?: number;
    minHoldSeconds?: number;
    maxHoldSeconds?: number;
    exitOnRegimeEnd?: boolean;
    regimeExitEnabled?: boolean;
    maxLeverage?: number;
    maxMarginUsd?: number;
    maxMarginPct?: number;
    confidenceThreshold?: number;
    openConfidenceThreshold?: number;
    closeConfidenceThreshold?: number;
    feeEstimateBps?: number;
    slippageBufferBps?: number;
    minExpectedMoveBps?: number;
    edgeCostMultiplier?: number;
    entryMakerPreferred?: boolean;
    entryMarketFallbackEnabled?: boolean;
    entryMarketFallbackMinProb?: number;
    cooldownAfterCloseSec?: number;
    emergencyBreakoutEnabled?: boolean;
    emergencyBreakoutMinProb?: number;
    emergencyBreakoutMinMoveBps?: number;
    emergencyBreakoutMinAtrPercentile?: number;
    entryChaseMaxSec?: number;
    exitChaseMaxSec?: number;
    executionRepriceMs?: number;
    makerOrderGtdSec?: number;
    makerMinRestMs?: number;
    makerReplaceOnlyOnTouchMove?: boolean;
    makerImproveOneTickOnWideSpread?: boolean;
    makerImproveMinSpreadTicks?: number;
    entryMinFillRatio?: number;
    stopLossPct?: number | null;
    stopLossAtrMult?: number | null;
    atrStopLossConfirmSec?: number;
    takeProfitPct?: number | null;
    takeProfitAtrMult?: number | null;
    trailingStopPct?: number | null;
    maxDailyLossUsd?: number;
    fundingRateLimitPct?: number;
    maxDailyTrades?: number;
  };
  position?: {
    open: boolean;
    side?: "LONG" | "SHORT";
    size?: number;
    entryPrice?: number;
    entryAt?: number;
    ageSec?: number;
    unrealizedPnl?: number;
    atrPct?: number;
    liveAtrPct?: number;
    entryAtrPct?: number;
    fixedStopPct?: number;
    fixedTakePct?: number;
    fixedStopPrice?: number;
    fixedTakePrice?: number;
    atrStopLossDebounceActive?: boolean;
    atrStopLossConfirmSec?: number;
    atrStopLossBreachSec?: number;
    atrStopLossConfirmRemainingSec?: number;
    updatedAt?: number;
  };
  agent?: {
    desired?: "LONG" | "SHORT" | "FLAT";
    confidence?: number;
    confidenceBand?: "HIGH" | "MEDIUM" | "LOW";
    regimeState?: "TREND" | "RANGE" | "UNKNOWN" | string;
    regimeDirection?: "UP" | "DOWN" | null | string;
    regimeStrength?: number;
    regimeDiagnostics?: unknown;
    lastRegimeChangeAt?: number;
    reason?: string;
    reasonHuman?: string;
    reasonRaw?: string;
    regime?: string;
    lastDecisionAt?: number;
    decisionHorizonSeconds?: number;
    decisionIntervalSeconds?: number;
    inPositionIntervalSeconds?: number;
    nextReassessAt?: number;
    minHoldUntil?: number;
    maxHoldUntil?: number;
  };
  trading?: {
    enabled?: boolean;
    running?: boolean;
    positionOpen?: boolean;
    entryAt?: number | null;
    initialHoldEndsAt?: number | null;
    nextReassessAt?: number | null;
    maxHoldEndsAt?: number | null;
    cooldownUntil?: number | null;
    nextDecisionAt?: number | null;
    tradesToday?: number;
    maxDailyTrades?: number;
    countdowns?: {
      initialHoldEndsInSec?: number | null;
      nextReassessInSec?: number | null;
      maxHoldEndsInSec?: number | null;
      cooldownEndsInSec?: number | null;
      nextDecisionInSec?: number | null;
    };
  };
  lastAction?: {
    type?: string;
    ok?: boolean;
    info?: unknown;
  };
  execution?: {
    fastFillEnabled?: boolean;
    makerOnlyEntry?: boolean;
    makerFirstExitWithMarketSafety?: boolean;
    exitMarketSafetyAfterSec?: number;
    quoteSource?: string;
    wsQuotes?: {
      bestBid?: number | null;
      bestAsk?: number | null;
      lastUpdateMs?: number | null;
      connected?: boolean;
      subscribed?: boolean;
      lastError?: string | null;
      productId?: string;
      restartCount?: number;
      lastRestartMs?: number | null;
      lastRestartReason?: string | null;
      stale?: boolean;
      staleAfterMs?: number;
    };
    lastEntryFill?: {
      isMaker?: boolean;
      feeUsd?: number;
      type?: string;
      price?: number;
      qty?: number;
      createdAt?: number;
    } | null;
    lastEntryFillAudit?: unknown;
    lastExitFillAudit?: unknown;
    lastExitMethod?: "maker" | "market_safety" | string | null;
    fillsAuditLast20?: {
      summary?: {
        count?: number;
        makerCount?: number;
        makerRatePct?: number;
        totalFeesUsd?: number;
      };
      fills?: Array<{
        isMaker?: boolean;
        feeUsd?: number;
        type?: string;
        price?: number;
        qty?: number;
        createdAt?: number;
      }>;
    } | null;
    entryMakerChases?: number;
    entryMakerOpened?: number;
    entryMakerTimeouts?: number;
    entryMakerPartialAccepts?: number;
    entryMakerFillRatePct?: number;
    entryMakerPartialRatePct?: number;
    avgEntryTimeToFirstFillMs?: number | null;
  };
};
