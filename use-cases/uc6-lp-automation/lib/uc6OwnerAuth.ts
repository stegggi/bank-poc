import { createHash, randomBytes } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";

const OWNER_HEADER = "xBank UC6 Owner Authorization";
const DEFAULT_RATE_WINDOW_MS = 60_000;

type Primitive = null | string | number | boolean;
type RegimeSettingsPayload = {
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
type TrendEscapeSettingsPayload = {
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
  uptrendHold?: string;
  downtrendHold?: string;
  fallbackHold?: string;
};
type ReEntrySettingsPayload = {
  enabled?: boolean;
  requireRegimeLabel?: string;
  minRegimeConfidence?: number;
  minMeanRevertConfirmSec?: number;
  maxDistanceFromMuPct?: number;
  minHoldSec?: number;
  cooldownAfterReEntrySec?: number;
};
type HodlGateSettingsPayload = {
  enabled?: boolean;
  marginUsd?: number;
  useUncollectedFees?: boolean;
  allowCloseIfOutOfRange?: boolean;
  outOfRangeMaxSec?: number;
  outOfRangeEmergencyMinSec?: number;
  outOfRangeEmergencyEdgePct?: number;
};
type ExecutionCapsSettingsPayload = {
  maxInventorySwapsPerRebalance?: number;
  maxSwapsOnOpen?: number;
  maxTopUpsPerCycle?: number;
  minTopUpUsd?: number;
  targetRatioTolerancePct?: number;
  minSwapUsd?: number;
  useMulticallClose?: boolean;
};
type GasTopUpSettingsPayload = {
  enabled?: boolean;
  minEthUsd?: number;
  topUpUsdc?: number;
  minIntervalSec?: number;
};
type PoolComparisonSettingsPayload = {
  enabled?: boolean;
  computeHourUtc?: number;
  maxCandidatesPerDex?: number;
  topN?: number;
  minTvlUsd?: number;
  maxRefCapitalPctOfTvl?: number;
  requireFeeRateInference?: boolean;
  allowLowTvlInTable?: boolean;
  rebalanceSwapNotionalPct?: number;
};
type OwnerSettingsValue =
  | Primitive
  | RegimeSettingsPayload
  | TrendEscapeSettingsPayload
  | ReEntrySettingsPayload
  | HodlGateSettingsPayload
  | ExecutionCapsSettingsPayload
  | GasTopUpSettingsPayload
  | PoolComparisonSettingsPayload;
type SettingRule = {
  type: "boolean" | "number" | "string";
  min?: number;
  max?: number;
  enum?: string[];
  nullable?: boolean;
};

type RateBucket = { count: number; resetAt: number };
type ChallengeStore = Map<string, Uc6ChallengeRecord>;
type RateLimitStore = Map<string, Map<string, RateBucket>>;

type GlobalUc6 = typeof globalThis & {
  __uc6Challenges?: ChallengeStore;
  __uc6RateLimit?: RateLimitStore;
};

export type OwnerAction = "update_settings" | "force_rebalance" | "liquidate_and_pause" | "emissions_stake" | "emissions_unstake" | "emissions_claim";

export type Uc6OwnerMessageParams = {
  action: OwnerAction;
  owner: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  payloadSha256: string;
};

export type ParsedUc6OwnerMessage = Uc6OwnerMessageParams;

export type VerifyOwnerSignatureParams = {
  ownerAddress: string;
  message: string;
  signature: string;
  payload: unknown;
  expectedAction?: OwnerAction;
  nowMs?: number;
  clockSkewSec?: number;
};

export type Uc6ChallengeRecord = {
  nonce: string;
  action: OwnerAction;
  owner: string;
  payloadSha256: string;
  issuedAt: string;
  expiresAt: string;
  createdAtMs: number;
  usedAtMs?: number;
};

function asObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function stableValue(value: unknown): string {
  if (value === null) return "null";

  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return Number.isFinite(value as number) ? JSON.stringify(value) : "null";
  if (t === "bigint") return JSON.stringify(String(value));
  if (t !== "object") return "null";

  if (Array.isArray(value)) {
    return `[${value.map((x) => stableValue(x)).join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${stableValue(obj[k])}`).join(",");
  return `{${body}}`;
}

function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

function asIsoTimestamp(v: string): number {
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) {
    throw new Error("Invalid timestamp in signed message");
  }
  return ms;
}

export function stableStringify(input: unknown): string {
  return stableValue(input);
}

