import { createHash, timingSafeEqual } from "node:crypto";

const REDACTION_PATTERNS = [
  {
    pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    replace: "$1[REDACTED]",
  },
  {
    pattern: /((?:UC6_|NEXT_PUBLIC_UC6_)(?:ADMIN_TOKEN|BOT_ADMIN_TOKEN|PRIVATE_KEY)\s*[:=]\s*)[^\s"',]+/gi,
    replace: "$1[REDACTED]",
  },
  {
    pattern: /((?:authorization|token|secret|privateKey|adminToken)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
    replace: "$1[REDACTED]",
  },
  {
    pattern: /(https?:\/\/[^/\s]+\/v3\/)[A-Za-z0-9]+/gi,
    replace: "$1[REDACTED]",
  },
];

export function safeBearerMatch(expectedToken, authorizationHeader) {
  const expected = String(expectedToken || "");
  const received = String(authorizationHeader || "");
  if (!expected || !received || !received.startsWith("Bearer ")) return false;
  const expectedDigest = createHash("sha256").update(`Bearer ${expected}`).digest();
  const receivedDigest = createHash("sha256").update(received).digest();
  return timingSafeEqual(expectedDigest, receivedDigest);
}

export function redactSensitiveText(input) {
  let out = String(input || "");
  for (const rule of REDACTION_PATTERNS) {
    out = out.replace(rule.pattern, rule.replace);
  }
  return out;
}

export function sanitizeErrorMessage(err, fallback = "unknown error", maxLen = 1200) {
  const raw = err instanceof Error ? err.message : err == null ? fallback : String(err);
  const redacted = redactSensitiveText(raw || fallback).trim() || fallback;
  if (redacted.length <= maxLen) return redacted;
  return `${redacted.slice(0, maxLen - 3)}...`;
}
