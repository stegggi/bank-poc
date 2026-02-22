import { createHash, randomBytes } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";

const OWNER_HEADER = "xBank UC6 Owner Authorization";
const DEFAULT_RATE_WINDOW_MS = 60_000;

type Primitive = null | string | number | boolean;

type RateBucket = { count: number; resetAt: number };
type ChallengeStore = Map<string, Uc6ChallengeRecord>;
type RateLimitStore = Map<string, Map<string, RateBucket>>;

type GlobalUc6 = typeof globalThis & {
  __uc6Challenges?: ChallengeStore;
  __uc6RateLimit?: RateLimitStore;
};

export type OwnerAction = "update_settings" | "force_rebalance";

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

  const action = fields.action;
  if (action !== "update_settings" && action !== "force_rebalance") {
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

export function normalizeOwnerSettings(input: unknown): Record<string, Primitive> {
  if (!asObject(input)) {
    throw new Error("Settings payload must be an object");
  }
  const out: Record<string, Primitive> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else {
      throw new Error(`Invalid settings value for "${key}"`);
    }
  }
  return out;
}
