import http from "node:http";
import process from "node:process";
import path from "node:path";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  erc20Abi,
  formatUnits,
  getAddress,
  http as viemHttp,
  maxUint256,
  parseUnits,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { verifyMessage } from "ethers";

const VERSION = "uc6-lp-bot/0.1";
const USDC_DECIMALS = 6;
const WETH_DECIMALS = 18;
const Q96 = 2n ** 96n;
const UINT128_MAX = (2n ** 128n) - 1n;
const EVENT_RING_LIMIT = 5;
const ACCOUNTING_EVENT_LIMIT = 5000;

const ENV = {
  rpcUrl: process.env.UC6_RPC_URL || "",
  privateKey: process.env.UC6_PRIVATE_KEY || "",
  adminToken: process.env.UC6_ADMIN_TOKEN || "",
  ownerAddress: process.env.UC6_OWNER_ADDRESS || "",
  host: process.env.UC6_HTTP_HOST || "0.0.0.0",
  port: Number(process.env.UC6_HTTP_PORT || 8797),
  dataDir: process.env.UC6_DATA_DIR || "/opt/uc6-bot",

  usdc: process.env.UC6_TOKEN_USDC || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  weth: process.env.UC6_TOKEN_WETH || "0x4200000000000000000000000000000000000006",

  slipstreamPool: process.env.UC6_SLIPSTREAM_POOL || "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59",
  slipstreamRouter: process.env.UC6_SLIPSTREAM_ROUTER || "0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5",
  slipstreamQuoter: process.env.UC6_SLIPSTREAM_QUOTER || "0x254cf9e1e6e233aa1ac962cb9b05b2cfeaae15b0",
  slipstreamNpm: process.env.UC6_SLIPSTREAM_NPM || "0x827922686190790b37229fd06084350e74485b72",

  uniswapPool: process.env.UC6_UNISWAP_POOL || "0xd0b53d9277642d899df5c87a3966a349a798f224",
  uniswapRouter: process.env.UC6_UNISWAP_ROUTER || "0x2626664c2603336E57B271c5C0b26F421741e481",
  uniswapQuoter: process.env.UC6_UNISWAP_QUOTER || "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  uniswapNpm: process.env.UC6_UNISWAP_NPM || "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
};

const SETTINGS_PATH = path.join(ENV.dataDir, "settings.json");
const STATE_PATH = path.join(ENV.dataDir, "state.json");

const POOL_ABI = [
  {
    name: "token0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "token1",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "tickSpacing",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "int24" }],
  },
  {
    name: "fee",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint24" }],
  },
];

const SLOT0_ABI_V7 = [
  {
    name: "slot0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
];

const SLOT0_ABI_V6 = [
  {
    name: "slot0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "unlocked", type: "bool" },
    ],
  },
];

const NPM_POSITION_ABI = [
  {
    name: "positions",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "nonce", type: "uint96" },
      { name: "operator", type: "address" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "tickSpacing", type: "int24" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
      { name: "tokensOwed0", type: "uint128" },
      { name: "tokensOwed1", type: "uint128" },
    ],
  },
  {
    name: "decreaseLiquidity",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "liquidity", type: "uint128" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    name: "collect",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "amount0Max", type: "uint128" },
          { name: "amount1Max", type: "uint128" },
        ],
      },
    ],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    name: "burn",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
];

const NPM_MINT_ABI_FEE = [
  {
    name: "mint",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "amount0Desired", type: "uint256" },
          { name: "amount1Desired", type: "uint256" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "tokenId", type: "uint256" },
      { name: "liquidity", type: "uint128" },
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
];

const NPM_MINT_ABI_TICK = [
  {
    name: "mint",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "tickSpacing", type: "int24" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "amount0Desired", type: "uint256" },
          { name: "amount1Desired", type: "uint256" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "tokenId", type: "uint256" },
      { name: "liquidity", type: "uint128" },
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
];

const NPM_MINT_ABI_TICK_WITH_PRICE = [
  {
    name: "mint",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "tickSpacing", type: "int24" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "amount0Desired", type: "uint256" },
          { name: "amount1Desired", type: "uint256" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "sqrtPriceX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "tokenId", type: "uint256" },
      { name: "liquidity", type: "uint128" },
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
];

const ROUTER_ABI_FEE = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
];

const ROUTER_ABI_TICK = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "tickSpacing", type: "int24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
];

const QUOTER_ABI_FEE_V2 = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
];

const QUOTER_ABI_TICK_V2 = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "tickSpacing", type: "int24" },
          { name: "amountIn", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
];

const ERC721_TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: true, name: "tokenId", type: "uint256" },
  ],
};

const NPM_COLLECT_EVENT = {
  type: "event",
  name: "Collect",
  inputs: [
    { indexed: true, name: "tokenId", type: "uint256" },
    { indexed: false, name: "recipient", type: "address" },
    { indexed: false, name: "amount0", type: "uint256" },
    { indexed: false, name: "amount1", type: "uint256" },
  ],
};

const DEFAULT_SETTINGS = {
  version: 1,
  tradingEnabled: true,
  killSwitch: false,
  failureCooldownSec: 900,
  venue: "slipstream",
  bandHalfBps: 100,
  edgeRebalancePct: 0.85,
  minRebalanceIntervalSec: 300,
  maxRebalancesPerDay: 20,
  slippageBps: 30,
  pollIntervalMs: 2000,
  maxDeployUsdc: 50_000,
  reserveMinUsdc: 25,
  reservePct: 0,
  reserveMaxUsdc: 0,
  compoundMode: "on_rebalance",
  harvestThresholdUsd: 30,
  churnProtectionEnabled: false,
  churnMaxCostToFeeRatio: 0.4,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function utcDayKey(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function toNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(v, fallback) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v.toLowerCase() === "true") return true;
    if (v.toLowerCase() === "false") return false;
  }
  return fallback;
}

function toRatio(v, fallback) {
  const n = toNumber(v, fallback);
  if (!Number.isFinite(n)) return fallback;
  if (n > 1) return n / 100;
  return n;
}

function normalizeSettings(input = {}, baseSettings = DEFAULT_SETTINGS) {
  const src = input && typeof input === "object" ? input : {};
  const killSwitch = toBool(src.killSwitch, baseSettings.killSwitch);
  const reserveMinUsdc = clamp(
    toNumber(src.reserveMinUsdc ?? src.keepUsdcReserve, baseSettings.reserveMinUsdc),
    0,
    5_000_000
  );
  const reservePct = clamp(toRatio(src.reservePct, baseSettings.reservePct), 0, 1);
  const reserveMaxUsdcRaw = toNumber(src.reserveMaxUsdc, baseSettings.reserveMaxUsdc);
  const reserveMaxUsdc = clamp(reserveMaxUsdcRaw, 0, 5_000_000);
  const compoundMode = src.compoundMode === "threshold_harvest" ? "threshold_harvest" : "on_rebalance";
  const out = {
    version: 1,
    tradingEnabled: killSwitch ? false : toBool(src.tradingEnabled, baseSettings.tradingEnabled),
    killSwitch,
    failureCooldownSec: clamp(
      Math.round(toNumber(src.failureCooldownSec, baseSettings.failureCooldownSec)),
      30,
      86_400
    ),
    venue: src.venue === "uniswapv3" ? "uniswapv3" : "slipstream",
    bandHalfBps: clamp(Math.round(toNumber(src.bandHalfBps, baseSettings.bandHalfBps)), 10, 5000),
    edgeRebalancePct: clamp(toNumber(src.edgeRebalancePct, baseSettings.edgeRebalancePct), 0.1, 0.99),
    minRebalanceIntervalSec: clamp(
      Math.round(toNumber(src.minRebalanceIntervalSec, baseSettings.minRebalanceIntervalSec)),
      30,
      86_400
    ),
    maxRebalancesPerDay: clamp(Math.round(toNumber(src.maxRebalancesPerDay, baseSettings.maxRebalancesPerDay)), 1, 500),
    slippageBps: clamp(Math.round(toNumber(src.slippageBps, baseSettings.slippageBps)), 1, 2_000),
    pollIntervalMs: clamp(Math.round(toNumber(src.pollIntervalMs, baseSettings.pollIntervalMs)), 500, 60_000),
    maxDeployUsdc: clamp(toNumber(src.maxDeployUsdc, baseSettings.maxDeployUsdc), 0, 5_000_000),
    reserveMinUsdc,
    reservePct,
    reserveMaxUsdc,
    keepUsdcReserve: reserveMinUsdc,
    compoundMode,
    harvestThresholdUsd: clamp(toNumber(src.harvestThresholdUsd, baseSettings.harvestThresholdUsd), 0, 1_000_000),
    churnProtectionEnabled: toBool(src.churnProtectionEnabled, baseSettings.churnProtectionEnabled),
    churnMaxCostToFeeRatio: clamp(
      toNumber(src.churnMaxCostToFeeRatio, baseSettings.churnMaxCostToFeeRatio),
      0,
      100
    ),
  };
  return out;
}

function defaultState(accountAddress) {
  return {
    version: 1,
    account: accountAddress,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    dayKey: utcDayKey(),
    rebalancesToday: 0,
    lastRebalanceAt: null,
    lastRebalanceAttemptAt: null,
    lastRebalanceFailedAt: null,
    rebalanceFailureCooldownUntil: null,
    consecutiveRebalanceFailures: 0,
    forceRebalanceRequestedAt: null,
    forceRebalanceRecoveryPending: false,
    pendingCompoundUsd: 0,
    position: {
      venue: "slipstream",
      tokenId: null,
      tickLower: null,
      tickUpper: null,
      centerTick: null,
      liquidity: null,
      inRange: null,
    },
    latest: {
      primary: null,
      fallback: null,
      wallet: null,
      collectableNow: { usdc: 0, weth: 0, usd: 0, isEstimated: true },
    },
    events: [],
    ledgerEvents: [],
    lastDecision: null,
    lastError: null,
  };
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function readJsonIfExists(filePath) {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    if (!text || !text.trim()) return null;
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) {
      try {
        const badPath = `${filePath}.bad-${Date.now()}`;
        await fsp.rename(filePath, badPath);
      } catch {
        // ignore backup move errors
      }
      return null;
    }
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const text = JSON.stringify(value, null, 2);
  await fsp.writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(tmp, filePath);
}