export function sha256HexFromObject(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export function randomNonce(byteLength = 16): string {
  return randomBytes(byteLength).toString("hex");
}

export function makeOwnerMessage(params: Uc6OwnerMessageParams): string {
  const owner = getAddress(params.owner);
  return [
    OWNER_HEADER,
    `action: ${params.action}`,
    `owner: ${owner}`,
    `issuedAt: ${params.issuedAt}`,
    `expiresAt: ${params.expiresAt}`,
    `nonce: ${params.nonce}`,
    `payloadSha256: ${params.payloadSha256.toLowerCase()}`,
  ].join("\n");
}

export function parseOwnerMessage(message: string): ParsedUc6OwnerMessage {
  const lines = String(message || "").replace(/\r\n/g, "\n").split("\n");
  if (lines.length !== 7 || lines[0] !== OWNER_HEADER) {
    throw new Error("Invalid owner authorization message format");
  }

  const fields: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(": ");
    if (idx <= 0) throw new Error("Malformed owner authorization message");
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 2).trim();
    fields[key] = value;
  }

  const action = fields.action as OwnerAction;
  const validActions: OwnerAction[] = [
    "update_settings", "force_rebalance", "liquidate_and_pause",
    "emissions_stake", "emissions_unstake", "emissions_claim",
  ];
  if (!validActions.includes(action)) {
    throw new Error("Unsupported owner action");
  }

  return {
    action,
    owner: getAddress(fields.owner || ""),
    issuedAt: fields.issuedAt || "",
    expiresAt: fields.expiresAt || "",
    nonce: fields.nonce || "",
    payloadSha256: String(fields.payloadSha256 || "").toLowerCase(),
  };
}

export function verifyOwnerSignatureOrThrow(params: VerifyOwnerSignatureParams): ParsedUc6OwnerMessage {
  const parsed = parseOwnerMessage(params.message);
  const expectedAction = params.expectedAction || "update_settings";
  if (parsed.action !== expectedAction) {
    throw new Error("Invalid owner action");
  }

  const owner = getAddress(params.ownerAddress);
  if (!sameAddress(parsed.owner, owner)) {
    throw new Error("Owner mismatch in message");
  }

  const now = params.nowMs ?? Date.now();
  const skewMs = (params.clockSkewSec ?? 30) * 1000;
  const issuedAtMs = asIsoTimestamp(parsed.issuedAt);
  const expiresAtMs = asIsoTimestamp(parsed.expiresAt);
  if (expiresAtMs <= issuedAtMs) throw new Error("Message expiry is invalid");
  if (now < issuedAtMs - skewMs) throw new Error("Message is not yet valid");
  if (now > expiresAtMs + skewMs) throw new Error("Message has expired");

  const payloadHash = sha256HexFromObject(params.payload);
  if (payloadHash !== parsed.payloadSha256) {
    throw new Error("Payload hash mismatch");
  }

  let recovered = "";
  try {
    recovered = getAddress(verifyMessage(params.message, params.signature));
  } catch {
    throw new Error("Invalid owner signature");
  }
  if (!sameAddress(recovered, owner)) {
    throw new Error("Recovered signer is not the configured owner");
  }

  return parsed;
}

function challengeStore(): ChallengeStore {
  const g = globalThis as GlobalUc6;
  if (!g.__uc6Challenges) g.__uc6Challenges = new Map();
  return g.__uc6Challenges;
}

export function purgeExpiredChallenges(nowMs = Date.now()): void {
  const store = challengeStore();
  for (const [nonce, challenge] of store.entries()) {
    const expiresAtMs = Date.parse(challenge.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs + 60_000 < nowMs || challenge.usedAtMs) {
      store.delete(nonce);
    }
  }
}

export function saveChallenge(record: Uc6ChallengeRecord): void {
  purgeExpiredChallenges(Date.now());
  challengeStore().set(record.nonce, record);
}

export function readChallenge(nonce: string): Uc6ChallengeRecord | null {
  purgeExpiredChallenges(Date.now());
  return challengeStore().get(nonce) || null;
}

export function consumeChallenge(nonce: string, usedAtMs = Date.now()): Uc6ChallengeRecord | null {
  const record = readChallenge(nonce);
  if (!record) return null;
  if (record.usedAtMs) return null;
  challengeStore().set(nonce, { ...record, usedAtMs });
  return record;
}

function limiterStore(): RateLimitStore {
  const g = globalThis as GlobalUc6;
  if (!g.__uc6RateLimit) g.__uc6RateLimit = new Map();
  return g.__uc6RateLimit;
}

