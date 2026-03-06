import readline from "node:readline";
import { evaluateUc5Regime } from "./regime_uc5.mjs";

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function normalizeResponse(id, payload = {}) {
  const state = payload.state === "TREND" || payload.state === "RANGE" || payload.state === "UNKNOWN" ? payload.state : "UNKNOWN";
  const direction = payload.direction === "UP" || payload.direction === "DOWN" ? payload.direction : null;
  return {
    id,
    ok: true,
    result: {
      state,
      direction,
      strength: clamp(Number(payload.strength || 0), 0, 1),
      reason: String(payload.reason || ""),
      ts: Number(payload.ts || Date.now()),
      diagnostics: payload.diagnostics && typeof payload.diagnostics === "object" ? payload.diagnostics : {},
    },
  };
}

function normalizeError(id, error) {
  return {
    id,
    ok: false,
    error: String(error || "unknown regime runner error"),
    result: {
      state: "UNKNOWN",
      direction: null,
      strength: 0,
      reason: String(error || "unknown regime runner error"),
      ts: Date.now(),
    },
  };
}

function handleRequest(line) {
  const req = JSON.parse(line);
  const id = req && typeof req === "object" ? req.id ?? null : null;
  const payload = req && typeof req === "object" ? req.payload ?? {} : {};

  const bars = Array.isArray(payload.bars) ? payload.bars : [];
  const lookbackSeconds = Math.max(60, Math.round(Number(payload.regimeLookbackSeconds ?? payload.windowSec ?? 1800)));
  const barSeconds = Math.max(1, Math.round(Number(payload.regimeBarSeconds ?? payload.sampleEverySec ?? 1)));
  const sampleEverySec = Math.max(1, Math.round(Number(payload.regimeSampleEverySec ?? payload.sampleEverySec ?? 12)));
  const minSamples = Math.max(5, Math.round(Number(payload.minSamples ?? Math.min(60, Math.max(5, Math.floor(lookbackSeconds / Math.max(sampleEverySec, 1) / 3))))));
  const trendHalfLifeMinSec = Math.max(60, Math.round(Number(payload.trendHalfLifeMinSec ?? 900)));

  return normalizeResponse(
    id,
    evaluateUc5Regime({
      bars,
      windowSec: lookbackSeconds,
      sampleEverySec,
      minSamples,
      trendHalfLifeMinSec,
    })
  );
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line || !line.trim()) return;
  let response;
  try {
    response = handleRequest(line);
  } catch (err) {
    let id = null;
    try {
      const maybeReq = JSON.parse(line);
      id = maybeReq && typeof maybeReq === "object" ? maybeReq.id ?? null : null;
    } catch {}
    response = normalizeError(id, err instanceof Error ? err.message : String(err || "unknown error"));
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
});

rl.on("close", () => {
  process.exit(0);
});