function stableStringify(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (t === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((x) => stableStringify(x)).join(",")}]`;
  if (t !== "object") return "null";
  const obj = value;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function sha256Hex(payload) {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function parseOwnerMessage(message) {
  const lines = String(message || "").replace(/\r\n/g, "\n").split("\n");
  if (lines.length !== 7 || lines[0] !== "xBank UC6 Owner Authorization") {
    throw new Error("Invalid owner message format");
  }
  const fields = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(": ");
    if (idx <= 0) throw new Error("Malformed owner message");
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 2).trim();
    fields[key] = value;
  }
  return {
    action: fields.action || "",
    owner: fields.owner || "",
    issuedAt: fields.issuedAt || "",
    expiresAt: fields.expiresAt || "",
    nonce: fields.nonce || "",
    payloadSha256: String(fields.payloadSha256 || "").toLowerCase(),
  };
}

function sameAddress(a, b) {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

function verifyOwnerSignature({ ownerAddress, message, signature, payload, expectedAction = "update_settings" }) {
  const parsed = parseOwnerMessage(message);
  if (parsed.action !== expectedAction) {
    throw new Error("Invalid owner action");
  }

  const owner = getAddress(ownerAddress);
  if (!sameAddress(parsed.owner, owner)) {
    throw new Error("Message owner mismatch");
  }

  const issuedAtMs = Date.parse(parsed.issuedAt);
  const expiresAtMs = Date.parse(parsed.expiresAt);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)) {
    throw new Error("Invalid owner message timestamps");
  }
  const now = Date.now();
  const skewMs = 30_000;
  if (expiresAtMs <= issuedAtMs || now > expiresAtMs + skewMs || now < issuedAtMs - skewMs) {
    throw new Error("Owner message expired or not yet valid");
  }

  const payloadHash = sha256Hex(payload);
  if (payloadHash !== parsed.payloadSha256) {
    throw new Error("Payload hash mismatch");
  }

  let recovered = "";
  try {
    recovered = getAddress(verifyMessage(message, signature));
  } catch {
    throw new Error("Invalid signature");
  }
  if (!sameAddress(recovered, owner)) {
    throw new Error("Recovered signer is not owner");
  }

  return parsed;
}

function extractIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    return xff.split(",")[0].trim();
  }
  const xrip = req.headers["x-real-ip"];
  if (typeof xrip === "string" && xrip.trim()) {
    return xrip.trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function jsonResponse(res, code, payload) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

function unauthorized(res) {
  return jsonResponse(res, 401, { error: "Unauthorized" });
}

function tooMany(res, retryAfterSec) {
  res.setHeader("retry-after", String(retryAfterSec));
  return jsonResponse(res, 429, { error: "Too many requests" });
}

async function readJsonBody(req, maxBytes = 1_000_000) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
  });
}

class SimpleRateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.store = new Map();
  }

  take(key) {
    const now = Date.now();
    let bucket = this.store.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
    }
    bucket.count += 1;
    this.store.set(key, bucket);
    if (this.store.size > 5_000) {
      for (const [k, v] of this.store.entries()) {
        if (v.resetAt <= now) this.store.delete(k);
      }
    }
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    const ok = bucket.count <= this.limit;
    return { ok, retryAfterSec };
  }
}

class Uc6Bot {
  constructor() {
    if (!ENV.rpcUrl) throw new Error("Missing UC6_RPC_URL");
    if (!ENV.privateKey) throw new Error("Missing UC6_PRIVATE_KEY");
    if (!ENV.adminToken) throw new Error("Missing UC6_ADMIN_TOKEN");
    if (!ENV.ownerAddress) throw new Error("Missing UC6_OWNER_ADDRESS");

    this.ownerAddress = getAddress(ENV.ownerAddress);
    this.usdc = getAddress(ENV.usdc);
    this.weth = getAddress(ENV.weth);
    this.slipstreamPool = getAddress(ENV.slipstreamPool);
    this.slipstreamRouter = getAddress(ENV.slipstreamRouter);
    this.slipstreamQuoter = getAddress(ENV.slipstreamQuoter);
    this.slipstreamNpm = getAddress(ENV.slipstreamNpm);
    this.uniswapPool = getAddress(ENV.uniswapPool);
    this.uniswapRouter = getAddress(ENV.uniswapRouter);
    this.uniswapQuoter = getAddress(ENV.uniswapQuoter);
    this.uniswapNpm = getAddress(ENV.uniswapNpm);

    const pk = ENV.privateKey.startsWith("0x") ? ENV.privateKey : `0x${ENV.privateKey}`;
    this.account = privateKeyToAccount(pk);
    this.publicClient = createPublicClient({
      chain: base,
      transport: viemHttp(ENV.rpcUrl, { timeout: 12_000 }),
    });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: base,
      transport: viemHttp(ENV.rpcUrl, { timeout: 20_000 }),
    });

    this.settings = { ...DEFAULT_SETTINGS };
    this.state = defaultState(this.account.address);
    this.settingsMtimeMs = 0;
    this.loopRunning = false;
    this.stopRequested = false;
    this.activeAction = null;
    this.ownerNonceUsed = new Map();
    this.ownerRateLimiter = new SimpleRateLimiter(20, 60_000);
    this.server = null;
  }

  async init() {
    await ensureDir(ENV.dataDir);
    try {
      await this.loadSettings(true);
    } catch (err) {
      this.settings = { ...DEFAULT_SETTINGS };
      this.setLastError(err);
    }

    try {
      await this.loadState();
    } catch (err) {
      this.state = defaultState(this.account.address);
      this.setLastError(err);
    }

    try {
      await this.refreshSnapshots();
      await this.reconcilePositionFromChain();
    } catch (err) {
      this.setLastError(err);
    }

    await this.persistState().catch((err) => {
      this.setLastError(err);
    });
  }

  async loadSettings(force = false) {
    try {
      const stat = await fsp.stat(SETTINGS_PATH);
      if (!force && stat.mtimeMs <= this.settingsMtimeMs) return;
      const parsed = await readJsonIfExists(SETTINGS_PATH);
      if (parsed) {
        this.settings = normalizeSettings(parsed, this.settings);
      } else {
        this.settings = { ...DEFAULT_SETTINGS };
      }
      this.settingsMtimeMs = stat.mtimeMs;
      return;
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        this.settings = { ...DEFAULT_SETTINGS };
        await writeJsonAtomic(SETTINGS_PATH, this.settings);
        const st = await fsp.stat(SETTINGS_PATH);
        this.settingsMtimeMs = st.mtimeMs;
        return;
      }
      throw err;
    }
  }

  async loadState() {
    const parsed = await readJsonIfExists(STATE_PATH);
    if (!parsed) {
      this.state = defaultState(this.account.address);
      return;
    }
    const baseState = defaultState(this.account.address);
    this.state = {
      ...baseState,
      ...parsed,
      account: this.account.address,
      position: {
        ...baseState.position,
        ...(parsed.position || {}),
      },
      latest: {
        ...baseState.latest,
        ...(parsed.latest || {}),
      },
    };
    if (!Array.isArray(this.state.events)) this.state.events = [];
    if (!Array.isArray(this.state.ledgerEvents)) this.state.ledgerEvents = Array.isArray(this.state.events) ? [...this.state.events] : [];
    if (this.state.events.length > EVENT_RING_LIMIT) {
      this.state.events = this.state.events.slice(-EVENT_RING_LIMIT);
    }
    if (this.state.ledgerEvents.length > ACCOUNTING_EVENT_LIMIT) {
      this.state.ledgerEvents = this.state.ledgerEvents.slice(-ACCOUNTING_EVENT_LIMIT);
    }
  }

  async persistState() {
    this.state.updatedAt = nowIso();
    await writeJsonAtomic(STATE_PATH, this.state);
  }

  async assertTxAllowed(context = "tx") {
    try {
      await this.loadSettings(false);
    } catch (err) {
      this.setLastError(err);
    }
    if (this.settings.killSwitch) {
      throw new Error(`Kill switch active; blocked ${context}`);
    }
    if (!this.settings.tradingEnabled) {
      throw new Error(`Trading disabled; blocked ${context}`);
    }
  }

  setLastError(err) {
    const msg = err instanceof Error ? err.message : String(err || "unknown error");
    this.state.lastError = `${nowIso()} ${msg}`;
  }

  setDecision(decision) {
    this.state.lastDecision = {
      at: nowIso(),
      ...decision,
    };
  }

  pruneUsedNonces() {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.ownerNonceUsed.entries()) {
      if (expiresAt < now) this.ownerNonceUsed.delete(nonce);
    }
  }

  ensureDailyCounter() {
    const dayKey = utcDayKey();
    if (this.state.dayKey !== dayKey) {
      this.state.dayKey = dayKey;
      this.state.rebalancesToday = 0;
    }
  }

  getSpotUsdcPerWeth() {
    const primary = this.state.latest?.primary?.priceUsdcPerWeth;
    if (Number.isFinite(primary) && primary > 0) return primary;
    const fallback = this.state.latest?.fallback?.priceUsdcPerWeth;
    if (Number.isFinite(fallback) && fallback > 0) return fallback;
    return 0;
  }

  getEffectiveReserveTargetUsdc(totalValueUsd) {
    const minUsdc = Number(this.settings.reserveMinUsdc || 0);
    const pct = Number(this.settings.reservePct || 0);
    const maxUsdc = Number(this.settings.reserveMaxUsdc || 0);
    let target = Math.max(0, minUsdc, totalValueUsd * pct);
    if (maxUsdc > 0) target = Math.min(target, maxUsdc);
    return target;
  }

  toUsdForTokenAmountRaw(tokenAddress, amountRaw, spotUsdcPerWeth) {
    if (!amountRaw || amountRaw <= 0n) return 0;
    if (sameAddress(tokenAddress, this.usdc)) {
      return Number(formatUnits(amountRaw, USDC_DECIMALS));
    }
    if (sameAddress(tokenAddress, this.weth)) {
      return Number(formatUnits(amountRaw, WETH_DECIMALS)) * spotUsdcPerWeth;
    }
    return 0;
  }

  pushEvent(event) {
    if (!Array.isArray(this.state.events)) this.state.events = [];
    if (!Array.isArray(this.state.ledgerEvents)) this.state.ledgerEvents = [];
    const next = {
      atIso: nowIso(),
      type: "info",
      reason: "n/a",
      txHashes: [],
      gasUsd: 0,
      swapCostUsd: 0,
      mintBurnUsd: 0,
      feesCollectedUsd: 0,
      rewardsUsd: 0,
      netUsd: 0,
      slippageBpsReal: null,
      swaps: [],
      isEstimated: false,
      ...event,
    };
    const last = this.state.events[this.state.events.length - 1];
    if (last && last.type === next.type && last.reason === next.reason) {
      const lastMs = Date.parse(last.atIso || "");
      const nextMs = Date.parse(next.atIso || "");
      if (Number.isFinite(lastMs) && Number.isFinite(nextMs) && nextMs - lastMs < 15_000) {
        return;
      }
    }
    this.state.events.push(next);
    if (this.state.events.length > EVENT_RING_LIMIT) {
      this.state.events = this.state.events.slice(-EVENT_RING_LIMIT);
    }
    this.state.ledgerEvents.push(next);
    if (this.state.ledgerEvents.length > ACCOUNTING_EVENT_LIMIT) {
      this.state.ledgerEvents = this.state.ledgerEvents.slice(-ACCOUNTING_EVENT_LIMIT);
    }
  }

  getEventsSince(startMs = null) {
    const events = Array.isArray(this.state.ledgerEvents)
      ? this.state.ledgerEvents
      : Array.isArray(this.state.events)
        ? this.state.events
        : [];
    if (!startMs) return events;
    return events.filter((ev) => {
      const ms = Date.parse(ev.atIso || "");
      return Number.isFinite(ms) && ms >= startMs;
    });
  }

  summarizeEvents(events) {
    let feesUsd = 0;
    let rewardsUsd = 0;
    let gasUsd = 0;
    let swapCostsUsd = 0;
    let mintBurnUsd = 0;
    let rebalances = 0;
    for (const ev of events) {
      feesUsd += Number(ev.feesCollectedUsd || 0);
      rewardsUsd += Number(ev.rewardsUsd || 0);
      gasUsd += Number(ev.gasUsd || 0);
      swapCostsUsd += Number(ev.swapCostUsd || 0);
      mintBurnUsd += Number(ev.mintBurnUsd || 0);
      if (ev.type === "recenter") rebalances += 1;
    }
    const totalCostsUsd = gasUsd + swapCostsUsd + mintBurnUsd;
    const netUsd = feesUsd + rewardsUsd - totalCostsUsd;
    return {
      feesUsd,
      rewardsUsd,
      gasUsd,
      swapCostsUsd,
      mintBurnUsd,
      totalCostsUsd,
      netUsd,
      rebalances,
      churnRatio: feesUsd > 0 ? totalCostsUsd / feesUsd : totalCostsUsd > 0 ? Number.POSITIVE_INFINITY : 0,
    };
  }

  parseLastErrorObject() {
    const raw = this.state.lastError;
    if (!raw) return null;
    const m = String(raw).match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+([\s\S]*)$/);
    if (!m) return { atIso: null, message: String(raw) };
    return { atIso: m[1], message: m[2] };
  }

  approxSqrtPriceX96FromTick(tick) {
    const sqrt = Math.pow(1.0001, Number(tick) / 2);
    if (!Number.isFinite(sqrt) || sqrt <= 0) return 0n;
    return BigInt(Math.floor(sqrt * Number(Q96)));
  }

  lpAmountsFromLiquidity(liquidityRaw, tickLower, tickUpper, sqrtPriceX96Raw, token0, token1) {
    const liquidity = BigInt(liquidityRaw || 0);
    if (liquidity <= 0n) return { usdcRaw: 0n, wethRaw: 0n };
    const sqrtP = BigInt(sqrtPriceX96Raw || 0n);
    const sqrtA = this.approxSqrtPriceX96FromTick(tickLower);
    const sqrtB = this.approxSqrtPriceX96FromTick(tickUpper);
    if (sqrtP <= 0n || sqrtA <= 0n || sqrtB <= 0n || sqrtB <= sqrtA) return { usdcRaw: 0n, wethRaw: 0n };

    let amount0 = 0n;
    let amount1 = 0n;

    if (sqrtP <= sqrtA) {
      amount0 = (liquidity * (sqrtB - sqrtA) * Q96) / (sqrtB * sqrtA);
    } else if (sqrtP < sqrtB) {
      amount0 = (liquidity * (sqrtB - sqrtP) * Q96) / (sqrtB * sqrtP);
      amount1 = (liquidity * (sqrtP - sqrtA)) / Q96;
    } else {
      amount1 = (liquidity * (sqrtB - sqrtA)) / Q96;
    }

    let usdcRaw = 0n;
    let wethRaw = 0n;
    if (sameAddress(token0, this.usdc)) usdcRaw = amount0;
    if (sameAddress(token1, this.usdc)) usdcRaw = amount1;
    if (sameAddress(token0, this.weth)) wethRaw = amount0;
    if (sameAddress(token1, this.weth)) wethRaw = amount1;
    return { usdcRaw, wethRaw };
  }

  distanceToEdge(position, currentTick) {
    if (!position) return { ticks: null, pct: null };
    const lower = Number(position.tickLower);
    const upper = Number(position.tickUpper);
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || !Number.isFinite(currentTick) || upper <= lower) {
      return { ticks: null, pct: null };
    }
    const ticksToLower = currentTick - lower;
    const ticksToUpper = upper - currentTick;
    const ticks = Math.max(0, Math.min(ticksToLower, ticksToUpper));
    const halfWidth = (upper - lower) / 2;
    const pct = halfWidth > 0 ? clamp(ticks / halfWidth, 0, 1) : null;
    return { ticks, pct };
  }

  beginAction(type, reason) {
    this.activeAction = {
      type,
      reason,
      atIso: nowIso(),
      txHashes: [],
      gasUsd: 0,
      swapCostUsd: 0,
      mintBurnUsd: 0,
      feesCollectedUsd: 0,
      rewardsUsd: 0,
      swaps: [],
      isEstimated: false,
    };
  }

  addTxToActiveAction(kind, hash, receipt) {
    if (!this.activeAction) return;
    if (hash) this.activeAction.txHashes.push(String(hash));
    const gasUsed = BigInt(receipt?.gasUsed || 0n);
    const gasPrice = BigInt(receipt?.effectiveGasPrice || 0n);
    const gasWei = gasUsed * gasPrice;
    const gasEth = Number(formatUnits(gasWei, 18));
    const gasUsd = gasEth * this.getSpotUsdcPerWeth();
    this.activeAction.gasUsd += gasUsd;
    if (kind === "mint" || kind === "decrease" || kind === "collect" || kind === "burn") {
      this.activeAction.mintBurnUsd += gasUsd;
    }
  }

  addSwapCostToActiveAction(usd, isEstimated = true) {
    if (!this.activeAction) return;
    this.activeAction.swapCostUsd += Number(usd || 0);
    this.activeAction.isEstimated = this.activeAction.isEstimated || Boolean(isEstimated);
  }

  addFeesToActiveAction(usd) {
    if (!this.activeAction) return;
    this.activeAction.feesCollectedUsd += Number(usd || 0);
  }

  finalizeActiveAction(typeOverride = null, reasonOverride = null, extra = {}) {
    if (!this.activeAction) return;
    const action = this.activeAction;
    this.activeAction = null;
    const type = typeOverride || action.type || "info";
    const reason = reasonOverride || action.reason || "n/a";
    const netUsd =
      Number(action.feesCollectedUsd || 0) +
      Number(action.rewardsUsd || 0) -
      (Number(action.gasUsd || 0) + Number(action.swapCostUsd || 0) + Number(action.mintBurnUsd || 0));
    const swaps = Array.isArray(action.swaps) ? action.swaps : [];
    let weightedSlippageNumerator = 0;
    let weightedSlippageDenominator = 0;
    for (const sw of swaps) {
      const q = Number(sw.quoteOutUsd || 0);
      const s = Number(sw.slippageBpsReal);
      if (q > 0 && Number.isFinite(s)) {
        weightedSlippageNumerator += s * q;
        weightedSlippageDenominator += q;
      }
    }
    const slippageBpsReal =
      weightedSlippageDenominator > 0 ? weightedSlippageNumerator / weightedSlippageDenominator : null;
    this.pushEvent({
      type,
      reason,
      atIso: action.atIso,
      txHashes: action.txHashes,
      gasUsd: Number(action.gasUsd || 0),
      swapCostUsd: Number(action.swapCostUsd || 0),
      mintBurnUsd: Number(action.mintBurnUsd || 0),
      feesCollectedUsd: Number(action.feesCollectedUsd || 0),
      rewardsUsd: Number(action.rewardsUsd || 0),
      netUsd,
      slippageBpsReal,
      swaps,
      isEstimated: Boolean(action.isEstimated),
      ...extra,
    });
  }

  getFailureCooldownGate() {
    const now = Date.now();
    const untilIso = this.state.rebalanceFailureCooldownUntil || null;
    const untilMs = untilIso ? Date.parse(untilIso) : 0;
    if (untilMs && Number.isFinite(untilMs) && now < untilMs) {
      const remainingSec = Math.ceil((untilMs - now) / 1000);
      return {
        allowed: false,
        reason: `failure_cooldown ${remainingSec}s`,
        remainingSec,
        until: untilIso,
      };
    }
    return { allowed: true, reason: "ok", remainingSec: 0, until: untilIso };
  }

  async getPoolSnapshot(poolAddress, venue) {
    const [slot0, token0, token1, tickSpacing, fee] = await Promise.all([
      this.readSlot0(poolAddress),
      this.publicClient.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "token0" }),
      this.publicClient.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "token1" }),
      this.publicClient.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "tickSpacing" }),
      this.publicClient
        .readContract({ address: poolAddress, abi: POOL_ABI, functionName: "fee" })
        .catch(() => 3000),
    ]);

    const sqrtPriceX96 = slot0.sqrtPriceX96 ?? slot0[0];
    const tick = Number(slot0.tick ?? slot0[1]);
    const token0Addr = getAddress(token0);
    const token1Addr = getAddress(token1);
    const spacing = Number(tickSpacing);
    const feeTier = Number(fee);

    const priceUsdcPerWeth = this.toUsdcPerWethPrice(sqrtPriceX96, token0Addr, token1Addr);

    return {
      venue,
      pool: poolAddress,
      token0: token0Addr,
      token1: token1Addr,
      fee: feeTier,
      tickSpacing: spacing,
      tick,
      sqrtPriceX96: sqrtPriceX96.toString(),
      priceUsdcPerWeth,
      updatedAt: nowIso(),
    };
  }

  async readSlot0(poolAddress) {
    try {
      return await this.publicClient.readContract({
        address: poolAddress,
        abi: SLOT0_ABI_V7,
        functionName: "slot0",
      });
    } catch (errV7) {
      try {
        return await this.publicClient.readContract({
          address: poolAddress,
          abi: SLOT0_ABI_V6,
          functionName: "slot0",
        });
      } catch (errV6) {
        const m7 = errV7 instanceof Error ? errV7.message : String(errV7 || "slot0(v7) failed");
        const m6 = errV6 instanceof Error ? errV6.message : String(errV6 || "slot0(v6) failed");
        throw new Error(`slot0 read failed for ${poolAddress}: ${m7}; fallback: ${m6}`);
      }
    }
  }

  toUsdcPerWethPrice(sqrtPriceX96, token0, token1) {
    const sqrt = Number(sqrtPriceX96) / 2 ** 96;
    const raw = sqrt * sqrt;
    if (!Number.isFinite(raw) || raw <= 0) return null;

    const dec0 = sameAddress(token0, this.usdc) ? USDC_DECIMALS : WETH_DECIMALS;
    const dec1 = sameAddress(token1, this.usdc) ? USDC_DECIMALS : WETH_DECIMALS;
    const humanToken1PerToken0 = raw * 10 ** (dec0 - dec1);

    if (sameAddress(token0, this.weth) && sameAddress(token1, this.usdc)) {
      return humanToken1PerToken0;
    }
    if (sameAddress(token0, this.usdc) && sameAddress(token1, this.weth)) {
      if (humanToken1PerToken0 === 0) return null;
      return 1 / humanToken1PerToken0;
    }
    return null;
  }

  async refreshSnapshots() {
    const [primary, fallback, usdcBalanceRaw, wethBalanceRaw, ethBalanceRaw] = await Promise.all([
      this.getPoolSnapshot(this.slipstreamPool, "slipstream"),
      this.getPoolSnapshot(this.uniswapPool, "uniswapv3").catch(() => null),
      this.readTokenBalance(this.usdc),
      this.readTokenBalance(this.weth),
      this.publicClient.getBalance({ address: this.account.address }),
    ]);

    const spot = this.toNumberOrZero(primary?.priceUsdcPerWeth) || this.toNumberOrZero(fallback?.priceUsdcPerWeth);
    const usdcValue = Number(formatUnits(usdcBalanceRaw, USDC_DECIMALS));
    const wethValue = Number(formatUnits(wethBalanceRaw, WETH_DECIMALS)) * spot;
    const ethValue = Number(formatUnits(ethBalanceRaw, 18)) * spot;

    this.state.latest.primary = primary;
    this.state.latest.fallback = fallback;
    this.state.latest.wallet = {
      usdc: Number(formatUnits(usdcBalanceRaw, USDC_DECIMALS)),
      weth: Number(formatUnits(wethBalanceRaw, WETH_DECIMALS)),
      eth: Number(formatUnits(ethBalanceRaw, 18)),
      valuesUsd: {
        usdc: usdcValue,
        weth: wethValue,
        eth: ethValue,
        total: usdcValue + wethValue + ethValue,
      },
      updatedAt: nowIso(),
    };

    return { primary, fallback, usdcBalanceRaw, wethBalanceRaw, ethBalanceRaw };
  }

  toNumberOrZero(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  async collectableNowSnapshot() {
    const tokenId = this.state.position?.tokenId;
    if (!tokenId) return { usdc: 0, weth: 0, usd: 0, isEstimated: true };
    const npm = this.state.position?.venue === "uniswapv3" ? this.uniswapNpm : this.slipstreamNpm;
    const posRaw = await this.publicClient.readContract({
      address: npm,
      abi: NPM_POSITION_ABI,
      functionName: "positions",
      args: [BigInt(tokenId)],
    });
    const token0 = getAddress(posRaw.token0 ?? posRaw[2]);
    const token1 = getAddress(posRaw.token1 ?? posRaw[3]);
    try {
      const sim = await this.publicClient.simulateContract({
        address: npm,
        abi: NPM_POSITION_ABI,
        functionName: "collect",
        args: [
          {
            tokenId: BigInt(tokenId),
            recipient: this.account.address,
            amount0Max: UINT128_MAX,
            amount1Max: UINT128_MAX,
          },
        ],
        account: this.account.address,
      });
      const out0 = BigInt(
        Array.isArray(sim.result)
          ? sim.result[0]
          : sim.result?.amount0 ?? sim.result?.[0] ?? 0n
      );
      const out1 = BigInt(
        Array.isArray(sim.result)
          ? sim.result[1]
          : sim.result?.amount1 ?? sim.result?.[1] ?? 0n
      );
      let usdcRaw = 0n;
      let wethRaw = 0n;
      if (sameAddress(token0, this.usdc)) usdcRaw = out0;
      if (sameAddress(token1, this.usdc)) usdcRaw = out1;
      if (sameAddress(token0, this.weth)) wethRaw = out0;
      if (sameAddress(token1, this.weth)) wethRaw = out1;
      const spot = this.getSpotUsdcPerWeth();
      const usdc = Number(formatUnits(usdcRaw, USDC_DECIMALS));
      const weth = Number(formatUnits(wethRaw, WETH_DECIMALS));
      return {
        usdc,
        weth,
        usd: usdc + weth * spot,
        isEstimated: false,
      };
    } catch {
      return { usdc: 0, weth: 0, usd: 0, isEstimated: true };
    }
  }

  async readTokenBalance(tokenAddress) {
    return await this.publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.account.address],
    });
  }

  async readAllowance(tokenAddress, spender) {
    return await this.publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.account.address, spender],
    });
  }

  async approveIfNeeded(tokenAddress, spender, amount) {
    if (amount <= 0n) return;
    const allowance = await this.readAllowance(tokenAddress, spender);
    if (allowance >= amount) return;
    await this.assertTxAllowed("approve");

    const hash = await this.walletClient.writeContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, maxUint256],
      account: this.account,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    this.addTxToActiveAction("approve", hash, receipt);
  }

  priceEstimateOut(amountIn, tokenIn, tokenOut, snapshot) {
    const price = snapshot?.priceUsdcPerWeth;
    if (!price || !Number.isFinite(price) || price <= 0) return 0n;

    if (sameAddress(tokenIn, this.usdc) && sameAddress(tokenOut, this.weth)) {
      const usdcIn = Number(formatUnits(amountIn, USDC_DECIMALS));
      const out = usdcIn / price;
      return out > 0 ? parseUnits(out.toFixed(18), WETH_DECIMALS) : 0n;
    }

    if (sameAddress(tokenIn, this.weth) && sameAddress(tokenOut, this.usdc)) {
      const wethIn = Number(formatUnits(amountIn, WETH_DECIMALS));
      const out = wethIn * price;
      return out > 0 ? parseUnits(out.toFixed(6), USDC_DECIMALS) : 0n;
    }

    return 0n;
  }

  minOutFromEstimate(estimatedOut, slippageBps) {
    if (estimatedOut <= 0n) return 0n;
    return (estimatedOut * BigInt(Math.max(0, 10_000 - slippageBps))) / 10_000n;
  }

  parseAmountOutFromQuoteResult(result) {
    if (typeof result === "bigint") return result;
    if (Array.isArray(result)) {
      const first = result[0];
      return typeof first === "bigint" ? first : BigInt(first || 0);
    }
    if (result && typeof result === "object") {
      const amountOut = result.amountOut ?? result[0];
      if (typeof amountOut === "bigint") return amountOut;
      if (amountOut != null) return BigInt(amountOut);
    }
    return BigInt(0);
  }

  async quoteExactInputSingle({ tokenIn, tokenOut, amountIn, fee, tickSpacing }) {
    const candidates = [
      {
        address: this.slipstreamQuoter,
        abi: QUOTER_ABI_TICK_V2,
        args: [
          {
            tokenIn,
            tokenOut,
            tickSpacing: tickSpacing || 1,
            amountIn,
            sqrtPriceLimitX96: BigInt(0),
          },
        ],
      },
      {
        address: this.uniswapQuoter,
        abi: QUOTER_ABI_FEE_V2,
        args: [
          {
            tokenIn,
            tokenOut,
            amountIn,
            fee: Math.max(1, Number(fee || 0) || 3000),
            sqrtPriceLimitX96: BigInt(0),
          },
        ],
      },
    ];

    for (const c of candidates) {
      try {
        const sim = await this.publicClient.simulateContract({
          address: c.address,
          abi: c.abi,
          functionName: "quoteExactInputSingle",
          args: c.args,
          account: this.account.address,
        });
        const amountOut = this.parseAmountOutFromQuoteResult(sim.result);
        if (amountOut > BigInt(0)) {
          return { amountOut, source: sameAddress(c.address, this.slipstreamQuoter) ? "slipstream_quoter" : "uniswap_quoter" };
        }
      } catch {
        // try next candidate
      }
    }

    return { amountOut: BigInt(0), source: "none" };
  }

  toNumberTokenAmount(tokenAddress, amountRaw) {
    if (!amountRaw || amountRaw <= BigInt(0)) return 0;
    if (sameAddress(tokenAddress, this.usdc)) return Number(formatUnits(amountRaw, USDC_DECIMALS));
    if (sameAddress(tokenAddress, this.weth)) return Number(formatUnits(amountRaw, WETH_DECIMALS));
    return 0;
  }

  usdValueForTokenOutDelta(tokenAddress, amountRaw, spotUsdcPerWeth) {
    if (!amountRaw || amountRaw <= BigInt(0)) return 0;
    if (sameAddress(tokenAddress, this.usdc)) return Number(formatUnits(amountRaw, USDC_DECIMALS));
    if (sameAddress(tokenAddress, this.weth)) return Number(formatUnits(amountRaw, WETH_DECIMALS)) * spotUsdcPerWeth;
    return 0;
  }

  addSwapMetricsToActiveAction(metrics = {}) {
    if (!this.activeAction) return;
    if (!Array.isArray(this.activeAction.swaps)) this.activeAction.swaps = [];
    const safe = {
      tokenIn: metrics.tokenIn || null,
      tokenOut: metrics.tokenOut || null,
      quoteSource: metrics.quoteSource || null,
      quoteOut: String(metrics.quoteOut ?? BigInt(0)),
      actualOut: String(metrics.actualOut ?? BigInt(0)),
      actualIn: String(metrics.actualIn ?? BigInt(0)),
      quoteOutUsd: Number(metrics.quoteOutUsd || 0),
      actualOutUsd: Number(metrics.actualOutUsd || 0),
      swapCostUsd: Number(metrics.swapCostUsd || 0),
      slippageBpsReal:
        metrics.slippageBpsReal == null || !Number.isFinite(Number(metrics.slippageBpsReal))
          ? null
          : Number(metrics.slippageBpsReal),
      isEstimated: Boolean(metrics.isEstimated),
    };
    this.activeAction.swaps.push(safe);
    this.activeAction.swapCostUsd += safe.swapCostUsd;
    this.activeAction.isEstimated = this.activeAction.isEstimated || safe.isEstimated;
  }

  async swapExactInputSingle({ router, tokenIn, tokenOut, amountIn, slippageBps, fee, tickSpacing, snapshot }) {
    if (amountIn <= 0n) return;

    await this.assertTxAllowed("swap");
    await this.approveIfNeeded(tokenIn, router, amountIn);
    const preInBalance = await this.readTokenBalance(tokenIn);
    const preOutBalance = await this.readTokenBalance(tokenOut);
    const quoterQuote = await this.quoteExactInputSingle({ tokenIn, tokenOut, amountIn, fee, tickSpacing }).catch(
      () => ({ amountOut: BigInt(0), source: "none" })
    );
    const estimatedOut = this.priceEstimateOut(amountIn, tokenIn, tokenOut, snapshot);
    const quotedOutForMin = quoterQuote.amountOut > BigInt(0) ? quoterQuote.amountOut : estimatedOut;
    const amountOutMinimum = this.minOutFromEstimate(quotedOutForMin, slippageBps);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    const candidates = [
      {
        abi: ROUTER_ABI_FEE,
        params: {
          tokenIn,
          tokenOut,
          fee: Math.max(1, fee || 3000),
          recipient: this.account.address,
          deadline,
          amountIn,
          amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      },
      {
        abi: ROUTER_ABI_TICK,
        params: {
          tokenIn,
          tokenOut,
          tickSpacing: tickSpacing || 1,
          recipient: this.account.address,
          deadline,
          amountIn,
          amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      },
    ];

    let lastErr = null;
    for (const c of candidates) {
      try {
        const sim = await this.publicClient.simulateContract({
          address: router,
          abi: c.abi,
          functionName: "exactInputSingle",
          args: [c.params],
          account: this.account.address,
        });
        const routerQuoteOut = this.parseAmountOutFromQuoteResult(sim.result);
        const quoteOut =
          quoterQuote.amountOut > BigInt(0) ? quoterQuote.amountOut : routerQuoteOut > BigInt(0) ? routerQuoteOut : estimatedOut;
        const quoteSource =
          quoterQuote.amountOut > BigInt(0) ? quoterQuote.source : routerQuoteOut > BigInt(0) ? "router_sim" : "price_estimate";

        await this.assertTxAllowed("swap_write");
        const hash = await this.walletClient.writeContract({
          ...sim.request,
          account: this.account,
        });
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
        this.addTxToActiveAction("swap", hash, receipt);
        const postInBalance = await this.readTokenBalance(tokenIn);
        const postOutBalance = await this.readTokenBalance(tokenOut);
        const actualOut = postOutBalance > preOutBalance ? postOutBalance - preOutBalance : BigInt(0);
        const actualIn = preInBalance > postInBalance ? preInBalance - postInBalance : BigInt(0);
        const quoteGap = quoteOut > actualOut ? quoteOut - actualOut : BigInt(0);
        const spot = this.getSpotUsdcPerWeth();
        const quoteOutUsd = this.usdValueForTokenOutDelta(tokenOut, quoteOut, spot);
        const actualOutUsd = this.usdValueForTokenOutDelta(tokenOut, actualOut, spot);
        const swapCostUsd = this.usdValueForTokenOutDelta(tokenOut, quoteGap, spot);
        const slippageBpsReal =
          quoteOut > BigInt(0)
            ? (Number(quoteOut - actualOut) / Number(quoteOut)) * 10_000
            : null;
        this.addSwapMetricsToActiveAction({
          tokenIn,
          tokenOut,
          quoteSource,
          quoteOut,
          actualOut,
          actualIn,
          quoteOutUsd,
          actualOutUsd,
          swapCostUsd: Math.max(0, swapCostUsd),
          slippageBpsReal,
          isEstimated: false,
        });
        return;
      } catch (err) {
        lastErr = err;
      }
    }

    throw new Error(`Swap failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr || "unknown")}`);
  }

  toTickDelta(halfBps, tickSpacing) {
    const priceFactor = 1 + halfBps / 10_000;
    const delta = Math.round(Math.log(priceFactor) / Math.log(1.0001));
    return Math.max(tickSpacing, delta);
  }

  floorTick(tick, spacing) {
    return Math.floor(tick / spacing) * spacing;
  }

  ceilTick(tick, spacing) {
    return Math.ceil(tick / spacing) * spacing;
  }

  computeTargetRange(currentTick, tickSpacing, bandHalfBps) {
    const center = this.floorTick(currentTick, tickSpacing);
    const delta = this.toTickDelta(bandHalfBps, tickSpacing);
    let tickLower = this.floorTick(center - delta, tickSpacing);
    let tickUpper = this.ceilTick(center + delta, tickSpacing);
    if (tickUpper <= tickLower) tickUpper = tickLower + tickSpacing;
    return { centerTick: center, tickLower, tickUpper };
  }

  parsePositionResult(pos) {
    if (!pos) return null;
    const token0 = pos.token0 ?? pos[2] ?? null;
    const token1 = pos.token1 ?? pos[3] ?? null;
    const selector = Number(pos.tickSpacing ?? pos.fee ?? pos[4] ?? 0);
    const tickLower = Number(pos.tickLower ?? pos[5] ?? 0);
    const tickUpper = Number(pos.tickUpper ?? pos[6] ?? 0);
    const liquidity = BigInt(pos.liquidity ?? pos[7] ?? 0);
    return {
      token0: token0 ? getAddress(token0) : null,
      token1: token1 ? getAddress(token1) : null,
      fee: selector,
      tickSpacing: selector,
      tickLower,
      tickUpper,
      liquidity,
    };
  }

  extractMintedTokenId(receipt, npmAddress) {
    for (const log of receipt.logs || []) {
      if (!sameAddress(log.address, npmAddress)) continue;
      try {
        const decoded = decodeEventLog({ abi: [ERC721_TRANSFER_EVENT], data: log.data, topics: log.topics });
        if (decoded.eventName !== "Transfer") continue;
        const from = decoded.args.from;
        const to = decoded.args.to;
        if (sameAddress(from, zeroAddress) && sameAddress(to, this.account.address)) {
          return BigInt(decoded.args.tokenId);
        }
      } catch {
        // ignore log decode errors for unrelated events
      }
    }
    return null;
  }

  extractCollectedAmountsFromReceipt(receipt, npmAddress, tokenId) {
    let amount0 = BigInt(0);
    let amount1 = BigInt(0);
    const wantTokenId = tokenId != null ? BigInt(tokenId) : null;
    for (const log of receipt?.logs || []) {
      if (!sameAddress(log.address, npmAddress)) continue;
      try {
        const decoded = decodeEventLog({ abi: [NPM_COLLECT_EVENT], data: log.data, topics: log.topics });
        if (decoded.eventName !== "Collect") continue;
        const evTokenId = BigInt(decoded.args.tokenId ?? 0);
        if (wantTokenId != null && evTokenId !== wantTokenId) continue;
        amount0 += BigInt(decoded.args.amount0 ?? 0);
        amount1 += BigInt(decoded.args.amount1 ?? 0);
      } catch {
        // ignore unrelated logs
      }
    }
    return { amount0, amount1 };
  }

  async mintPosition({
    npmAddress,
    token0,
    token1,
    fee,
    tickSpacing,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    slippageBps,
    sqrtPriceX96,
    venue,
  }) {
    await this.assertTxAllowed("mint");
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
    // For concentrated-liquidity mint, exact ratio can differ from desired amounts.
    // Strict min constraints frequently cause reverts; keep mint mins permissive here.
    const _slippageBps = slippageBps;
    void _slippageBps;
    const amount0Min = 0n;
    const amount1Min = 0n;
    let sqrtPriceX96Value = 0n;
    try {
      if (sqrtPriceX96 !== undefined && sqrtPriceX96 !== null) {
        sqrtPriceX96Value = BigInt(sqrtPriceX96);
      }
    } catch {
      sqrtPriceX96Value = 0n;
    }

    let candidates = [];
    if (venue === "slipstream") {
      // Slipstream NPM mint signature includes sqrtPriceX96.
      // For existing pools, pass 0 to avoid createPool path.
      candidates = [
        {
          name: "mint-slipstream-existing-pool",
          abi: NPM_MINT_ABI_TICK_WITH_PRICE,
          args: [
            {
              token0,
              token1,
              tickSpacing: tickSpacing || 1,
              tickLower,
              tickUpper,
              amount0Desired,
              amount1Desired,
              amount0Min,
              amount1Min,
              recipient: this.account.address,
              deadline,
              sqrtPriceX96: 0n,
            },
          ],
        },
      ];
      if (sqrtPriceX96Value > 0n) {
        candidates.push({
          name: "mint-slipstream-init-pool",
          abi: NPM_MINT_ABI_TICK_WITH_PRICE,
          args: [
            {
              token0,
              token1,
              tickSpacing: tickSpacing || 1,
              tickLower,
              tickUpper,
              amount0Desired,
              amount1Desired,
              amount0Min,
              amount1Min,
              recipient: this.account.address,
              deadline,
              sqrtPriceX96: sqrtPriceX96Value,
            },
          ],
        });
      }
    } else {
      candidates = [
        {
          name: "mint-uniswap-fee",
          abi: NPM_MINT_ABI_FEE,
          args: [
            {
              token0,
              token1,
              fee: Math.max(1, fee || 3000),
              tickLower,
              tickUpper,
              amount0Desired,
              amount1Desired,
              amount0Min,
              amount1Min,
              recipient: this.account.address,
              deadline,
            },
          ],
        },
      ];
    }

    let lastErr = null;
    const errors = [];
    let anyBroadcastedMintTx = false;
    let lastBroadcastedMintTxHash = null;
    let lastBroadcastedMintReceiptStatus = null;
    for (const candidate of candidates) {
      let broadcastedHash = null;
      let broadcastedReceiptStatus = null;
      try {
        const sim = await this.publicClient.simulateContract({
          address: npmAddress,
          abi: candidate.abi,
          functionName: "mint",
          args: candidate.args,
          account: this.account.address,
        });

        await this.assertTxAllowed("mint_write");
        const hash = await this.walletClient.writeContract({
          ...sim.request,
          account: this.account,
        });
        broadcastedHash = hash;
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
        broadcastedReceiptStatus = receipt.status || null;
        this.addTxToActiveAction("mint", hash, receipt);
        if (receipt.status && receipt.status !== "success") {
          throw new Error(`Mint tx reverted on-chain (${candidate.name}) hash=${hash}`);
        }

        let tokenId = this.extractMintedTokenId(receipt, npmAddress);
        if (!tokenId) {
          const res = Array.isArray(sim.result) ? sim.result[0] : null;
          if (typeof res === "bigint") tokenId = res;
        }
        if (!tokenId) throw new Error("Mint succeeded but tokenId could not be determined");

        let pos = null;
        try {
          const posRaw = await this.publicClient.readContract({
            address: npmAddress,
            abi: NPM_POSITION_ABI,
            functionName: "positions",
            args: [tokenId],
          });
          pos = this.parsePositionResult(posRaw);
        } catch (posErr) {
          const msg = posErr instanceof Error ? posErr.message : String(posErr || "");
          // Accept successful mint tx + ERC721 transfer even if an immediate positions() read
          // briefly returns ID on the RPC backend. Reconcile loop will fill details next tick.
          if (!(msg.includes('function "positions" reverted') && /\bID\b/.test(msg))) {
            throw posErr;
          }
        }

        return {
          tokenId: tokenId.toString(),
          liquidity: pos?.liquidity?.toString() || null,
          tickLower: pos?.tickLower ?? tickLower,
          tickUpper: pos?.tickUpper ?? tickUpper,
          centerTick: Math.round((tickLower + tickUpper) / 2),
          venue,
        };
      } catch (err) {
        if (broadcastedHash && err && typeof err === "object") {
          err.uc6MintTxBroadcasted = true;
          err.uc6MintTxHash = broadcastedHash;
          err.uc6MintReceiptStatus = broadcastedReceiptStatus;
        }
        if (broadcastedHash) {
          anyBroadcastedMintTx = true;
          lastBroadcastedMintTxHash = broadcastedHash;
          lastBroadcastedMintReceiptStatus = broadcastedReceiptStatus;
        }
        lastErr = err;
        errors.push(
          `${candidate.name}: ${err instanceof Error ? err.message : String(err || "unknown")}`
        );
        // Never auto-try another on-chain mint candidate after a tx has been broadcast.
        // Let the failure cooldown handle retries on later loop iterations.
        if (broadcastedHash) break;
      }
    }

    const tail =
      errors.length > 0 ? ` | candidates => ${errors.join(" || ")}` : "";
    const wrapped = new Error(
      `Mint failed: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr || "unknown")
      }${tail}`
    );
    if (anyBroadcastedMintTx) {
      wrapped.uc6MintTxBroadcasted = true;
      wrapped.uc6MintTxHash = lastBroadcastedMintTxHash;
      wrapped.uc6MintReceiptStatus = lastBroadcastedMintReceiptStatus;
    }
    throw wrapped;
  }

  async closePosition({ npmAddress, tokenId, feeValueOverrideUsd = null }) {
    if (!tokenId) return;
    await this.assertTxAllowed("close_position");
    const id = BigInt(tokenId);

    let posRaw;
    try {
      posRaw = await this.publicClient.readContract({
        address: npmAddress,
        abi: NPM_POSITION_ABI,
        functionName: "positions",
        args: [id],
      });
    } catch {
      // Position may already be gone.
      return;
    }

    const pos = this.parsePositionResult(posRaw);
    if (!pos) return;

    if (pos.liquidity > 0n) {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      await this.assertTxAllowed("close_decrease_liquidity");
      const hashDec = await this.walletClient.writeContract({
        address: npmAddress,
        abi: NPM_POSITION_ABI,
        functionName: "decreaseLiquidity",
        args: [
          {
            tokenId: id,
            liquidity: pos.liquidity,
            amount0Min: 0n,
            amount1Min: 0n,
            deadline,
          },
        ],
        account: this.account,
      });
      const recDec = await this.publicClient.waitForTransactionReceipt({ hash: hashDec });
      this.addTxToActiveAction("decrease", hashDec, recDec);
    }

    const preUsdc = await this.readTokenBalance(this.usdc);
    const preWeth = await this.readTokenBalance(this.weth);

    await this.assertTxAllowed("close_collect");
    const hashCollect = await this.walletClient.writeContract({
      address: npmAddress,
      abi: NPM_POSITION_ABI,
      functionName: "collect",
      args: [
        {
          tokenId: id,
          recipient: this.account.address,
          amount0Max: 340282366920938463463374607431768211455n,
          amount1Max: 340282366920938463463374607431768211455n,
        },
      ],
      account: this.account,
    });
    const recCollect = await this.publicClient.waitForTransactionReceipt({ hash: hashCollect });
    this.addTxToActiveAction("collect", hashCollect, recCollect);

    const postUsdc = await this.readTokenBalance(this.usdc);
    const postWeth = await this.readTokenBalance(this.weth);
    const usdcDelta = postUsdc > preUsdc ? postUsdc - preUsdc : 0n;
    const wethDelta = postWeth > preWeth ? postWeth - preWeth : 0n;
    const feesUsd =
      Number(formatUnits(usdcDelta, USDC_DECIMALS)) +
      Number(formatUnits(wethDelta, WETH_DECIMALS)) * this.getSpotUsdcPerWeth();
    // For rebalance close, collect() contains principal + fees after decreaseLiquidity.
    // We attribute only pre-close collectable fees (or fallback computed value if override absent).
    this.addFeesToActiveAction(feeValueOverrideUsd == null ? feesUsd : feeValueOverrideUsd);
    this.state.latest.collectableNow = { usdc: 0, weth: 0, usd: 0, isEstimated: false };

    try {
      await this.assertTxAllowed("close_burn");
      const hashBurn = await this.walletClient.writeContract({
        address: npmAddress,
        abi: NPM_POSITION_ABI,
        functionName: "burn",
        args: [id],
        account: this.account,
      });
      const recBurn = await this.publicClient.waitForTransactionReceipt({ hash: hashBurn });
      this.addTxToActiveAction("burn", hashBurn, recBurn);
    } catch {
      // Burn can fail if dust remains; position is still closed if liquidity is zero.
    }
  }

  async collectPositionFees({ npmAddress, tokenId }) {
    if (!tokenId) return { usdc: 0, weth: 0, usd: 0 };
    await this.assertTxAllowed("harvest_collect");
    const id = BigInt(tokenId);
    let posRaw = null;
    try {
      posRaw = await this.publicClient.readContract({
        address: npmAddress,
        abi: NPM_POSITION_ABI,
        functionName: "positions",
        args: [id],
      });
    } catch {
      posRaw = null;
    }
    const pos = posRaw ? this.parsePositionResult(posRaw) : null;
    const preUsdc = await this.readTokenBalance(this.usdc);
    const preWeth = await this.readTokenBalance(this.weth);

    const hashCollect = await this.walletClient.writeContract({
      address: npmAddress,
      abi: NPM_POSITION_ABI,
      functionName: "collect",
      args: [
        {
          tokenId: id,
          recipient: this.account.address,
          amount0Max: UINT128_MAX,
          amount1Max: UINT128_MAX,
        },
      ],
      account: this.account,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: hashCollect });
    this.addTxToActiveAction("collect", hashCollect, receipt);

    const decodedCollect = this.extractCollectedAmountsFromReceipt(receipt, npmAddress, id);

    const postUsdc = await this.readTokenBalance(this.usdc);
    const postWeth = await this.readTokenBalance(this.weth);
    const usdcDelta = postUsdc > preUsdc ? postUsdc - preUsdc : 0n;
    const wethDelta = postWeth > preWeth ? postWeth - preWeth : 0n;
    let usdcRaw = usdcDelta;
    let wethRaw = wethDelta;
    if (pos && (decodedCollect.amount0 > 0n || decodedCollect.amount1 > 0n)) {
      let mappedUsdc = 0n;
      let mappedWeth = 0n;
      if (sameAddress(pos.token0, this.usdc)) mappedUsdc = decodedCollect.amount0;
      if (sameAddress(pos.token1, this.usdc)) mappedUsdc = decodedCollect.amount1;
      if (sameAddress(pos.token0, this.weth)) mappedWeth = decodedCollect.amount0;
      if (sameAddress(pos.token1, this.weth)) mappedWeth = decodedCollect.amount1;
      // Prefer exact decoded amounts if mapping succeeded.
      if (mappedUsdc > 0n || mappedWeth > 0n) {
        usdcRaw = mappedUsdc;
        wethRaw = mappedWeth;
      }
    }
    const usdc = Number(formatUnits(usdcRaw, USDC_DECIMALS));
    const weth = Number(formatUnits(wethRaw, WETH_DECIMALS));
    const usd = usdc + weth * this.getSpotUsdcPerWeth();
    this.addFeesToActiveAction(usd);
    this.state.latest.collectableNow = { usdc: 0, weth: 0, usd: 0, isEstimated: false };
    return { usdc, weth, usd };
  }

  async normalizeInventoryToUsdc({ router, fee, tickSpacing, snapshot }) {
    const wethBal = await this.readTokenBalance(this.weth);
    if (wethBal <= 0n) return;
    await this.assertTxAllowed("normalize_inventory");

    await this.swapExactInputSingle({
      router,
      tokenIn: this.weth,
      tokenOut: this.usdc,
      amountIn: wethBal,
      slippageBps: this.settings.slippageBps,
      fee,
      tickSpacing,
      snapshot,
    });
  }

  getRebalanceGate() {
    this.ensureDailyCounter();

    const now = Date.now();
    const lastMs = this.state.lastRebalanceAt ? Date.parse(this.state.lastRebalanceAt) : 0;
    const cooldownMs = this.settings.minRebalanceIntervalSec * 1000;
    if (lastMs && now - lastMs < cooldownMs) {
      const remainingSec = Math.ceil((cooldownMs - (now - lastMs)) / 1000);
      return { allowed: false, reason: `cooldown ${remainingSec}s`, remainingSec };
    }

    if (Number(this.state.rebalancesToday || 0) >= this.settings.maxRebalancesPerDay) {
      return { allowed: false, reason: "daily limit reached", remainingSec: null };
    }

    const failureGate = this.getFailureCooldownGate();
    if (!failureGate.allowed) {
      return {
        allowed: false,
        reason: failureGate.reason,
        remainingSec: failureGate.remainingSec,
      };
    }

    if (this.settings.churnProtectionEnabled) {
      const start24h = Date.now() - 24 * 60 * 60 * 1000;
      const stats24h = this.summarizeEvents(this.getEventsSince(start24h));
      const ratio = stats24h.churnRatio;
      const maxRatio = Number(this.settings.churnMaxCostToFeeRatio || 0);
      const shouldBlock =
        !Number.isFinite(ratio) ? stats24h.totalCostsUsd > 0 : ratio > maxRatio;
      if (shouldBlock) {
        return {
          allowed: false,
          reason: `churn_protection ratio=${Number.isFinite(ratio) ? ratio.toFixed(2) : "inf"}`,
          remainingSec: null,
        };
      }
    }

    return { allowed: true, reason: "ok", remainingSec: 0 };
  }

  markRebalanceFailure(err, triggerReason) {
    const now = Date.now();
    const at = new Date(now).toISOString();
    const cooldownSec = Math.max(0, Number(this.settings.failureCooldownSec || 0));
    const untilIso = cooldownSec > 0 ? new Date(now + cooldownSec * 1000).toISOString() : null;

    this.state.lastRebalanceAttemptAt = at;
    this.state.lastRebalanceFailedAt = at;
    this.state.rebalanceFailureCooldownUntil = untilIso;
    this.state.consecutiveRebalanceFailures = Number(this.state.consecutiveRebalanceFailures || 0) + 1;
    this.setLastError(err);
    this.setDecision({
      action: "failed",
      reason: triggerReason,
      error: err instanceof Error ? err.message : String(err || "unknown"),
      txHash: this.activeAction?.txHashes?.[this.activeAction.txHashes.length - 1] || null,
      consecutiveRebalanceFailures: this.state.consecutiveRebalanceFailures,
      failureCooldownUntil: untilIso,
    });
  }

  markRebalanceSuccess(triggerReason, venue) {
    const at = nowIso();
    this.ensureDailyCounter();
    this.state.lastRebalanceAttemptAt = at;
    this.state.rebalancesToday = Number(this.state.rebalancesToday || 0) + 1;
    this.state.lastRebalanceAt = at;
    this.state.lastRebalanceFailedAt = null;
    this.state.rebalanceFailureCooldownUntil = null;
    this.state.consecutiveRebalanceFailures = 0;
    this.state.pendingCompoundUsd = 0;
    this.state.lastError = null;
    this.setDecision({
      action: "rebalanced",
      reason: triggerReason,
      venue,
      txHash: this.activeAction?.txHashes?.[this.activeAction.txHashes.length - 1] || null,
    });
  }

  getPositionTrigger(currentTick) {
    const p = this.state.position || {};
    if (!p.tokenId) {
      return { trigger: true, reason: "no_position", edgeProgress: 1 };
    }

    const lower = Number(p.tickLower);
    const upper = Number(p.tickUpper);
    const center = Number(p.centerTick);

    if (!Number.isFinite(lower) || !Number.isFinite(upper) || !Number.isFinite(center)) {
      return { trigger: true, reason: "position_invalid", edgeProgress: 1 };
    }

    if (currentTick <= lower || currentTick >= upper) {
      return { trigger: true, reason: "out_of_range", edgeProgress: 1 };
    }

    const halfWidth = Math.max(1, Math.abs(upper - center));
    const distance = Math.abs(currentTick - center);
    const edgeProgress = distance / halfWidth;
    if (edgeProgress >= this.settings.edgeRebalancePct) {
      return { trigger: true, reason: "near_edge", edgeProgress };
    }

    return { trigger: false, reason: "in_band", edgeProgress };
  }

  async reconcilePositionFromChain() {
    const tokenId = this.state.position?.tokenId;
    if (!tokenId) return;

    const npm = this.state.position.venue === "uniswapv3" ? this.uniswapNpm : this.slipstreamNpm;

    try {
      const posRaw = await this.publicClient.readContract({
        address: npm,
        abi: NPM_POSITION_ABI,
        functionName: "positions",
        args: [BigInt(tokenId)],
      });
      const pos = this.parsePositionResult(posRaw);
      if (!pos || pos.liquidity === 0n) {
        this.state.position = {
          ...this.state.position,
          tokenId: null,
          liquidity: null,
          inRange: null,
        };
        return;
      }

      this.state.position.tickLower = pos.tickLower;
      this.state.position.tickUpper = pos.tickUpper;
      this.state.position.centerTick = Math.round((pos.tickLower + pos.tickUpper) / 2);
      this.state.position.liquidity = pos.liquidity.toString();

      const tick = Number(this.state.latest?.primary?.tick ?? 0);
      this.state.position.inRange = tick > pos.tickLower && tick < pos.tickUpper;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err || "");
      // Slipstream/Uniswap position managers revert with reason `ID` when tokenId no longer exists
      // (e.g. just burned during a recenter). Treat this as a state reconciliation signal, not an error.
      if (msg.includes('function "positions" reverted') && /\bID\b/.test(msg)) {
        this.state.position = {
          ...this.state.position,
          tokenId: null,
          tickLower: null,
          tickUpper: null,
          centerTick: null,
          liquidity: null,
          inRange: null,
        };
        return;
      }
      this.setLastError(err);
    }
  }

  async maybeHarvestOnly() {
    if (this.settings.compoundMode !== "threshold_harvest") return false;
    const tokenId = this.state.position?.tokenId;
    if (!tokenId) return false;
    const collectable = this.state.latest?.collectableNow;
    const collectableUsd = Number(collectable?.usd || 0);
    if (collectableUsd < Number(this.settings.harvestThresholdUsd || 0)) return false;

    const npm = this.state.position?.venue === "uniswapv3" ? this.uniswapNpm : this.slipstreamNpm;
    this.beginAction("harvest", "threshold");
    try {
      const collected = await this.collectPositionFees({ npmAddress: npm, tokenId });
      this.state.pendingCompoundUsd = Number(this.state.pendingCompoundUsd || 0) + Number(collected.usd || 0);
      this.setDecision({
        action: "harvest",
        reason: "threshold",
        collectedUsd: Number(collected.usd || 0),
        pendingCompoundUsd: Number(this.state.pendingCompoundUsd || 0),
        txHash: this.activeAction?.txHashes?.[this.activeAction.txHashes.length - 1] || null,
      });
      this.finalizeActiveAction("harvest", "threshold", {
        note: "increaseLiquidity not implemented; collected fees kept as pending compound",
      });
      return true;
    } catch (err) {
      this.setLastError(err);
      this.finalizeActiveAction("error", "harvest_failed", {
        message: err instanceof Error ? err.message : String(err || "unknown"),
      });
      return false;
    }
  }

  async rebalanceSlipstream(snapshot) {
    const router = this.slipstreamRouter;
    const npm = this.slipstreamNpm;

    const currentTokenId = this.state.position?.tokenId;
    let closedExistingPosition = false;
    if (currentTokenId) {
      let preCloseCollectableUsd = Number(this.state.latest?.collectableNow?.usd || 0);
      try {
        const freshCollectable = await this.collectableNowSnapshot();
        preCloseCollectableUsd = Number(freshCollectable?.usd || 0);
      } catch {
        // use latest cached collectable snapshot
      }
      await this.closePosition({
        npmAddress: npm,
        tokenId: currentTokenId,
        feeValueOverrideUsd: preCloseCollectableUsd,
      });
      this.state.position = {
        ...this.state.position,
        tokenId: null,
        liquidity: null,
        inRange: null,
      };
      closedExistingPosition = true;
    }

    // Only normalize after closing an existing position. When opening from a failed prior attempt,
    // keep inventory mix to avoid repeated back-and-forth swaps.
    if (closedExistingPosition) {
      await this.normalizeInventoryToUsdc({
        router,
        fee: snapshot.fee,
        tickSpacing: snapshot.tickSpacing,
        snapshot,
      });
    }

    let usdcBalanceRaw = await this.readTokenBalance(this.usdc);
    let wethBalanceRaw = await this.readTokenBalance(this.weth);
    const walletSnapshot = this.state.latest?.wallet;
    const totalValueUsd = Number(walletSnapshot?.valuesUsd?.total || 0);
    const effectiveReserveUsdc = this.getEffectiveReserveTargetUsdc(totalValueUsd);
    const keepReserveRaw = parseUnits(effectiveReserveUsdc.toFixed(6), USDC_DECIMALS);
    const maxDeployRaw = parseUnits(this.settings.maxDeployUsdc.toFixed(6), USDC_DECIMALS);

    let freeUsdcRaw = usdcBalanceRaw > keepReserveRaw ? usdcBalanceRaw - keepReserveRaw : 0n;
    let deployableUsdcRaw = freeUsdcRaw < maxDeployRaw ? freeUsdcRaw : maxDeployRaw;
    if (deployableUsdcRaw <= 0n && wethBalanceRaw > 0n) {
      // If wallet drifted to WETH while no position exists, restore deployable USDC once.
      await this.swapExactInputSingle({
        router,
        tokenIn: this.weth,
        tokenOut: this.usdc,
        amountIn: wethBalanceRaw,
        slippageBps: this.settings.slippageBps,
        fee: snapshot.fee,
        tickSpacing: snapshot.tickSpacing,
        snapshot,
      });
      usdcBalanceRaw = await this.readTokenBalance(this.usdc);
      wethBalanceRaw = await this.readTokenBalance(this.weth);
      freeUsdcRaw = usdcBalanceRaw > keepReserveRaw ? usdcBalanceRaw - keepReserveRaw : 0n;
      deployableUsdcRaw = freeUsdcRaw < maxDeployRaw ? freeUsdcRaw : maxDeployRaw;
    }
    if (deployableUsdcRaw <= 0n) {
      throw new Error(
        `No deployable USDC after reserve and maxDeploy limits ${JSON.stringify({
          reserveUsdc: Number(formatUnits(keepReserveRaw, USDC_DECIMALS)),
          maxDeployUsdc: Number(this.settings.maxDeployUsdc || 0),
          usdcBalance: Number(formatUnits(usdcBalanceRaw, USDC_DECIMALS)),
          wethBalance: Number(formatUnits(wethBalanceRaw, WETH_DECIMALS)),
          freeUsdc: Number(formatUnits(freeUsdcRaw, USDC_DECIMALS)),
        })}`
      );
    }

    // Move only part of USDC to WETH. Use ceil division so small deploy amounts still get some WETH.
    const swapIn = (deployableUsdcRaw + 1n) / 2n;
    if (swapIn > 0n) {
      await this.swapExactInputSingle({
        router,
        tokenIn: this.usdc,
        tokenOut: this.weth,
        amountIn: swapIn,
        slippageBps: this.settings.slippageBps,
        fee: snapshot.fee,
        tickSpacing: snapshot.tickSpacing,
        snapshot,
      });
    }

    const usdcAfter = await this.readTokenBalance(this.usdc);
    const wethAfter = await this.readTokenBalance(this.weth);

    let usdcSpendable = usdcAfter > keepReserveRaw ? usdcAfter - keepReserveRaw : 0n;
    let usdcToUse = usdcSpendable < maxDeployRaw ? usdcSpendable : maxDeployRaw;
    let wethToUse = wethAfter;

    // Recovery path: if one side is unexpectedly empty, do a one-shot top-up swap.
    if ((usdcToUse <= 0n || wethToUse <= 0n) && (usdcAfter > 0n || wethAfter > 0n)) {
      if (wethToUse <= 0n && usdcToUse > 0n) {
        const topUpUsdcIn = usdcToUse / 4n;
        if (topUpUsdcIn > 0n) {
          await this.swapExactInputSingle({
            router,
            tokenIn: this.usdc,
            tokenOut: this.weth,
            amountIn: topUpUsdcIn,
            slippageBps: this.settings.slippageBps,
            fee: snapshot.fee,
            tickSpacing: snapshot.tickSpacing,
            snapshot,
          });
        }
      } else if (usdcToUse <= 0n && wethToUse > 0n) {
        const topUpWethIn = wethToUse / 4n;
        if (topUpWethIn > 0n) {
          await this.swapExactInputSingle({
            router,
            tokenIn: this.weth,
            tokenOut: this.usdc,
            amountIn: topUpWethIn,
            slippageBps: this.settings.slippageBps,
            fee: snapshot.fee,
            tickSpacing: snapshot.tickSpacing,
            snapshot,
          });
        }
      }

      const usdcRetry = await this.readTokenBalance(this.usdc);
      const wethRetry = await this.readTokenBalance(this.weth);
      usdcSpendable = usdcRetry > keepReserveRaw ? usdcRetry - keepReserveRaw : 0n;
      usdcToUse = usdcSpendable < maxDeployRaw ? usdcSpendable : maxDeployRaw;
      wethToUse = wethRetry;
    }

    if (usdcToUse <= 0n || wethToUse <= 0n) {
      const diag = {
        reserveUsdc: Number(formatUnits(keepReserveRaw, USDC_DECIMALS)),
        maxDeployUsdc: Number(this.settings.maxDeployUsdc || 0),
        usdcBalance: Number(formatUnits(usdcAfter, USDC_DECIMALS)),
        wethBalance: Number(formatUnits(wethAfter, WETH_DECIMALS)),
        usdcSpendable: Number(formatUnits(usdcSpendable, USDC_DECIMALS)),
        usdcToUse: Number(formatUnits(usdcToUse > 0n ? usdcToUse : 0n, USDC_DECIMALS)),
        wethToUse: Number(formatUnits(wethToUse > 0n ? wethToUse : 0n, WETH_DECIMALS)),
        spot: this.getSpotUsdcPerWeth(),
      };
      throw new Error(`Insufficient dual-asset balances for LP mint ${JSON.stringify(diag)}`);
    }

    const token0 = snapshot.token0;
    const token1 = snapshot.token1;
    const amount0Desired = sameAddress(token0, this.usdc) ? usdcToUse : wethToUse;
    const amount1Desired = sameAddress(token1, this.usdc) ? usdcToUse : wethToUse;

    await this.approveIfNeeded(token0, npm, amount0Desired);
    await this.approveIfNeeded(token1, npm, amount1Desired);

    const maxPreflightMintAttempts = 3;
    let mintBasis = snapshot;
    let targetRange = this.computeTargetRange(
      mintBasis.tick,
      mintBasis.tickSpacing,
      this.settings.bandHalfBps
    );
    let minted;
    let lastMintErr = null;
    const preflightErrors = [];

    for (let attempt = 1; attempt <= maxPreflightMintAttempts; attempt += 1) {
      if (attempt > 1) {
        try {
          mintBasis = await this.getPoolSnapshot(this.slipstreamPool, "slipstream");
        } catch {
          // Keep prior snapshot if refresh fails.
        }
        targetRange = this.computeTargetRange(
          mintBasis.tick,
          mintBasis.tickSpacing,
          this.settings.bandHalfBps
        );
      } else {
        try {
          mintBasis = await this.getPoolSnapshot(this.slipstreamPool, "slipstream");
          targetRange = this.computeTargetRange(
            mintBasis.tick,
            mintBasis.tickSpacing,
            this.settings.bandHalfBps
          );
        } catch {
          // Keep provided snapshot on first attempt if refresh fails.
        }
      }

      try {
        minted = await this.mintPosition({
          npmAddress: npm,
          token0,
          token1,
          fee: mintBasis.fee,
          tickSpacing: mintBasis.tickSpacing,
          tickLower: targetRange.tickLower,
          tickUpper: targetRange.tickUpper,
          amount0Desired,
          amount1Desired,
          slippageBps: this.settings.slippageBps,
          sqrtPriceX96: mintBasis.sqrtPriceX96,
          venue: "slipstream",
        });
        break;
      } catch (err) {
        lastMintErr = err;
        preflightErrors.push(
          `attempt${attempt}: ${err instanceof Error ? err.message : String(err || "unknown")}`
        );
        // If a mint tx was broadcast, do not try more on-chain mints in this rebalance attempt.
        if (err && typeof err === "object" && err.uc6MintTxBroadcasted) {
          break;
        }
      }
    }

    if (!minted) {
      throw new Error(
        `mint_retry_failed: ${preflightErrors.join(" | ") || (lastMintErr instanceof Error ? lastMintErr.message : String(lastMintErr || "unknown"))}`
      );
    }

    this.state.position = {
      venue: "slipstream",
      tokenId: minted.tokenId,
      tickLower: minted.tickLower,
      tickUpper: minted.tickUpper,
      centerTick: minted.centerTick,
      liquidity: minted.liquidity,
      inRange: snapshot.tick > minted.tickLower && snapshot.tick < minted.tickUpper,
    };
  }

  async evaluateAndAct() {
    const primary = this.state.latest?.primary;
    if (!primary) {
      this.setDecision({ action: "monitor", reason: "no_market_data" });
      return;
    }

    const forceRequestedAt = this.state.forceRebalanceRequestedAt || null;
    const forceRebalance = Boolean(forceRequestedAt);
    const gate = this.getRebalanceGate();
    const trigger = this.getPositionTrigger(primary.tick);
    const recoveryRetry = Boolean(this.state.forceRebalanceRecoveryPending) && trigger.reason === "no_position";
    const effectiveTrigger = forceRebalance
      ? { ...trigger, trigger: true, reason: "manual_force" }
      : recoveryRetry
        ? { ...trigger, trigger: true, reason: "recovery_retry" }
      : trigger;

    if (this.settings.killSwitch) {
      this.setDecision({
        action: "monitor",
        reason: "kill_switch_active",
        tradingEnabled: false,
        gate,
        forceRebalanceRequestedAt: forceRequestedAt,
      });
      this.pushEvent({ type: "blocked", reason: "kill_switch_active" });
      return;
    }

    if (!this.settings.tradingEnabled) {
      this.setDecision({
        action: "monitor",
        reason: effectiveTrigger.reason,
        tradingEnabled: false,
        gate,
        forceRebalanceRequestedAt: forceRequestedAt,
      });
      this.pushEvent({ type: "blocked", reason: "trading_disabled" });
      return;
    }

    if (!effectiveTrigger.trigger) {
      const harvested = await this.maybeHarvestOnly();
      if (harvested) return;
      this.setDecision({
        action: "monitor",
        reason: trigger.reason,
        edgeProgress: trigger.edgeProgress,
        gate,
      });
      return;
    }

    if (!forceRebalance && !recoveryRetry && !gate.allowed) {
      this.setDecision({ action: "skipped", reason: effectiveTrigger.reason, gate });
      this.pushEvent({ type: "blocked", reason: gate.reason });
      return;
    }

    if (this.settings.venue === "uniswapv3") {
      if (forceRebalance) this.state.forceRebalanceRequestedAt = null;
      if (recoveryRetry) this.state.forceRebalanceRecoveryPending = false;
      this.setDecision({
        action: "skipped",
        reason: effectiveTrigger.reason,
        note: "uniswapv3 execution path is intentionally read-only in this version",
      });
      return;
    }

    if (forceRebalance) this.state.forceRebalanceRequestedAt = null;
    if (recoveryRetry) this.state.forceRebalanceRecoveryPending = false;
    this.beginAction("recenter", effectiveTrigger.reason);
    try {
      await this.rebalanceSlipstream(primary);
      if (!this.state.position?.tokenId) {
        throw new Error("Rebalance finished without an active LP position (tokenId missing)");
      }
      this.markRebalanceSuccess(effectiveTrigger.reason, "slipstream");
      this.finalizeActiveAction("recenter", effectiveTrigger.reason, forceRebalance ? { requestedAt: forceRequestedAt } : {});
    } catch (err) {
      if (forceRebalance && !this.state.position?.tokenId) {
        // Force-rebalance can close first and then fail on re-open; allow one quick retry.
        this.state.forceRebalanceRecoveryPending = true;
      }
      this.markRebalanceFailure(err, effectiveTrigger.reason);
      this.finalizeActiveAction("error", effectiveTrigger.reason, {
        message: err instanceof Error ? err.message : String(err || "unknown"),
        ...(forceRebalance ? { requestedAt: forceRequestedAt } : {}),
      });
    }
  }

  async loopOnce() {
    this.ensureDailyCounter();
    await this.loadSettings(false);
    const snapshots = await this.refreshSnapshots();
    await this.reconcilePositionFromChain();
    try {
      this.state.latest.collectableNow = await this.collectableNowSnapshot();
    } catch {
      this.state.latest.collectableNow = { usdc: 0, weth: 0, usd: 0, isEstimated: true };
    }

    const tokenId = this.state.position?.tokenId;
    if (tokenId && this.state.position?.tickLower != null && this.state.position?.tickUpper != null) {
      const tick = snapshots.primary.tick;
      this.state.position.inRange = tick > this.state.position.tickLower && tick < this.state.position.tickUpper;
    }

    await this.evaluateAndAct();
  }

  async mainLoop() {
    while (!this.stopRequested) {
      const started = Date.now();
      try {
        await this.loopOnce();
      } catch (err) {
        this.setLastError(err);
      }

      try {
        await this.persistState();
      } catch (err) {
        this.setLastError(err);
      }

      const elapsed = Date.now() - started;
      const waitMs = Math.max(250, this.settings.pollIntervalMs - elapsed);
      await sleep(waitMs);
    }
  }

  statusPayload() {
    const gate = this.getRebalanceGate();
    const latest = this.state.latest || {};
    const primary = latest.primary || null;
    const fallback = latest.fallback || null;
    const venueActive = this.settings.venue === "uniswapv3" ? "uniswapv3" : "slipstream";
    const activePool = venueActive === "uniswapv3" ? fallback || primary : primary || fallback;
    const selectorType = venueActive === "uniswapv3" ? "fee" : "tickSpacing";
    const selectorValue = selectorType === "fee" ? Number(activePool?.fee || 0) : Number(activePool?.tickSpacing || 0);
    const spotUsdcPerWeth = this.getSpotUsdcPerWeth();
    const walletState = latest.wallet || {};
    const walletUsdc = Number(walletState.usdc || 0);
    const walletWeth = Number(walletState.weth || 0);
    const walletEth = Number(walletState.eth || 0);
    const walletValueUsd =
      Number(walletState.valuesUsd?.total || 0) || walletUsdc + walletWeth * spotUsdcPerWeth + walletEth * spotUsdcPerWeth;

    const pos = this.state.position || {};
    const token0 = activePool?.token0 || this.weth;
    const token1 = activePool?.token1 || this.usdc;
    const tickLower = Number(pos.tickLower);
    const tickUpper = Number(pos.tickUpper);
    const hasRange = Number.isFinite(tickLower) && Number.isFinite(tickUpper) && tickUpper > tickLower;
    const liquidityRaw = pos.liquidity ? BigInt(pos.liquidity) : 0n;
    const lpAmountsRaw =
      hasRange && liquidityRaw > 0n && activePool?.sqrtPriceX96
        ? this.lpAmountsFromLiquidity(liquidityRaw, tickLower, tickUpper, BigInt(activePool.sqrtPriceX96), token0, token1)
        : { usdcRaw: 0n, wethRaw: 0n };

    const lpUsdc = Number(formatUnits(lpAmountsRaw.usdcRaw, USDC_DECIMALS));
    const lpWeth = Number(formatUnits(lpAmountsRaw.wethRaw, WETH_DECIMALS));
    const lpUsdValue = lpUsdc + lpWeth * spotUsdcPerWeth;
    const sideUsd = {
      usdc: lpUsdc,
      weth: lpWeth * spotUsdcPerWeth,
    };

    const distance = this.distanceToEdge(pos, Number(activePool?.tick ?? 0));
    const reserveTargetUsdc = this.getEffectiveReserveTargetUsdc(walletValueUsd + lpUsdValue);
    const reserveTargetUsd = reserveTargetUsdc;
    const portfolioTotalUsd = walletValueUsd + lpUsdValue;
    const deployedPct = portfolioTotalUsd > 0 ? (lpUsdValue / portfolioTotalUsd) * 100 : 0;

    const now = Date.now();
    const todayStart = Date.parse(`${utcDayKey()}T00:00:00.000Z`);
    const events24h = this.getEventsSince(now - 24 * 60 * 60 * 1000);
    const events7d = this.getEventsSince(now - 7 * 24 * 60 * 60 * 1000);
    const events30d = this.getEventsSince(now - 30 * 24 * 60 * 60 * 1000);
    const eventsToday = this.getEventsSince(todayStart);
    const eventsAll = this.getEventsSince(null);
    const todayStats = this.summarizeEvents(eventsToday);
    const stats24h = this.summarizeEvents(events24h);
    const stats7d = this.summarizeEvents(events7d);
    const stats30d = this.summarizeEvents(events30d);
    const statsAll = this.summarizeEvents(eventsAll);

    const collectableNow = latest.collectableNow || { usdc: 0, weth: 0, usd: 0, isEstimated: true };
    const avgCapitalToday = lpUsdValue > 0 ? lpUsdValue : 1;
    const avgCapital7d = lpUsdValue > 0 ? lpUsdValue : 1;
    const avgCapital30d = lpUsdValue > 0 ? lpUsdValue : 1;
    const aprToday = lpUsdValue > 0 ? (todayStats.netUsd / avgCapitalToday) * 365 : null;
    const apr7d = lpUsdValue > 0 ? (stats7d.netUsd / avgCapital7d) * 365 : null;
    const apr30d = events30d.length > 0 && lpUsdValue > 0 ? (stats30d.netUsd / avgCapital30d) * 365 : null;
    const churnRatioToday = Number.isFinite(todayStats.churnRatio) ? todayStats.churnRatio : null;

    return {
      ok: true,
      ts: nowIso(),
      version: VERSION,
      account: this.account.address,
      tradingEnabled: this.settings.tradingEnabled && !this.settings.killSwitch,
      killSwitch: Boolean(this.settings.killSwitch),
      market: {
        chain: { name: "Base", chainId: base.id },
        venueActive,
        pair: { base: "WETH", quote: "USDC" },
        selector: { type: selectorType, value: selectorValue },
        poolAddress: activePool?.pool || null,
        spotPrice: {
          usdcPerWeth: spotUsdcPerWeth,
          updatedAtIso: activePool?.updatedAt || null,
        },
        tick: {
          current: Number(activePool?.tick ?? 0),
          spacing: Number(activePool?.tickSpacing ?? 0),
        },
        primary,
        fallback,
      },
      settings: {
        tradingEnabled: this.settings.tradingEnabled,
        killSwitch: this.settings.killSwitch,
        venue: this.settings.venue,
        bandHalfBps: this.settings.bandHalfBps,
        edgeRebalancePct: this.settings.edgeRebalancePct,
        minRebalanceIntervalSec: this.settings.minRebalanceIntervalSec,
        maxRebalancesPerDay: this.settings.maxRebalancesPerDay,
        slippageBps: this.settings.slippageBps,
        pollIntervalMs: this.settings.pollIntervalMs,
        maxDeployUsdc: this.settings.maxDeployUsdc,
        reservePolicy: {
          minUsdc: this.settings.reserveMinUsdc,
          pct: this.settings.reservePct,
          maxUsdc: this.settings.reserveMaxUsdc,
          effectiveTargetUsdc: reserveTargetUsdc,
        },
        compoundMode: this.settings.compoundMode,
        harvestThresholdUsd: this.settings.harvestThresholdUsd,
        failureCooldownSec: this.settings.failureCooldownSec,
        churnProtection: {
          enabled: this.settings.churnProtectionEnabled,
          maxCostToFeeRatio: this.settings.churnMaxCostToFeeRatio,
          currentRatioToday: churnRatioToday,
        },
        keepUsdcReserve: this.settings.keepUsdcReserve,
      },
      position: {
        tokenId: pos.tokenId || null,
        tickLower: pos.tickLower ?? null,
        tickUpper: pos.tickUpper ?? null,
        centerTick: pos.centerTick ?? null,
        inRange: Boolean(pos.inRange),
        distanceToEdge: distance,
        liquidity: pos.liquidity || null,
        amountsInLP: {
          usdc: lpUsdc,
          weth: lpWeth,
          usdValue: lpUsdValue,
          sideUsd,
        },
      },
      wallet: {
        balances: {
          usdc: walletUsdc,
          weth: walletWeth,
          eth: walletEth,
        },
        valuesUsd: {
          usdc: walletUsdc,
          weth: walletWeth * spotUsdcPerWeth,
          eth: walletEth * spotUsdcPerWeth,
          total: walletValueUsd,
        },
        allocationUsd: {
          idle: walletValueUsd,
          lpDeployed: lpUsdValue,
          reserveTarget: reserveTargetUsd,
        },
        deployedPct,
      },
      fees: {
        collectableNow,
        collectedTodayUsd: todayStats.feesUsd,
        collected7dUsd: stats7d.feesUsd,
        collectedTotalUsd: statsAll.feesUsd,
        pendingCompoundUsd: Number(this.state.pendingCompoundUsd || 0),
      },
      costs: {
        gasTodayUsd: todayStats.gasUsd,
        gas7dUsd: stats7d.gasUsd,
        gasTotalUsd: statsAll.gasUsd,
        swapCostsTodayUsd: todayStats.swapCostsUsd,
        swapCosts7dUsd: stats7d.swapCostsUsd,
        swapCostsTotalUsd: statsAll.swapCostsUsd,
        mintBurnTodayUsd: todayStats.mintBurnUsd,
        mintBurn7dUsd: stats7d.mintBurnUsd,
        mintBurnTotalUsd: statsAll.mintBurnUsd,
        totalTodayUsd: todayStats.totalCostsUsd,
        total7dUsd: stats7d.totalCostsUsd,
        totalTotalUsd: statsAll.totalCostsUsd,
      },
      pnl: {
        netTodayUsd: todayStats.netUsd,
        net7dUsd: stats7d.netUsd,
        netTotalUsd: statsAll.netUsd,
        aprToday,
        apr7d,
        apr30d,
      },
      ops: {
        rebalancesToday: this.state.rebalancesToday,
        rebalances24h: stats24h.rebalances,
        rebalances7d: stats7d.rebalances,
        churnRatioToday,
        lastRebalanceAtIso: this.state.lastRebalanceAt,
        cooldownRemainingSec: gate.remainingSec,
        forceRebalanceRequestedAtIso: this.state.forceRebalanceRequestedAt || null,
        forceRebalanceRecoveryPending: Boolean(this.state.forceRebalanceRecoveryPending),
        lastDecision: this.state.lastDecision,
        lastError: this.parseLastErrorObject(),
      },
      events: {
        lastN: eventsAll.slice(-50),
      },
      // Backward-compatible mirrors:
      counters: {
        dayKey: this.state.dayKey,
        rebalancesToday: this.state.rebalancesToday,
        lastRebalanceAt: this.state.lastRebalanceAt,
        lastRebalanceAttemptAt: this.state.lastRebalanceAttemptAt,
        lastRebalanceFailedAt: this.state.lastRebalanceFailedAt,
        rebalanceFailureCooldownUntil: this.state.rebalanceFailureCooldownUntil,
        consecutiveRebalanceFailures: Number(this.state.consecutiveRebalanceFailures || 0),
        forceRebalanceRequestedAt: this.state.forceRebalanceRequestedAt || null,
        forceRebalanceRecoveryPending: Boolean(this.state.forceRebalanceRecoveryPending),
        canRebalanceNow: gate.allowed,
        reason: gate.reason,
      },
      lastDecision: this.state.lastDecision,
      lastError: this.state.lastError,
    };
  }

  async handleOwnerSettings(req, res) {
    const ip = extractIp(req);
    const rl = this.ownerRateLimiter.take(ip);
    if (!rl.ok) return tooMany(res, rl.retryAfterSec);

    const auth = String(req.headers.authorization || "");
    if (auth !== `Bearer ${ENV.adminToken}`) return unauthorized(res);

    try {
      const body = await readJsonBody(req);
      const message = String(body.message || "");
      const signature = String(body.signature || "");
      const payload = body.payload && typeof body.payload === "object" ? body.payload : {};

      if (!message || !signature) {
        return jsonResponse(res, 400, { error: "Missing message or signature" });
      }

      const parsed = verifyOwnerSignature({
        ownerAddress: this.ownerAddress,
        message,
        signature,
        payload,
      });

      this.pruneUsedNonces();
      if (this.ownerNonceUsed.has(parsed.nonce)) {
        return jsonResponse(res, 409, { error: "Owner nonce already used" });
      }

      const nextSettings = normalizeSettings(payload, this.settings);
      if (this.settings.killSwitch && !nextSettings.killSwitch) {
        const allowReset = String(process.env.UC6_ALLOW_KILL_SWITCH_RESET || "")
          .trim()
          .toLowerCase();
        if (!(allowReset === "1" || allowReset === "true" || allowReset === "yes")) {
          return jsonResponse(res, 409, {
            error:
              "Kill switch reset blocked. Set UC6_ALLOW_KILL_SWITCH_RESET=true on VM for intentional manual reset.",
          });
        }
      }
      if (nextSettings.killSwitch) {
        nextSettings.tradingEnabled = false;
      }
      await writeJsonAtomic(SETTINGS_PATH, nextSettings);
      this.settings = nextSettings;
      try {
        const st = await fsp.stat(SETTINGS_PATH);
        this.settingsMtimeMs = st.mtimeMs;
      } catch {}

      const nonceExpiry = Date.parse(parsed.expiresAt) + 60_000;
      this.ownerNonceUsed.set(parsed.nonce, nonceExpiry);

      this.setDecision({ action: "settings_updated", by: this.ownerAddress });
      await this.persistState();

      return jsonResponse(res, 200, { ok: true, settings: this.settings });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err || "Bad request");
      return jsonResponse(res, 400, { error: msg });
    }
  }

  async handleOwnerForceRebalance(req, res) {
    const ip = extractIp(req);
    const rl = this.ownerRateLimiter.take(ip);
    if (!rl.ok) return tooMany(res, rl.retryAfterSec);

    const auth = String(req.headers.authorization || "");
    if (auth !== `Bearer ${ENV.adminToken}`) return unauthorized(res);

    try {
      const body = await readJsonBody(req);
      const message = String(body.message || "");
      const signature = String(body.signature || "");
      const payload = body.payload && typeof body.payload === "object" ? body.payload : {};

      if (!message || !signature) {
        return jsonResponse(res, 400, { error: "Missing message or signature" });
      }

      const parsed = verifyOwnerSignature({
        ownerAddress: this.ownerAddress,
        message,
        signature,
        payload,
        expectedAction: "force_rebalance",
      });

      this.pruneUsedNonces();
      if (this.ownerNonceUsed.has(parsed.nonce)) {
        return jsonResponse(res, 409, { error: "Owner nonce already used" });
      }

      this.state.forceRebalanceRequestedAt = nowIso();
      const nonceExpiry = Date.parse(parsed.expiresAt) + 60_000;
      this.ownerNonceUsed.set(parsed.nonce, nonceExpiry);
      this.setDecision({ action: "force_rebalance_requested", by: this.ownerAddress });
      await this.persistState();

      return jsonResponse(res, 200, {
        ok: true,
        forceRebalanceRequestedAt: this.state.forceRebalanceRequestedAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err || "Bad request");
      return jsonResponse(res, 400, { error: msg });
    }
  }

  async handleHttp(req, res) {
    if (!req.url) return jsonResponse(res, 404, { error: "Not found" });
    const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && u.pathname === "/health") {
      return jsonResponse(res, 200, {
        ok: true,
        ts: nowIso(),
        tradingEnabled: this.settings.tradingEnabled && !this.settings.killSwitch,
        killSwitch: Boolean(this.settings.killSwitch),
        account: this.account.address,
      });
    }

    if (req.method === "GET" && u.pathname === "/status") {
      return jsonResponse(res, 200, this.statusPayload());
    }

    if (u.pathname.startsWith("/owner/")) {
      if (req.method === "POST" && u.pathname === "/owner/settings") {
        return await this.handleOwnerSettings(req, res);
      }
      if (req.method === "POST" && u.pathname === "/owner/force-rebalance") {
        return await this.handleOwnerForceRebalance(req, res);
      }
      return jsonResponse(res, 405, { error: "Method not allowed" });
    }

    return jsonResponse(res, 404, { error: "Not found" });
  }

  async startHttp() {
    this.server = http.createServer(async (req, res) => {
      try {
        await this.handleHttp(req, res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "internal error";
        jsonResponse(res, 500, { error: msg });
      }
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(ENV.port, ENV.host, () => resolve());
    });
  }

  async start() {
    await this.init();
    await this.startHttp();
    this.loopRunning = true;
    console.log(`[UC6] ${VERSION} running on ${ENV.host}:${ENV.port} account=${this.account.address}`);
    await this.mainLoop();
  }

  async stop() {
    this.stopRequested = true;
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
    }
    await this.persistState().catch(() => {});
  }
}

async function main() {
  const bot = new Uc6Bot();

  const shutdown = async (sig) => {
    console.log(`[UC6] received ${sig}, shutting down`);
    await bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[UC6] unhandled rejection", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[UC6] uncaught exception", err);
  });

  await bot.start();
}

main().catch((err) => {
  console.error("[UC6] fatal", err instanceof Error ? err.message : err);
  process.exit(1);
});