export function bestEffortRateLimit(params: {
  namespace: string;
  ip: string;
  limit: number;
  windowMs?: number;
}): { ok: boolean; retryAfterSec: number; remaining: number } {
  const now = Date.now();
  const windowMs = params.windowMs ?? DEFAULT_RATE_WINDOW_MS;
  const namespace = params.namespace;
  const ip = params.ip || "unknown";
  const root = limiterStore();

  let nsMap = root.get(namespace);
  if (!nsMap) {
    nsMap = new Map();
    root.set(namespace, nsMap);
  }

  let bucket = nsMap.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
  }
  bucket.count += 1;
  nsMap.set(ip, bucket);

  // Opportunistic cleanup.
  if (nsMap.size > 5000) {
    for (const [k, v] of nsMap.entries()) {
      if (v.resetAt <= now) nsMap.delete(k);
    }
  }

  const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  const remaining = Math.max(0, params.limit - bucket.count);
  if (bucket.count > params.limit) return { ok: false, retryAfterSec, remaining: 0 };
  return { ok: true, retryAfterSec, remaining };
}

export function getClientIp(input: {
  headers: Record<string, string | string[] | undefined>;
  remoteAddress?: string | null;
}): string {
  const xff = input.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    return xff.split(",")[0].trim();
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return String(xff[0]).split(",")[0].trim();
  }
  const xrip = input.headers["x-real-ip"];
  if (typeof xrip === "string" && xrip.trim()) return xrip.trim();
  if (Array.isArray(xrip) && xrip[0]) return String(xrip[0]).trim();
  return input.remoteAddress || "unknown";
}

const REGIME_SETTING_RULES: Record<keyof Required<RegimeSettingsPayload>, SettingRule> = {
  enabled: { type: "boolean" },
  windowSec: { type: "number", min: 60, max: 86_400 },
  sampleEverySec: { type: "number", min: 1, max: 3_600 },
  minSamples: { type: "number", min: 5, max: 20_000 },
  fastWindowSec: { type: "number", min: 30, max: 86_400 },
  fastSampleEverySec: { type: "number", min: 1, max: 3_600 },
  fastMinSamples: { type: "number", min: 5, max: 20_000 },
  fastWeight: { type: "number", min: 0, max: 0.8 },
  mrHalfLifeMaxSec: { type: "number", min: 10, max: 86_400 },
  trendHalfLifeMinSec: { type: "number", min: 10, max: 86_400 },
  maxEdgeAdj: { type: "number", min: 0, max: 0.5 },
  maxBandAdjBps: { type: "number", min: 0, max: 500 },
  maxBandNarrowBps: { type: "number", min: 0, max: 500 },
  maxCooldownAdjSec: { type: "number", min: 0, max: 86_400 },
};

const TOP_LEVEL_SETTING_RULES: Record<string, SettingRule> = {
  tradingEnabled: { type: "boolean" },
  killSwitch: { type: "boolean" },
  failureCooldownSec: { type: "number", min: 30, max: 86_400 },
  venue: { type: "string", enum: ["slipstream", "uniswapv3"] },
  bandHalfBps: { type: "number", min: 10, max: 5_000 },
  bandHalfBpsUp: { type: "number", min: 10, max: 5_000, nullable: true },
  bandHalfBpsDown: { type: "number", min: 10, max: 5_000, nullable: true },
  edgeRebalancePct: { type: "number", min: 0.1, max: 0.99 },
  minRebalanceIntervalSec: { type: "number", min: 30, max: 86_400 },
  maxRebalancesPerDay: { type: "number", min: 1, max: 500 },
  slippageBps: { type: "number", min: 1, max: 2_000 },
  pollIntervalMs: { type: "number", min: 500, max: 60_000 },
  wsEnabled: { type: "boolean" },
  slot0RefreshEverySec: { type: "number", min: 2, max: 3_600 },
  balancesRefreshEverySec: { type: "number", min: 2, max: 3_600 },
  positionRefreshEverySec: { type: "number", min: 2, max: 3_600 },
  inventoryRefreshEverySec: { type: "number", min: 5, max: 86_400 },
  collectableRefreshEverySec: { type: "number", min: 10, max: 86_400 },
  dashboardRecommendedPollMs: { type: "number", min: 1_000, max: 60_000 },
  maxDeployUsdc: { type: "number", min: 0, max: 5_000_000 },
  maxInitialMintUsdc: { type: "number", min: 0, max: 5_000_000 },
  minTopUpUsd: { type: "number", min: 0, max: 1_000_000 },
  reserveMinUsdc: { type: "number", min: 0, max: 5_000_000 },
  reservePct: { type: "number", min: 0, max: 100 },
  reserveMaxUsdc: { type: "number", min: 0, max: 5_000_000 },
  keepUsdcReserve: { type: "number", min: 0, max: 5_000_000 },
  compoundMode: { type: "string", enum: ["threshold_harvest", "on_rebalance"] },
  harvestThresholdUsd: { type: "number", min: 0, max: 1_000_000 },
  churnProtectionEnabled: { type: "boolean" },
  churnMaxCostToFeeRatio: { type: "number", min: 0, max: 100 },
};

