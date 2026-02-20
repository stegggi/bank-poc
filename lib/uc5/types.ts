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
  ingestIntervalSec: z.number().int().min(1).max(60).default(2),
  reassessIntervalSec: z.number().int().min(5).max(86400).default(8), // legacy alias
  decisionLoopIntervalSec: z.number().int().min(3).max(60).default(4),
  inPositionReassessIntervalSec: z.number().int().min(5).max(300).default(8),
  riskLoopIntervalSec: z.number().int().min(1).max(5).default(1),
  metricsLoopIntervalSec: z.number().int().min(30).max(300).default(45),

  // legacy compat
  pollIntervalSeconds: z.number().int().min(2).max(60).default(2),
  predictionHorizonSeconds: z.number().int().min(10).max(259200).default(30),

  // Risk & behavior
  maxLeverage: z.number().min(1).max(20).default(2),
  maxMarginPct: z.number().min(0).max(100).default(25),
  maxMarginUsd: z.number().min(1).max(100000).default(100), // max margin to use
  confidenceThreshold: z.number().min(0.5).max(0.95).default(0.65), // legacy alias
  openConfidenceThreshold: z.number().min(0.5).max(0.95).default(0.65),
  closeConfidenceThreshold: z.number().min(0.45).max(0.9).default(0.55),

  minHoldSeconds: z.number().int().min(5).max(259200).default(5),
  maxHoldSeconds: z.number().int().min(5).max(259200).default(7200),

  // Execution guardrails (simple)
  maxOrdersPerHour: z.number().int().min(1).max(2000).default(120),
  smartEntryTimeoutMs: z.number().int().min(200).max(5000).default(900),
  orderGuardMs: z.number().int().min(200).max(5000).default(900),
  maxSpreadBpsForTrade: z.number().min(1).max(100).default(12),
  exitSpreadInsaneBps: z.number().min(5).max(300).default(28),

  stopLossPct: z.number().positive().max(1).nullable().optional().default(0.003),
  stopLossAtrMult: z.number().positive().max(20).nullable().optional().default(null),
  takeProfitPct: z.number().positive().max(1).nullable().optional().default(0.006),
  takeProfitAtrMult: z.number().positive().max(20).nullable().optional().default(null),
  trailingStopPct: z.number().positive().max(1).nullable().optional().default(null),
  maxDailyLossUsd: z.number().min(0).max(10000000).default(0),
  tapeCvdEnabled: z.boolean().default(false),
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
    riskLoopIntervalSec?: number;
    decisionLoopIntervalSec?: number;
    inPositionReassessIntervalSec?: number;
    metricsLoopIntervalSec?: number;
    reassessIntervalSec?: number;
    predictionHorizonSeconds?: number;
    minHoldSeconds?: number;
    maxHoldSeconds?: number;
    maxLeverage?: number;
    maxMarginUsd?: number;
    maxMarginPct?: number;
    confidenceThreshold?: number;
    openConfidenceThreshold?: number;
    closeConfidenceThreshold?: number;
    stopLossPct?: number | null;
    stopLossAtrMult?: number | null;
    takeProfitPct?: number | null;
    takeProfitAtrMult?: number | null;
    trailingStopPct?: number | null;
    maxDailyLossUsd?: number;
  };
  position?: {
    open: boolean;
    side?: "LONG" | "SHORT";
    size?: number;
    entryPrice?: number;
    entryAt?: number;
    ageSec?: number;
    unrealizedPnl?: number;
    updatedAt?: number;
  };
  agent?: {
    desired?: "LONG" | "SHORT" | "FLAT";
    confidence?: number;
    confidenceBand?: "HIGH" | "MEDIUM" | "LOW";
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
    nextDecisionAt?: number | null;
    countdowns?: {
      initialHoldEndsInSec?: number | null;
      nextReassessInSec?: number | null;
      maxHoldEndsInSec?: number | null;
      nextDecisionInSec?: number | null;
    };
  };
  lastAction?: {
    type?: string;
    ok?: boolean;
    info?: unknown;
  };
};
