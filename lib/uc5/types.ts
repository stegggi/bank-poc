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

  // Bot runtime knobs
  ingestionEnabled: z.boolean().default(true),
  tradingEnabled: z.boolean().default(true),
  killSwitch: z.boolean().default(false), // legacy compat
  ingestIntervalSec: z.number().int().min(1).max(60).default(2),
  reassessIntervalSec: z.number().int().min(60).max(86400).default(300),

  // legacy compat
  pollIntervalSeconds: z.number().int().min(2).max(60).default(2),
  predictionHorizonSeconds: z.number().int().min(3600).max(259200).default(3600),

  // Risk & behavior
  maxLeverage: z.number().min(1).max(20).default(2),
  maxMarginPct: z.number().min(0).max(100).default(25),
  maxMarginUsd: z.number().min(1).max(100000).default(100), // max margin to use
  confidenceThreshold: z.number().min(0.5).max(0.95).default(0.6),

  minHoldSeconds: z.number().int().min(3600).max(259200).default(3600),
  maxHoldSeconds: z.number().int().min(3600).max(259200).default(7200),

  // Execution guardrails (simple)
  maxOrdersPerHour: z.number().int().min(1).max(2000).default(120),
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
    reassessIntervalSec?: number;
    predictionHorizonSeconds?: number;
    minHoldSeconds?: number;
    maxHoldSeconds?: number;
    maxLeverage?: number;
    maxMarginUsd?: number;
    maxMarginPct?: number;
    confidenceThreshold?: number;
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
    lastDecisionAt?: number;
    decisionHorizonSeconds?: number;
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