const HODL_GATE_SETTING_RULES: Record<keyof Required<HodlGateSettingsPayload>, SettingRule> = {
  enabled: { type: "boolean" },
  marginUsd: { type: "number", min: 0, max: 1_000_000 },
  useUncollectedFees: { type: "boolean" },
  allowCloseIfOutOfRange: { type: "boolean" },
  outOfRangeMaxSec: { type: "number", min: 30, max: 7 * 24 * 60 * 60 },
  outOfRangeEmergencyMinSec: { type: "number", min: 5, max: 7 * 24 * 60 * 60 },
  outOfRangeEmergencyEdgePct: { type: "number", min: 1, max: 5 },
};

const TREND_ESCAPE_SETTING_RULES: Record<keyof Required<TrendEscapeSettingsPayload>, SettingRule> = {
  enabled: { type: "boolean" },
  variant: { type: "string", enum: ["hybrid", "tiered"] },
  requireRegimeLabel: { type: "string", enum: ["trending", "mean_reverting"] },
  minRegimeConfidence: { type: "number", min: 0, max: 1 },
  minEdgeProgressToConsider: { type: "number", min: 0.2, max: 0.95 },
  baseConfirmSec: { type: "number", min: 30, max: 3600 },
  urgencyThreshold: { type: "number", min: 0.3, max: 1.0 },
  directionLookbackSec: { type: "number", min: 30, max: 86_400 },
  minTrendMovePct: { type: "number", min: 0, max: 1 },
  minTrendConfirmSec: { type: "number", min: 5, max: 86_400 },
  cooldownAfterEscapeSec: { type: "number", min: 0, max: 7 * 24 * 60 * 60 },
  minAlphaUsdToEscape: { type: "number", min: -1_000_000, max: 1_000_000 },
  emergencyOutOfRangeEdgePct: { type: "number", min: 1, max: 5 },
  emergencyMinOutOfRangeSec: { type: "number", min: 5, max: 7 * 24 * 60 * 60 },
  uptrendHold: { type: "string", enum: ["WETH", "USDC", "50_50"] },
  downtrendHold: { type: "string", enum: ["WETH", "USDC", "50_50"] },
  fallbackHold: { type: "string", enum: ["WETH", "USDC", "50_50"] },
};

const REENTRY_SETTING_RULES: Record<keyof Required<ReEntrySettingsPayload>, SettingRule> = {
  enabled: { type: "boolean" },
  requireRegimeLabel: { type: "string", enum: ["trending", "mean_reverting"] },
  minRegimeConfidence: { type: "number", min: 0, max: 1 },
  minMeanRevertConfirmSec: { type: "number", min: 5, max: 86_400 },
  maxDistanceFromMuPct: { type: "number", min: 0, max: 1 },
  minHoldSec: { type: "number", min: 0, max: 7 * 24 * 60 * 60 },
  cooldownAfterReEntrySec: { type: "number", min: 0, max: 7 * 24 * 60 * 60 },
};

const EXECUTION_CAPS_SETTING_RULES: Record<keyof Required<ExecutionCapsSettingsPayload>, SettingRule> = {
  maxInventorySwapsPerRebalance: { type: "number", min: 0, max: 10 },
  maxSwapsOnOpen: { type: "number", min: 0, max: 10 },
  maxTopUpsPerCycle: { type: "number", min: 0, max: 20 },
  minTopUpUsd: { type: "number", min: 0, max: 1_000_000 },
  targetRatioTolerancePct: { type: "number", min: 0.001, max: 0.5 },
  minSwapUsd: { type: "number", min: 0, max: 1_000_000 },
  useMulticallClose: { type: "boolean" },
};

