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
  slipstreamNpm: process.env.UC6_SLIPSTREAM_NPM || "0x827922686190790b37229fd06084350e74485b72",

  uniswapPool: process.env.UC6_UNISWAP_POOL || "0xd0b53d9277642d899df5c87a3966a349a798f224",
  uniswapRouter: process.env.UC6_UNISWAP_ROUTER || "0x2626664c2603336E57B271c5C0b26F421741e481",
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
      { name: "fee", type: "uint24" },
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

const ERC721_TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: true, name: "tokenId", type: "uint256" },
  ],
};

const DEFAULT_SETTINGS = {
  version: 1,
  tradingEnabled: true,
  killSwitch: false,
  venue: "slipstream",
  bandHalfBps: 100,
  edgeRebalancePct: 0.85,
  minRebalanceIntervalSec: 300,
  maxRebalancesPerDay: 20,
  slippageBps: 30,
  pollIntervalMs: 2000,
  maxDeployUsdc: 50_000,
  keepUsdcReserve: 25,
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

function normalizeSettings(input = {}, baseSettings = DEFAULT_SETTINGS) {
  const src = input && typeof input === "object" ? input : {};
  const killSwitch = toBool(src.killSwitch, baseSettings.killSwitch);
  const out = {
    version: 1,
    tradingEnabled: killSwitch ? false : toBool(src.tradingEnabled, baseSettings.tradingEnabled),
    killSwitch,
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
    keepUsdcReserve: clamp(toNumber(src.keepUsdcReserve, baseSettings.keepUsdcReserve), 0, 500_000),
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
    },
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

function verifyOwnerSignature({ ownerAddress, message, signature, payload }) {
  const parsed = parseOwnerMessage(message);
  if (parsed.action !== "update_settings") {
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
    this.slipstreamNpm = getAddress(ENV.slipstreamNpm);
    this.uniswapPool = getAddress(ENV.uniswapPool);
    this.uniswapRouter = getAddress(ENV.uniswapRouter);
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
    const [primary, fallback, usdcBalanceRaw, wethBalanceRaw] = await Promise.all([
      this.getPoolSnapshot(this.slipstreamPool, "slipstream"),
      this.getPoolSnapshot(this.uniswapPool, "uniswapv3").catch(() => null),
      this.readTokenBalance(this.usdc),
      this.readTokenBalance(this.weth),
    ]);

    this.state.latest.primary = primary;
    this.state.latest.fallback = fallback;
    this.state.latest.wallet = {
      usdc: Number(formatUnits(usdcBalanceRaw, USDC_DECIMALS)),
      weth: Number(formatUnits(wethBalanceRaw, WETH_DECIMALS)),
      updatedAt: nowIso(),
    };

    return { primary, fallback, usdcBalanceRaw, wethBalanceRaw };
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
    await this.publicClient.waitForTransactionReceipt({ hash });
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

  async swapExactInputSingle({ router, tokenIn, tokenOut, amountIn, slippageBps, fee, tickSpacing, snapshot }) {
    if (amountIn <= 0n) return;

    await this.assertTxAllowed("swap");
    await this.approveIfNeeded(tokenIn, router, amountIn);
    const estimatedOut = this.priceEstimateOut(amountIn, tokenIn, tokenOut, snapshot);
    const amountOutMinimum = this.minOutFromEstimate(estimatedOut, slippageBps);
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

        await this.assertTxAllowed("swap_write");
        const hash = await this.walletClient.writeContract({
          ...sim.request,
          account: this.account,
        });
        await this.publicClient.waitForTransactionReceipt({ hash });
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
    const tickLower = Number(pos.tickLower ?? pos[5] ?? 0);
    const tickUpper = Number(pos.tickUpper ?? pos[6] ?? 0);
    const liquidity = BigInt(pos.liquidity ?? pos[7] ?? 0);
    return { tickLower, tickUpper, liquidity };
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

    const candidates = [
      {
        name: "mint-tickSpacing-sqrtPrice",
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
      },
      {
        name: "mint-fee",
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
      {
        name: "mint-tickSpacing",
        abi: NPM_MINT_ABI_TICK,
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
          },
        ],
      },
    ];

    let lastErr = null;
    const errors = [];
    for (const candidate of candidates) {
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
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

        let tokenId = this.extractMintedTokenId(receipt, npmAddress);
        if (!tokenId) {
          const res = Array.isArray(sim.result) ? sim.result[0] : null;
          if (typeof res === "bigint") tokenId = res;
        }
        if (!tokenId) throw new Error("Mint succeeded but tokenId could not be determined");

        const posRaw = await this.publicClient.readContract({
          address: npmAddress,
          abi: NPM_POSITION_ABI,
          functionName: "positions",
          args: [tokenId],
        });
        const pos = this.parsePositionResult(posRaw);

        return {
          tokenId: tokenId.toString(),
          liquidity: pos?.liquidity?.toString() || null,
          tickLower: pos?.tickLower ?? tickLower,
          tickUpper: pos?.tickUpper ?? tickUpper,
          centerTick: Math.round((tickLower + tickUpper) / 2),
          venue,
        };
      } catch (err) {
        lastErr = err;
        errors.push(
          `${candidate.name}: ${err instanceof Error ? err.message : String(err || "unknown")}`
        );
      }
    }

    const tail =
      errors.length > 0 ? ` | candidates => ${errors.join(" || ")}` : "";
    throw new Error(
      `Mint failed: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr || "unknown")
      }${tail}`
    );
  }

  async closePosition({ npmAddress, tokenId }) {
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
      await this.publicClient.waitForTransactionReceipt({ hash: hashDec });
    }

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
    await this.publicClient.waitForTransactionReceipt({ hash: hashCollect });

    try {
      await this.assertTxAllowed("close_burn");
      const hashBurn = await this.walletClient.writeContract({
        address: npmAddress,
        abi: NPM_POSITION_ABI,
        functionName: "burn",
        args: [id],
        account: this.account,
      });
      await this.publicClient.waitForTransactionReceipt({ hash: hashBurn });
    } catch {
      // Burn can fail if dust remains; position is still closed if liquidity is zero.
    }
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

    return { allowed: true, reason: "ok", remainingSec: 0 };
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
      this.setLastError(err);
    }
  }

  async rebalanceSlipstream(snapshot) {
    const router = this.slipstreamRouter;
    const npm = this.slipstreamNpm;

    const currentTokenId = this.state.position?.tokenId;
    if (currentTokenId) {
      await this.closePosition({ npmAddress: npm, tokenId: currentTokenId });
      this.state.position = {
        ...this.state.position,
        tokenId: null,
        liquidity: null,
        inRange: null,
      };
    }

    await this.normalizeInventoryToUsdc({
      router,
      fee: snapshot.fee,
      tickSpacing: snapshot.tickSpacing,
      snapshot,
    });

    const usdcBalanceRaw = await this.readTokenBalance(this.usdc);
    const keepReserveRaw = parseUnits(this.settings.keepUsdcReserve.toFixed(6), USDC_DECIMALS);
    const maxDeployRaw = parseUnits(this.settings.maxDeployUsdc.toFixed(6), USDC_DECIMALS);

    const freeUsdcRaw = usdcBalanceRaw > keepReserveRaw ? usdcBalanceRaw - keepReserveRaw : 0n;
    const deployableUsdcRaw = freeUsdcRaw < maxDeployRaw ? freeUsdcRaw : maxDeployRaw;
    if (deployableUsdcRaw <= 0n) {
      throw new Error("No deployable USDC after reserve and maxDeploy limits");
    }

    const swapIn = deployableUsdcRaw / 2n;
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

    const usdcSpendable = usdcAfter > keepReserveRaw ? usdcAfter - keepReserveRaw : 0n;
    const usdcToUse = usdcSpendable < maxDeployRaw ? usdcSpendable : maxDeployRaw;
    const wethToUse = wethAfter;

    if (usdcToUse <= 0n || wethToUse <= 0n) {
      throw new Error("Insufficient dual-asset balances for LP mint");
    }

    const token0 = snapshot.token0;
    const token1 = snapshot.token1;
    const amount0Desired = sameAddress(token0, this.usdc) ? usdcToUse : wethToUse;
    const amount1Desired = sameAddress(token1, this.usdc) ? usdcToUse : wethToUse;

    await this.approveIfNeeded(token0, npm, amount0Desired);
    await this.approveIfNeeded(token1, npm, amount1Desired);

    const targetRange = this.computeTargetRange(snapshot.tick, snapshot.tickSpacing, this.settings.bandHalfBps);
    const minted = await this.mintPosition({
      npmAddress: npm,
      token0,
      token1,
      fee: snapshot.fee,
      tickSpacing: snapshot.tickSpacing,
      tickLower: targetRange.tickLower,
      tickUpper: targetRange.tickUpper,
      amount0Desired,
      amount1Desired,
      slippageBps: this.settings.slippageBps,
      sqrtPriceX96: snapshot.sqrtPriceX96,
      venue: "slipstream",
    });

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

    const gate = this.getRebalanceGate();
    const trigger = this.getPositionTrigger(primary.tick);

    if (this.settings.killSwitch) {
      this.setDecision({ action: "monitor", reason: "kill_switch_active", tradingEnabled: false, gate });
      return;
    }

    if (!this.settings.tradingEnabled) {
      this.setDecision({ action: "monitor", reason: trigger.reason, tradingEnabled: false, gate });
      return;
    }

    if (!trigger.trigger) {
      this.setDecision({ action: "monitor", reason: trigger.reason, edgeProgress: trigger.edgeProgress, gate });
      return;
    }

    if (!gate.allowed) {
      this.setDecision({ action: "skipped", reason: trigger.reason, gate });
      return;
    }

    if (this.settings.venue === "uniswapv3") {
      this.setDecision({
        action: "skipped",
        reason: trigger.reason,
        note: "uniswapv3 execution path is intentionally read-only in this version",
      });
      return;
    }

    await this.rebalanceSlipstream(primary);
    this.ensureDailyCounter();
    this.state.rebalancesToday = Number(this.state.rebalancesToday || 0) + 1;
    this.state.lastRebalanceAt = nowIso();
    this.setDecision({ action: "rebalanced", reason: trigger.reason, venue: "slipstream" });
  }

  async loopOnce() {
    this.ensureDailyCounter();
    await this.loadSettings(false);
    const snapshots = await this.refreshSnapshots();
    await this.reconcilePositionFromChain();

    const tokenId = this.state.position?.tokenId;
    if (tokenId && this.state.position?.tickLower != null && this.state.position?.tickUpper != null) {
      const tick = snapshots.primary.tick;
      this.state.position.inRange = tick > this.state.position.tickLower && tick < this.state.position.tickUpper;
    }

    await this.evaluateAndAct();
    this.state.lastError = null;
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

    return {
      ok: true,
      ts: nowIso(),
      version: VERSION,
      account: this.account.address,
      tradingEnabled: this.settings.tradingEnabled && !this.settings.killSwitch,
      killSwitch: Boolean(this.settings.killSwitch),
      settings: this.settings,
      market: {
        primary: latest.primary,
        fallback: latest.fallback,
      },
      wallet: latest.wallet,
      position: this.state.position,
      counters: {
        dayKey: this.state.dayKey,
        rebalancesToday: this.state.rebalancesToday,
        lastRebalanceAt: this.state.lastRebalanceAt,
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