const GAS_TOP_UP_SETTING_RULES: Record<keyof Required<GasTopUpSettingsPayload>, SettingRule> = {
  enabled: { type: "boolean" },
  minEthUsd: { type: "number", min: 0, max: 1_000_000 },
  topUpUsdc: { type: "number", min: 0.01, max: 1_000_000 },
  minIntervalSec: { type: "number", min: 30, max: 86_400 },
};

const POOL_COMPARISON_SETTING_RULES: Record<keyof Required<PoolComparisonSettingsPayload>, SettingRule> = {
  enabled: { type: "boolean" },
  computeHourUtc: { type: "number", min: 0, max: 23 },
  maxCandidatesPerDex: { type: "number", min: 5, max: 100 },
  topN: { type: "number", min: 1, max: 20 },
  minTvlUsd: { type: "number", min: 0, max: 1_000_000_000 },
  maxRefCapitalPctOfTvl: { type: "number", min: 0, max: 1 },
  requireFeeRateInference: { type: "boolean" },
  allowLowTvlInTable: { type: "boolean" },
  rebalanceSwapNotionalPct: { type: "number", min: 0, max: 1 },
};

function normalizeRegimeSettings(input: unknown): RegimeSettingsPayload {
  return normalizeSettingsObjectByRules<RegimeSettingsPayload>("regime", input, REGIME_SETTING_RULES);
}

function validateSettingRule(scope: string, key: string, value: unknown, rule: SettingRule): unknown {
  const label = scope ? `${scope}.${key}` : key;
  if (rule.nullable && value === null) {
    return null;
  }
  if (rule.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new Error(`Invalid settings value for "${label}"`);
    }
    return value;
  }
  if (rule.type === "string") {
    if (typeof value !== "string") {
      throw new Error(`Invalid settings value for "${label}"`);
    }
    if (rule.enum && !rule.enum.includes(value)) {
      throw new Error(`Invalid settings value for "${label}"`);
    }
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid settings value for "${label}"`);
  }
  if (rule.min != null && value < rule.min) {
    throw new Error(`Invalid settings value for "${label}"`);
  }
  if (rule.max != null && value > rule.max) {
    throw new Error(`Invalid settings value for "${label}"`);
  }
  return value;
}

function normalizeSettingsObjectByRules<T extends Record<string, unknown>>(
  scope: string,
  input: unknown,
  rules: Record<string, SettingRule>
): T {
  if (!asObject(input)) {
    throw new Error(`Invalid settings value for "${scope}"`);
  }
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(input)) {
    const rule = rules[rawKey];
    if (!rule) {
      throw new Error(`Invalid settings value for "${scope}.${rawKey}"`);
    }
    out[rawKey] = validateSettingRule(scope, rawKey, value, rule);
  }
  return out as T;
}

export function normalizeOwnerSettings(input: unknown): Record<string, OwnerSettingsValue> {
  if (!asObject(input)) {
    throw new Error("Settings payload must be an object");
  }
  const out: Record<string, OwnerSettingsValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "regime") {
      out[key] = normalizeRegimeSettings(value);
    } else if (key === "hodlGate") {
      out[key] = normalizeSettingsObjectByRules<HodlGateSettingsPayload>("hodlGate", value, HODL_GATE_SETTING_RULES);
    } else if (key === "trendEscape") {
      out[key] = normalizeSettingsObjectByRules<TrendEscapeSettingsPayload>(
        "trendEscape",
        value,
        TREND_ESCAPE_SETTING_RULES
      );
    } else if (key === "reEntry") {
      out[key] = normalizeSettingsObjectByRules<ReEntrySettingsPayload>("reEntry", value, REENTRY_SETTING_RULES);
    } else if (key === "executionCaps") {
      out[key] = normalizeSettingsObjectByRules<ExecutionCapsSettingsPayload>(
        "executionCaps",
        value,
        EXECUTION_CAPS_SETTING_RULES
      );
    } else if (key === "gasTopUp") {
      out[key] = normalizeSettingsObjectByRules<GasTopUpSettingsPayload>("gasTopUp", value, GAS_TOP_UP_SETTING_RULES);
    } else if (key === "poolComparison") {
      out[key] = normalizeSettingsObjectByRules<PoolComparisonSettingsPayload>(
        "poolComparison",
        value,
        POOL_COMPARISON_SETTING_RULES
      );
    } else if (TOP_LEVEL_SETTING_RULES[key]) {
      out[key] = validateSettingRule("", key, value, TOP_LEVEL_SETTING_RULES[key]) as Primitive;
    } else {
      throw new Error(`Invalid settings value for "${key}"`);
    }
  }
  return out;
}
