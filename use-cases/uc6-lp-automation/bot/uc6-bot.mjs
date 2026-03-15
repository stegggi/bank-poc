import http from "node:http";
import process from "node:process";
import path from "node:path";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
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
import { createRegimeState, estimateOU, getRegimeAdvice, ingestSample } from "./lib/regime.mjs";
import { redactSensitiveText, safeBearerMatch, sanitizeErrorMessage } from "./lib/security.mjs";
import {
  AERO_ADDRESS,
  VOTER_ADDRESS,
  resolveGauge,
  isAutoStakeEligible,
  checkStakedOnChain,
  readEmissionsMetrics,
  fetchAeroPrice,
  stakeNft,
  unstakeNft,
  claimRewards as claimAeroRewards,
  invalidateGaugeCache,
} from "./lib/emissions.mjs";
import {
  loadPoolComparisonCache as loadPoolComparisonCacheFile,
  runPoolComparisonJob,
} from "./lib/pool_compare/job.mjs";

const VERSION = "uc6-lp-bot/0.1";
const USDC_DECIMALS = 6;
const WETH_DECIMALS = 18;
const Q96 = 2n ** 96n;
const UINT128_MAX = (2n ** 128n) - 1n;
const EVENT_RING_LIMIT = 5;
const ACCOUNTING_EVENT_LIMIT = 5000;
const MIN_IDLE_TOPUP_USD = 1;
const USDC_RESERVE_GUARD_RAW = BigInt(250000); // 0.25 USDC safety buffer above reserve target
const CAPITAL_SAMPLE_MIN_INTERVAL_MS = 5 * 60 * 1000;
const CAPITAL_SAMPLE_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;
const CAPITAL_SAMPLE_MAX_GAP_MS = 30 * 60 * 1000;
const CAPITAL_SAMPLE_MAX_POINTS = 15_000;
const ENTRY_SNAPSHOT_FALLBACK_WINDOW_MS = 5 * 60 * 1000;
const LAST_ERROR_AUTO_CLEAR_AFTER_MS = 5 * 60 * 1000;
const LAST_ERROR_AUTO_CLEAR_SUCCESS_LOOPS = 5;
const HTTP_JSON_MAX_BYTES = 64 * 1024;
const HTTP_SERVER_REQUEST_TIMEOUT_MS = 15_000;
const HTTP_SERVER_HEADERS_TIMEOUT_MS = 16_000;
const HTTP_SERVER_KEEPALIVE_TIMEOUT_MS = 5_000;

const ENV = {
  rpcUrl: process.env.UC6_RPC_URL || "",
  httpInfuraUrl: process.env.UC6_HTTP_INFURA_URL || "",
  httpAnkrUrl: process.env.UC6_HTTP_ANKR_URL || "",
  httpAlchemyUrl: process.env.UC6_HTTP_ALCHEMY_URL || "",
  httpPublicUrl: process.env.UC6_HTTP_PUBLIC_URL || "https://mainnet.base.org",
  wsAnkrUrl: process.env.UC6_WS_ANKR_URL || "",
  wsPublicUrl: process.env.UC6_WS_PUBLIC_URL || "wss://mainnet.base.org",
  wsAlchemyUrl: process.env.UC6_WS_ALCHEMY_URL || "",
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
const POSITION_EVENTS_PATH = path.join(ENV.dataDir, "events.jsonl");
const POSITION_RECORDS_PATH = path.join(ENV.dataDir, "positions.json");
const POOL_RANKINGS_PATH = path.join(ENV.dataDir, "pool_rankings.json");
const POOL_TVL_HISTORY_PATH = path.join(ENV.dataDir, "pool_tvl_history.jsonl");
const POSITION_SUMMARY_LIMIT = 20;
const POSITION_PAGE_SIZE_DEFAULT = 10;
const POSITION_PAGE_SIZE_MAX = 100;
const REGIME_WARN_MIN_INTERVAL_MS = 60_000;
const POOL_COMPARISON_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const POOL_COMPARISON_STALE_MS = 24 * 60 * 60 * 1000;
const TX_LOOKUP_PROVIDER_PREFERENCE = ["ankr_http", "base_public_http", "infura_http", "alchemy_http"];
const INFURA_DAILY_RETRY_HOUR_UTC = 5;
const MULTICALL_BATCH_SIZE = 50;
const TOP_UP_FAILURE_COOLDOWN_SEC = 60;

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
  {
    name: "feeGrowthGlobal0X128",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "feeGrowthGlobal1X128",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    // Slipstream CLPool ticks() — has extra stakedLiquidityNet + rewardGrowthOutsideX128 vs Uniswap V3.
    name: "ticks",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tick", type: "int24" }],
    outputs: [
      { name: "liquidityGross", type: "uint128" },
      { name: "liquidityNet", type: "int128" },
      { name: "stakedLiquidityNet", type: "int128" },
      { name: "feeGrowthOutside0X128", type: "uint256" },
      { name: "feeGrowthOutside1X128", type: "uint256" },
      { name: "rewardGrowthOutsideX128", type: "uint256" },
      { name: "tickCumulativeOutside", type: "int56" },
      { name: "secondsPerLiquidityOutsideX128", type: "uint160" },
      { name: "secondsOutside", type: "uint32" },
      { name: "initialized", type: "bool" },
    ],
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
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "tokenOfOwnerByIndex",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
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
  {
    name: "multicall",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
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

const NPM_INCREASE_LIQUIDITY_ABI = [
  {
    name: "increaseLiquidity",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "amount0Desired", type: "uint256" },
          { name: "amount1Desired", type: "uint256" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
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

const WETH_WRAPPER_ABI = [
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
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

const ERC20_TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
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
  minRebalanceIntervalSec: 7200,
  maxRebalancesPerDay: 20,
  slippageBps: 30,
  pollIntervalMs: 2000,
  wsEnabled: true,
  slot0RefreshEverySec: 20,
  balancesRefreshEverySec: 120,
  positionRefreshEverySec: 180,
  inventoryRefreshEverySec: 900,
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
  churnProtectionEnabled: false,
  churnMaxCostToFeeRatio: 0.4,
  regime: {
    enabled: false,
    windowSec: 1800,
    sampleEverySec: 12,
    minSamples: 60,
    fastWindowSec: 300,
    fastSampleEverySec: 6,
    fastMinSamples: 30,
    fastWeight: 0.4,
    mrHalfLifeMaxSec: 180,
    trendHalfLifeMinSec: 900,
    maxEdgeAdj: 0.1,
    maxBandAdjBps: 50,
    maxBandNarrowBps: 20,
    maxCooldownAdjSec: 900,
  },
  hodlGate: {
    enabled: true,
    marginUsd: 0.1,
    useUncollectedFees: true,
    allowCloseIfOutOfRange: true,
    outOfRangeMaxSec: 900,
    outOfRangeEmergencyMinSec: 60,
    outOfRangeEmergencyEdgePct: 1.15,
  },
  trendEscape: {
    enabled: true,
    variant: "hybrid",
    requireRegimeLabel: "trending",
    minRegimeConfidence: 0.6,
    directionLookbackSec: 600,
    minTrendMovePct: 0.004,
    minTrendConfirmSec: 120,
    cooldownAfterEscapeSec: 3600,
    minAlphaUsdToEscape: 0,
    emergencyOutOfRangeEdgePct: 1.15,
    emergencyMinOutOfRangeSec: 120,
    uptrendHold: "WETH",
    downtrendHold: "USDC",
    fallbackHold: "50_50",
  },
  reEntry: {
    enabled: true,
    requireRegimeLabel: "mean_reverting",
    minRegimeConfidence: 0.6,
    minMeanRevertConfirmSec: 300,
    maxDistanceFromMuPct: 0.006,
    minHoldSec: 900,
    cooldownAfterReEntrySec: 1800,
  },
  executionCaps: {
    maxInventorySwapsPerRebalance: 2,
    maxSwapsOnOpen: 1,
    maxTopUpsPerCycle: 1,
    minTopUpUsd: 5,
    targetRatioTolerancePct: 0.1,
    minSwapUsd: 5,
    useMulticallClose: false,
  },
  gasTopUp: {
    enabled: true,
    minEthUsd: 5,
    topUpUsdc: 5,
    minIntervalSec: 1800,
  },
  poolComparison: {
    enabled: true,
    computeHourUtc: 8,
    maxCandidatesPerDex: 50,
    topN: 5,
    minTvlUsd: 2_000_000,
    maxRefCapitalPctOfTvl: 0.0025,
    requireFeeRateInference: true,
    allowLowTvlInTable: true,
    rebalanceSwapNotionalPct: 0.1,
  },
  emissions: {
    enabled: true,
    autoStakeOnMint: true,
    autoUnstakeOnRebalance: true,
    autoClaim: false,
    claimMinUsd: 2.0,
    claimCooldownSec: 21600,
    approvalMode: "approve_token",
    voterAddress: VOTER_ADDRESS,
    gaugeOverrideByPool: {},
    priceSource: {
      provider: "geckoterminal",
      tokenNetwork: "base",
      refreshSec: 900,
    },
  },
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

function chunkArray(items, size) {
  const out = [];
  const arr = Array.isArray(items) ? items : [];
  const chunkSize = Math.max(1, Math.floor(Number(size || 1)));
  for (let i = 0; i < arr.length; i += chunkSize) {
    out.push(arr.slice(i, i + chunkSize));
  }
  return out;
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
  const baseRegime = baseSettings.regime && typeof baseSettings.regime === "object" ? baseSettings.regime : DEFAULT_SETTINGS.regime;
  const srcRegime = src.regime && typeof src.regime === "object" ? src.regime : {};
  const baseHodlGate =
    baseSettings.hodlGate && typeof baseSettings.hodlGate === "object"
      ? baseSettings.hodlGate
      : DEFAULT_SETTINGS.hodlGate;
  const srcHodlGate = src.hodlGate && typeof src.hodlGate === "object" ? src.hodlGate : {};
  const baseTrendEscape =
    baseSettings.trendEscape && typeof baseSettings.trendEscape === "object"
      ? baseSettings.trendEscape
      : DEFAULT_SETTINGS.trendEscape;
  const srcTrendEscape = src.trendEscape && typeof src.trendEscape === "object" ? src.trendEscape : {};
  const baseReEntry =
    baseSettings.reEntry && typeof baseSettings.reEntry === "object"
      ? baseSettings.reEntry
      : DEFAULT_SETTINGS.reEntry;
  const srcReEntry = src.reEntry && typeof src.reEntry === "object" ? src.reEntry : {};
  const baseExecutionCaps =
    baseSettings.executionCaps && typeof baseSettings.executionCaps === "object"
      ? baseSettings.executionCaps
      : DEFAULT_SETTINGS.executionCaps;
  const srcExecutionCaps = src.executionCaps && typeof src.executionCaps === "object" ? src.executionCaps : {};
  const baseGasTopUp =
    baseSettings.gasTopUp && typeof baseSettings.gasTopUp === "object"
      ? baseSettings.gasTopUp
      : DEFAULT_SETTINGS.gasTopUp;
  const srcGasTopUp = src.gasTopUp && typeof src.gasTopUp === "object" ? src.gasTopUp : {};
  const basePoolComparison =
    baseSettings.poolComparison && typeof baseSettings.poolComparison === "object"
      ? baseSettings.poolComparison
      : DEFAULT_SETTINGS.poolComparison;
  const srcPoolComparison = src.poolComparison && typeof src.poolComparison === "object" ? src.poolComparison : {};
  const baseEmissions =
    baseSettings.emissions && typeof baseSettings.emissions === "object"
      ? baseSettings.emissions
      : DEFAULT_SETTINGS.emissions;
  const srcEmissions = src.emissions && typeof src.emissions === "object" ? src.emissions : {};
  const basePriceSource =
    baseEmissions.priceSource && typeof baseEmissions.priceSource === "object"
      ? baseEmissions.priceSource
      : DEFAULT_SETTINGS.emissions.priceSource;
  const srcPriceSource = srcEmissions.priceSource && typeof srcEmissions.priceSource === "object" ? srcEmissions.priceSource : {};
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
    wsEnabled: toBool(src.wsEnabled, baseSettings.wsEnabled),
    slot0RefreshEverySec: clamp(
      Math.round(toNumber(src.slot0RefreshEverySec, baseSettings.slot0RefreshEverySec)),
      2,
      3600
    ),
    balancesRefreshEverySec: clamp(
      Math.round(toNumber(src.balancesRefreshEverySec, baseSettings.balancesRefreshEverySec)),
      2,
      3600
    ),
    positionRefreshEverySec: clamp(
      Math.round(toNumber(src.positionRefreshEverySec, baseSettings.positionRefreshEverySec)),
      2,
      3600
    ),
    inventoryRefreshEverySec: clamp(
      Math.round(toNumber(src.inventoryRefreshEverySec, baseSettings.inventoryRefreshEverySec)),
      5,
      86400
    ),
    collectableRefreshEverySec: clamp(
      Math.round(toNumber(src.collectableRefreshEverySec, baseSettings.collectableRefreshEverySec)),
      10,
      86400
    ),
    dashboardRecommendedPollMs: clamp(
      Math.round(toNumber(src.dashboardRecommendedPollMs, baseSettings.dashboardRecommendedPollMs)),
      1000,
      60000
    ),
    maxDeployUsdc: clamp(toNumber(src.maxDeployUsdc, baseSettings.maxDeployUsdc), 0, 5_000_000),
    maxInitialMintUsdc: clamp(
      toNumber(src.maxInitialMintUsdc, baseSettings.maxInitialMintUsdc),
      0,
      5_000_000
    ),
    minTopUpUsd: clamp(toNumber(src.minTopUpUsd, baseSettings.minTopUpUsd), 0, 1_000_000),
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
    regime: {
      enabled: toBool(srcRegime.enabled ?? src.regimeEnabled, baseRegime.enabled),
      windowSec: clamp(
        Math.round(toNumber(srcRegime.windowSec ?? src.regimeWindowSec, baseRegime.windowSec)),
        60,
        86_400
      ),
      sampleEverySec: clamp(
        Math.round(toNumber(srcRegime.sampleEverySec ?? src.regimeSampleEverySec, baseRegime.sampleEverySec)),
        1,
        3_600
      ),
      minSamples: clamp(
        Math.round(toNumber(srcRegime.minSamples ?? src.regimeMinSamples, baseRegime.minSamples)),
        5,
        20_000
      ),
      mrHalfLifeMaxSec: clamp(
        Math.round(toNumber(srcRegime.mrHalfLifeMaxSec ?? src.regimeMrHalfLifeMaxSec, baseRegime.mrHalfLifeMaxSec)),
        10,
        86_400
      ),
      trendHalfLifeMinSec: clamp(
        Math.round(
          toNumber(srcRegime.trendHalfLifeMinSec ?? src.regimeTrendHalfLifeMinSec, baseRegime.trendHalfLifeMinSec)
        ),
        10,
        86_400
      ),
      maxEdgeAdj: clamp(toNumber(srcRegime.maxEdgeAdj ?? src.regimeMaxEdgeAdj, baseRegime.maxEdgeAdj), 0, 0.5),
      maxBandAdjBps: clamp(
        Math.round(toNumber(srcRegime.maxBandAdjBps ?? src.regimeMaxBandAdjBps, baseRegime.maxBandAdjBps)),
        0,
        500
      ),
      maxCooldownAdjSec: clamp(
        Math.round(
          toNumber(srcRegime.maxCooldownAdjSec ?? src.regimeMaxCooldownAdjSec, baseRegime.maxCooldownAdjSec)
        ),
        0,
        86_400
      ),
    },
    hodlGate: {
      enabled: toBool(srcHodlGate.enabled, baseHodlGate.enabled),
      marginUsd: clamp(toNumber(srcHodlGate.marginUsd, baseHodlGate.marginUsd), 0, 1_000_000),
      useUncollectedFees: toBool(srcHodlGate.useUncollectedFees, baseHodlGate.useUncollectedFees),
      allowCloseIfOutOfRange: toBool(srcHodlGate.allowCloseIfOutOfRange, baseHodlGate.allowCloseIfOutOfRange),
      outOfRangeMaxSec: clamp(
        Math.round(toNumber(srcHodlGate.outOfRangeMaxSec, baseHodlGate.outOfRangeMaxSec)),
        30,
        7 * 24 * 60 * 60
      ),
      outOfRangeEmergencyMinSec: clamp(
        Math.round(toNumber(srcHodlGate.outOfRangeEmergencyMinSec, baseHodlGate.outOfRangeEmergencyMinSec)),
        5,
        7 * 24 * 60 * 60
      ),
      outOfRangeEmergencyEdgePct: clamp(
        toNumber(srcHodlGate.outOfRangeEmergencyEdgePct, baseHodlGate.outOfRangeEmergencyEdgePct),
        1,
        5
      ),
    },
    trendEscape: {
      enabled: toBool(srcTrendEscape.enabled, baseTrendEscape.enabled),
      variant: "hybrid",
      requireRegimeLabel:
        srcTrendEscape.requireRegimeLabel === "mean_reverting" ? "mean_reverting" : "trending",
      minRegimeConfidence: clamp(
        toNumber(srcTrendEscape.minRegimeConfidence, baseTrendEscape.minRegimeConfidence),
        0,
        1
      ),
      directionLookbackSec: clamp(
        Math.round(toNumber(srcTrendEscape.directionLookbackSec, baseTrendEscape.directionLookbackSec)),
        30,
        86_400
      ),
      minTrendMovePct: clamp(
        toNumber(srcTrendEscape.minTrendMovePct, baseTrendEscape.minTrendMovePct),
        0,
        1
      ),
      minTrendConfirmSec: clamp(
        Math.round(toNumber(srcTrendEscape.minTrendConfirmSec, baseTrendEscape.minTrendConfirmSec)),
        5,
        86_400
      ),
      cooldownAfterEscapeSec: clamp(
        Math.round(toNumber(srcTrendEscape.cooldownAfterEscapeSec, baseTrendEscape.cooldownAfterEscapeSec)),
        0,
        7 * 24 * 60 * 60
      ),
      minAlphaUsdToEscape: clamp(
        toNumber(srcTrendEscape.minAlphaUsdToEscape, baseTrendEscape.minAlphaUsdToEscape),
        -1_000_000,
        1_000_000
      ),
      emergencyOutOfRangeEdgePct: clamp(
        toNumber(srcTrendEscape.emergencyOutOfRangeEdgePct, baseTrendEscape.emergencyOutOfRangeEdgePct),
        1,
        5
      ),
      emergencyMinOutOfRangeSec: clamp(
        Math.round(toNumber(srcTrendEscape.emergencyMinOutOfRangeSec, baseTrendEscape.emergencyMinOutOfRangeSec)),
        5,
        7 * 24 * 60 * 60
      ),
      uptrendHold:
        srcTrendEscape.uptrendHold === "USDC"
          ? "USDC"
          : srcTrendEscape.uptrendHold === "50_50"
            ? "50_50"
            : "WETH",
      downtrendHold:
        srcTrendEscape.downtrendHold === "WETH"
          ? "WETH"
          : srcTrendEscape.downtrendHold === "50_50"
            ? "50_50"
            : "USDC",
      fallbackHold:
        srcTrendEscape.fallbackHold === "WETH"
          ? "WETH"
          : srcTrendEscape.fallbackHold === "USDC"
            ? "USDC"
            : "50_50",
    },
    reEntry: {
      enabled: toBool(srcReEntry.enabled, baseReEntry.enabled),
      requireRegimeLabel:
        srcReEntry.requireRegimeLabel === "trending" ? "trending" : "mean_reverting",
      minRegimeConfidence: clamp(
        toNumber(srcReEntry.minRegimeConfidence, baseReEntry.minRegimeConfidence),
        0,
        1
      ),
      minMeanRevertConfirmSec: clamp(
        Math.round(toNumber(srcReEntry.minMeanRevertConfirmSec, baseReEntry.minMeanRevertConfirmSec)),
        5,
        86_400
      ),
      maxDistanceFromMuPct: clamp(
        toNumber(srcReEntry.maxDistanceFromMuPct, baseReEntry.maxDistanceFromMuPct),
        0,
        1
      ),
      minHoldSec: clamp(
        Math.round(toNumber(srcReEntry.minHoldSec, baseReEntry.minHoldSec)),
        0,
        7 * 24 * 60 * 60
      ),
      cooldownAfterReEntrySec: clamp(
        Math.round(toNumber(srcReEntry.cooldownAfterReEntrySec, baseReEntry.cooldownAfterReEntrySec)),
        0,
        7 * 24 * 60 * 60
      ),
    },
    executionCaps: {
      maxInventorySwapsPerRebalance: clamp(
        Math.round(
          toNumber(srcExecutionCaps.maxInventorySwapsPerRebalance, baseExecutionCaps.maxInventorySwapsPerRebalance)
        ),
        0,
        10
      ),
      maxSwapsOnOpen: clamp(
        Math.round(toNumber(srcExecutionCaps.maxSwapsOnOpen, baseExecutionCaps.maxSwapsOnOpen)),
        0,
        10
      ),
      maxTopUpsPerCycle: clamp(
        Math.round(toNumber(srcExecutionCaps.maxTopUpsPerCycle, baseExecutionCaps.maxTopUpsPerCycle)),
        0,
        20
      ),
      minTopUpUsd: clamp(toNumber(srcExecutionCaps.minTopUpUsd, baseExecutionCaps.minTopUpUsd), 0, 1_000_000),
      targetRatioTolerancePct: clamp(
        toNumber(srcExecutionCaps.targetRatioTolerancePct, baseExecutionCaps.targetRatioTolerancePct),
        0.001,
        0.5
      ),
      minSwapUsd: clamp(toNumber(srcExecutionCaps.minSwapUsd, baseExecutionCaps.minSwapUsd), 0, 1_000_000),
      useMulticallClose: toBool(srcExecutionCaps.useMulticallClose, baseExecutionCaps.useMulticallClose),
    },
    gasTopUp: {
      enabled: toBool(srcGasTopUp.enabled, baseGasTopUp.enabled),
      minEthUsd: clamp(toNumber(srcGasTopUp.minEthUsd, baseGasTopUp.minEthUsd), 0, 1_000_000),
      topUpUsdc: clamp(toNumber(srcGasTopUp.topUpUsdc, baseGasTopUp.topUpUsdc), 0.01, 1_000_000),
      minIntervalSec: clamp(
        Math.round(toNumber(srcGasTopUp.minIntervalSec, baseGasTopUp.minIntervalSec)),
        30,
        86_400
      ),
    },
    poolComparison: {
      enabled: toBool(srcPoolComparison.enabled, basePoolComparison.enabled),
      computeHourUtc: clamp(
        Math.round(toNumber(srcPoolComparison.computeHourUtc, basePoolComparison.computeHourUtc)),
        0,
        23
      ),
      maxCandidatesPerDex: clamp(
        Math.round(toNumber(srcPoolComparison.maxCandidatesPerDex, basePoolComparison.maxCandidatesPerDex)),
        5,
        100
      ),
      topN: clamp(Math.round(toNumber(srcPoolComparison.topN, basePoolComparison.topN)), 1, 20),
      minTvlUsd: clamp(toNumber(srcPoolComparison.minTvlUsd, basePoolComparison.minTvlUsd), 0, 1_000_000_000),
      maxRefCapitalPctOfTvl: clamp(
        toNumber(srcPoolComparison.maxRefCapitalPctOfTvl, basePoolComparison.maxRefCapitalPctOfTvl),
        0,
        1
      ),
      requireFeeRateInference: toBool(
        srcPoolComparison.requireFeeRateInference,
        basePoolComparison.requireFeeRateInference
      ),
      allowLowTvlInTable: toBool(srcPoolComparison.allowLowTvlInTable, basePoolComparison.allowLowTvlInTable),
      rebalanceSwapNotionalPct: clamp(
        toNumber(srcPoolComparison.rebalanceSwapNotionalPct, basePoolComparison.rebalanceSwapNotionalPct),
        0,
        1
      ),
    },
    emissions: {
      enabled: toBool(srcEmissions.enabled, baseEmissions.enabled),
      autoStakeOnMint: toBool(srcEmissions.autoStakeOnMint, baseEmissions.autoStakeOnMint),
      autoUnstakeOnRebalance: toBool(srcEmissions.autoUnstakeOnRebalance, baseEmissions.autoUnstakeOnRebalance),
      autoClaim: toBool(srcEmissions.autoClaim, baseEmissions.autoClaim),
      claimMinUsd: clamp(toNumber(srcEmissions.claimMinUsd, baseEmissions.claimMinUsd), 0, 1_000_000),
      claimCooldownSec: clamp(
        Math.round(toNumber(srcEmissions.claimCooldownSec, baseEmissions.claimCooldownSec)),
        0,
        604_800
      ),
      approvalMode:
        srcEmissions.approvalMode === "approve_for_all"
          ? "approve_for_all"
          : "approve_token",
      voterAddress: typeof srcEmissions.voterAddress === "string" && srcEmissions.voterAddress.startsWith("0x")
        ? srcEmissions.voterAddress
        : baseEmissions.voterAddress,
      gaugeOverrideByPool:
        srcEmissions.gaugeOverrideByPool && typeof srcEmissions.gaugeOverrideByPool === "object"
          ? srcEmissions.gaugeOverrideByPool
          : baseEmissions.gaugeOverrideByPool,
      priceSource: {
        provider: typeof srcPriceSource.provider === "string" ? srcPriceSource.provider : basePriceSource.provider,
        tokenNetwork: typeof srcPriceSource.tokenNetwork === "string" ? srcPriceSource.tokenNetwork : basePriceSource.tokenNetwork,
        refreshSec: clamp(
          Math.round(toNumber(srcPriceSource.refreshSec, basePriceSource.refreshSec)),
          60,
          86_400
        ),
      },
    },
  };
  if (out.regime.trendHalfLifeMinSec <= out.regime.mrHalfLifeMaxSec) {
    out.regime.trendHalfLifeMinSec = out.regime.mrHalfLifeMaxSec + 1;
  }
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
    outOfRangeSinceIso: null,
    lastGasTopUpAttemptAt: null,
    lastGasTopUpSuccessAt: null,
    lastGasTopUpSkipReason: null,
    activePositionRunId: null,
    strategyMode: "LP_ACTIVE",
    holdStartedAtIso: null,
    escapeCooldownUntilIso: null,
    reEntryCooldownUntilIso: null,
    trendingSinceIso: null,
    meanRevertingSinceIso: null,
    topUpRetryAfterIso: null,
    pendingEntrySnapshot: null,
    pendingCompoundUsd: 0,
    rangeStats: {
      sinceIso: nowIso(),
      lastSampleAtIso: null,
      eligibleMs: 0,
      inRangeMs: 0,
    },
    capitalStats: {
      sinceIso: nowIso(),
      lastSampleAtIso: null,
      samples: [],
    },
    position: {
      venue: "slipstream",
      tokenId: null,
      bandHalfBps: null,
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
      positionInventory: null,
      regime: null,
      regimeDecision: null,
      refresh: {},
    },
    emissions: {
      gaugeAddress: null,
      gaugeAlive: null,
      gaugeMeta: null,
      staked: false,
      stakedTokenId: null,
      lastStakeAtIso: null,
      lastUnstakeAtIso: null,
      lastClaimAtIso: null,
      autoStakeEligible: null,
      autoStakeBlockedReason: null,
      aeroPrice: null,
      rewardToken: null,
      claimable: null,
      walletAero: null,
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

async function appendJsonLineAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const line = `${JSON.stringify(value)}\n`;
  await fsp.appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
}

async function readJsonLinesIfExists(filePath) {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    if (!text || !text.trim()) return [];
    const lines = text.split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      if (!line || !line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // ignore malformed lines in append-only journal
      }
    }
    return out;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }
}

function humanDurationFromSeconds(totalSec) {
  const s = Math.max(0, Math.round(Number(totalSec || 0)));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return `${s}s`;
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
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.end(JSON.stringify(payload));
}

function unauthorized(res) {
  return jsonResponse(res, 401, { error: "Unauthorized" });
}

function tooMany(res, retryAfterSec) {
  res.setHeader("retry-after", String(retryAfterSec));
  return jsonResponse(res, 429, { error: "Too many requests" });
}

function requestErrorStatus(message) {
  if (String(message || "").toLowerCase().includes("too large")) return 413;
  return 400;
}

async function readJsonBody(req, maxBytes = HTTP_JSON_MAX_BYTES) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const contentLength = Number(req.headers["content-length"] || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      reject(new Error("Request body too large"));
      req.destroy();
      return;
    }
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

function isRpc429Error(err) {
  const msg = err instanceof Error ? err.message : String(err || "");
  return msg.includes("Status: 429") || /Too Many Requests/i.test(msg);
}

function isInfuraDailyLimitError(err) {
  const msg = err instanceof Error ? err.message : String(err || "");
  return /daily/i.test(msg) && /(limit|credit|request)/i.test(msg);
}

function nextUtcHourMs(targetHourUtc) {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(targetHourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime();
}

function withTimeout(promise, ms, label = "rpc call") {
  if (!ms || ms <= 0) return promise;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

class HttpProviderPool {
  constructor({ account, chain, providers }) {
    this.account = account;
    this.chain = chain;
    this.providers = providers
      .filter((p) => p && p.url)
      .map((p, idx) => ({
        name: p.name,
        url: p.url,
        priority: idx,
        publicClient: createPublicClient({ chain, transport: viemHttp(p.url, { timeout: 12_000 }) }),
        walletClient: createWalletClient({ account, chain, transport: viemHttp(p.url, { timeout: 20_000 }) }),
        failCount: 0,
        successStreak: 0,
        cooldownUntilMs: 0,
        lastError: null,
        last429AtIso: null,
      }));
    this.activeIndex = 0;
    this.failThreshold = 2;
    this.cooldownMs = 120_000;
    this.promoteSuccessThreshold = 5;
    this.minRequestGapMs = this.providers.some((p) => p.name === "infura_http") ? 200 : 0;
    this.nextRequestAtMs = 0;
  }

  hasProviders() {
    return Array.isArray(this.providers) && this.providers.length > 0;
  }

  getActive() {
    if (!this.hasProviders()) return null;
    return this.providers[this.activeIndex] || this.providers[0];
  }

  snapshotStatus() {
    const now = Date.now();
    const active = this.getActive();
    return {
      active: active ? active.name : null,
      providers: this.providers.map((p) => ({
        name: p.name,
        active: active ? p.name === active.name : false,
        cooldownRemainingSec: p.cooldownUntilMs > now ? Math.ceil((p.cooldownUntilMs - now) / 1000) : 0,
        failCount: p.failCount,
        successStreak: p.successStreak,
        lastError: p.lastError,
        last429AtIso: p.last429AtIso,
      })),
    };
  }

  markSuccess(provider) {
    if (!provider) return;
    provider.failCount = 0;
    provider.successStreak += 1;
    provider.lastError = null;
    provider.cooldownUntilMs = 0;
    if (provider.priority === 0) return;
    const primary = this.providers[0];
    if (provider.successStreak >= this.promoteSuccessThreshold && primary && primary.cooldownUntilMs <= Date.now()) {
      this.activeIndex = 0;
    }
  }

  markFailure(provider, err) {
    if (!provider) return;
    provider.failCount += 1;
    provider.successStreak = 0;
    provider.lastError = err instanceof Error ? err.message : String(err || "unknown");
    if (isRpc429Error(err)) provider.last429AtIso = nowIso();
    if (provider.name === "infura_http" && (isRpc429Error(err) || isInfuraDailyLimitError(err))) {
      provider.cooldownUntilMs = nextUtcHourMs(INFURA_DAILY_RETRY_HOUR_UTC);
      return;
    }
    if (provider.failCount >= this.failThreshold) {
      provider.cooldownUntilMs = Date.now() + this.cooldownMs;
    }
  }

  chooseIndexes(preferredNames = null) {
    const count = this.providers.length;
    const now = Date.now();
    const baseOrder = [];
    if (Array.isArray(preferredNames) && preferredNames.length > 0) {
      for (const name of preferredNames) {
        const idx = this.providers.findIndex((p) => p.name === name);
        if (idx >= 0 && !baseOrder.includes(idx)) baseOrder.push(idx);
      }
    }
    for (let offset = 0; offset < count; offset += 1) {
      const idx = (this.activeIndex + offset) % count;
      if (!baseOrder.includes(idx)) baseOrder.push(idx);
    }

    const out = [];
    for (let orderPos = 0; orderPos < baseOrder.length; orderPos += 1) {
      const idx = baseOrder[orderPos];
      const p = this.providers[idx];
      if (p.cooldownUntilMs > now && orderPos !== baseOrder.length - 1) continue;
      out.push(idx);
    }
    if (out.length === 0 && count > 0) out.push(this.activeIndex);
    return out;
  }

  async waitForRateSlot() {
    if (!(this.minRequestGapMs > 0)) return;
    const now = Date.now();
    const waitMs = Math.max(0, this.nextRequestAtMs - now);
    this.nextRequestAtMs = Math.max(now, this.nextRequestAtMs) + this.minRequestGapMs;
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }

  async invoke(kind, fn, { timeoutMs = 8_000, retries = 1, preferredNames = null } = {}) {
    if (!this.hasProviders()) throw new Error("No HTTP RPC providers configured");
    let lastErr = null;
    const indexes = this.chooseIndexes(preferredNames);
    for (const idx of indexes) {
      const provider = this.providers[idx];
      const attempts = Math.max(1, retries);
      for (let i = 0; i < attempts; i += 1) {
        try {
          await this.waitForRateSlot();
          const res = await withTimeout(fn(provider), timeoutMs, `${kind} via ${provider.name}`);
          this.activeIndex = idx;
          this.markSuccess(provider);
          return res;
        } catch (err) {
          lastErr = err;
          this.markFailure(provider, err);
          if (i + 1 < attempts) {
            await sleep(150 + Math.floor(Math.random() * 250));
          }
        }
      }
    }
    throw lastErr || new Error(`${kind} failed on all HTTP providers`);
  }
}

class WsHeadWatcher {
  constructor(providers = []) {
    this.providers = providers.filter((p) => p && p.url);
    this.activeIndex = 0;
    this.ws = null;
    this.connected = false;
    this.subscriptionId = null;
    this.nextId = 1;
    this.reconnectTimer = null;
    this.stop = false;
    this.lastHeadBlock = null;
    this.lastHeadAtIso = null;
    this.headSeen = false;
    this.lastError = null;
  }

  status() {
    const active = this.providers[this.activeIndex] || null;
    return {
      enabled: this.providers.length > 0,
      connected: this.connected,
      active: active?.name || null,
      lastHeadBlock: this.lastHeadBlock,
      lastHeadAtIso: this.lastHeadAtIso,
      lastError: this.lastError,
    };
  }

  consumeHeadSeen() {
    const seen = this.headSeen;
    this.headSeen = false;
    return seen;
  }

  async start() {
    this.stop = false;
    if (this.providers.length === 0) return;
    this.connect();
  }

  async shutdown() {
    this.stop = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.close?.();
    } catch {}
    this.ws = null;
    this.connected = false;
    this.subscriptionId = null;
  }

  scheduleReconnect(delayMs = 2000) {
    if (this.stop) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.activeIndex = this.providers.length > 0 ? (this.activeIndex + 1) % this.providers.length : 0;
      this.connect();
    }, delayMs);
  }

  connect() {
    if (this.stop || this.providers.length === 0) return;
    const provider = this.providers[this.activeIndex];
    if (typeof WebSocket !== "function") {
      this.lastError = "WebSocket API not available in runtime";
      return;
    }
    try {
      this.ws = new WebSocket(provider.url);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err || "ws connect failed");
      this.scheduleReconnect(3000);
      return;
    }
    const ws = this.ws;
    ws.onopen = () => {
      this.connected = true;
      this.lastError = null;
      const req = {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "eth_subscribe",
        params: ["newHeads"],
      };
      ws.send(JSON.stringify(req));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        if (msg?.id && typeof msg.result === "string") {
          this.subscriptionId = msg.result;
          return;
        }
        if (msg?.method === "eth_subscription" && msg?.params?.subscription === this.subscriptionId) {
          const head = msg.params.result || {};
          const blockHex = head.number;
          if (typeof blockHex === "string") {
            const n = Number.parseInt(blockHex, 16);
            if (Number.isFinite(n)) this.lastHeadBlock = n;
          }
          this.lastHeadAtIso = nowIso();
          this.headSeen = true;
        }
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err || "ws message parse error");
      }
    };
    ws.onerror = () => {
      this.lastError = `ws error (${provider.name})`;
    };
    ws.onclose = () => {
      this.connected = false;
      this.subscriptionId = null;
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect(3000);
    };
  }
}

class Uc6Bot {
  constructor() {
    const hasExplicitHttpProviders = Boolean(
      ENV.httpInfuraUrl || ENV.httpAnkrUrl || ENV.httpAlchemyUrl || process.env.UC6_HTTP_PUBLIC_URL
    );
    const httpProviders = hasExplicitHttpProviders
      ? ENV.httpInfuraUrl
        ? [
            { name: "infura_http", url: ENV.httpInfuraUrl || "" },
            { name: "ankr_http", url: ENV.httpAnkrUrl || "" },
            { name: "base_public_http", url: ENV.httpPublicUrl || "" },
          ]
        : [
            { name: "ankr_http", url: ENV.httpAnkrUrl || "" },
            { name: "alchemy_http", url: ENV.httpAlchemyUrl || "" },
            { name: "base_public_http", url: ENV.httpPublicUrl || "" },
          ]
      : [
          { name: "legacy_http", url: ENV.rpcUrl || "" },
          { name: "base_public_http", url: ENV.httpPublicUrl || "" },
        ];
    const httpPrimaryUrl = (httpProviders.find((p) => p.url) || {}).url || "";
    if (!httpPrimaryUrl) {
      throw new Error("Missing UC6 HTTP RPC URL (UC6_HTTP_INFURA_URL, UC6_HTTP_ANKR_URL or UC6_RPC_URL)");
    }
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
    this.httpPool = new HttpProviderPool({
      account: this.account,
      chain: base,
      providers: httpProviders,
    });
    this.publicClient = {
      readContract: (args) => this.httpPool.invoke("readContract", (p) => p.publicClient.readContract(args), { timeoutMs: 8_000, retries: 2 }),
      multicall: (args) =>
        this.httpPool.invoke("multicall", (p) => p.publicClient.multicall(args), { timeoutMs: 12_000, retries: 2 }),
      simulateContract: (args) =>
        this.httpPool.invoke("simulateContract", (p) => p.publicClient.simulateContract(args), { timeoutMs: 12_000, retries: 2 }),
      getBalance: (args) => this.httpPool.invoke("getBalance", (p) => p.publicClient.getBalance(args), { timeoutMs: 8_000, retries: 2 }),
      getTransaction: (args) =>
        this.httpPool.invoke("getTransaction", (p) => p.publicClient.getTransaction(args), {
          timeoutMs: 8_000,
          retries: 2,
          preferredNames: TX_LOOKUP_PROVIDER_PREFERENCE,
        }),
      getTransactionReceipt: (args) =>
        this.httpPool.invoke("getTransactionReceipt", (p) => p.publicClient.getTransactionReceipt(args), {
          timeoutMs: 8_000,
          retries: 2,
          preferredNames: TX_LOOKUP_PROVIDER_PREFERENCE,
        }),
      waitForTransactionReceipt: (args) =>
        this.httpPool.invoke(
          "waitForTransactionReceipt",
          (p) => p.publicClient.waitForTransactionReceipt({ pollingInterval: 4_000, ...args }),
          { timeoutMs: 45_000, retries: 1, preferredNames: TX_LOOKUP_PROVIDER_PREFERENCE }
        ),
      getChainId: () => this.httpPool.invoke("getChainId", (p) => p.publicClient.getChainId(), { timeoutMs: 5_000, retries: 1 }),
    };
    this.walletClient = {
      writeContract: (args) =>
        this.httpPool.invoke("writeContract", (p) => p.walletClient.writeContract(args), { timeoutMs: 20_000, retries: 1 }),
    };
    this.wsHeadWatcher = new WsHeadWatcher([
      { name: "base_public_ws", url: ENV.wsPublicUrl || "" },
      { name: "alchemy_ws", url: ENV.wsAlchemyUrl || "" },
    ]);

    this.settings = { ...DEFAULT_SETTINGS };
    this.state = defaultState(this.account.address);
    this.settingsMtimeMs = 0;
    this.loopRunning = false;
    this.stopRequested = false;
    this.activeAction = null;
    this.lastLedgerRepairAtMs = 0;
    this.ledgerRepairInFlight = false;
    this.ledgerRepairDirty = true;
    this.ownerNonceUsed = new Map();
    this.ownerSettingsRateLimiter = new SimpleRateLimiter(10, 60_000);
    this.ownerActionRateLimiter = new SimpleRateLimiter(5, 60_000);
    this.publicStatusRateLimiter = new SimpleRateLimiter(240, 60_000);
    this.publicPositionsRateLimiter = new SimpleRateLimiter(60, 60_000);
    this.server = null;
    this.poolMetaCache = new Map();
    this.refreshClock = {
      slot0Ms: 0,
      balancesMs: 0,
      positionMs: 0,
      inventoryMs: 0,
      collectableMs: 0,
      heavyMs: 0,
    };
    this.positionLifecycleEvents = [];
    this.positionRecords = [];
    this.positionRecordsById = new Map();
    this.lifecycleCurrentTokenByRunId = new Map();
    this.lifecyclePendingOpenByRunId = new Map();
    this.pendingLifecycleContext = null;
    this.lifecyclePhaseContext = null;
    this.successfulLoopStreak = 0;
    this.lastSuccessfulLoopAtMs = 0;
    this.regimeState = null;
    this.regimeStateConfigKey = "";
    this.lastRegimeWarnAtMs = 0;
    this.poolComparisonCache = null;
    this.poolComparisonLastError = null;
    this.poolComparisonLastCheckAtMs = 0;
    this.poolComparisonJobPromise = null;
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
      await this.loadLifecycleStores();
    } catch (err) {
      this.positionLifecycleEvents = [];
      this.positionRecords = [];
      this.positionRecordsById = new Map();
      this.lifecycleCurrentTokenByRunId = new Map();
      this.lifecyclePendingOpenByRunId = new Map();
      this.setLastError(err);
    }

    try {
      await this.loadPoolComparisonCache();
    } catch (err) {
      this.poolComparisonCache = null;
      this.setPoolComparisonError(err);
    }

    try {
      if (this.settings.wsEnabled) await this.wsHeadWatcher.start();
      await this.refreshSnapshots({ forceSlot0: true, forceBalances: true, headSeen: true });
      await this.reconcilePositionFromChain();
      await this.syncStrategyModeInvariant();
    } catch (err) {
      this.setLastError(err);
    }

    // Reconcile emissions staking state with on-chain truth
    try {
      await this.reconcileEmissionsState();
    } catch (err) {
      console.warn("[UC6] [emissions] reconcile error on startup:", sanitizeErrorMessage(err));
    }

    this.resetRangeStatsSampler(Date.now());

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
    if (!this.state.emissions || typeof this.state.emissions !== "object") {
      this.state.emissions = { ...baseState.emissions };
    } else {
      this.state.emissions = {
        ...baseState.emissions,
        ...this.state.emissions,
      };
    }
    if (!Array.isArray(this.state.events)) this.state.events = [];
    if (!Array.isArray(this.state.ledgerEvents)) this.state.ledgerEvents = Array.isArray(this.state.events) ? [...this.state.events] : [];
    if (!this.state.rangeStats || typeof this.state.rangeStats !== "object") {
      this.state.rangeStats = { ...baseState.rangeStats };
    } else {
      this.state.rangeStats = {
        ...baseState.rangeStats,
        ...this.state.rangeStats,
      };
    }
    if (!this.state.capitalStats || typeof this.state.capitalStats !== "object") {
      this.state.capitalStats = { ...baseState.capitalStats };
    } else {
      this.state.capitalStats = {
        ...baseState.capitalStats,
        ...this.state.capitalStats,
      };
    }
    if (!Array.isArray(this.state.capitalStats.samples)) this.state.capitalStats.samples = [];
    if (this.state.events.length > EVENT_RING_LIMIT) {
      this.state.events = this.state.events.slice(-EVENT_RING_LIMIT);
    }
    if (this.state.ledgerEvents.length > ACCOUNTING_EVENT_LIMIT) {
      this.state.ledgerEvents = this.state.ledgerEvents.slice(-ACCOUNTING_EVENT_LIMIT);
    }
    if (this.state.capitalStats.samples.length > CAPITAL_SAMPLE_MAX_POINTS) {
      this.state.capitalStats.samples = this.state.capitalStats.samples.slice(-CAPITAL_SAMPLE_MAX_POINTS);
    }
  }

  async persistState() {
    this.state.updatedAt = nowIso();
    await writeJsonAtomic(STATE_PATH, this.state);
  }

  async reconcileEmissionsState() {
    if (!this.settings.emissions?.enabled) return;
    const em = this.state.emissions;
    if (!em) return;
    const tokenId = em.stakedTokenId || this.state.position?.tokenId;
    if (!tokenId) return;
    const gaugeAddr = em.gaugeAddress;
    if (!gaugeAddr) {
      if (em.staked) {
        console.log("[UC6] [emissions] state says staked but no gaugeAddress — clearing staked flag");
        em.staked = false;
        em.stakedTokenId = null;
      }
      return;
    }
    const onChainStaked = await checkStakedOnChain(
      this.publicClient,
      gaugeAddr,
      this.account.address,
      tokenId,
    );
    if (em.staked && !onChainStaked) {
      console.log(`[UC6] [emissions] state says staked but chain says NOT staked (tokenId=${tokenId}) — fixing`);
      em.staked = false;
      em.stakedTokenId = null;
    } else if (!em.staked && onChainStaked) {
      console.log(`[UC6] [emissions] state says NOT staked but chain says staked (tokenId=${tokenId}) — fixing`);
      em.staked = true;
      em.stakedTokenId = tokenId;
    }
  }

  async autoStakeAfterMint(tokenId, npmAddress) {
    const poolAddress = this.slipstreamPool;
    const gauge = await resolveGauge(this.publicClient, poolAddress, this.settings);
    const eligibility = isAutoStakeEligible(gauge);
    const em = this.state.emissions;
    em.gaugeAddress = gauge.gaugeAddress;
    em.gaugeAlive = gauge.gaugeAlive;
    em.gaugeMeta = gauge.gaugeMeta;
    em.rewardToken = gauge.rewardToken;
    em.autoStakeEligible = eligibility.eligible;
    em.autoStakeBlockedReason = eligibility.blockedReason;

    if (!eligibility.eligible) {
      console.log(
        `[UC6] [emissions] auto-stake skipped: ${eligibility.blockedReason}`,
      );
      return;
    }

    console.log(`[UC6] [emissions] auto-staking tokenId=${tokenId} into gauge=${gauge.gaugeAddress}`);
    const result = await stakeNft(
      this.walletClient,
      this.publicClient,
      npmAddress,
      gauge.gaugeAddress,
      tokenId,
      this.account,
      this.settings.emissions.approvalMode,
      (msg) => console.log(`[UC6] [emissions] ${msg}`),
    );

    if (result.success) {
      em.staked = true;
      em.stakedTokenId = tokenId;
      em.lastStakeAtIso = nowIso();

      const gasUsd =
        Number(formatUnits(result.gasCostWei, 18)) * this.getSpotUsdcPerWeth();

      await this.appendLifecycleEvent(
        this.lifecycleCommonFields({
          type: "EMISSIONS_STAKE",
          tokenId,
          txHashes: result.txHashes,
          accounting: { gasUsd, isEstimated: false },
          details: {
            gaugeAddress: gauge.gaugeAddress,
            approvalMode: this.settings.emissions.approvalMode,
          },
        }),
      ).catch((err) => this.setLastError(err));

      console.log(`[UC6] [emissions] staked tokenId=${tokenId}, gasUsd=${gasUsd.toFixed(4)}`);
      this.pushEvent({ type: "stake", reason: "auto_stake", gasUsd, txHashes: result.txHashes });
    }
  }

  /**
   * Called in the main loop when in_band and no top-up was needed.
   * Stakes the NFT into the gauge once all top-ups are complete.
   */
  async maybeAutoStakeIdle() {
    if (!this.settings.emissions?.enabled) return false;
    if (!this.settings.emissions?.autoStakeOnMint) return false;
    const em = this.state.emissions;
    if (em?.staked) return false;
    const tokenId = this.state.position?.tokenId;
    if (!tokenId) return false;

    // Back off after a failed stake attempt (5 min cooldown)
    const retryAt = Date.parse(em._autoStakeRetryAfterIso || "");
    if (Number.isFinite(retryAt) && retryAt > Date.now()) return false;

    const venue = this.state.position?.venue === "uniswapv3" ? "uniswapv3" : "slipstream";
    const npmAddress = venue === "uniswapv3" ? this.uniswapNpm : this.slipstreamNpm;

    try {
      await this.autoStakeAfterMint(tokenId, npmAddress);
      em._autoStakeRetryAfterIso = null;
      await this.persistState();
      return true;
    } catch (err) {
      em._autoStakeRetryAfterIso = new Date(Date.now() + 300_000).toISOString();
      console.warn("[UC6] [emissions] auto-stake idle failed:", sanitizeErrorMessage(err));
      this.pushEvent({ type: "error", reason: "auto_stake_failed", message: sanitizeErrorMessage(err) });
      return false;
    }
  }

  async ensureUnstakedForNpmActions(reason) {
    if (!this.settings.emissions?.enabled) return;
    const em = this.state.emissions;
    if (!em?.staked || !em.stakedTokenId) return;
    const gaugeAddress = em.gaugeAddress;
    if (!gaugeAddress) {
      em.staked = false;
      em.stakedTokenId = null;
      return;
    }

    console.log(
      `[UC6] [emissions] unstaking tokenId=${em.stakedTokenId} before ${reason}`,
    );

    const aeroPrice = em.aeroPrice?.aeroUsd || 0;
    const result = await unstakeNft(
      this.walletClient,
      this.publicClient,
      gaugeAddress,
      em.stakedTokenId,
      this.account,
      (msg) => console.log(`[UC6] [emissions] ${msg}`),
    );

    if (result.success) {
      const gasUsd =
        Number(formatUnits(result.gasCostWei, 18)) * this.getSpotUsdcPerWeth();
      const rewardsUsd = result.aeroClaimed * aeroPrice;

      em.staked = false;
      em.lastUnstakeAtIso = nowIso();

      await this.appendLifecycleEvent(
        this.lifecycleCommonFields({
          type: "EMISSIONS_UNSTAKE",
          tokenId: em.stakedTokenId,
          txHashes: [result.txHash],
          accounting: { gasUsd, rewardsUsd, isEstimated: false },
          details: {
            reason,
            gaugeAddress,
            aeroClaimed: result.aeroClaimed,
            aeroPrice,
          },
        }),
      ).catch((err) => this.setLastError(err));

      em.stakedTokenId = null;
      console.log(
        `[UC6] [emissions] unstaked for ${reason}, aeroClaimed=${result.aeroClaimed.toFixed(4)}, gasUsd=${gasUsd.toFixed(4)}`,
      );
      this.pushEvent({ type: "unstake", reason, gasUsd, rewardsUsd: result.aeroClaimed * aeroPrice, txHashes: [result.txHash] });
    }
  }

  async refreshEmissionsMaybe() {
    if (!this.settings.emissions?.enabled) return;
    const em = this.state.emissions;
    if (!em) return;

    // Refresh gauge resolution every 15 min
    if (this.isTtlDue("emissions_gauge", 900)) {
      try {
        const gauge = await resolveGauge(
          this.publicClient,
          this.slipstreamPool,
          this.settings,
        );
        em.gaugeAddress = gauge.gaugeAddress;
        em.gaugeAlive = gauge.gaugeAlive;
        em.gaugeMeta = gauge.gaugeMeta;
        em.rewardToken = gauge.rewardToken;
        const eligibility = isAutoStakeEligible(gauge);
        em.autoStakeEligible = eligibility.eligible;
        em.autoStakeBlockedReason = eligibility.blockedReason;
        this.markRefreshStamp("emissions_gauge", "emissionsGauge");
      } catch (err) {
        console.warn("[UC6] [emissions] gauge refresh error:", sanitizeErrorMessage(err));
      }
    }

    // Refresh AERO price
    const priceTtl = this.settings.emissions?.priceSource?.refreshSec ?? 900;
    if (this.isTtlDue("emissions_price", priceTtl)) {
      try {
        em.aeroPrice = await fetchAeroPrice(this.settings);
        this.markRefreshStamp("emissions_price", "emissionsPrice");
      } catch (err) {
        console.warn("[UC6] [emissions] price refresh error:", sanitizeErrorMessage(err));
      }
    }

    // Refresh claimable + wallet AERO every 60s
    if (this.isTtlDue("emissions_metrics", 60)) {
      try {
        const tokenId = em.stakedTokenId || this.state.position?.tokenId;
        const metrics = await readEmissionsMetrics(
          this.publicClient,
          em.gaugeAddress,
          this.account.address,
          tokenId,
          em.staked,
        );
        em.claimable = { aero: metrics.claimableAero, updatedAtIso: metrics.updatedAtIso };
        em.walletAero = { aero: metrics.walletAero, updatedAtIso: metrics.updatedAtIso };
        this.markRefreshStamp("emissions_metrics", "emissionsMetrics");
      } catch (err) {
        console.warn("[UC6] [emissions] metrics refresh error:", sanitizeErrorMessage(err));
      }
    }

    // Auto-claim check
    if (
      this.settings.emissions.autoClaim &&
      em.staked &&
      em.gaugeAddress &&
      em.claimable
    ) {
      const aeroPrice = em.aeroPrice?.aeroUsd || 0;
      const claimableUsd = (em.claimable.aero || 0) * aeroPrice;
      const cooldownOk =
        !em.lastClaimAtIso ||
        Date.now() - new Date(em.lastClaimAtIso).getTime() >=
          (this.settings.emissions.claimCooldownSec || 21600) * 1000;

      if (
        claimableUsd >= (this.settings.emissions.claimMinUsd || 2) &&
        cooldownOk
      ) {
        try {
          const tokenId = em.stakedTokenId || this.state.position?.tokenId;
          if (tokenId) {
            console.log(`[UC6] [emissions] auto-claiming AERO (claimableUsd=${claimableUsd.toFixed(2)})`);
            const result = await claimAeroRewards(
              this.walletClient,
              this.publicClient,
              em.gaugeAddress,
              tokenId,
              this.account,
              (msg) => console.log(`[UC6] [emissions] ${msg}`),
            );
            if (result.success) {
              const gasUsd =
                Number(formatUnits(result.gasCostWei, 18)) *
                this.getSpotUsdcPerWeth();
              em.lastClaimAtIso = nowIso();

              await this.appendLifecycleEvent(
                this.lifecycleCommonFields({
                  type: "EMISSIONS_CLAIM",
                  tokenId: String(tokenId),
                  txHashes: [result.txHash],
                  accounting: {
                    gasUsd,
                    rewardsUsd: result.aeroClaimed * aeroPrice,
                    isEstimated: false,
                  },
                  details: {
                    aeroClaimed: result.aeroClaimed,
                    aeroPrice,
                    gaugeAddress: em.gaugeAddress,
                  },
                }),
              ).catch((err) => this.setLastError(err));

              console.log(
                `[UC6] [emissions] claimed ${result.aeroClaimed.toFixed(4)} AERO, gasUsd=${gasUsd.toFixed(4)}`,
              );
              this.pushEvent({ type: "claim", reason: "auto_claim", gasUsd, rewardsUsd: result.aeroClaimed * aeroPrice, txHashes: [result.txHash] });
            }
          }
        } catch (err) {
          console.warn("[UC6] [emissions] auto-claim error:", sanitizeErrorMessage(err));
        }
      }
    }
  }

  ensureLatestRefreshMeta() {
    if (!this.state.latest) this.state.latest = {};
    if (!this.state.latest.refresh || typeof this.state.latest.refresh !== "object") {
      this.state.latest.refresh = {};
    }
    return this.state.latest.refresh;
  }

  markRefreshStamp(clockKey, latestField) {
    const ts = Date.now();
    this.refreshClock[clockKey] = ts;
    this.ensureLatestRefreshMeta()[latestField] = nowIso();
  }

  isTtlDue(clockKey, everySec, { force = false } = {}) {
    if (force) return true;
    const ttlMs = Math.max(1, Number(everySec || 0)) * 1000;
    const last = Number(this.refreshClock[clockKey] || 0);
    if (!last) return true;
    return Date.now() - last >= ttlMs;
  }

  resetRangeStatsSampler(nowMs = Date.now()) {
    if (!this.state.rangeStats || typeof this.state.rangeStats !== "object") {
      this.state.rangeStats = {
        sinceIso: new Date(nowMs).toISOString(),
        lastSampleAtIso: null,
        eligibleMs: 0,
        inRangeMs: 0,
      };
    }
    this.state.rangeStats.lastSampleAtIso = new Date(nowMs).toISOString();
    if (!this.state.rangeStats.sinceIso) this.state.rangeStats.sinceIso = this.state.rangeStats.lastSampleAtIso;
  }

  updateRangeStats(nowMs = Date.now()) {
    if (!this.state.rangeStats || typeof this.state.rangeStats !== "object") {
      this.resetRangeStatsSampler(nowMs);
      return;
    }
    const prevIso = this.state.rangeStats.lastSampleAtIso || null;
    const prevMs = prevIso ? Date.parse(prevIso) : NaN;
    if (Number.isFinite(prevMs) && nowMs > prevMs) {
      let deltaMs = nowMs - prevMs;
      // After process restarts or long pauses, reset the sampler instead of counting downtime.
      if (deltaMs > 120_000) {
        this.resetRangeStatsSampler(nowMs);
        return;
      }
      const eligible = Boolean(this.settings.tradingEnabled) && !Boolean(this.settings.killSwitch);
      const inRange = eligible && Boolean(this.state.position?.inRange);
      if (eligible) {
        this.state.rangeStats.eligibleMs = Number(this.state.rangeStats.eligibleMs || 0) + deltaMs;
      }
      if (inRange) {
        this.state.rangeStats.inRangeMs = Number(this.state.rangeStats.inRangeMs || 0) + deltaMs;
      }
    }
    this.state.rangeStats.lastSampleAtIso = new Date(nowMs).toISOString();
    if (!this.state.rangeStats.sinceIso) this.state.rangeStats.sinceIso = this.state.rangeStats.lastSampleAtIso;
  }

  estimateAggregatedLpUsdValueFromLatest() {
    const latest = this.state.latest || {};
    const positionInventory = latest.positionInventory || null;
    if (positionInventory && Number(positionInventory.activeCount || 0) > 0) {
      return Number(positionInventory.totalUsdValue || 0);
    }
    return this.estimateTrackedLpUsdValueFromLatest();
  }

  ensureCapitalStatsSampler(nowMs = Date.now()) {
    if (!this.state.capitalStats || typeof this.state.capitalStats !== "object") {
      this.state.capitalStats = {
        sinceIso: new Date(nowMs).toISOString(),
        lastSampleAtIso: null,
        samples: [],
      };
    }
    if (!Array.isArray(this.state.capitalStats.samples)) this.state.capitalStats.samples = [];
    if (!this.state.capitalStats.sinceIso) this.state.capitalStats.sinceIso = new Date(nowMs).toISOString();
    return this.state.capitalStats;
  }

  updateCapitalStats(deployedUsd, nowMs = Date.now()) {
    const value = Number(deployedUsd);
    if (!Number.isFinite(value) || value < 0) return;
    const stats = this.ensureCapitalStatsSampler(nowMs);
    const prevIso = stats.lastSampleAtIso || null;
    const prevMs = prevIso ? Date.parse(prevIso) : NaN;
    const shouldSample =
      !Number.isFinite(prevMs) ||
      nowMs <= prevMs ||
      nowMs - prevMs >= CAPITAL_SAMPLE_MIN_INTERVAL_MS;
    stats.lastSampleAtIso = new Date(nowMs).toISOString();
    if (!shouldSample) return;

    stats.samples.push({
      atIso: stats.lastSampleAtIso,
      deployedUsd: value,
    });

    const cutoffMs = nowMs - CAPITAL_SAMPLE_RETENTION_MS;
    stats.samples = stats.samples
      .filter((s) => {
        const t = Date.parse(s?.atIso || "");
        return Number.isFinite(t) && t >= cutoffMs;
      })
      .slice(-CAPITAL_SAMPLE_MAX_POINTS);
  }

  averageDeployedUsdSince(sinceMs, fallbackUsd, nowMs = Date.now()) {
    const fallback = Number.isFinite(Number(fallbackUsd)) ? Number(fallbackUsd) : 0;
    if (!(Number.isFinite(sinceMs) && Number.isFinite(nowMs) && nowMs > sinceMs)) {
      return fallback > 0 ? fallback : 1;
    }
    const stats = this.state.capitalStats;
    const samplesRaw = Array.isArray(stats?.samples) ? stats.samples : [];
    const samples = samplesRaw
      .map((s) => ({
        atMs: Date.parse(s?.atIso || ""),
        deployedUsd: Number(s?.deployedUsd || 0),
      }))
      .filter((s) => Number.isFinite(s.atMs) && Number.isFinite(s.deployedUsd) && s.deployedUsd >= 0)
      .sort((a, b) => a.atMs - b.atMs);

    if (samples.length === 0) return fallback > 0 ? fallback : 1;

    let weightedUsdMs = 0;
    let coveredMs = 0;

    let prev = null;
    for (const sample of samples) {
      if (sample.atMs <= sinceMs) prev = sample;
      if (sample.atMs > sinceMs) break;
    }
    if (!prev) {
      prev = samples.find((s) => s.atMs >= sinceMs) || null;
    }
    if (!prev) return fallback > 0 ? fallback : 1;

    for (const sample of samples) {
      if (sample.atMs <= prev.atMs) continue;
      const start = Math.max(prev.atMs, sinceMs);
      const end = Math.min(sample.atMs, nowMs);
      const delta = end - start;
      if (delta > 0 && delta <= CAPITAL_SAMPLE_MAX_GAP_MS) {
        weightedUsdMs += prev.deployedUsd * delta;
        coveredMs += delta;
      }
      prev = sample;
      if (sample.atMs >= nowMs) break;
    }

    if (prev) {
      const tailStart = Math.max(prev.atMs, sinceMs);
      const tailEnd = nowMs;
      const tailDelta = tailEnd - tailStart;
      if (tailDelta > 0 && tailDelta <= CAPITAL_SAMPLE_MAX_GAP_MS) {
        weightedUsdMs += prev.deployedUsd * tailDelta;
        coveredMs += tailDelta;
      }
    }

    if (coveredMs <= 0) return fallback > 0 ? fallback : 1;
    const avg = weightedUsdMs / coveredMs;
    return avg > 0 ? avg : fallback > 0 ? fallback : 1;
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
    const msg = sanitizeErrorMessage(err);
    this.state.lastError = `${nowIso()} ${msg}`;
    this.successfulLoopStreak = 0;
  }

  markSuccessfulLoop(nowMs = Date.now()) {
    this.lastSuccessfulLoopAtMs = nowMs;
    this.successfulLoopStreak = Number(this.successfulLoopStreak || 0) + 1;
    if (!this.state.lastError) return;
    if (this.successfulLoopStreak < LAST_ERROR_AUTO_CLEAR_SUCCESS_LOOPS) return;
    const parsed = this.parseLastErrorObject();
    const errMs = Date.parse(parsed?.atIso || "");
    if (!Number.isFinite(errMs)) return;
    if (nowMs - errMs < LAST_ERROR_AUTO_CLEAR_AFTER_MS) return;
    this.state.lastError = null;
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

  getMinimumMintNotionalUsd() {
    const caps = this.getExecutionCapsConfig();
    return Math.max(5, Number(caps.minSwapUsd || 0), 0);
  }

  async syncStrategyModeInvariant({ persist = false } = {}) {
    const hasActiveLp = Boolean(this.state.position?.tokenId);
    const mode = this.getStrategyMode();
    if (!hasActiveLp || mode === "LP_ACTIVE") {
      return { changed: false, mode };
    }
    this.setStrategyModeState("LP_ACTIVE", {
      holdStartedAtIso: null,
      escapeCooldownUntilIso: null,
    });
    if (persist) {
      await this.persistState().catch((err) => this.setLastError(err));
    }
    return { changed: true, mode: "LP_ACTIVE" };
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
      const dedupWindowMs = next.type === "blocked" ? 120_000 : 15_000;
      if (Number.isFinite(lastMs) && Number.isFinite(nextMs) && nextMs - lastMs < dedupWindowMs) {
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
    this.ledgerRepairDirty = true;
  }

  emptyLifecycleAccounting() {
    return {
      gasUsd: 0,
      swapCostUsd: 0,
      mintBurnUsd: 0,
      feesCollectedUsd: 0,
      rewardsUsd: 0,
      isEstimated: false,
    };
  }

  emptyLifecycleRecord(seed = {}) {
    return {
      id: seed.id || randomUUID(),
      tokenId: seed.tokenId || null,
      chain: { name: "Base", chainId: base.id },
      venue: seed.venue || "slipstream",
      poolAddress: seed.poolAddress || this.slipstreamPool,
      pair: { base: "WETH", quote: "USDC" },
      selector: seed.selector || { type: "tickSpacing", value: 0, humanLabel: undefined },
      band: seed.band || { bandHalfBps: 0, tickLower: 0, tickUpper: 0 },
      entry: {
        openedAtIso: seed.openedAtIso || nowIso(),
        entrySnapshotAtIso: null,
        entryValueUsd: 0,
        entryTokens: { weth: 0, usdc: 0 },
        spotPriceUsdcPerWeth: 0,
        rawMintValueUsd: null,
      },
      exit: {
        closedAtIso: null,
        exitValueUsd: null,
        exitTokens: null,
        spotPriceUsdcPerWeth: null,
      },
      duration: {
        secondsInPosition: null,
        human: null,
      },
      performance: {
        feesCollectedUsd: 0,
        rewardsUsd: 0,
        gasUsd: 0,
        swapCostUsd: 0,
        mintBurnUsd: 0,
        totalCostsUsd: 0,
        feesNetUsd: 0,
        capitalGainLossUsd: 0,
        impermanentLossUsd: 0,
        divergenceVsHodlUsd: 0,
        requiredFeesToBeatHodlUsd: 0,
        alphaVsHodlUsd: 0,
        netProfitUsd: 0,
        costToFeeRatio: 0,
        avgDeployedUsd: 0,
        feeApr: 0,
        alphaApr: 0,
        absoluteApr: 0,
        apr: 0,
      },
      activity: {
        rebalances: 0,
        harvests: 0,
        swaps: 0,
        txCount: 0,
        closeGateBlockedCount: 0,
        closeGateOverrideReason: null,
      },
      tx: {
        openTxHashes: [],
        closeTxHashes: [],
        allTxHashes: [],
      },
      closeReason: null,
      closeHoldTarget: null,
      status: "OPEN",
      notes: null,
      createdAtIso: seed.createdAtIso || nowIso(),
      updatedAtIso: nowIso(),
      _internal: {
        baselineWeth: 0,
        baselineUsdc: 0,
        entryCaptured: false,
        openPhaseDone: false,
      },
    };
  }

  selectorForVenue(venue, snapshot = null) {
    if (venue === "uniswapv3") {
      const fee = Number(snapshot?.fee || this.state.latest?.fallback?.fee || 0);
      return {
        type: "fee",
        value: fee,
        humanLabel:
          fee > 0
            ? `${(fee / 10000).toFixed(fee % 100 === 0 ? 2 : 4)}%`
            : undefined,
      };
    }
    return {
      type: "tickSpacing",
      value: Number(snapshot?.tickSpacing || this.state.latest?.primary?.tickSpacing || 0),
      humanLabel: undefined,
    };
  }

  currentBandDescriptor() {
    const p = this.state.position || {};
    return {
      bandHalfBps: Number(p.bandHalfBps || this.settings.bandHalfBps || 0),
      tickLower: Number(p.tickLower ?? 0),
      tickUpper: Number(p.tickUpper ?? 0),
    };
  }

  lifecycleCommonFields({ type, positionRunId, tokenId = null, band = null, txHashes = [], accounting = null, details = {} }) {
    const venue = this.state.position?.venue === "uniswapv3" ? "uniswapv3" : "slipstream";
    const market = this.state.latest?.primary || this.state.latest?.fallback || {};
    const poolAddress = venue === "uniswapv3" ? this.uniswapPool : this.slipstreamPool;
    return {
      id: randomUUID(),
      atIso: nowIso(),
      chainId: base.id,
      positionRunId,
      type,
      venue,
      poolAddress,
      tokenId: tokenId == null ? undefined : String(tokenId),
      band: band || undefined,
      spotPriceUsdcPerWeth: this.getSpotUsdcPerWeth() || Number(market?.priceUsdcPerWeth || 0) || undefined,
      txHashes: Array.isArray(txHashes) ? txHashes.filter(Boolean).map(String) : [],
      accounting: {
        ...this.emptyLifecycleAccounting(),
        ...(accounting || {}),
      },
      details: details && typeof details === "object" ? details : {},
    };
  }

  async appendLifecycleEvent(event) {
    const next = {
      ...event,
      id: event?.id || randomUUID(),
      atIso: event?.atIso || nowIso(),
      chainId: base.id,
    };
    this.positionLifecycleEvents.push(next);
    await appendJsonLineAtomic(POSITION_EVENTS_PATH, next);
    this.applyLifecycleEventToRecords(next);
    await this.persistPositionRecords();
    return next;
  }

  sanitizePositionRecordForPersist(record) {
    if (!record || typeof record !== "object") return record;
    const { _internal, ...rest } = record;
    return rest;
  }

  async persistPositionRecords() {
    const items = (Array.isArray(this.positionRecords) ? this.positionRecords : [])
      .map((r) => this.sanitizePositionRecordForPersist(r));
    await writeJsonAtomic(POSITION_RECORDS_PATH, {
      version: 1,
      updatedAtIso: nowIso(),
      items,
    });
  }

  async loadLifecycleStores() {
    this.positionLifecycleEvents = await readJsonLinesIfExists(POSITION_EVENTS_PATH);
    this.positionRecordsById = new Map();
    this.positionRecords = [];
    this.lifecycleCurrentTokenByRunId = new Map();
    this.lifecyclePendingOpenByRunId = new Map();
    for (const ev of this.positionLifecycleEvents) {
      try {
        this.applyLifecycleEventToRecords(ev);
      } catch {
        // skip malformed historical lifecycle rows
      }
    }
    this.repairLifecycleRecordsMissingEntrySnapshots();
    // Always persist the rebuilt derived records on startup so positions.json
    // reflects the current reducer logic (including historical backfills that
    // may be reconstructed during replay before the explicit repair pass).
    await this.persistPositionRecords();
  }

  async loadPoolComparisonCache() {
    const cached = await loadPoolComparisonCacheFile(POOL_RANKINGS_PATH);
    this.poolComparisonCache = cached && typeof cached === "object" ? cached : null;
    return this.poolComparisonCache;
  }

  setPoolComparisonError(err) {
    const message = sanitizeErrorMessage(err);
    this.poolComparisonLastError = {
      atIso: nowIso(),
      message,
    };
  }

  clearPoolComparisonError() {
    this.poolComparisonLastError = null;
  }

  getPoolComparisonGasBaselineUsd() {
    try {
      const now = Date.now();
      const stats7d = this.summarizeEvents(this.getEventsSince(now - 7 * 24 * 60 * 60 * 1000));
      const rebalances = Math.max(0, Number(stats7d?.rebalances || 0));
      const gasUsd = Math.max(0, Number(stats7d?.gasUsd || 0));
      if (rebalances > 0 && Number.isFinite(gasUsd)) {
        return Math.max(0.001, gasUsd / rebalances);
      }
    } catch {
      // ignore and use fallback
    }
    return 0.03;
  }

  symbolForPoolCompareAddress(addr) {
    if (!addr) return null;
    if (sameAddress(addr, this.weth)) return "WETH";
    if (sameAddress(addr, this.usdc)) return "USDC";
    return null;
  }

  buildPoolComparisonCurrentRef() {
    const latest = this.state.latest || {};
    const primary = latest.primary || null;
    const fallback = latest.fallback || null;
    const venueActive = this.settings.venue === "uniswapv3" ? "uniswapv3" : "slipstream";
    const activePool = venueActive === "uniswapv3" ? fallback || primary : primary || fallback;
    const selectorType = venueActive === "uniswapv3" ? "feeTier" : "tickSpacing";
    const selectorValue =
      selectorType === "feeTier"
        ? (Number.isFinite(Number(activePool?.fee)) ? Number(activePool.fee) : null)
        : (Number.isFinite(Number(activePool?.tickSpacing)) ? Number(activePool.tickSpacing) : null);
    const refCapitalUsd = this.estimateAggregatedLpUsdValueFromLatest();
    const gasBaselineUsd = this.getPoolComparisonGasBaselineUsd();

    const token0 = activePool?.token0 || this.weth;
    const token1 = activePool?.token1 || this.usdc;
    const baseSymbol = this.symbolForPoolCompareAddress(token0) || "WETH";
    const quoteSymbol = this.symbolForPoolCompareAddress(token1) || "USDC";

    return {
      poolAddress: String(activePool?.pool || ENV.slipstreamPool || "").toLowerCase() || null,
      dexId: null,
      dexName: venueActive === "uniswapv3" ? "Uniswap v3 (Base)" : "Aerodrome Slipstream",
      pair: {
        baseSymbol,
        quoteSymbol,
        baseAddress: token0 || null,
        quoteAddress: token1 || null,
        pairKey: `${baseSymbol}/${quoteSymbol}`,
      },
      selector: {
        type: selectorType,
        value: selectorValue,
      },
      band: {
        bandHalfBps: Number(this.settings.bandHalfBps || 0),
        edgeRebalancePct: Number(this.settings.edgeRebalancePct || 0),
      },
      refCapitalUsd: Math.max(0, Number(refCapitalUsd || 0)),
      gasBaselineUsd,
    };
  }

  isPoolComparisonDue(nowMs = Date.now()) {
    const cfg = this.settings?.poolComparison;
    if (!cfg || cfg.enabled === false) return false;
    const computedMs = Date.parse(this.poolComparisonCache?.computedAtIso || "");
    if (!Number.isFinite(computedMs)) return true;
    if (nowMs - computedMs >= POOL_COMPARISON_STALE_MS) return true;
    const cacheDay = utcDayKey(computedMs);
    const nowDay = utcDayKey(nowMs);
    if (cacheDay !== nowDay) {
      const hour = new Date(nowMs).getUTCHours();
      const computeHourUtc = clamp(Math.round(Number(cfg.computeHourUtc || 8)), 0, 23);
      if (hour >= computeHourUtc) return true;
    }
    return false;
  }

  maybeStartPoolComparisonJob() {
    const now = Date.now();
    if (this.poolComparisonJobPromise) return;
    if (now - this.poolComparisonLastCheckAtMs < POOL_COMPARISON_CHECK_INTERVAL_MS) return;
    this.poolComparisonLastCheckAtMs = now;
    if (!this.isPoolComparisonDue(now)) return;

    const settings = this.settings?.poolComparison || DEFAULT_SETTINGS.poolComparison;
    const currentRef = this.buildPoolComparisonCurrentRef();
    this.poolComparisonJobPromise = (async () => {
      try {
        const result = await runPoolComparisonJob({
          rankingsPath: POOL_RANKINGS_PATH,
          tvlHistoryPath: POOL_TVL_HISTORY_PATH,
          currentRef,
          settings,
          logger: console,
          fetchFn: globalThis.fetch,
        });
        if (result && typeof result === "object") {
          this.poolComparisonCache = result;
          if (result.lastError) {
            this.poolComparisonLastError = {
              atIso: result.computedAtIso || nowIso(),
              message: String(result.lastError),
            };
          } else {
            this.clearPoolComparisonError();
          }
        }
      } catch (err) {
        this.setPoolComparisonError(err);
      } finally {
        this.poolComparisonJobPromise = null;
      }
    })();
    this.poolComparisonJobPromise.catch(() => {});
  }

  getPoolComparisonStatusPayload() {
    const cached = this.poolComparisonCache && typeof this.poolComparisonCache === "object" ? this.poolComparisonCache : null;
    const currentRef = this.buildPoolComparisonCurrentRef();
    return {
      ok: Boolean(cached?.ok),
      computedAtIso: cached?.computedAtIso || null,
      current: cached?.current || null,
      top5: Array.isArray(cached?.top5) ? cached.top5 : [],
      notRecommended: Array.isArray(cached?.notRecommended) ? cached.notRecommended : [],
      ref: cached?.ref || {
        currentPool: currentRef,
      },
      network: cached?.network || { id: "base", name: "Base", chainId: 8453 },
      notes: cached?.notes || null,
      lastError: this.poolComparisonLastError || (cached?.lastError ? { atIso: cached?.computedAtIso || null, message: String(cached.lastError) } : null),
    };
  }

  getLifecycleRecordById(id, { createFromEvent = null } = {}) {
    if (!id) return null;
    let rec = this.positionRecordsById.get(id);
    if (!rec && createFromEvent) {
      rec = this.emptyLifecycleRecord({
        id,
        tokenId: createFromEvent.tokenId || createFromEvent.details?.mintedTokenId || id,
        venue: createFromEvent.venue,
        poolAddress: createFromEvent.poolAddress,
        selector:
          createFromEvent.details?.selector ||
          this.selectorForVenue(createFromEvent.venue),
        band: createFromEvent.band || this.currentBandDescriptor(),
        openedAtIso: createFromEvent.atIso,
        createdAtIso: createFromEvent.atIso,
      });
      this.positionRecordsById.set(id, rec);
      this.positionRecords.push(rec);
    }
    return rec || null;
  }

  addUniqueTxHashes(targetArr, txHashes) {
    if (!Array.isArray(targetArr)) return;
    const seen = new Set(targetArr.map(String));
    for (const hash of Array.isArray(txHashes) ? txHashes : []) {
      if (!hash) continue;
      const key = String(hash);
      if (seen.has(key)) continue;
      seen.add(key);
      targetArr.push(key);
    }
  }

  addAccountingToRecord(rec, accounting) {
    if (!rec || !accounting) return;
    const perf = rec.performance;
    perf.gasUsd += Number(accounting.gasUsd || 0);
    perf.swapCostUsd += Number(accounting.swapCostUsd || 0);
    perf.mintBurnUsd += Number(accounting.mintBurnUsd || 0);
    perf.feesCollectedUsd += Number(accounting.feesCollectedUsd || 0);
    perf.rewardsUsd += Number(accounting.rewardsUsd || 0);
  }

  getOrCreatePendingOpenForRun(runId, seed = null) {
    if (!runId) return null;
    let pending = this.lifecyclePendingOpenByRunId.get(runId);
    if (!pending) {
      pending = {
        openedAtIso: null,
        selector: null,
        band: null,
        accounting: this.emptyLifecycleAccounting(),
        tx: {
          openTxHashes: [],
          allTxHashes: [],
        },
        activity: {
          swaps: 0,
        },
        notes: null,
      };
      this.lifecyclePendingOpenByRunId.set(runId, pending);
    }
    if (seed && typeof seed === "object") {
      if (seed.openedAtIso) pending.openedAtIso = pending.openedAtIso || String(seed.openedAtIso);
      if (seed.selector && typeof seed.selector === "object") pending.selector = { ...(pending.selector || {}), ...seed.selector };
      if (seed.band && typeof seed.band === "object") {
        pending.band = {
          bandHalfBps: Number(seed.band.bandHalfBps || pending.band?.bandHalfBps || 0),
          tickLower: Number(seed.band.tickLower ?? pending.band?.tickLower ?? 0),
          tickUpper: Number(seed.band.tickUpper ?? pending.band?.tickUpper ?? 0),
        };
      }
      if (seed.notes && !pending.notes) pending.notes = String(seed.notes);
    }
    return pending;
  }

  addLifecycleEventToPendingOpen(pending, ev, { countAsSwap = false } = {}) {
    if (!pending || !ev) return;
    if (ev.accounting) {
      pending.accounting.gasUsd += Number(ev.accounting.gasUsd || 0);
      pending.accounting.swapCostUsd += Number(ev.accounting.swapCostUsd || 0);
      pending.accounting.mintBurnUsd += Number(ev.accounting.mintBurnUsd || 0);
      pending.accounting.feesCollectedUsd += Number(ev.accounting.feesCollectedUsd || 0);
      pending.accounting.rewardsUsd += Number(ev.accounting.rewardsUsd || 0);
      pending.accounting.isEstimated = Boolean(pending.accounting.isEstimated || ev.accounting.isEstimated);
    }
    const txHashes = Array.isArray(ev.txHashes) ? ev.txHashes : [];
    this.addUniqueTxHashes(pending.tx.openTxHashes, txHashes);
    this.addUniqueTxHashes(pending.tx.allTxHashes, txHashes);
    if (countAsSwap) pending.activity.swaps += 1;
    if (ev.details?.selector && typeof ev.details.selector === "object") {
      pending.selector = { ...(pending.selector || {}), ...ev.details.selector };
    }
    if (ev.band && typeof ev.band === "object") {
      pending.band = {
        bandHalfBps: Number(ev.band.bandHalfBps || pending.band?.bandHalfBps || 0),
        tickLower: Number(ev.band.tickLower ?? pending.band?.tickLower ?? 0),
        tickUpper: Number(ev.band.tickUpper ?? pending.band?.tickUpper ?? 0),
      };
    }
  }

  applyPendingOpenToRecord(rec, pending) {
    if (!rec || !pending) return;
    rec.entry.openedAtIso = rec.entry.openedAtIso || pending.openedAtIso || rec.entry.openedAtIso;
    if (pending.selector) rec.selector = { ...rec.selector, ...pending.selector };
    if (pending.band) {
      rec.band = {
        bandHalfBps: Number(pending.band.bandHalfBps || rec.band.bandHalfBps || 0),
        tickLower: Number(pending.band.tickLower ?? rec.band.tickLower ?? 0),
        tickUpper: Number(pending.band.tickUpper ?? rec.band.tickUpper ?? 0),
      };
    }
    this.addAccountingToRecord(rec, pending.accounting);
    this.addUniqueTxHashes(rec.tx.openTxHashes, pending.tx.openTxHashes);
    this.addUniqueTxHashes(rec.tx.allTxHashes, pending.tx.allTxHashes);
    rec.activity.swaps += Number(pending.activity?.swaps || 0);
    rec.activity.txCount = rec.tx.allTxHashes.length;
    if (!rec.notes && pending.notes) rec.notes = pending.notes;
  }

  closeLifecycleRecordFromPrincipalOut(rec, { atIso = null, principalOut = null, spotPriceUsdcPerWeth = null, exitValueUsd = null } = {}) {
    if (!rec) return;
    const principal = principalOut && typeof principalOut === "object" ? principalOut : {};
    const exitTokens = {
      weth: Number(principal.weth || 0),
      usdc: Number(principal.usdc || 0),
    };
    rec.exit.exitTokens = exitTokens;
    const spot = Number(spotPriceUsdcPerWeth || rec.exit?.spotPriceUsdcPerWeth || 0);
    if (spot > 0) rec.exit.spotPriceUsdcPerWeth = spot;
    const computedExitValueUsd = exitTokens.usdc + exitTokens.weth * (spot > 0 ? spot : 0);
    rec.exit.exitValueUsd = Number.isFinite(Number(exitValueUsd)) && Number(exitValueUsd) > 0
      ? Number(exitValueUsd)
      : (spot > 0 ? computedExitValueUsd : Number(rec.exit?.exitValueUsd || 0) || null);
    rec.exit.closedAtIso = atIso || rec.exit.closedAtIso || nowIso();
    rec.status = "CLOSED";

    const baselineWeth = Number(rec._internal?.baselineWeth || 0);
    const baselineUsdc = Number(rec._internal?.baselineUsdc || 0);
    const hasBaseline = Boolean(rec?._internal?.entryCaptured) && (Math.abs(baselineWeth) > 0 || Math.abs(baselineUsdc) > 0);
    const pExit = Number(rec.exit?.spotPriceUsdcPerWeth || 0);
    if (pExit > 0 && hasBaseline) {
      const hodlExit = baselineWeth * pExit + baselineUsdc;
      const lpExitPrincipal = exitTokens.weth * pExit + exitTokens.usdc;
      if (Number.isFinite(hodlExit) && Number.isFinite(lpExitPrincipal)) {
        rec.performance.impermanentLossUsd = lpExitPrincipal - hodlExit;
      }
    }
  }

  appendLifecycleRecordNote(rec, note) {
    if (!rec || !note) return;
    const next = String(note).trim();
    if (!next) return;
    const current = String(rec.notes || "").trim();
    if (!current) {
      rec.notes = next;
      return;
    }
    if (current.includes(next)) return;
    rec.notes = `${current}; ${next}`;
  }

  isEntrySnapshotMissing(rec) {
    if (!rec) return true;
    if (!rec.entry?.entrySnapshotAtIso) return true;
    if (!(Number(rec.entry?.entryValueUsd || 0) > 0)) return true;
    if (!(Number(rec.entry?.spotPriceUsdcPerWeth || 0) > 0)) return true;
    return false;
  }

  mintPrincipalForLifecycleEvent(ev) {
    if (!ev || (ev.type !== "OPEN_MINT" && ev.type !== "REBALANCE_MINT")) return null;
    let amount0Used = 0n;
    let amount1Used = 0n;
    try {
      amount0Used = BigInt(ev.details?.amount0Used || 0);
      amount1Used = BigInt(ev.details?.amount1Used || 0);
    } catch {
      return null;
    }
    const wethLower = String(this.weth || ENV.weth || "").toLowerCase();
    const usdcLower = String(this.usdc || ENV.usdc || "").toLowerCase();
    if (!wethLower || !usdcLower) return null;
    const token0IsWeth = wethLower < usdcLower;
    const wethRaw = token0IsWeth ? amount0Used : amount1Used;
    const usdcRaw = token0IsWeth ? amount1Used : amount0Used;
    return {
      weth: Number(formatUnits(wethRaw, WETH_DECIMALS)),
      usdc: Number(formatUnits(usdcRaw, USDC_DECIMALS)),
    };
  }

  deriveFallbackEntryBaselineForRecord(rec, { closeAtIso = null } = {}) {
    if (!rec?.tokenId) return null;
    const tokenId = String(rec.tokenId);
    const allEvents = Array.isArray(this.positionLifecycleEvents) ? this.positionLifecycleEvents : [];
    const byTokenEvents = allEvents.filter((ev) => {
        const candidates = [
          ev?.tokenId,
          ev?.details?.mintedTokenId,
          ev?.details?.closedTokenId,
        ].filter(Boolean).map((v) => String(v));
        return candidates.includes(tokenId);
      });
    const openTxSet = new Set(
      (Array.isArray(rec?.tx?.openTxHashes) ? rec.tx.openTxHashes : [])
        .filter(Boolean)
        .map((h) => String(h).toLowerCase())
    );
    const byOpenTxEvents = openTxSet.size > 0
      ? allEvents.filter((ev) => {
          const hashes = Array.isArray(ev?.txHashes) ? ev.txHashes : [];
          return hashes.some((h) => openTxSet.has(String(h).toLowerCase()));
        })
      : [];
    const events = [...byTokenEvents];
    for (const ev of byOpenTxEvents) {
      if (!events.includes(ev)) events.push(ev);
    }
    events.sort((a, b) => Date.parse(a?.atIso || "") - Date.parse(b?.atIso || ""));
    if (!events.length) {
      const rawMintValueUsd = Number(rec.entry?.rawMintValueUsd || 0);
      if (!(rawMintValueUsd > 0)) return null;
      const pExit = Number(rec?.exit?.spotPriceUsdcPerWeth || 0);
      return {
        entrySnapshotAtIso: rec.entry?.openedAtIso || closeAtIso || null,
        entryTokens: { weth: 0, usdc: 0 },
        entryValueUsd: rawMintValueUsd,
        spotPriceUsdcPerWeth: Math.max(0, pExit),
        rawMintValueUsd,
        topUpCount: 0,
        lastContributionAtIso: rec.entry?.openedAtIso || closeAtIso || null,
        approx: true,
        note: "entry snapshot fallback (value-only from raw mint value)",
      };
    }

    const mintEv = events.find((ev) => ev?.type === "OPEN_MINT" || ev?.type === "REBALANCE_MINT");
    if (!mintEv) {
      const rawMintValueUsd = Number(rec.entry?.rawMintValueUsd || 0);
      if (!(rawMintValueUsd > 0)) return null;
      const firstAt = events[0]?.atIso || rec.entry?.openedAtIso || closeAtIso || null;
      const spot = Number(
        events.find((ev) => Number(ev?.spotPriceUsdcPerWeth || 0) > 0)?.spotPriceUsdcPerWeth ||
        rec?.exit?.spotPriceUsdcPerWeth || 0
      );
      return {
        entrySnapshotAtIso: firstAt,
        entryTokens: { weth: 0, usdc: 0 },
        entryValueUsd: rawMintValueUsd,
        spotPriceUsdcPerWeth: Math.max(0, spot),
        rawMintValueUsd,
        topUpCount: 0,
        lastContributionAtIso: firstAt,
        approx: true,
        note: "entry snapshot fallback (value-only; mint event missing in journal)",
      };
    }
    const mintMs = Date.parse(mintEv.atIso || "");
    if (!Number.isFinite(mintMs)) return null;
    const latestEntrySnapshotMs = events.reduce((latest, ev) => {
      if (ev?.type !== "ENTRY_SNAPSHOT") return latest;
      const evMs = Date.parse(ev?.atIso || "");
      return Number.isFinite(evMs) ? Math.max(latest, evMs) : latest;
    }, Number.NEGATIVE_INFINITY);

    const mintPrincipal = this.mintPrincipalForLifecycleEvent(mintEv);
    const hasMintTokenBaseline = Boolean(mintPrincipal) &&
      (Number(mintPrincipal?.weth || 0) > 0 || Number(mintPrincipal?.usdc || 0) > 0);
    let entryWeth = Number(mintPrincipal?.weth || 0);
    let entryUsdc = Number(mintPrincipal?.usdc || 0);
    let rawMintValueUsd = Number(rec.entry?.rawMintValueUsd || mintEv?.details?.rawMintValueUsd || 0);
    let topupWeth = 0;
    let topupUsdc = 0;
    let topUpCount = 0;

    let cutoffMs = mintMs + ENTRY_SNAPSHOT_FALLBACK_WINDOW_MS;
    if (Number.isFinite(latestEntrySnapshotMs)) {
      cutoffMs = Math.max(cutoffMs, latestEntrySnapshotMs);
    }
    const closeMs = Date.parse(closeAtIso || rec?.exit?.closedAtIso || "");
    if (Number.isFinite(closeMs)) cutoffMs = Math.min(cutoffMs, closeMs);

    let lastIncludedEv = mintEv;
    for (const ev of events) {
      const evMs = Date.parse(ev?.atIso || "");
      if (!Number.isFinite(evMs) || evMs < mintMs || evMs > cutoffMs) continue;
      if (ev === mintEv) continue;
      if (ev?.type === "TOP_UP") {
        topUpCount += 1;
        const p = ev?.details?.principalAdded || {};
        const addWeth = Number(p.weth || 0);
        const addUsdc = Number(p.usdc || 0);
        topupWeth += addWeth;
        topupUsdc += addUsdc;
        if (hasMintTokenBaseline) {
          entryWeth += addWeth;
          entryUsdc += addUsdc;
        }
        lastIncludedEv = ev;
      }
    }

    const spotCandidates = [
      Number(lastIncludedEv?.details?.spotPriceUsdcPerWeth || 0),
      Number(lastIncludedEv?.spotPriceUsdcPerWeth || 0),
      Number(mintEv?.details?.spotPriceUsdcPerWeth || 0),
      Number(mintEv?.spotPriceUsdcPerWeth || 0),
      Number(rec?.exit?.spotPriceUsdcPerWeth || 0),
    ];
    const spot = spotCandidates.find((v) => Number.isFinite(v) && v > 0) || 0;
    const topupValueUsd = (topupUsdc > 0 ? topupUsdc : 0) + (spot > 0 ? (topupWeth * spot) : 0);
    let entryValueUsd = 0;
    if (rawMintValueUsd > 0) {
      // Most reliable for tax backfill: mint event already stores raw USD at execution time.
      entryValueUsd = rawMintValueUsd + topupValueUsd;
    } else if (spot > 0 && hasMintTokenBaseline) {
      entryValueUsd = entryUsdc + (entryWeth * spot);
    } else {
      entryValueUsd = Math.max(0, rawMintValueUsd);
    }
    const entryAtIso = lastIncludedEv?.atIso || mintEv?.atIso || closeAtIso || null;

    if (!(entryValueUsd > 0) && !(entryWeth > 0 || entryUsdc > 0 || topupWeth > 0 || topupUsdc > 0)) return null;
    const entryTokens = hasMintTokenBaseline
      ? { weth: Math.max(0, entryWeth), usdc: Math.max(0, entryUsdc) }
      : { weth: 0, usdc: 0 };
    const noteBase =
      Number.isFinite(closeMs) && closeMs - mintMs < 60_000
        ? "entry snapshot fallback (position closed before delayed entry snapshot)"
        : "entry snapshot fallback (reconstructed from mint/top-up events)";
    const note = hasMintTokenBaseline
      ? noteBase
      : `${noteBase}; value baseline recovered but token baseline unavailable`;
    return {
      entrySnapshotAtIso: entryAtIso,
      entryTokens,
      entryValueUsd: Math.max(0, entryValueUsd),
      spotPriceUsdcPerWeth: Math.max(0, Number(spot || 0)),
      rawMintValueUsd: rawMintValueUsd > 0 ? rawMintValueUsd : null,
      topUpCount,
      lastContributionAtIso: lastIncludedEv?.atIso || mintEv?.atIso || closeAtIso || null,
      approx: true,
      note,
    };
  }

  deriveValueOnlyEntryBaselineForRecord(rec, { closeAtIso = null } = {}) {
    if (!rec) return null;
    const tokenId = rec?.tokenId != null ? String(rec.tokenId) : "";
    const allEvents = Array.isArray(this.positionLifecycleEvents) ? this.positionLifecycleEvents : [];
    const openTxSet = new Set(
      (Array.isArray(rec?.tx?.openTxHashes) ? rec.tx.openTxHashes : [])
        .filter(Boolean)
        .map((h) => String(h).toLowerCase())
    );
    const events = allEvents.filter((ev) => {
      const tokenCandidates = [
        ev?.tokenId,
        ev?.details?.mintedTokenId,
        ev?.details?.closedTokenId,
      ]
        .filter(Boolean)
        .map((v) => String(v));
      const tokenMatch = tokenId ? tokenCandidates.includes(tokenId) : false;
      const txMatch = openTxSet.size > 0
        ? (Array.isArray(ev?.txHashes) ? ev.txHashes : []).some((h) => openTxSet.has(String(h).toLowerCase()))
        : false;
      return tokenMatch || txMatch;
    });
    events.sort((a, b) => Date.parse(a?.atIso || "") - Date.parse(b?.atIso || ""));

    const mintEv = events.find((ev) => ev?.type === "OPEN_MINT" || ev?.type === "REBALANCE_MINT");
    const closeMs = Date.parse(closeAtIso || rec?.exit?.closedAtIso || "");
    const exitSpot = Number(rec?.exit?.spotPriceUsdcPerWeth || 0);
    const recRawMintValue = Number(rec?.entry?.rawMintValueUsd || 0);

    if (!mintEv) {
      if (!(recRawMintValue > 0)) return null;
      return {
        entrySnapshotAtIso: rec?.entry?.openedAtIso || closeAtIso || nowIso(),
        entryTokens: { weth: 0, usdc: 0 },
        entryValueUsd: recRawMintValue,
        spotPriceUsdcPerWeth: Math.max(0, exitSpot),
        rawMintValueUsd: recRawMintValue,
        topUpCount: 0,
        lastContributionAtIso: rec?.entry?.openedAtIso || closeAtIso || nowIso(),
        approx: true,
        note: "entry snapshot fallback (value-only from stored raw mint value)",
      };
    }

    const mintMs = Date.parse(mintEv?.atIso || "");
    if (!Number.isFinite(mintMs)) return null;
    const latestEntrySnapshotMs = events.reduce((latest, ev) => {
      if (ev?.type !== "ENTRY_SNAPSHOT") return latest;
      const evMs = Date.parse(ev?.atIso || "");
      return Number.isFinite(evMs) ? Math.max(latest, evMs) : latest;
    }, Number.NEGATIVE_INFINITY);
    let cutoffMs = mintMs + ENTRY_SNAPSHOT_FALLBACK_WINDOW_MS;
    if (Number.isFinite(latestEntrySnapshotMs)) {
      cutoffMs = Math.max(cutoffMs, latestEntrySnapshotMs);
    }
    if (Number.isFinite(closeMs)) cutoffMs = Math.min(cutoffMs, closeMs);

    const spotCandidates = [
      Number(mintEv?.details?.spotPriceUsdcPerWeth || 0),
      Number(mintEv?.spotPriceUsdcPerWeth || 0),
      exitSpot,
    ];
    const baseSpot = spotCandidates.find((v) => Number.isFinite(v) && v > 0) || 0;
    let valueUsd = Number(mintEv?.details?.rawMintValueUsd || recRawMintValue || 0);
    let lastIncludedEv = mintEv;
    let topUpCount = 0;

    for (const ev of events) {
      const evMs = Date.parse(ev?.atIso || "");
      if (!Number.isFinite(evMs) || evMs < mintMs || evMs > cutoffMs) continue;
      if (ev === mintEv) continue;
      if (ev?.type !== "TOP_UP") continue;
      topUpCount += 1;
      const p = ev?.details?.principalAdded || {};
      const addUsdc = Number(p.usdc || 0);
      const addWeth = Number(p.weth || 0);
      const spot = Number(
        ev?.details?.spotPriceUsdcPerWeth ||
        ev?.spotPriceUsdcPerWeth ||
        baseSpot ||
        0
      );
      valueUsd += Math.max(0, addUsdc) + (spot > 0 ? Math.max(0, addWeth) * spot : 0);
      lastIncludedEv = ev;
    }

    if (!(valueUsd > 0)) return null;
    return {
      entrySnapshotAtIso: lastIncludedEv?.atIso || mintEv?.atIso || rec?.entry?.openedAtIso || closeAtIso || nowIso(),
      entryTokens: { weth: 0, usdc: 0 },
      entryValueUsd: valueUsd,
      spotPriceUsdcPerWeth: Math.max(0, baseSpot),
      rawMintValueUsd: Number(mintEv?.details?.rawMintValueUsd || recRawMintValue || 0) || null,
      topUpCount,
      lastContributionAtIso: lastIncludedEv?.atIso || mintEv?.atIso || rec?.entry?.openedAtIso || closeAtIso || nowIso(),
      approx: true,
      note: "entry snapshot fallback (value-only reconstruction from mint/top-up events)",
    };
  }

  applyEntryBaselineFallbackToRecord(rec, baseline) {
    if (!rec || !baseline) return false;
    const beforeKey = JSON.stringify({
      at: rec.entry?.entrySnapshotAtIso || null,
      v: Number(rec.entry?.entryValueUsd || 0),
      w: Number(rec.entry?.entryTokens?.weth || 0),
      u: Number(rec.entry?.entryTokens?.usdc || 0),
      p: Number(rec.entry?.spotPriceUsdcPerWeth || 0),
    });
    rec.entry.entrySnapshotAtIso = baseline.entrySnapshotAtIso || rec.entry.entrySnapshotAtIso || rec.entry.openedAtIso || nowIso();
    rec.entry.entryValueUsd = Number(baseline.entryValueUsd || rec.entry.entryValueUsd || 0);
    rec.entry.entryTokens = {
      weth: Number(baseline.entryTokens?.weth || rec.entry.entryTokens?.weth || 0),
      usdc: Number(baseline.entryTokens?.usdc || rec.entry.entryTokens?.usdc || 0),
    };
    rec.entry.spotPriceUsdcPerWeth = Number(
      baseline.spotPriceUsdcPerWeth || rec.entry.spotPriceUsdcPerWeth || 0
    );
    if (baseline.rawMintValueUsd != null && Number(baseline.rawMintValueUsd) > 0) {
      rec.entry.rawMintValueUsd = Number(baseline.rawMintValueUsd);
    }
    rec.entry.entrySnapshotApprox = Boolean(baseline.approx);
    if (baseline.note) rec.entry.entrySnapshotNote = String(baseline.note);
    rec._internal.baselineWeth = Number(rec.entry.entryTokens?.weth || 0);
    rec._internal.baselineUsdc = Number(rec.entry.entryTokens?.usdc || 0);
    rec._internal.entryCaptured = (Math.abs(rec._internal.baselineWeth) > 0 || Math.abs(rec._internal.baselineUsdc) > 0);
    rec._internal.openPhaseDone = true;
    this.appendLifecycleRecordNote(rec, baseline.note || "entry snapshot fallback applied");
    const afterKey = JSON.stringify({
      at: rec.entry?.entrySnapshotAtIso || null,
      v: Number(rec.entry?.entryValueUsd || 0),
      w: Number(rec.entry?.entryTokens?.weth || 0),
      u: Number(rec.entry?.entryTokens?.usdc || 0),
      p: Number(rec.entry?.spotPriceUsdcPerWeth || 0),
    });
    return beforeKey !== afterKey;
  }

  shouldReplaceEntryBaseline(rec, baseline) {
    if (!rec || !baseline) return false;
    if (this.isEntrySnapshotMissing(rec)) return true;

    const currentValueUsd = Number(rec?.entry?.entryValueUsd || 0);
    const nextValueUsd = Number(baseline?.entryValueUsd || 0);
    const currentWeth = Number(rec?.entry?.entryTokens?.weth || 0);
    const currentUsdc = Number(rec?.entry?.entryTokens?.usdc || 0);
    const nextWeth = Number(baseline?.entryTokens?.weth || 0);
    const nextUsdc = Number(baseline?.entryTokens?.usdc || 0);
    const spot = Number(
      baseline?.spotPriceUsdcPerWeth ||
      rec?.entry?.spotPriceUsdcPerWeth ||
      rec?.exit?.spotPriceUsdcPerWeth ||
      0
    );
    const tokenDeltaUsd =
      Math.abs(nextUsdc - currentUsdc) +
      (spot > 0 ? Math.abs(nextWeth - currentWeth) * spot : 0);
    const currentApprox = Boolean(rec?.entry?.entrySnapshotApprox);
    const nextApprox = Boolean(baseline?.approx);
    const topUpCount = Math.max(0, Number(baseline?.topUpCount || 0));
    const currentSnapshotMs = Date.parse(rec?.entry?.entrySnapshotAtIso || "");
    const lastContributionMs = Date.parse(
      baseline?.lastContributionAtIso || baseline?.entrySnapshotAtIso || ""
    );

    if (
      topUpCount > 0 &&
      Number.isFinite(currentSnapshotMs) &&
      Number.isFinite(lastContributionMs) &&
      currentSnapshotMs < lastContributionMs + 45_000
    ) {
      return true;
    }

    if (nextValueUsd > currentValueUsd + 1) return true;
    if (nextWeth > currentWeth + 1e-9) return true;
    if (nextUsdc > currentUsdc + 1e-6) return true;
    if ((currentApprox || nextApprox) && (Math.abs(nextValueUsd - currentValueUsd) > 1 || tokenDeltaUsd > 1)) {
      return true;
    }
    return false;
  }

  ensureEntryBaselineBeforeClose(rec, { closeAtIso = null } = {}) {
    if (!rec || !this.isEntrySnapshotMissing(rec)) return false;
    let baseline = this.deriveFallbackEntryBaselineForRecord(rec, { closeAtIso });
    if (!baseline) {
      baseline = this.deriveValueOnlyEntryBaselineForRecord(rec, { closeAtIso });
    }
    if (!baseline) return false;
    return this.applyEntryBaselineFallbackToRecord(rec, baseline);
  }

  repairLifecycleRecordsMissingEntrySnapshots() {
    let repaired = 0;
    for (const rec of Array.isArray(this.positionRecords) ? this.positionRecords : []) {
      if (!rec) continue;
      const closeAtIso = rec?.exit?.closedAtIso || null;
      let changed = false;
      const fallback = this.deriveFallbackEntryBaselineForRecord(rec, { closeAtIso });
      if (fallback && this.shouldReplaceEntryBaseline(rec, fallback)) {
        changed = this.applyEntryBaselineFallbackToRecord(rec, fallback);
      }
      if (!changed && this.isEntrySnapshotMissing(rec)) {
        const valueOnly = this.deriveValueOnlyEntryBaselineForRecord(rec, { closeAtIso });
        if (valueOnly && this.shouldReplaceEntryBaseline(rec, valueOnly)) {
          changed = this.applyEntryBaselineFallbackToRecord(rec, valueOnly);
        }
      }
      if (!changed && this.isEntrySnapshotMissing(rec)) {
        const rawMintValueUsd = Number(rec?.entry?.rawMintValueUsd || 0);
        const exitSpot = Number(rec?.exit?.spotPriceUsdcPerWeth || 0);
        if (rawMintValueUsd > 0) {
          changed = this.applyEntryBaselineFallbackToRecord(rec, {
            entrySnapshotAtIso: rec?.entry?.openedAtIso || closeAtIso || nowIso(),
            entryTokens: { weth: 0, usdc: 0 },
            entryValueUsd: rawMintValueUsd,
            spotPriceUsdcPerWeth: Math.max(0, exitSpot),
            rawMintValueUsd,
            topUpCount: 0,
            lastContributionAtIso: rec?.entry?.openedAtIso || closeAtIso || nowIso(),
            approx: true,
            note: "entry snapshot fallback (raw mint value only, startup repair)",
          });
        }
      }
      if (!changed) continue;
      this.recomputeLifecycleRecordDerived(rec);
      repaired += 1;
    }
    return repaired;
  }

  updateBaselineFromSwap(rec, details = {}) {
    if (!rec?._internal?.entryCaptured) return;
    const tokenIn = details.tokenIn;
    const tokenOut = details.tokenOut;
    const actualIn = (() => {
      try {
        return BigInt(details.actualIn || 0);
      } catch {
        return 0n;
      }
    })();
    const actualOut = (() => {
      try {
        return BigInt(details.actualOut || 0);
      } catch {
        return 0n;
      }
    })();
    if (sameAddress(tokenIn, this.weth)) rec._internal.baselineWeth -= Number(formatUnits(actualIn, WETH_DECIMALS));
    if (sameAddress(tokenOut, this.weth)) rec._internal.baselineWeth += Number(formatUnits(actualOut, WETH_DECIMALS));
    if (sameAddress(tokenIn, this.usdc)) rec._internal.baselineUsdc -= Number(formatUnits(actualIn, USDC_DECIMALS));
    if (sameAddress(tokenOut, this.usdc)) rec._internal.baselineUsdc += Number(formatUnits(actualOut, USDC_DECIMALS));
  }

  updateBaselineFromPrincipalAdd(rec, principal = {}) {
    if (!rec?._internal?.entryCaptured) return;
    rec._internal.baselineWeth += Number(principal.weth || 0);
    rec._internal.baselineUsdc += Number(principal.usdc || 0);
  }

  recomputeLifecycleRecordDerived(rec) {
    if (!rec) return;
    const perf = rec.performance;
    perf.totalCostsUsd = Number(perf.gasUsd || 0) + Number(perf.swapCostUsd || 0);
    perf.feesNetUsd =
      Number(perf.feesCollectedUsd || 0) +
      Number(perf.rewardsUsd || 0) -
      Number(perf.totalCostsUsd || 0);
    // Use swap-adjusted baseline when available (consistent with live HODL gate
    // and closeLifecycleRecordFromPrincipalOut). Fall back to original entry tokens.
    const hasAdjustedBaseline = Boolean(rec._internal?.entryCaptured) &&
      (Math.abs(Number(rec._internal?.baselineWeth || 0)) > 0 || Math.abs(Number(rec._internal?.baselineUsdc || 0)) > 0);
    const baselineWeth = hasAdjustedBaseline ? Number(rec._internal.baselineWeth) : Number(rec.entry?.entryTokens?.weth || 0);
    const baselineUsdc = hasAdjustedBaseline ? Number(rec._internal.baselineUsdc) : Number(rec.entry?.entryTokens?.usdc || 0);
    const exitWeth = Number(rec.exit?.exitTokens?.weth || 0);
    const exitUsdc = Number(rec.exit?.exitTokens?.usdc || 0);
    const exitSpot = Number(rec.exit?.spotPriceUsdcPerWeth || 0);
    if (
      rec.status === "CLOSED" &&
      exitSpot > 0 &&
      (Math.abs(baselineWeth) > 0 || Math.abs(baselineUsdc) > 0) &&
      (Math.abs(exitWeth) > 0 || Math.abs(exitUsdc) > 0)
    ) {
      const hodlExitUsd = baselineUsdc + baselineWeth * exitSpot;
      const lpExitPrincipalUsd = exitUsdc + exitWeth * exitSpot;
      perf.impermanentLossUsd = lpExitPrincipalUsd - hodlExitUsd;
    } else {
      perf.impermanentLossUsd = Number(perf.impermanentLossUsd || 0);
    }
    // Signed benchmark delta: LP principal value minus HODL principal value at exit.
    perf.divergenceVsHodlUsd = Number(perf.impermanentLossUsd || 0);
    perf.costToFeeRatio =
      Number(perf.totalCostsUsd || 0) / Math.max(Number(perf.feesCollectedUsd || 0), 1e-9);
    const entryValueUsd = Number(rec.entry?.entryValueUsd || 0);
    const exitValueUsd = Number(rec.exit?.exitValueUsd || 0);
    perf.capitalGainLossUsd =
      rec.status === "CLOSED" && entryValueUsd > 0 && Number.isFinite(exitValueUsd)
        ? (exitValueUsd - entryValueUsd)
        : Number(perf.capitalGainLossUsd || 0) || 0;
    // Absolute realized PnL (for tax/economic view) = principal move + net fees income.
    perf.netProfitUsd = Number(perf.feesNetUsd || 0) + Number(perf.capitalGainLossUsd || 0);
    // Benchmark-relative result vs HODL principal + fees net (optional analytic field).
    perf.alphaVsHodlUsd = Number(perf.feesNetUsd || 0) + Number(perf.divergenceVsHodlUsd || 0);
    perf.requiredFeesToBeatHodlUsd = Math.max(0, -Number(perf.divergenceVsHodlUsd || 0));
    perf.avgDeployedUsd = rec.status === "CLOSED" && exitValueUsd > 0
      ? (entryValueUsd + exitValueUsd) / 2
      : entryValueUsd;

    // Duration/APR should reflect how long the LP NFT was actually open on-chain.
    // Keep entrySnapshotAtIso only as the valuation/HODL baseline.
    const openedAtMs = Date.parse(rec.entry?.openedAtIso || rec.entry?.entrySnapshotAtIso || "");
    const closedAtMs = Date.parse(rec.exit?.closedAtIso || "");
    if (Number.isFinite(openedAtMs) && Number.isFinite(closedAtMs) && closedAtMs > openedAtMs) {
      rec.duration.secondsInPosition = Math.round((closedAtMs - openedAtMs) / 1000);
      rec.duration.human = humanDurationFromSeconds(rec.duration.secondsInPosition);
      const days = rec.duration.secondsInPosition / 86400;
      if (days > 0 && perf.avgDeployedUsd > 0) {
        perf.feeApr = (perf.feesNetUsd / perf.avgDeployedUsd) * (365 / days) * 100;
        perf.alphaApr = (perf.alphaVsHodlUsd / perf.avgDeployedUsd) * (365 / days) * 100;
        perf.absoluteApr = (perf.netProfitUsd / perf.avgDeployedUsd) * (365 / days) * 100;
        // Backward-compatible mirror used by existing UI cards.
        perf.apr = perf.absoluteApr;
      }
    } else if (Number.isFinite(openedAtMs) && openedAtMs > 0) {
      rec.duration.secondsInPosition = null;
      rec.duration.human = null;
      perf.feeApr = 0;
      perf.alphaApr = 0;
      perf.absoluteApr = 0;
      perf.apr = 0;
    }
    rec.updatedAtIso = nowIso();
  }

  applyLifecycleCloseContext(rec, { closeReason = null, closeHoldTarget = null } = {}) {
    if (!rec) return;
    if (closeReason != null) {
      const nextReason = this.normalizeLifecycleCloseReason(closeReason, rec.closeReason || "close_position");
      if (nextReason) rec.closeReason = nextReason;
    }
    if (closeHoldTarget != null) {
      const nextTarget = String(closeHoldTarget || "").trim();
      rec.closeHoldTarget = nextTarget || null;
    }
  }

  normalizeLifecycleCloseReason(reason, fallback = "close_position") {
    const raw = String(reason || "").trim();
    if (!raw) return fallback;
    const normalized = raw.toLowerCase();
    const invalidCloseReasons = new Set([
      "auto",
      "open_position",
      "open_swap",
      "idle_deploy",
      "mean_reversion_reentry",
      "reentry",
      "reentry_failed",
      "trend_escape_hold",
    ]);
    if (invalidCloseReasons.has(normalized)) return fallback;
    return raw;
  }

  applyLifecycleEventToRecords(ev) {
    if (!ev || typeof ev !== "object") return;
    const runId = String(ev.positionRunId || "");
    if (!runId) return;
    const type = String(ev.type || "");
    const txHashes = Array.isArray(ev.txHashes) ? ev.txHashes : [];
    const touchRecordCommon = (rec) => {
      if (!rec) return;
      rec.updatedAtIso = ev.atIso || nowIso();
      if (ev.venue) rec.venue = ev.venue;
      if (ev.poolAddress) rec.poolAddress = ev.poolAddress;
      if (ev.details?.selector) rec.selector = { ...rec.selector, ...ev.details.selector };
      if (ev.band && typeof ev.band === "object") {
        rec.band = {
          bandHalfBps: Number(ev.band.bandHalfBps || rec.band.bandHalfBps || 0),
          tickLower: Number(ev.band.tickLower ?? rec.band.tickLower ?? 0),
          tickUpper: Number(ev.band.tickUpper ?? rec.band.tickUpper ?? 0),
        };
      }
      if (ev.accounting) this.addAccountingToRecord(rec, ev.accounting);
      this.addUniqueTxHashes(rec.tx.allTxHashes, txHashes);
      rec.activity.txCount = rec.tx.allTxHashes.length;
    };
    const currentTokenId = this.lifecycleCurrentTokenByRunId.get(runId) || null;
    const resolveTokenId = (...candidates) => {
      for (const c of candidates) {
        if (c == null) continue;
        const s = String(c);
        if (s) return s;
      }
      return null;
    };
    const getRecordForToken = (tokenId, { create = false, seedEvent = ev } = {}) => {
      const id = resolveTokenId(tokenId);
      if (!id) return null;
      let rec = this.positionRecordsById.get(id);
      if (!rec && create) {
        rec = this.getLifecycleRecordById(id, {
          createFromEvent: {
            ...seedEvent,
            tokenId: id,
          },
        });
        if (rec) rec.tokenId = id;
      }
      if (rec && !rec.tokenId) rec.tokenId = id;
      return rec;
    };

    if (type === "OPEN_POSITION") {
      const pending = this.getOrCreatePendingOpenForRun(runId, {
        openedAtIso: ev.atIso,
        selector: ev.details?.selector || null,
        band: ev.band || ev.details?.plannedBand || null,
      });
      if (pending) pending.notes = pending.notes || String(ev.details?.reason || "open_position");
    } else if (type === "OPEN_SWAP" || type === "REBALANCE_INVENTORY_SWAP") {
      const pending = this.getOrCreatePendingOpenForRun(runId, {
        openedAtIso: ev.atIso,
        band: ev.band || null,
      });
      this.addLifecycleEventToPendingOpen(pending, ev, { countAsSwap: true });
    } else if (type === "OPEN_MINT" || type === "REBALANCE_MINT") {
      const mintedTokenId = resolveTokenId(ev.details?.mintedTokenId, ev.tokenId);
      const rec = getRecordForToken(mintedTokenId, { create: true });
      if (rec) {
        const pending = this.getOrCreatePendingOpenForRun(runId, null);
        if (pending) {
          this.applyPendingOpenToRecord(rec, pending);
          this.lifecyclePendingOpenByRunId.delete(runId);
        }
        touchRecordCommon(rec);
        rec.status = "OPEN";
        rec.entry.openedAtIso = ev.atIso || rec.entry.openedAtIso;
        this.addUniqueTxHashes(rec.tx.openTxHashes, txHashes);
        if (ev.band) rec.band = { ...rec.band, ...ev.band };
        const rawMintValueUsd = Number(ev.details?.rawMintValueUsd || 0);
        if (rawMintValueUsd > 0 && !(Number(rec.entry.rawMintValueUsd || 0) > 0)) {
          rec.entry.rawMintValueUsd = rawMintValueUsd;
        }
        this.recomputeLifecycleRecordDerived(rec);
      }
      if (mintedTokenId) this.lifecycleCurrentTokenByRunId.set(runId, mintedTokenId);
    } else if (type === "TOP_UP") {
      const tokenId = resolveTokenId(ev.tokenId, currentTokenId);
      const rec = getRecordForToken(tokenId, { create: false });
      if (rec) {
        touchRecordCommon(rec);
        rec.activity.swaps += Number(ev.details?.swapsInAction || 0);
        this.addUniqueTxHashes(rec.tx.openTxHashes, txHashes);
        const principalAdded = ev.details?.principalAdded || {};
        const topUpSpot = Number(
          ev?.details?.spotPriceUsdcPerWeth ||
          ev?.spotPriceUsdcPerWeth ||
          rec?.entry?.spotPriceUsdcPerWeth ||
          this.getSpotUsdcPerWeth() ||
          0
        );
        if (rec.entry?.entrySnapshotAtIso) {
          rec.entry.entryTokens = {
            weth: Number(rec.entry?.entryTokens?.weth || 0) + Number(principalAdded.weth || 0),
            usdc: Number(rec.entry?.entryTokens?.usdc || 0) + Number(principalAdded.usdc || 0),
          };
          rec.entry.entryValueUsd =
            Number(rec.entry?.entryValueUsd || 0) +
            Number(principalAdded.usdc || 0) +
            (topUpSpot > 0 ? Number(principalAdded.weth || 0) * topUpSpot : 0);
          if (!(Number(rec.entry?.spotPriceUsdcPerWeth || 0) > 0) && topUpSpot > 0) {
            rec.entry.spotPriceUsdcPerWeth = topUpSpot;
          }
        }
        this.updateBaselineFromPrincipalAdd(rec, principalAdded);
        this.recomputeLifecycleRecordDerived(rec);
      }
    } else if (type === "ENTRY_SNAPSHOT") {
      const tokenId = resolveTokenId(ev.tokenId, currentTokenId);
      const rec = getRecordForToken(tokenId, { create: false });
      if (rec) {
        touchRecordCommon(rec);
        const entryTokens = ev.details?.entryTokens || {};
        rec.entry.entrySnapshotAtIso = ev.atIso || rec.entry.entrySnapshotAtIso;
        rec.entry.entryValueUsd = Number(ev.details?.entryValueUsd || rec.entry.entryValueUsd || 0);
        rec.entry.entryTokens = {
          weth: Number(entryTokens.weth || 0),
          usdc: Number(entryTokens.usdc || 0),
        };
        rec.entry.spotPriceUsdcPerWeth = Number(ev.details?.spotPriceUsdcPerWeth || ev.spotPriceUsdcPerWeth || 0);
        if (Number(ev.details?.rawMintValueUsd || 0) > 0) {
          rec.entry.rawMintValueUsd = Number(ev.details.rawMintValueUsd);
        }
        rec._internal.baselineWeth = rec.entry.entryTokens.weth;
        rec._internal.baselineUsdc = rec.entry.entryTokens.usdc;
        rec._internal.entryCaptured = true;
        rec._internal.openPhaseDone = true;
        this.recomputeLifecycleRecordDerived(rec);
      }
    } else if (type === "HARVEST_COLLECT") {
      const tokenId = resolveTokenId(ev.tokenId, currentTokenId);
      const rec = getRecordForToken(tokenId, { create: false });
      if (rec) {
        touchRecordCommon(rec);
        rec.activity.harvests += 1;
        this.recomputeLifecycleRecordDerived(rec);
      }
    } else if (type === "TREND_ESCAPE_START") {
      const tokenId = resolveTokenId(ev.tokenId, currentTokenId);
      const rec = getRecordForToken(tokenId, { create: false });
      if (rec) {
        touchRecordCommon(rec);
        this.applyLifecycleCloseContext(rec, {
          closeReason: ev.details?.reason || "trend_escape",
          closeHoldTarget: ev.details?.holdTarget || null,
        });
        this.recomputeLifecycleRecordDerived(rec);
      }
    } else if (type === "REBALANCE_START") {
      const closingTokenId = resolveTokenId(ev.tokenId, currentTokenId);
      const rec = getRecordForToken(closingTokenId, { create: false });
      if (rec) {
        touchRecordCommon(rec);
        rec.activity.rebalances += 1;
        this.applyLifecycleCloseContext(rec, {
          closeReason: this.normalizeLifecycleCloseReason(ev.details?.reason, "rebalance"),
          closeHoldTarget: null,
        });
        this.recomputeLifecycleRecordDerived(rec);
      }
      this.getOrCreatePendingOpenForRun(runId, {
        openedAtIso: ev.atIso,
        band: ev.details?.newBand || null,
      });
    } else if (type === "REBALANCE_CLOSE") {
      const tokenId = resolveTokenId(ev.details?.closedTokenId, ev.tokenId, currentTokenId);
      const rec = getRecordForToken(tokenId, { create: false });
      if (rec) {
        touchRecordCommon(rec);
        this.addUniqueTxHashes(rec.tx.closeTxHashes, txHashes);
        const principalOut = ev.details?.principalOut || {};
        this.ensureEntryBaselineBeforeClose(rec, { closeAtIso: ev.atIso || null });
        this.closeLifecycleRecordFromPrincipalOut(rec, {
          atIso: ev.atIso || null,
          principalOut,
          spotPriceUsdcPerWeth: Number(ev.spotPriceUsdcPerWeth || 0),
        });
        this.recomputeLifecycleRecordDerived(rec);
      }
      if (tokenId && this.lifecycleCurrentTokenByRunId.get(runId) === tokenId) {
        this.lifecycleCurrentTokenByRunId.delete(runId);
      }
    } else if (type === "CLOSE_POSITION_START") {
      const tokenId = resolveTokenId(ev.tokenId, currentTokenId);
      const rec = getRecordForToken(tokenId, { create: false });
      if (rec) {
        touchRecordCommon(rec);
        this.applyLifecycleCloseContext(rec, {
          closeReason: ev.details?.reason || rec.closeReason || "close_position",
          closeHoldTarget: ev.details?.holdTarget || rec.closeHoldTarget || null,
        });
        this.addUniqueTxHashes(rec.tx.closeTxHashes, txHashes);
        this.recomputeLifecycleRecordDerived(rec);
      }
    } else if (type === "CLOSE_POSITION") {
      const tokenId = resolveTokenId(ev.details?.closedTokenId, ev.tokenId, currentTokenId);
      const rec = getRecordForToken(tokenId, { create: false });
      if (rec) {
        touchRecordCommon(rec);
        this.applyLifecycleCloseContext(rec, {
          closeReason: rec.closeReason || ev.details?.reason || "close_position",
          closeHoldTarget: rec.closeHoldTarget || ev.details?.holdTarget || null,
        });
        this.addUniqueTxHashes(rec.tx.closeTxHashes, txHashes);
        const principalOut = ev.details?.principalOut || {};
        this.ensureEntryBaselineBeforeClose(rec, { closeAtIso: ev.atIso || null });
        this.closeLifecycleRecordFromPrincipalOut(rec, {
          atIso: ev.atIso || null,
          principalOut,
          spotPriceUsdcPerWeth: Number(ev.details?.spotPriceUsdcPerWeth || ev.spotPriceUsdcPerWeth || 0),
          exitValueUsd: Number(ev.details?.exitValueUsd || 0),
        });
        this.recomputeLifecycleRecordDerived(rec);
      }
      if (tokenId && this.lifecycleCurrentTokenByRunId.get(runId) === tokenId) {
        this.lifecycleCurrentTokenByRunId.delete(runId);
      }
    } else if (type === "EXIT_SNAPSHOT") {
      const tokenId = resolveTokenId(ev.tokenId, currentTokenId);
      const rec = getRecordForToken(tokenId, { create: false });
      if (rec) {
        touchRecordCommon(rec);
        this.ensureEntryBaselineBeforeClose(rec, { closeAtIso: ev.atIso || null });
        const exitTokens = ev.details?.exitTokens || rec.exit.exitTokens || {};
        this.closeLifecycleRecordFromPrincipalOut(rec, {
          atIso: ev.atIso || null,
          principalOut: exitTokens,
          spotPriceUsdcPerWeth: Number(ev.details?.spotPriceUsdcPerWeth || ev.spotPriceUsdcPerWeth || rec.exit?.spotPriceUsdcPerWeth || 0),
          exitValueUsd: Number(ev.details?.exitValueUsd || rec.exit?.exitValueUsd || 0),
        });
        this.recomputeLifecycleRecordDerived(rec);
      }
      if (tokenId && this.lifecycleCurrentTokenByRunId.get(runId) === tokenId) {
        this.lifecycleCurrentTokenByRunId.delete(runId);
      }
    }

    this.positionRecords.sort((a, b) => {
      const aClosed = Date.parse(a?.exit?.closedAtIso || "");
      const bClosed = Date.parse(b?.exit?.closedAtIso || "");
      const aOpen = a.status !== "CLOSED";
      const bOpen = b.status !== "CLOSED";
      if (aOpen !== bOpen) return aOpen ? -1 : 1;
      return (Number.isFinite(bClosed) ? bClosed : 0) - (Number.isFinite(aClosed) ? aClosed : 0);
    });
  }

  getClosedPositionRecordsSorted() {
    return (Array.isArray(this.positionRecords) ? this.positionRecords : [])
      .filter((r) => r && r.status === "CLOSED")
      .slice()
      .sort((a, b) => {
        const ams = Date.parse(a?.exit?.closedAtIso || "");
        const bms = Date.parse(b?.exit?.closedAtIso || "");
        return (Number.isFinite(bms) ? bms : 0) - (Number.isFinite(ams) ? ams : 0);
      });
  }

  getPositionRecordsPage(page = 1, pageSize = 10) {
    const p = Math.max(1, Math.floor(Number(page || 1)));
    const size = Math.max(1, Math.min(POSITION_PAGE_SIZE_MAX, Math.floor(Number(pageSize || 10))));
    const all = this.getClosedPositionRecordsSorted();
    const totalItems = all.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / size));
    const pageSafe = Math.min(p, totalPages);
    const start = (pageSafe - 1) * size;
    const items = all.slice(start, start + size).map((r) => this.sanitizePositionRecordForPersist(r));
    return {
      items,
      page: pageSafe,
      pageSize: size,
      totalItems,
      totalPages,
    };
  }

  getPositionsSummary(limit = POSITION_SUMMARY_LIMIT) {
    return this.getClosedPositionRecordsSorted()
      .slice(0, Math.max(0, Number(limit || POSITION_SUMMARY_LIMIT)))
      .map((r) => this.sanitizePositionRecordForPersist(r));
  }

  getPositionsTaxSummary() {
    const closed = this.getClosedPositionRecordsSorted();
    const byYear = new Map();
    let totalClosedPositions = 0;
    let totalRealizedNetProfitUsd = 0;
    let totalFeesCollectedUsd = 0;
    let totalRewardsUsd = 0;
    let totalTotalCostsUsd = 0;
    let totalFeesNetUsd = 0;
    let totalCapitalGainLossUsd = 0;
    let totalAlphaVsHodlUsd = 0;
    const currentYear = new Date().getUTCFullYear();
    const latest = this.state.latest || {};
    const walletValueUsd = Number(latest?.wallet?.valuesUsd?.total || 0);
    const lpValueUsd = Number(this.estimateAggregatedLpUsdValueFromLatest() || 0);
    const totalAssetValueTodayUsd = walletValueUsd + lpValueUsd;
    let latestYearSeen = null;

    for (const rec of closed) {
      const closedAtIso = rec?.exit?.closedAtIso || null;
      const closedAtMs = closedAtIso ? Date.parse(closedAtIso) : NaN;
      if (!Number.isFinite(closedAtMs)) continue;
      const year = new Date(closedAtMs).getUTCFullYear();
      if (!Number.isFinite(year)) continue;
      const perf = rec?.performance || {};
      const net = Number(perf.netProfitUsd || 0);
      const feesCollected = Number(perf.feesCollectedUsd || 0);
      const rewards = Number(perf.rewardsUsd || 0);
      const totalCosts = Number(perf.totalCostsUsd || 0);
      const feesNet = Number(perf.feesNetUsd || 0);
      const capitalGainLoss = Number(perf.capitalGainLossUsd || 0);
      const divergenceVsHodl = Number(
        perf.divergenceVsHodlUsd != null
          ? perf.divergenceVsHodlUsd
          : (perf.impermanentLossUsd || 0)
      );
      const alphaVsHodlRaw = Number(perf.alphaVsHodlUsd);
      const alphaVsHodl = Number.isFinite(alphaVsHodlRaw)
        ? alphaVsHodlRaw
        : (
            (Number.isFinite(feesNet) ? feesNet : 0) +
            (Number.isFinite(divergenceVsHodl) ? divergenceVsHodl : 0)
          );
      const entryValueUsd = [
        Number(rec?.entry?.entryValueUsd || 0),
        Number(perf.avgDeployedUsd || 0),
        Number(rec?.exit?.exitValueUsd || 0),
      ].find((v) => Number.isFinite(v) && v > 0) || 0;
      const openedAtIso =
        rec?.entry?.openedAtIso ||
        rec?.entry?.entrySnapshotAtIso ||
        rec?.createdAtIso ||
        rec?.exit?.closedAtIso ||
        null;
      const openedAtMs = openedAtIso ? Date.parse(openedAtIso) : NaN;
      totalClosedPositions += 1;
      totalRealizedNetProfitUsd += Number.isFinite(net) ? net : 0;
      totalFeesCollectedUsd += Number.isFinite(feesCollected) ? feesCollected : 0;
      totalRewardsUsd += Number.isFinite(rewards) ? rewards : 0;
      totalTotalCostsUsd += Number.isFinite(totalCosts) ? totalCosts : 0;
      totalFeesNetUsd += Number.isFinite(feesNet) ? feesNet : 0;
      totalCapitalGainLossUsd += Number.isFinite(capitalGainLoss) ? capitalGainLoss : 0;
      totalAlphaVsHodlUsd += Number.isFinite(alphaVsHodl) ? alphaVsHodl : 0;
      latestYearSeen = latestYearSeen == null ? year : Math.max(latestYearSeen, year);
      let row = byYear.get(year);
      if (!row) {
        row = {
          year,
          closedPositions: 0,
          realizedNetProfitUsd: 0,
          feesCollectedUsd: 0,
          rewardsUsd: 0,
          totalCostsUsd: 0,
          feesNetUsd: 0,
          capitalGainLossUsd: 0,
          alphaVsHodlUsd: 0,
          assetValueStartUsd: null,
          assetValueTodayUsd: null,
          ytdPct: null,
          firstOpenedAtIso: null,
          firstOpenedAtMs: null,
          firstClosedAtIso: null,
          lastClosedAtIso: null,
        };
        byYear.set(year, row);
      }
      row.closedPositions += 1;
      row.realizedNetProfitUsd += Number.isFinite(net) ? net : 0;
      row.feesCollectedUsd += Number.isFinite(feesCollected) ? feesCollected : 0;
      row.rewardsUsd += Number.isFinite(rewards) ? rewards : 0;
      row.totalCostsUsd += Number.isFinite(totalCosts) ? totalCosts : 0;
      row.feesNetUsd += Number.isFinite(feesNet) ? feesNet : 0;
      row.capitalGainLossUsd += Number.isFinite(capitalGainLoss) ? capitalGainLoss : 0;
      row.alphaVsHodlUsd += Number.isFinite(alphaVsHodl) ? alphaVsHodl : 0;
      if (
        Number.isFinite(openedAtMs) &&
        (!Number.isFinite(row.firstOpenedAtMs) || openedAtMs < row.firstOpenedAtMs)
      ) {
        row.firstOpenedAtIso = openedAtIso;
        row.firstOpenedAtMs = openedAtMs;
        row.assetValueStartUsd = Number.isFinite(entryValueUsd) && entryValueUsd > 0 ? entryValueUsd : row.assetValueStartUsd;
      }
      if (!Number.isFinite(row.assetValueStartUsd) || !(Number(row.assetValueStartUsd) > 0)) {
        row.assetValueStartUsd = Number.isFinite(entryValueUsd) && entryValueUsd > 0 ? entryValueUsd : row.assetValueStartUsd;
      }
      if (!row.firstClosedAtIso || closedAtIso < row.firstClosedAtIso) row.firstClosedAtIso = closedAtIso;
      if (!row.lastClosedAtIso || closedAtIso > row.lastClosedAtIso) row.lastClosedAtIso = closedAtIso;
    }

    const years = Array.from(byYear.values())
      .map((row) => {
        const startUsd = Number(row.assetValueStartUsd || 0);
        if (Number(row.year) === currentYear || (latestYearSeen != null && Number(row.year) === Number(latestYearSeen) && !byYear.has(currentYear))) {
          row.assetValueTodayUsd = totalAssetValueTodayUsd;
          row.ytdPct =
            Number.isFinite(startUsd) && startUsd > 0
              ? ((totalAssetValueTodayUsd / startUsd) - 1) * 100
              : null;
        } else {
          row.assetValueTodayUsd = null;
          row.ytdPct = null;
        }
        delete row.firstOpenedAtMs;
        return row;
      })
      .sort((a, b) => b.year - a.year);
    return {
      timezone: "UTC",
      dateRangeRule: "01-01..12-31",
      totals: {
        closedPositions: totalClosedPositions,
        feesCollectedUsd: totalFeesCollectedUsd,
        rewardsUsd: totalRewardsUsd,
        totalCostsUsd: totalTotalCostsUsd,
        feesNetUsd: totalFeesNetUsd,
        capitalGainLossUsd: totalCapitalGainLossUsd,
        alphaVsHodlUsd: totalAlphaVsHodlUsd,
        realizedNetProfitUsd: totalRealizedNetProfitUsd,
        totalAssetValueTodayUsd,
      },
      years,
    };
  }

  getActivePositionRecord() {
    const tokenId = this.state.position?.tokenId ? String(this.state.position.tokenId) : null;
    if (!tokenId) return null;
    let rec = this.positionRecordsById.get(tokenId);
    if (!rec && Array.isArray(this.positionRecords)) {
      rec = this.positionRecords.find((r) => String(r?.tokenId || r?.id || "") === tokenId) || null;
      if (rec) this.positionRecordsById.set(tokenId, rec);
    }
    if (!rec) {
      rec = this.ensureActiveLifecycleRecordFromTrackedPosition();
    }
    if (!rec || rec.status === "CLOSED") return null;
    return this.sanitizePositionRecordForPersist(rec);
  }

  ensureActiveLifecycleRecordFromTrackedPosition() {
    const tokenId = this.state.position?.tokenId ? String(this.state.position.tokenId) : null;
    if (!tokenId) return null;
    let rec = this.positionRecordsById.get(tokenId);
    if (!rec && Array.isArray(this.positionRecords)) {
      rec = this.positionRecords.find((r) => String(r?.tokenId || r?.id || "") === tokenId) || null;
      if (rec) this.positionRecordsById.set(tokenId, rec);
    }
    if (rec) {
      const note = String(rec?.entry?.entrySnapshotNote || "");
      const needsUpgrade = this.isEntrySnapshotMissing(rec) || note.includes("adopted active on-chain position");
      if (needsUpgrade) {
        const historicalBaseline =
          this.deriveFallbackEntryBaselineForRecord(rec, { closeAtIso: null }) ||
          this.deriveValueOnlyEntryBaselineForRecord(rec, { closeAtIso: null });
        if (historicalBaseline && this.shouldReplaceEntryBaseline(rec, historicalBaseline)) {
          this.applyEntryBaselineFallbackToRecord(rec, historicalBaseline);
          this.recomputeLifecycleRecordDerived(rec);
          this.persistPositionRecords().catch(() => {});
        }
      }
      return rec;
    }

    const pos = this.state.position || {};
    const venue = pos.venue === "uniswapv3" ? "uniswapv3" : "slipstream";
    const latest = this.state.latest || {};
    const primary = latest.primary || null;
    const fallback = latest.fallback || null;
    const activePool = venue === "uniswapv3" ? (fallback || primary) : (primary || fallback);
    const tickLower = Number(pos.tickLower);
    const tickUpper = Number(pos.tickUpper);
    const hasRange = Number.isFinite(tickLower) && Number.isFinite(tickUpper) && tickUpper > tickLower;
    const bandHalfBps = Number(pos.bandHalfBps || this.estimateBandHalfBpsFromTicks(tickLower, tickUpper) || this.settings.bandHalfBps || 0);
    const selector = this.selectorForVenue(venue, activePool || null);
    const now = nowIso();

    rec = this.getLifecycleRecordById(tokenId, {
      createFromEvent: {
        tokenId,
        venue,
        poolAddress: activePool?.pool || (venue === "uniswapv3" ? this.uniswapPool : this.slipstreamPool),
        atIso: now,
        band: {
          bandHalfBps,
          tickLower: Number.isFinite(tickLower) ? tickLower : 0,
          tickUpper: Number.isFinite(tickUpper) ? tickUpper : 0,
        },
        details: { selector },
      },
    });
    if (!rec) return null;

    // Prefer reconstructing the true entry baseline from historical lifecycle
    // events before falling back to a "current snapshot" baseline.
    const historicalBaseline =
      this.deriveFallbackEntryBaselineForRecord(rec, { closeAtIso: null }) ||
      this.deriveValueOnlyEntryBaselineForRecord(rec, { closeAtIso: null });
    if (historicalBaseline) {
      this.applyEntryBaselineFallbackToRecord(rec, historicalBaseline);
    }

    let baselineWeth = Number(rec?._internal?.baselineWeth || 0);
    let baselineUsdc = Number(rec?._internal?.baselineUsdc || 0);
    const hasHistoricalBaseline = Boolean(rec?._internal?.entryCaptured) &&
      (Math.abs(baselineWeth) > 0 || Math.abs(baselineUsdc) > 0);

    // If no historical baseline can be reconstructed, adopt current LP
    // composition as a degraded baseline to keep gate math coherent.
    const liquidityRaw = pos.liquidity ? BigInt(pos.liquidity) : 0n;
    if (!hasHistoricalBaseline && hasRange && liquidityRaw > 0n && activePool?.sqrtPriceX96) {
      const token0 = activePool?.token0 || this.weth;
      const token1 = activePool?.token1 || this.usdc;
      const amounts = this.lpAmountsFromLiquidity(
        liquidityRaw,
        tickLower,
        tickUpper,
        BigInt(activePool.sqrtPriceX96),
        token0,
        token1
      );
      baselineUsdc = Number(formatUnits(amounts.usdcRaw, USDC_DECIMALS));
      baselineWeth = Number(formatUnits(amounts.wethRaw, WETH_DECIMALS));
    }

    const spot = Number(this.getSpotUsdcPerWeth() || 0);
    const entryValueUsd = baselineUsdc + (spot > 0 ? baselineWeth * spot : 0);
    rec.status = "OPEN";
    rec.tokenId = tokenId;
    rec.venue = venue;
    rec.poolAddress = activePool?.pool || rec.poolAddress || (venue === "uniswapv3" ? this.uniswapPool : this.slipstreamPool);
    rec.selector = { ...rec.selector, ...selector };
    rec.band = {
      ...rec.band,
      bandHalfBps,
      tickLower: Number.isFinite(tickLower) ? tickLower : rec.band.tickLower,
      tickUpper: Number.isFinite(tickUpper) ? tickUpper : rec.band.tickUpper,
    };
    rec.entry.openedAtIso = rec.entry.openedAtIso || now;
    rec.entry.entrySnapshotAtIso = rec.entry.entrySnapshotAtIso || now;
    rec.entry.entryTokens = { weth: baselineWeth, usdc: baselineUsdc };
    rec.entry.entryValueUsd = entryValueUsd > 0 ? entryValueUsd : Number(rec.entry.entryValueUsd || 0);
    rec.entry.spotPriceUsdcPerWeth = spot > 0 ? spot : Number(rec.entry.spotPriceUsdcPerWeth || 0);
    rec.entry.entrySnapshotApprox = true;
    if (!hasHistoricalBaseline) {
      rec.entry.entrySnapshotNote = "entry snapshot fallback (adopted active on-chain position)";
    }
    rec._internal.baselineWeth = baselineWeth;
    rec._internal.baselineUsdc = baselineUsdc;
    rec._internal.entryCaptured = Math.abs(baselineWeth) > 0 || Math.abs(baselineUsdc) > 0;
    rec._internal.openPhaseDone = true;
    this.appendLifecycleRecordNote(rec, "adopted active on-chain position after lifecycle gap");
    this.recomputeLifecycleRecordDerived(rec);
    this.persistPositionRecords().catch(() => {});
    return rec;
  }

  async maybeEmitPendingEntrySnapshot() {
    const pending = this.state.pendingEntrySnapshot;
    if (!pending || !pending.positionRunId || pending.emitted) return false;
    const dueMs = Date.parse(pending.dueAtIso || "");
    if (!(Number.isFinite(dueMs) && Date.now() >= dueMs)) return false;
    if (!this.state.position?.tokenId) return false;
    const latest = this.state.latest || {};
    const activePool = latest.primary || latest.fallback || null;
    if (!activePool?.sqrtPriceX96) return false;
    const pos = this.state.position || {};
    const liq = pos.liquidity ? BigInt(pos.liquidity) : 0n;
    const lower = Number(pos.tickLower);
    const upper = Number(pos.tickUpper);
    if (!(liq > 0n && Number.isFinite(lower) && Number.isFinite(upper) && upper > lower)) return false;
    const amounts = this.lpAmountsFromLiquidity(
      liq,
      lower,
      upper,
      BigInt(activePool.sqrtPriceX96),
      activePool.token0 || this.weth,
      activePool.token1 || this.usdc
    );
    const entryTokens = {
      weth: Number(formatUnits(amounts.wethRaw, WETH_DECIMALS)),
      usdc: Number(formatUnits(amounts.usdcRaw, USDC_DECIMALS)),
    };
    const spot = this.getSpotUsdcPerWeth();
    const entryValueUsd = entryTokens.usdc + entryTokens.weth * spot;
    await this.appendLifecycleEvent(
      this.lifecycleCommonFields({
        type: "ENTRY_SNAPSHOT",
        positionRunId: String(pending.positionRunId),
        tokenId: this.state.position?.tokenId || null,
        band: {
          bandHalfBps: Number(pos.bandHalfBps || this.settings.bandHalfBps || 0),
          tickLower: Number(pos.tickLower || 0),
          tickUpper: Number(pos.tickUpper || 0),
        },
        accounting: this.emptyLifecycleAccounting(),
        details: {
          entryTokens,
          entryValueUsd,
          rawMintValueUsd: Number(pending.rawMintValueUsd || 0),
          spotPriceUsdcPerWeth: spot,
          note: "baseline after top-up",
        },
      })
    );
    this.state.pendingEntrySnapshot = null;
    return true;
  }

  scheduleEntrySnapshot({ positionRunId, rawMintValueUsd = 0 }) {
    if (!positionRunId) return;
    const nextRunId = String(positionRunId);
    const pending = this.state.pendingEntrySnapshot;
    const nextDueAtIso = new Date(Date.now() + 60_000).toISOString();
    if (pending?.positionRunId === nextRunId) {
      pending.dueAtIso = nextDueAtIso;
      pending.rawMintValueUsd = Math.max(
        Number(pending.rawMintValueUsd || 0),
        Number(rawMintValueUsd || 0)
      );
      return;
    }
    this.state.pendingEntrySnapshot = {
      positionRunId: nextRunId,
      dueAtIso: nextDueAtIso,
      rawMintValueUsd: Number(rawMintValueUsd || 0),
    };
  }

  ensureActivePositionRun({ reason = "auto", snapshot = null, tokenId = null, bandHalfBpsOverride = null } = {}) {
    if (this.state.activePositionRunId) return String(this.state.activePositionRunId);
    const runId = randomUUID();
    this.state.activePositionRunId = runId;
    const band = this.currentBandDescriptor();
    const plannedBandHalfBps = Number.isFinite(Number(bandHalfBpsOverride))
      ? Number(bandHalfBpsOverride)
      : Number(this.settings.bandHalfBps || 0);
    const venue = this.settings.venue === "uniswapv3" ? "uniswapv3" : "slipstream";
    const details = {
      reason,
      plannedBand: {
        bandHalfBps: plannedBandHalfBps,
        tickLower: Number(band.tickLower || 0),
        tickUpper: Number(band.tickUpper || 0),
      },
      reservePolicy: {
        minUsdc: Number(this.settings.reserveMinUsdc || 0),
        pct: Number(this.settings.reservePct || 0),
        maxUsdc: Number(this.settings.reserveMaxUsdc || 0),
      },
      selector: this.selectorForVenue(venue, snapshot),
    };
    void this.appendLifecycleEvent(
      this.lifecycleCommonFields({
        type: "OPEN_POSITION",
        positionRunId: runId,
        tokenId,
        band: {
          bandHalfBps: plannedBandHalfBps,
          tickLower: Number(band.tickLower || 0),
          tickUpper: Number(band.tickUpper || 0),
        },
        details,
      })
    ).catch((err) => this.setLastError(err));
    return runId;
  }

  setLifecyclePhaseContext(ctx) {
    this.lifecyclePhaseContext = ctx && typeof ctx === "object" ? { ...ctx } : null;
  }

  clearLifecyclePhaseContext() {
    this.lifecyclePhaseContext = null;
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
    // `gasUsd` is tracked as total tx gas and `mintBurnUsd` is a labeled subset
    // (mint/increase/decrease/collect/burn gas). Do not double-count it in totals.
    const totalCostsUsd = gasUsd + swapCostsUsd;
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

  estimateTrackedLpUsdValueFromLatest() {
    const latest = this.state.latest || {};
    const activePool = latest.primary || latest.fallback || null;
    const pos = this.state.position || {};
    const tickLower = Number(pos.tickLower);
    const tickUpper = Number(pos.tickUpper);
    const hasRange = Number.isFinite(tickLower) && Number.isFinite(tickUpper) && tickUpper > tickLower;
    const liquidityRaw = pos.liquidity ? BigInt(pos.liquidity) : 0n;
    if (!(hasRange && liquidityRaw > 0n && activePool?.sqrtPriceX96)) return 0;
    const token0 = activePool?.token0 || this.weth;
    const token1 = activePool?.token1 || this.usdc;
    const amounts = this.lpAmountsFromLiquidity(
      liquidityRaw,
      tickLower,
      tickUpper,
      BigInt(activePool.sqrtPriceX96),
      token0,
      token1
    );
    const usdc = Number(formatUnits(amounts.usdcRaw, USDC_DECIMALS));
    const weth = Number(formatUnits(amounts.wethRaw, WETH_DECIMALS));
    return usdc + weth * this.getSpotUsdcPerWeth();
  }

  summarizeBandPerformance(events) {
    const _unusedEvents = events;
    void _unusedEvents;
    const closedRecords = this.getClosedPositionRecordsSorted();
    const tiny = 1e-9;
    const byBand = new Map();
    for (const rec of closedRecords) {
      const perf = rec?.performance || {};
      const activity = rec?.activity || {};
      const duration = rec?.duration || {};
      const band = rec?.band || {};
      let bandHalfBps = this.estimateBandHalfBpsFromTicks(band.tickLower, band.tickUpper);
      if (!(Number.isFinite(bandHalfBps) && bandHalfBps > 0)) {
        bandHalfBps = Number(band.bandHalfBps || 0);
      }
      if (!Number.isFinite(bandHalfBps) || bandHalfBps <= 0) continue;

      let row = byBand.get(bandHalfBps);
      if (!row) {
        row = {
          bandHalfBps,
          runs: 0,
          wins: 0,
          alphaUsdSum: 0,
          avgDeployedUsdSum: 0,
          totalCostsUsd: 0,
          timeToRebalanceSecSum: 0,
          timeToRebalanceSamples: 0,
        };
        byBand.set(bandHalfBps, row);
      }

      const alphaUsd = Number(perf.alphaVsHodlUsd || 0);
      const avgDeployedUsd = Number(perf.avgDeployedUsd || 0);
      const totalCostsUsd = Number(perf.totalCostsUsd || 0);
      const durationSec = Number(duration.secondsInPosition || 0);
      const rebalancesCount = Math.max(0, Number(activity.rebalances || 0));
      const timeToRebalanceSec = durationSec > 0 ? durationSec / Math.max(rebalancesCount, 1) : 0;

      row.runs += 1;
      if (Number.isFinite(alphaUsd)) {
        row.alphaUsdSum += alphaUsd;
        if (alphaUsd > 0) row.wins += 1;
      }
      if (Number.isFinite(avgDeployedUsd) && avgDeployedUsd > 0) {
        row.avgDeployedUsdSum += avgDeployedUsd;
      }
      if (Number.isFinite(totalCostsUsd) && totalCostsUsd >= 0) {
        row.totalCostsUsd += totalCostsUsd;
      }
      if (Number.isFinite(timeToRebalanceSec) && timeToRebalanceSec > 0) {
        row.timeToRebalanceSecSum += timeToRebalanceSec;
        row.timeToRebalanceSamples += 1;
      }
    }

    return Array.from(byBand.values())
      .map((row) => {
        const denom = Math.max(tiny, row.avgDeployedUsdSum);
        const alphaBpsTotal = (row.alphaUsdSum / denom) * 10_000;
        const costBpsTotal = (row.totalCostsUsd / denom) * 10_000;
        const winRate = row.runs > 0 ? row.wins / row.runs : 0;
        const avgTimeToRebalanceSec =
          row.timeToRebalanceSamples > 0 ? row.timeToRebalanceSecSum / row.timeToRebalanceSamples : null;
        return {
          bandHalfBps: row.bandHalfBps,
          bandHalfPct: row.bandHalfBps / 100,
          actualBandKey: `±${(row.bandHalfBps / 100).toFixed(2)}%`,
          runs: row.runs,
          alphaBpsTotal,
          winRate,
          costBpsTotal,
          avgTimeToRebalanceSec,
        };
      })
      .sort((a, b) => {
        const alphaDelta = Number(b.alphaBpsTotal || 0) - Number(a.alphaBpsTotal || 0);
        if (Math.abs(alphaDelta) > 1e-12) return alphaDelta;
        return Number(b.runs || 0) - Number(a.runs || 0);
      });
  }

  estimateBandHalfBpsFromTicks(tickLower, tickUpper) {
    const lower = Number(tickLower);
    const upper = Number(tickUpper);
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) return null;
    const halfTicks = Math.max(1, Math.round((upper - lower) / 2));
    const priceFactor = Math.pow(1.0001, halfTicks);
    if (!Number.isFinite(priceFactor) || priceFactor <= 1) return null;
    const bps = Math.round((priceFactor - 1) * 10_000);
    return bps > 0 ? bps : null;
  }

  async deriveMintBandMetaFromTxs(txHashes) {
    if (!Array.isArray(txHashes) || txHashes.length === 0) return null;
    for (const hash of txHashes) {
      if (!hash) continue;
      let tx;
      try {
        tx = await this.publicClient.getTransaction({ hash });
      } catch {
        continue;
      }
      if (!tx?.input || tx.input === "0x") continue;
      const candidates = [NPM_MINT_ABI_TICK_WITH_PRICE, NPM_MINT_ABI_TICK, NPM_MINT_ABI_FEE];
      for (const abi of candidates) {
        try {
          const decoded = decodeFunctionData({ abi, data: tx.input });
          if (decoded.functionName !== "mint") continue;
          const params = Array.isArray(decoded.args) ? decoded.args[0] : null;
          const lower = params?.tickLower;
          const upper = params?.tickUpper;
          const bandHalfBpsEffective = this.estimateBandHalfBpsFromTicks(lower, upper);
          return {
            tickLower: Number.isFinite(Number(lower)) ? Number(lower) : null,
            tickUpper: Number.isFinite(Number(upper)) ? Number(upper) : null,
            bandHalfBpsEffective:
              Number.isFinite(Number(bandHalfBpsEffective)) && Number(bandHalfBpsEffective) > 0
                ? Number(bandHalfBpsEffective)
                : null,
          };
        } catch {
          // try next candidate ABI
        }
      }
    }
    return null;
  }

  needsLedgerFeeBackfill() {
    const ledger = Array.isArray(this.state.ledgerEvents) ? this.state.ledgerEvents : [];
    return ledger.some((ev) => {
      if (!ev || (ev.type !== "harvest" && ev.type !== "recenter" && ev.type !== "liquidate")) return false;
      if (Number(ev.feesCollectedUsd || 0) > 0) return false;
      if (ev.feesBackfilled) return false;
      return Array.isArray(ev.txHashes) && ev.txHashes.some((h) => typeof h === "string" && h.startsWith("0x"));
    });
  }

  needsLedgerBandBackfill() {
    const recenterEvents = Array.isArray(this.state.ledgerEvents)
      ? this.state.ledgerEvents.filter((ev) => ev && ev.type === "recenter")
      : [];
    if (recenterEvents.length <= 1) return false;
    for (let i = 1; i < recenterEvents.length; i += 1) {
      const ev = recenterEvents[i];
      const missingBand = !(Number.isFinite(Number(ev?.closedBandHalfBpsEffective)) && Number(ev.closedBandHalfBpsEffective) > 0);
      const missingDuration = !(Number.isFinite(Number(ev?.runDurationSec)) && Number(ev.runDurationSec) > 0);
      if (missingBand || missingDuration) return true;
    }
    return false;
  }

  async backfillBandMetadataForRecenters() {
    if (!Array.isArray(this.state.ledgerEvents) || this.state.ledgerEvents.length === 0) return false;
    let changed = false;
    const recenterIndexes = this.state.ledgerEvents
      .map((ev, idx) => ({ ev, idx }))
      .filter(({ ev }) => ev && ev.type === "recenter")
      .sort((a, b) => {
        const ams = Date.parse(a.ev?.atIso || "");
        const bms = Date.parse(b.ev?.atIso || "");
        return (Number.isFinite(ams) ? ams : 0) - (Number.isFinite(bms) ? bms : 0);
      });

    if (recenterIndexes.length <= 1) return false;

    let needsBandRepair = false;
    let needsDurationRepair = false;
    for (let i = 1; i < recenterIndexes.length; i += 1) {
      const ev = recenterIndexes[i].ev;
      if (!(Number.isFinite(Number(ev?.closedBandHalfBpsEffective)) && Number(ev.closedBandHalfBpsEffective) > 0)) {
        needsBandRepair = true;
      }
      if (!(Number.isFinite(Number(ev?.runDurationSec)) && Number(ev.runDurationSec) > 0)) {
        needsDurationRepair = true;
      }
      if (needsBandRepair && needsDurationRepair) break;
    }
    if (!needsBandRepair && !needsDurationRepair) return false;

    const openedBandByRecenterIndex = new Map();
    const getOpenedBandForRecenterIndex = async (index) => {
      if (index < 0 || index >= recenterIndexes.length) return null;
      if (openedBandByRecenterIndex.has(index)) return openedBandByRecenterIndex.get(index) || null;
      const ev = recenterIndexes[index]?.ev;
      const meta = await this.deriveMintBandMetaFromTxs(ev?.txHashes || []);
      openedBandByRecenterIndex.set(index, meta || null);
      return meta || null;
    };

    for (let i = 0; i < recenterIndexes.length; i += 1) {
      const { idx } = recenterIndexes[i];
      const ev = this.state.ledgerEvents[idx];
      if (!ev || ev.type !== "recenter") continue;

      const currentEffectiveBand = Number(ev.closedBandHalfBpsEffective);
      if (!(Number.isFinite(currentEffectiveBand) && currentEffectiveBand > 0) && i > 0) {
        const prevOpened = await getOpenedBandForRecenterIndex(i - 1);
        if (prevOpened) {
          let rowChanged = false;
          if (Number.isFinite(Number(prevOpened.tickLower)) && Number.isFinite(Number(prevOpened.tickUpper))) {
            ev.closedTickLower = Number(prevOpened.tickLower);
            ev.closedTickUpper = Number(prevOpened.tickUpper);
            rowChanged = true;
          }
          if (Number.isFinite(Number(prevOpened.bandHalfBpsEffective)) && Number(prevOpened.bandHalfBpsEffective) > 0) {
            ev.closedBandHalfBpsEffective = Number(prevOpened.bandHalfBpsEffective);
            if (!(Number.isFinite(Number(ev.closedBandHalfBps)) && Number(ev.closedBandHalfBps) > 0)) {
              ev.closedBandHalfBps = Number(prevOpened.bandHalfBpsEffective);
            }
            rowChanged = true;
          }
          if (rowChanged) changed = true;
        }
      }

      const currentDuration = Number(ev.runDurationSec);
      if (!(Number.isFinite(currentDuration) && currentDuration > 0) && i > 0) {
        const prevEv = recenterIndexes[i - 1].ev;
        const prevMs = Date.parse(prevEv?.atIso || "");
        const curMs = Date.parse(ev.atIso || "");
        if (Number.isFinite(prevMs) && Number.isFinite(curMs) && curMs > prevMs) {
          ev.runDurationSec = Math.round((curMs - prevMs) / 1000);
          changed = true;
        }
      }
    }
    return changed;
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
    if (kind === "mint" || kind === "increase" || kind === "decrease" || kind === "collect" || kind === "burn") {
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
    // `mintBurnUsd` is informational (subset of gasUsd), so net should not subtract it again.
    const netUsd =
      Number(action.feesCollectedUsd || 0) +
      Number(action.rewardsUsd || 0) -
      (Number(action.gasUsd || 0) + Number(action.swapCostUsd || 0));
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

  async getPoolMetaCached(poolAddress) {
    const key = getAddress(poolAddress);
    const cached = this.poolMetaCache.get(key);
    if (cached) return cached;
    let token0 = null;
    let token1 = null;
    let tickSpacing = null;
    let fee = 3000;
    try {
      const results = await this.publicClient.multicall({
        allowFailure: true,
        contracts: [
          { address: key, abi: POOL_ABI, functionName: "token0" },
          { address: key, abi: POOL_ABI, functionName: "token1" },
          { address: key, abi: POOL_ABI, functionName: "tickSpacing" },
          { address: key, abi: POOL_ABI, functionName: "fee" },
        ],
      });
      token0 = results?.[0]?.status === "success" ? results[0].result : null;
      token1 = results?.[1]?.status === "success" ? results[1].result : null;
      tickSpacing = results?.[2]?.status === "success" ? results[2].result : null;
      fee = results?.[3]?.status === "success" ? Number(results[3].result) : 3000;
    } catch {
      // Fall back to individual reads when multicall is unavailable or degraded.
    }
    if (!token0) token0 = await this.publicClient.readContract({ address: key, abi: POOL_ABI, functionName: "token0" });
    if (!token1) token1 = await this.publicClient.readContract({ address: key, abi: POOL_ABI, functionName: "token1" });
    if (tickSpacing == null) {
      tickSpacing = await this.publicClient.readContract({ address: key, abi: POOL_ABI, functionName: "tickSpacing" });
    }
    if (!(Number.isFinite(Number(fee)) && Number(fee) > 0)) {
      fee = await this.publicClient.readContract({ address: key, abi: POOL_ABI, functionName: "fee" }).catch(() => 3000);
    }
    const meta = {
      token0: getAddress(token0),
      token1: getAddress(token1),
      tickSpacing: Number(tickSpacing),
      fee: Number(fee),
      cachedAtIso: nowIso(),
    };
    this.poolMetaCache.set(key, meta);
    return meta;
  }

  async getPoolSnapshot(poolAddress, venue) {
    const [slot0, meta] = await Promise.all([this.readSlot0(poolAddress), this.getPoolMetaCached(poolAddress)]);

    const sqrtPriceX96 = slot0.sqrtPriceX96 ?? slot0[0];
    const tick = Number(slot0.tick ?? slot0[1]);
    const token0Addr = meta.token0;
    const token1Addr = meta.token1;
    const spacing = Number(meta.tickSpacing);
    const feeTier = Number(meta.fee);

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
    return this.httpPool.invoke(
      "slot0",
      async (provider) => {
        try {
          return await provider.publicClient.readContract({
            address: poolAddress,
            abi: SLOT0_ABI_V7,
            functionName: "slot0",
          });
        } catch (errV7) {
          if (isRpc429Error(errV7)) throw errV7;
          try {
            return await provider.publicClient.readContract({
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
      },
      { timeoutMs: 8_000, retries: 2 }
    );
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

  async refreshSnapshots(options = {}) {
    return this.refreshSnapshotsSelective(options);
  }

  async refreshPoolSnapshotsLight() {
    const needFallback =
      !this.state.latest?.fallback ||
      !this.refreshClock.slot0Ms ||
      Date.now() - this.refreshClock.slot0Ms >= 60_000;
    const [primary, fallbackMaybe] = await Promise.all([
      this.getPoolSnapshot(this.slipstreamPool, "slipstream"),
      needFallback ? this.getPoolSnapshot(this.uniswapPool, "uniswapv3").catch(() => null) : Promise.resolve(undefined),
    ]);
    const fallback = fallbackMaybe === undefined ? this.state.latest?.fallback || null : fallbackMaybe;
    this.state.latest.primary = primary;
    this.state.latest.fallback = fallback;
    this.markRefreshStamp("slot0Ms", "slot0AtIso");
    try {
      this.ingestRegimeSampleFromSnapshot(primary);
    } catch (err) {
      this.warnRegimeRateLimited(err instanceof Error ? err.message : String(err || "regime sample ingest failed"));
    }
    return { primary, fallback };
  }

  async refreshWalletBalancesHeavy() {
    const [{ usdcBalanceRaw, wethBalanceRaw }, ethBalanceRaw] = await Promise.all([
      this.readWalletPairBalances(),
      this.publicClient.getBalance({ address: this.account.address }),
    ]);
    const primary = this.state.latest?.primary || null;
    const fallback = this.state.latest?.fallback || null;
    const spot = this.toNumberOrZero(primary?.priceUsdcPerWeth) || this.toNumberOrZero(fallback?.priceUsdcPerWeth);
    const usdcValue = Number(formatUnits(usdcBalanceRaw, USDC_DECIMALS));
    const wethValue = Number(formatUnits(wethBalanceRaw, WETH_DECIMALS)) * spot;
    const ethValue = Number(formatUnits(ethBalanceRaw, 18)) * spot;
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
    this.markRefreshStamp("balancesMs", "balancesAtIso");
    return { usdcBalanceRaw, wethBalanceRaw, ethBalanceRaw };
  }

  async refreshSnapshotsSelective({ forceSlot0 = false, forceBalances = false, headSeen = false } = {}) {
    const now = Date.now();
    const slot0TtlMs = Math.max(1, Number(this.settings.slot0RefreshEverySec || 12)) * 1000;
    const needSlot0 =
      forceSlot0 ||
      !this.state.latest?.primary ||
      (now - this.refreshClock.slot0Ms >= slot0TtlMs &&
        (!this.settings.wsEnabled || headSeen || now - this.refreshClock.slot0Ms >= slot0TtlMs * 3));
    const needBalances =
      forceBalances ||
      !this.state.latest?.wallet ||
      now - this.refreshClock.balancesMs >= Number(this.settings.balancesRefreshEverySec || 60) * 1000;

    let primary = this.state.latest?.primary || null;
    let fallback = this.state.latest?.fallback || null;
    let usdcBalanceRaw = null;
    let wethBalanceRaw = null;
    let ethBalanceRaw = null;

    if (needSlot0) {
      try {
        const out = await this.refreshPoolSnapshotsLight();
        primary = out.primary;
        fallback = out.fallback;
      } catch (err) {
        // Keep serving cached market data when providers are throttled, but surface the error.
        this.setLastError(err);
        if (!primary) throw err;
      }
    }
    if (needBalances) {
      try {
        const out = await this.refreshWalletBalancesHeavy();
        usdcBalanceRaw = out.usdcBalanceRaw;
        wethBalanceRaw = out.wethBalanceRaw;
        ethBalanceRaw = out.ethBalanceRaw;
      } catch (err) {
        this.setLastError(err);
        if (!this.state.latest?.wallet) throw err;
      }
    }
    return { primary, fallback, usdcBalanceRaw, wethBalanceRaw, ethBalanceRaw };
  }

  async refreshCollectableNowMaybe({ force = false } = {}) {
    const tokenId = this.state.position?.tokenId;
    if (!tokenId) {
      this.state.latest.collectableNow = { usdc: 0, weth: 0, usd: 0, isEstimated: true };
      this.markRefreshStamp("collectableMs", "collectableAtIso");
      return this.state.latest.collectableNow;
    }
    if (!this.isTtlDue("collectableMs", this.settings.collectableRefreshEverySec, { force })) {
      return this.state.latest?.collectableNow || { usdc: 0, weth: 0, usd: 0, isEstimated: true };
    }
    try {
      this.state.latest.collectableNow = await this.collectableNowSnapshot();
    } catch (err) {
      this.setLastError(err);
      const prev = this.state.latest?.collectableNow || { usdc: 0, weth: 0, usd: 0, isEstimated: true };
      this.state.latest.collectableNow = {
        usdc: Number(prev.usdc || 0),
        weth: Number(prev.weth || 0),
        usd: Number(prev.usd || 0),
        isEstimated: true,
      };
    } finally {
      this.markRefreshStamp("collectableMs", "collectableAtIso");
    }
    return this.state.latest.collectableNow;
  }

  async maybeRefreshPositionFromChain({ force = false } = {}) {
    if (!this.state.position?.tokenId) return;
    if (!this.isTtlDue("positionMs", this.settings.positionRefreshEverySec, { force })) return;
    try {
      await this.reconcilePositionFromChain();
    } finally {
      this.markRefreshStamp("positionMs", "positionAtIso");
    }
  }

  async maybeRefreshPositionInventory({ force = false } = {}) {
    if (!force && !this.state.position?.tokenId && this.getStrategyMode() !== "LP_ACTIVE") return;
    if (!this.isTtlDue("inventoryMs", this.settings.inventoryRefreshEverySec, { force })) return;
    try {
      await this.refreshOwnedSlipstreamPositionInventory();
    } finally {
      this.markRefreshStamp("inventoryMs", "inventoryAtIso");
    }
  }

  toNumberOrZero(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  getRegimeSettings() {
    const cfg = this.settings?.regime && typeof this.settings.regime === "object" ? this.settings.regime : DEFAULT_SETTINGS.regime;
    return {
      enabled: Boolean(cfg.enabled),
      windowSec: Math.max(60, Math.round(Number(cfg.windowSec || DEFAULT_SETTINGS.regime.windowSec))),
      sampleEverySec: Math.max(1, Math.round(Number(cfg.sampleEverySec || DEFAULT_SETTINGS.regime.sampleEverySec))),
      minSamples: Math.max(5, Math.round(Number(cfg.minSamples || DEFAULT_SETTINGS.regime.minSamples))),
      fastWindowSec: Math.max(30, Math.round(Number(cfg.fastWindowSec || DEFAULT_SETTINGS.regime.fastWindowSec))),
      fastSampleEverySec: Math.max(1, Math.round(Number(cfg.fastSampleEverySec || DEFAULT_SETTINGS.regime.fastSampleEverySec))),
      fastMinSamples: Math.max(5, Math.round(Number(cfg.fastMinSamples || DEFAULT_SETTINGS.regime.fastMinSamples))),
      fastWeight: clamp(Number(cfg.fastWeight ?? DEFAULT_SETTINGS.regime.fastWeight), 0, 0.8),
      mrHalfLifeMaxSec: Math.max(10, Math.round(Number(cfg.mrHalfLifeMaxSec || DEFAULT_SETTINGS.regime.mrHalfLifeMaxSec))),
      trendHalfLifeMinSec: Math.max(
        11,
        Math.round(Number(cfg.trendHalfLifeMinSec || DEFAULT_SETTINGS.regime.trendHalfLifeMinSec))
      ),
      maxEdgeAdj: clamp(Number(cfg.maxEdgeAdj || DEFAULT_SETTINGS.regime.maxEdgeAdj), 0, 0.5),
      maxBandAdjBps: clamp(
        Math.round(Number(cfg.maxBandAdjBps || DEFAULT_SETTINGS.regime.maxBandAdjBps)),
        0,
        500
      ),
      maxBandNarrowBps: clamp(
        Math.round(Number(cfg.maxBandNarrowBps ?? DEFAULT_SETTINGS.regime.maxBandNarrowBps)),
        0,
        100
      ),
      maxCooldownAdjSec: clamp(
        Math.round(Number(cfg.maxCooldownAdjSec || DEFAULT_SETTINGS.regime.maxCooldownAdjSec)),
        0,
        86_400
      ),
    };
  }

  getTrendEscapeSettings() {
    const cfg =
      this.settings?.trendEscape && typeof this.settings.trendEscape === "object"
        ? this.settings.trendEscape
        : DEFAULT_SETTINGS.trendEscape;
    return {
      enabled: Boolean(cfg.enabled),
      variant: "hybrid",
      requireRegimeLabel: cfg.requireRegimeLabel === "mean_reverting" ? "mean_reverting" : "trending",
      minRegimeConfidence: clamp(Number(cfg.minRegimeConfidence || 0), 0, 1),
      directionLookbackSec: clamp(Math.round(Number(cfg.directionLookbackSec || 0)), 30, 86_400),
      minTrendMovePct: clamp(Number(cfg.minTrendMovePct || 0), 0, 1),
      minTrendConfirmSec: clamp(Math.round(Number(cfg.minTrendConfirmSec || 0)), 5, 86_400),
      cooldownAfterEscapeSec: clamp(Math.round(Number(cfg.cooldownAfterEscapeSec || 0)), 0, 7 * 24 * 60 * 60),
      minAlphaUsdToEscape: clamp(Number(cfg.minAlphaUsdToEscape || 0), -1_000_000, 1_000_000),
      emergencyOutOfRangeEdgePct: clamp(Number(cfg.emergencyOutOfRangeEdgePct || 1), 1, 5),
      emergencyMinOutOfRangeSec: clamp(
        Math.round(Number(cfg.emergencyMinOutOfRangeSec || 0)),
        5,
        7 * 24 * 60 * 60
      ),
      uptrendHold: cfg.uptrendHold === "USDC" ? "USDC" : cfg.uptrendHold === "50_50" ? "50_50" : "WETH",
      downtrendHold: cfg.downtrendHold === "WETH" ? "WETH" : cfg.downtrendHold === "50_50" ? "50_50" : "USDC",
      fallbackHold: cfg.fallbackHold === "WETH" ? "WETH" : cfg.fallbackHold === "USDC" ? "USDC" : "50_50",
    };
  }

  getReEntrySettings() {
    const cfg =
      this.settings?.reEntry && typeof this.settings.reEntry === "object"
        ? this.settings.reEntry
        : DEFAULT_SETTINGS.reEntry;
    return {
      enabled: Boolean(cfg.enabled),
      requireRegimeLabel: cfg.requireRegimeLabel === "trending" ? "trending" : "mean_reverting",
      minRegimeConfidence: clamp(Number(cfg.minRegimeConfidence || 0), 0, 1),
      minMeanRevertConfirmSec: clamp(Math.round(Number(cfg.minMeanRevertConfirmSec || 0)), 5, 86_400),
      maxDistanceFromMuPct: clamp(Number(cfg.maxDistanceFromMuPct || 0), 0, 1),
      minHoldSec: clamp(Math.round(Number(cfg.minHoldSec || 0)), 0, 7 * 24 * 60 * 60),
      cooldownAfterReEntrySec: clamp(Math.round(Number(cfg.cooldownAfterReEntrySec || 0)), 0, 7 * 24 * 60 * 60),
    };
  }

  getStrategyMode() {
    const mode = String(this.state?.strategyMode || "LP_ACTIVE");
    if (mode === "HOLD_WETH" || mode === "HOLD_USDC" || mode === "HOLD_50_50") return mode;
    return "LP_ACTIVE";
  }

  holdModeFromTarget(target) {
    if (target === "WETH") return "HOLD_WETH";
    if (target === "USDC") return "HOLD_USDC";
    return "HOLD_50_50";
  }

  holdTargetFromMode(mode = null) {
    const value = String(mode || this.getStrategyMode());
    if (value === "HOLD_WETH") return "WETH";
    if (value === "HOLD_USDC") return "USDC";
    return "50_50";
  }

  isoMs(v) {
    const ms = Date.parse(String(v || ""));
    return Number.isFinite(ms) ? ms : NaN;
  }

  cooldownRemainingSec(iso) {
    const ms = this.isoMs(iso);
    if (!(Number.isFinite(ms) && ms > Date.now())) return 0;
    return Math.max(0, Math.ceil((ms - Date.now()) / 1000));
  }

  setStrategyModeState(mode, extra = {}) {
    this.state.strategyMode = mode;
    if ("holdStartedAtIso" in extra) this.state.holdStartedAtIso = extra.holdStartedAtIso || null;
    if ("escapeCooldownUntilIso" in extra) this.state.escapeCooldownUntilIso = extra.escapeCooldownUntilIso || null;
    if ("reEntryCooldownUntilIso" in extra) this.state.reEntryCooldownUntilIso = extra.reEntryCooldownUntilIso || null;
  }

  getRegimeLookbackSample(lookbackSec) {
    const samples = Array.isArray(this.regimeState?.samples) ? this.regimeState.samples : [];
    if (!samples.length) return null;
    const targetTsSec = Math.floor(Date.now() / 1000) - Math.max(1, Math.round(Number(lookbackSec || 0)));
    let candidate = null;
    for (const sample of samples) {
      const tsSec = Number(sample?.tsSec || 0);
      if (!Number.isFinite(tsSec) || tsSec > targetTsSec) break;
      candidate = sample;
    }
    return candidate;
  }

  updateTrendConfirmState(trendCtx) {
    const now = nowIso();
    if (trendCtx?.trendingCondition) {
      if (!this.state.trendingSinceIso) this.state.trendingSinceIso = now;
    } else {
      this.state.trendingSinceIso = null;
    }
    if (trendCtx?.meanRevertingCondition) {
      if (!this.state.meanRevertingSinceIso) this.state.meanRevertingSinceIso = now;
    } else {
      this.state.meanRevertingSinceIso = null;
    }
  }

  buildTrendContext(primary = null, { persistState = true } = {}) {
    const trendCfg = this.getTrendEscapeSettings();
    const reEntryCfg = this.getReEntrySettings();
    const latestRegime = this.state.latest?.regime || null;
    const priceNow = Number(primary?.priceUsdcPerWeth || this.getSpotUsdcPerWeth() || 0);
    const tickNow = Number(primary?.tick ?? this.state.latest?.primary?.tick ?? this.state.latest?.fallback?.tick ?? NaN);
    const logPriceNow = Number.isFinite(tickNow) ? tickNow * Math.log(1.0001) : null;
    const lookbackSample = this.getRegimeLookbackSample(trendCfg.directionLookbackSec);
    const logPriceLookback = Number.isFinite(Number(lookbackSample?.logPrice || NaN))
      ? Number(lookbackSample.logPrice)
      : null;
    const trendMovePct =
      Number.isFinite(logPriceNow) && Number.isFinite(logPriceLookback)
        ? Math.exp(logPriceNow - logPriceLookback) - 1
        : null;
    let direction = "flat";
    if (Number.isFinite(trendMovePct)) {
      if (trendMovePct >= trendCfg.minTrendMovePct) direction = "up";
      else if (trendMovePct <= -trendCfg.minTrendMovePct) direction = "down";
    }
    const regimeOk = Boolean(latestRegime?.ok);
    const regimeLabel = String(latestRegime?.label || "unknown");
    const hasUsableMu =
      regimeOk &&
      (regimeLabel === "mean_reverting" || Number(latestRegime?.thetaStrength || 0) > 0.3) &&
      Number.isFinite(Number(latestRegime?.mu)) &&
      Number.isFinite(Number(latestRegime?.theta)) &&
      Number(latestRegime.theta) > 0;
    const muLogPrice =
      hasUsableMu
        ? Number(latestRegime.mu)
        : null;
    const distanceFromMuPct =
      Number.isFinite(logPriceNow) && Number.isFinite(muLogPrice)
        ? Math.abs(Math.exp(logPriceNow - muLogPrice) - 1)
        : null;
    const regimeConfidence = clamp(Number(latestRegime?.confidence || 0), 0, 1);
    const trendingCondition =
      trendCfg.enabled &&
      regimeLabel === trendCfg.requireRegimeLabel &&
      regimeConfidence >= trendCfg.minRegimeConfidence &&
      Number.isFinite(trendMovePct) &&
      Math.abs(trendMovePct) >= trendCfg.minTrendMovePct &&
      (direction === "up" || direction === "down");
    const meanRevertingCondition =
      reEntryCfg.enabled &&
      regimeLabel === reEntryCfg.requireRegimeLabel &&
      regimeConfidence >= reEntryCfg.minRegimeConfidence &&
      Number.isFinite(distanceFromMuPct) &&
      distanceFromMuPct <= reEntryCfg.maxDistanceFromMuPct;
    const nextTrendingSinceIso = trendingCondition
      ? this.state.trendingSinceIso || nowIso()
      : null;
    const nextMeanRevertingSinceIso = meanRevertingCondition
      ? this.state.meanRevertingSinceIso || nowIso()
      : null;
    if (persistState) {
      this.state.trendingSinceIso = nextTrendingSinceIso;
      this.state.meanRevertingSinceIso = nextMeanRevertingSinceIso;
    }
    const trendingSinceMs = this.isoMs(nextTrendingSinceIso);
    const meanRevertingSinceMs = this.isoMs(nextMeanRevertingSinceIso);
    const trendingConfirmSec =
      trendingCondition && Number.isFinite(trendingSinceMs) && Date.now() > trendingSinceMs
        ? Math.round((Date.now() - trendingSinceMs) / 1000)
        : trendingCondition
          ? 0
          : 0;
    const meanRevertConfirmSec =
      meanRevertingCondition && Number.isFinite(meanRevertingSinceMs) && Date.now() > meanRevertingSinceMs
        ? Math.round((Date.now() - meanRevertingSinceMs) / 1000)
        : meanRevertingCondition
          ? 0
          : 0;
    return {
      priceNow,
      trendMovePct,
      direction,
      lookbackSec: trendCfg.directionLookbackSec,
      distanceFromMuPct,
      trendingCondition,
      trendingConfirmSec,
      meanRevertingCondition,
      meanRevertConfirmSec,
      regimeLabel,
      regimeConfidence,
      trendingSinceIso: nextTrendingSinceIso,
      meanRevertingSinceIso: nextMeanRevertingSinceIso,
      muPrice:
        Number.isFinite(priceNow) && Number.isFinite(logPriceNow) && Number.isFinite(muLogPrice)
          ? priceNow / Math.exp(logPriceNow - muLogPrice)
          : null,
    };
  }

  syncRegimeStateWithSettings() {
    const cfg = this.getRegimeSettings();
    const key = stableStringify(cfg);
    if (!this.regimeState || this.regimeStateConfigKey !== key) {
      this.regimeState = createRegimeState({
        windowSec: cfg.windowSec,
        sampleEverySec: cfg.sampleEverySec,
        minSamples: cfg.minSamples,
      });
      // Keep classification knobs in state config for estimator defaults (optional use).
      this.regimeState.config = {
        ...this.regimeState.config,
        mrHalfLifeMaxSec: cfg.mrHalfLifeMaxSec,
        trendHalfLifeMinSec: cfg.trendHalfLifeMinSec,
      };
      // Fast window for quicker regime-shift detection (dual-window estimation).
      this.regimeStateFast = createRegimeState({
        windowSec: cfg.fastWindowSec,
        sampleEverySec: cfg.fastSampleEverySec,
        minSamples: cfg.fastMinSamples,
      });
      this.regimeStateFast.config = {
        ...this.regimeStateFast.config,
        mrHalfLifeMaxSec: cfg.mrHalfLifeMaxSec,
        trendHalfLifeMinSec: cfg.trendHalfLifeMinSec,
      };
      this.regimeStateConfigKey = key;
    }
    return cfg;
  }

  warnRegimeRateLimited(message) {
    const now = Date.now();
    if (now - this.lastRegimeWarnAtMs < REGIME_WARN_MIN_INTERVAL_MS) return;
    this.lastRegimeWarnAtMs = now;
    try {
      console.warn(`[UC6] regime warning: ${redactSensitiveText(message)}`);
    } catch {}
  }

  ingestRegimeSampleFromSnapshot(snapshot) {
    const cfg = this.syncRegimeStateWithSettings();
    if (!cfg.enabled) return false;
    const tick = Number(snapshot?.tick);
    if (!Number.isFinite(tick)) return false;
    try {
      const sample = { tsSec: Math.floor(Date.now() / 1000), tick };
      const slowOk = ingestSample(this.regimeState, sample);
      // Also feed the fast window (separate cadence, so ingestSample handles dedup).
      if (this.regimeStateFast) ingestSample(this.regimeStateFast, sample);
      return slowOk;
    } catch (err) {
      this.warnRegimeRateLimited(err instanceof Error ? err.message : String(err || "ingest failed"));
      return false;
    }
  }

  estimateRegimeAndAdvice({ triggerBase, gateBase }) {
    const latest = this.state.latest || {};
    const cfg = this.syncRegimeStateWithSettings();
    const baseThresholds = {
      edgeRebalancePct: Number(this.settings.edgeRebalancePct || 0),
      minRebalanceIntervalSec: Number(this.settings.minRebalanceIntervalSec || 0),
      bandHalfBps: Number(this.settings.bandHalfBps || 0),
    };
    const baseDecisionView = {
      baseThresholds,
      effectiveThresholds: { ...baseThresholds },
      adviceReason: "regime_disabled",
      waitRecommended: false,
    };
    if (!cfg.enabled) {
      latest.regime = {
        enabled: false,
        ok: false,
        label: "unknown",
        thetaStrength: 0,
        theta: null,
        halfLifeSec: null,
        sigma: null,
        mu: null,
        confidence: 0,
        updatedAtIso: null,
        sampleCount: Array.isArray(this.regimeState?.samples) ? this.regimeState.samples.length : 0,
        requiredMinSamples: cfg.minSamples,
        feasibleSamples: null,
        windowSec: cfg.windowSec,
        fast: null,
      };
      latest.regimeDecision = baseDecisionView;
      this.state.latest = latest;
      return {
        enabled: false,
        est: null,
        advice: null,
        effectiveSettings: baseThresholds,
      };
    }

    try {
      const ouOpts = { mrHalfLifeMaxSec: cfg.mrHalfLifeMaxSec, trendHalfLifeMinSec: cfg.trendHalfLifeMinSec };
      const estSlow = estimateOU(this.regimeState, ouOpts);
      const estFast = this.regimeStateFast ? estimateOU(this.regimeStateFast, ouOpts) : null;

      // Blend fast + slow estimates: use fast window for quicker regime-shift detection.
      const fw = clamp(Number(cfg.fastWeight || 0), 0, 0.8);
      const est = { ...estSlow };
      if (estFast?.ok && estSlow.ok && fw > 0) {
        // Blend theta and thetaStrength; keep slow-window label for gate compatibility.
        if (estFast.theta > 0 && estSlow.theta > 0) {
          est.theta = (1 - fw) * estSlow.theta + fw * estFast.theta;
          est.halfLifeSec = est.theta > 0 ? Math.log(2) / est.theta : Number.POSITIVE_INFINITY;
        }
        est.thetaStrength = (1 - fw) * (estSlow.thetaStrength || 0) + fw * (estFast.thetaStrength || 0);
        // Use fast window's label if it detects trending (faster escape).
        if (estFast.label === "trending" && estSlow.label !== "trending") {
          est.label = "trending";
        }
      }
      console.log(`[regime-blend] fw=${fw} slow: ok=${estSlow.ok} b=${estSlow.slope?.toFixed(6)} theta=${estSlow.theta?.toFixed(6)} tStr=${estSlow.thetaStrength?.toFixed(4)} label=${estSlow.label} | fast: ok=${estFast?.ok} b=${estFast?.slope?.toFixed(6)} theta=${estFast?.theta?.toFixed(6)} tStr=${estFast?.thetaStrength?.toFixed(4)} label=${estFast?.label} | blended: theta=${est.theta?.toFixed(6)} tStr=${est.thetaStrength?.toFixed(4)} label=${est.label}`);
      const now = Date.now();
      const stats24h = this.summarizeEvents(this.getEventsSince(now - 24 * 60 * 60 * 1000));
      const recentRebalanceCostUsd =
        stats24h.rebalances > 0 ? stats24h.totalCostsUsd / stats24h.rebalances : this.estimateRecentRebalanceCostUsd();
      const feesPerHour = stats24h.feesUsd / 24;
      const advice = getRegimeAdvice({
        est,
        baseSettings: this.settings,
        edgeProgress: Number(triggerBase?.edgeProgress || 0),
        outOfRange: String(triggerBase?.reason || "") === "out_of_range",
        costs: {
          estimatedActionCostUsd: recentRebalanceCostUsd,
          gateAllowed: Boolean(gateBase?.allowed),
        },
        fees: {
          trailingFeesPerHourUsd: feesPerHour,
          fees24hUsd: stats24h.feesUsd,
        },
      });
      const effective = {
        edgeRebalancePct: baseThresholds.edgeRebalancePct,
        minRebalanceIntervalSec: baseThresholds.minRebalanceIntervalSec,
        bandHalfBps: baseThresholds.bandHalfBps,
      };
      if (advice?.ok) {
        effective.edgeRebalancePct = clamp(
          baseThresholds.edgeRebalancePct + Number(advice.edgeRebalancePctAdj || 0),
          0.6,
          0.98
        );
        effective.minRebalanceIntervalSec = clamp(
          Math.round(baseThresholds.minRebalanceIntervalSec + Number(advice.minRebalanceIntervalSecAdj || 0)),
          60,
          7200
        );
        // Allow both widening and narrowing from regime advice.
        const bandAdj = Number(advice.bandHalfBpsAdj || 0);
        const minBandHalfBps = Math.max(30, Math.round(baseThresholds.bandHalfBps * 0.7));
        effective.bandHalfBps = clamp(
          Math.round(baseThresholds.bandHalfBps + bandAdj),
          minBandHalfBps,
          Math.round(baseThresholds.bandHalfBps + Math.max(0, Number(cfg.maxBandAdjBps || 0)))
        );
      }
      const estOk = Boolean(est?.ok);
      const hasUsableMu =
        estOk &&
        (est?.label === "mean_reverting" || (Number(est?.thetaStrength || 0) > 0.3)) &&
        Number.isFinite(Number(est?.mu)) &&
        Number.isFinite(Number(est?.theta)) &&
        Number(est?.theta) > 0;
      latest.regime = {
        enabled: true,
        ok: estOk,
        label: est?.label || "unknown",
        thetaStrength: estOk ? Number(est?.thetaStrength || 0) : 0,
        theta: estOk && Number.isFinite(Number(est?.theta)) ? Number(est.theta) : null,
        halfLifeSec: estOk && Number.isFinite(Number(est?.halfLifeSec)) ? Number(est.halfLifeSec) : null,
        sigma: estOk && Number.isFinite(Number(est?.sigma)) ? Number(est.sigma) : null,
        mu: hasUsableMu ? Number(est.mu) : null,
        confidence: Number.isFinite(Number(est?.confidence)) ? Number(est.confidence) : 0,
        updatedAtIso: this.regimeState?.updatedAtSec ? new Date(this.regimeState.updatedAtSec * 1000).toISOString() : null,
        sampleCount: Array.isArray(this.regimeState?.samples) ? this.regimeState.samples.length : 0,
        requiredMinSamples: Number.isFinite(Number(est?.requiredMinSamples)) ? Number(est.requiredMinSamples) : cfg.minSamples,
        feasibleSamples: Number.isFinite(Number(est?.feasibleSamples)) ? Number(est.feasibleSamples) : null,
        windowSec: cfg.windowSec,
        fast: estFast?.ok ? {
          theta: Number.isFinite(Number(estFast.theta)) ? Number(estFast.theta) : null,
          thetaStrength: Number(estFast.thetaStrength || 0),
          halfLifeSec: Number.isFinite(Number(estFast.halfLifeSec)) ? Number(estFast.halfLifeSec) : null,
          label: estFast.label || "unknown",
          confidence: Number(estFast.confidence || 0),
          sampleCount: Array.isArray(this.regimeStateFast?.samples) ? this.regimeStateFast.samples.length : 0,
          windowSec: cfg.fastWindowSec,
        } : null,
      };
      latest.regimeDecision = {
        baseThresholds,
        effectiveThresholds: effective,
        adviceReason: String(advice?.reason || (est?.ok ? "no_adjustment" : "estimation_unavailable")),
        waitRecommended: Boolean(advice?.waitRecommended),
      };
      this.state.latest = latest;
      return {
        enabled: true,
        est,
        advice,
        effectiveSettings: effective,
      };
    } catch (err) {
      this.warnRegimeRateLimited(err instanceof Error ? err.message : String(err || "estimate failed"));
      latest.regime = {
        enabled: true,
        ok: false,
        label: "unknown",
        thetaStrength: 0,
        theta: null,
        halfLifeSec: null,
        sigma: null,
        mu: null,
        confidence: 0,
        updatedAtIso: this.regimeState?.updatedAtSec ? new Date(this.regimeState.updatedAtSec * 1000).toISOString() : null,
        sampleCount: Array.isArray(this.regimeState?.samples) ? this.regimeState.samples.length : 0,
        requiredMinSamples: cfg.minSamples,
        feasibleSamples: null,
        windowSec: cfg.windowSec,
        fast: null,
      };
      latest.regimeDecision = {
        ...baseDecisionView,
        adviceReason: "regime_fallback_on_error",
      };
      this.state.latest = latest;
      return {
        enabled: true,
        est: null,
        advice: null,
        effectiveSettings: baseThresholds,
      };
    }
  }

  estimateRecentRebalanceCostUsd() {
    const events = Array.isArray(this.state?.ledgerEvents) ? this.state.ledgerEvents : [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      if (!ev || ev.type !== "recenter") continue;
      const gas = Number(ev.gasUsd || 0);
      const swap = Number(ev.swapCostUsd || 0);
      const total = gas + swap;
      if (Number.isFinite(total) && total > 0) return total;
    }
    return 0;
  }

  async collectableNowSnapshot() {
    const tokenId = this.state.position?.tokenId;
    if (!tokenId) return { usdc: 0, weth: 0, usd: 0, isEstimated: true };
    const npm = this.state.position?.venue === "uniswapv3" ? this.uniswapNpm : this.slipstreamNpm;
    const venueActive = this.state.position?.venue === "uniswapv3" ? "uniswapv3" : "slipstream";
    const activePool = venueActive === "uniswapv3"
      ? this.state.latest?.fallback || this.state.latest?.primary || null
      : this.state.latest?.primary || this.state.latest?.fallback || null;
    const token0 = getAddress(activePool?.token0 || this.weth);
    const token1 = getAddress(activePool?.token1 || this.usdc);
    const staked = Boolean(this.state.emissions?.staked);
    let out0 = 0n;
    let out1 = 0n;
    let estimated = false;
    if (!staked) {
      // Not staked: simulate collect() from our address (standard approach).
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
      out0 = BigInt(
        Array.isArray(sim.result)
          ? sim.result[0]
          : sim.result?.amount0 ?? sim.result?.[0] ?? 0n
      );
      out1 = BigInt(
        Array.isArray(sim.result)
          ? sim.result[1]
          : sim.result?.amount1 ?? sim.result?.[1] ?? 0n
      );
    } else {
      // Staked: compute uncollected fees from pool feeGrowth state (same math as Aerodrome UI).
      // Slipstream's collect() simulation returns 0 for staked positions, so we must compute directly.
      const poolAddress = activePool?.pool || this.slipstreamPool;
      try {
        // Step 1: read position + pool globals in parallel.
        const [pos, feeGlobal0, feeGlobal1, slot0] = await Promise.all([
          this.publicClient.readContract({ address: npm, abi: NPM_POSITION_ABI, functionName: "positions", args: [BigInt(tokenId)] }),
          this.publicClient.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "feeGrowthGlobal0X128" }),
          this.publicClient.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "feeGrowthGlobal1X128" }),
          this.readSlot0(poolAddress),
        ]);
        // Step 2: read tick data (needs tickLower/tickUpper from position).
        const [tickLowerData, tickUpperData] = await Promise.all([
          this.publicClient.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "ticks", args: [Number(pos.tickLower ?? pos[5])] }),
          this.publicClient.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "ticks", args: [Number(pos.tickUpper ?? pos[6])] }),
        ]);
        const liquidity = BigInt(pos.liquidity ?? pos[7] ?? 0n);
        const fgInside0Last = BigInt(pos.feeGrowthInside0LastX128 ?? pos[8] ?? 0n);
        const fgInside1Last = BigInt(pos.feeGrowthInside1LastX128 ?? pos[9] ?? 0n);
        const tickLower = Number(pos.tickLower ?? pos[5]);
        const tickUpper = Number(pos.tickUpper ?? pos[6]);
        const currentTick = Number(slot0.tick ?? slot0[1]);
        const fg0 = BigInt(feeGlobal0);
        const fg1 = BigInt(feeGlobal1);
        // Slipstream ticks(): [liquidityGross, liquidityNet, stakedLiquidityNet, feeGrowthOutside0X128, feeGrowthOutside1X128, ...]
        const fgOutLower0 = BigInt(tickLowerData.feeGrowthOutside0X128 ?? tickLowerData[3] ?? 0n);
        const fgOutLower1 = BigInt(tickLowerData.feeGrowthOutside1X128 ?? tickLowerData[4] ?? 0n);
        const fgOutUpper0 = BigInt(tickUpperData.feeGrowthOutside0X128 ?? tickUpperData[3] ?? 0n);
        const fgOutUpper1 = BigInt(tickUpperData.feeGrowthOutside1X128 ?? tickUpperData[4] ?? 0n);
        // Compute fee growth inside the tick range (modular uint256 arithmetic).
        const Q256 = 1n << 256n;
        const mod = (v) => ((v % Q256) + Q256) % Q256;
        const fgBelow0 = currentTick >= tickLower ? fgOutLower0 : mod(fg0 - fgOutLower0);
        const fgBelow1 = currentTick >= tickLower ? fgOutLower1 : mod(fg1 - fgOutLower1);
        const fgAbove0 = currentTick < tickUpper ? fgOutUpper0 : mod(fg0 - fgOutUpper0);
        const fgAbove1 = currentTick < tickUpper ? fgOutUpper1 : mod(fg1 - fgOutUpper1);
        const fgInside0 = mod(fg0 - fgBelow0 - fgAbove0);
        const fgInside1 = mod(fg1 - fgBelow1 - fgAbove1);
        // Uncollected fees = delta(feeGrowthInside) * liquidity / 2^128, plus any tokensOwed.
        const Q128 = 1n << 128n;
        const uncollected0 = mod(fgInside0 - fgInside0Last) * liquidity / Q128;
        const uncollected1 = mod(fgInside1 - fgInside1Last) * liquidity / Q128;
        const tokensOwed0 = BigInt(pos.tokensOwed0 ?? pos[10] ?? 0n);
        const tokensOwed1 = BigInt(pos.tokensOwed1 ?? pos[11] ?? 0n);
        out0 = uncollected0 + tokensOwed0;
        out1 = uncollected1 + tokensOwed1;
        estimated = true;
        console.log(`[UC6] [collectable] feeGrowth compute tokenId=${tokenId} out0=${out0} out1=${out1} liq=${liquidity} tick=${currentTick} range=[${tickLower},${tickUpper}]`);
      } catch (err) {
        console.log(`[UC6] [collectable] feeGrowth compute FAILED tokenId=${tokenId} err=${err?.shortMessage || err?.message || err}`);
        return { usdc: 0, weth: 0, usd: 0, isEstimated: true };
      }
    }
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
      isEstimated: estimated,
    };
  }

  async readTokenBalance(tokenAddress) {
    return await this.publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.account.address],
    });
  }

  async readWalletPairBalances() {
    try {
      const results = await this.publicClient.multicall({
        allowFailure: true,
        contracts: [
          {
            address: this.usdc,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [this.account.address],
          },
          {
            address: this.weth,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [this.account.address],
          },
        ],
      });
      const usdcBalanceRaw = results?.[0]?.status === "success" ? BigInt(results[0].result || 0n) : null;
      const wethBalanceRaw = results?.[1]?.status === "success" ? BigInt(results[1].result || 0n) : null;
      if (usdcBalanceRaw != null && wethBalanceRaw != null) {
        return { usdcBalanceRaw, wethBalanceRaw };
      }
    } catch {
      // Fall back to individual reads when multicall is unavailable or degraded.
    }
    const [usdcBalanceRaw, wethBalanceRaw] = await Promise.all([
      this.readTokenBalance(this.usdc),
      this.readTokenBalance(this.weth),
    ]);
    return { usdcBalanceRaw, wethBalanceRaw };
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

  async quoteExactInputSingle({ tokenIn, tokenOut, amountIn, fee, tickSpacing, venueHint = null }) {
    const slipstreamCandidate = {
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
    };
    const uniswapCandidate = {
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
    };
    const candidates =
      venueHint === "slipstream"
        ? [slipstreamCandidate]
        : venueHint === "uniswapv3"
          ? [uniswapCandidate]
          : [slipstreamCandidate, uniswapCandidate];

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
    const minSwapIn =
      sameAddress(tokenIn, this.usdc)
        ? BigInt(1000) // 0.001 USDC dust floor
        : sameAddress(tokenIn, this.weth)
          ? BigInt("1000000000000") // 1e-6 WETH dust floor
          : BigInt(1);
    if (amountIn < minSwapIn) return null;

    await this.assertTxAllowed("swap");
    await this.approveIfNeeded(tokenIn, router, amountIn);
    const preInBalance = await this.readTokenBalance(tokenIn);
    const preOutBalance = await this.readTokenBalance(tokenOut);
    const venueHint = sameAddress(router, this.slipstreamRouter)
      ? "slipstream"
      : sameAddress(router, this.uniswapRouter)
        ? "uniswapv3"
        : null;
    const quoterQuote = await this.quoteExactInputSingle({ tokenIn, tokenOut, amountIn, fee, tickSpacing, venueHint }).catch(
      () => ({ amountOut: BigInt(0), source: "none" })
    );
    const estimatedOut = this.priceEstimateOut(amountIn, tokenIn, tokenOut, snapshot);
    const quotedOutForMin = quoterQuote.amountOut > BigInt(0) ? quoterQuote.amountOut : estimatedOut;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    const candidatesBase = [
      {
        abi: ROUTER_ABI_FEE,
        paramsBase: {
          tokenIn,
          tokenOut,
          fee: Math.max(1, fee || 3000),
          recipient: this.account.address,
          deadline,
          amountIn,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      },
      {
        abi: ROUTER_ABI_TICK,
        paramsBase: {
          tokenIn,
          tokenOut,
          tickSpacing: tickSpacing || 1,
          recipient: this.account.address,
          deadline,
          amountIn,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      },
    ];

    const retrySlippageBps = Math.max(Number(slippageBps || 0), 500);
    const slippageAttempts = [Number(slippageBps || 0)];
    if (retrySlippageBps > slippageAttempts[0]) slippageAttempts.push(retrySlippageBps);

    let lastErr = null;
    for (let slippageAttemptIndex = 0; slippageAttemptIndex < slippageAttempts.length; slippageAttemptIndex += 1) {
      const slippageBpsUsed = slippageAttempts[slippageAttemptIndex];
      const amountOutMinimum = this.minOutFromEstimate(quotedOutForMin, slippageBpsUsed);
      let sawTooLittleReceived = false;

      for (const c of candidatesBase) {
        const params = { ...c.paramsBase, amountOutMinimum };
        try {
          const sim = await this.publicClient.simulateContract({
            address: router,
            abi: c.abi,
            functionName: "exactInputSingle",
            args: [params],
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
          if (receipt.status && receipt.status !== "success") {
            throw new Error(`Swap tx reverted on-chain hash=${hash}`);
          }
          const inDelta = this.extractWalletErc20DeltaFromReceipt(receipt, tokenIn);
          const outDelta = this.extractWalletErc20DeltaFromReceipt(receipt, tokenOut);
          const postInBalance = await this.readTokenBalance(tokenIn);
          const postOutBalance = await this.readTokenBalance(tokenOut);
          const actualOutByBalance = postOutBalance > preOutBalance ? postOutBalance - preOutBalance : BigInt(0);
          const actualInByBalance = preInBalance > postInBalance ? preInBalance - postInBalance : BigInt(0);
          const actualOut = outDelta.inflow > 0n ? outDelta.inflow : actualOutByBalance;
          const actualIn = inDelta.outflow > 0n ? inDelta.outflow : actualInByBalance;
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
          const phaseCtx = this.lifecyclePhaseContext;
          if (phaseCtx?.positionRunId && (phaseCtx.phase === "open_swap" || phaseCtx.phase === "rebalance_inventory_swap")) {
            const gasUsed = BigInt(receipt?.gasUsed || 0n);
            const gasPrice = BigInt(receipt?.effectiveGasPrice || 0n);
            const gasUsdThisTx = Number(formatUnits(gasUsed * gasPrice, 18)) * this.getSpotUsdcPerWeth();
            const lifecycleType = phaseCtx.phase === "open_swap" ? "OPEN_SWAP" : "REBALANCE_INVENTORY_SWAP";
            await this.appendLifecycleEvent(
              this.lifecycleCommonFields({
                type: lifecycleType,
                positionRunId: String(phaseCtx.positionRunId),
                tokenId: phaseCtx.tokenId || this.state.position?.tokenId || null,
                band: phaseCtx.band || undefined,
                txHashes: [hash],
                accounting: {
                  gasUsd: gasUsdThisTx,
                  swapCostUsd: Math.max(0, swapCostUsd),
                  mintBurnUsd: 0,
                  feesCollectedUsd: 0,
                  rewardsUsd: 0,
                  isEstimated: false,
                },
                details: {
                  tokenIn,
                  tokenOut,
                  amountIn: amountIn.toString(),
                  quoteOut: quoteOut.toString(),
                  actualOut: actualOut.toString(),
                  actualIn: actualIn.toString(),
                  slippageBpsReal,
                  quoteSource,
                },
              })
            ).catch((err) => this.setLastError(err));
          }
          return {
            tokenIn,
            tokenOut,
            actualIn,
            actualOut,
            quoteOut,
            quoteSource,
            slippageBpsReal,
            slippageBpsUsed,
          };
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err || "");
          if (msg.includes("Too little received")) {
            sawTooLittleReceived = true;
          }
        }
      }

      const hasRetry = slippageAttemptIndex + 1 < slippageAttempts.length;
      if (!(hasRetry && sawTooLittleReceived)) {
        break;
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
    const tick = Math.round(Number(currentTick || 0));
    const spacing = Math.max(1, Math.round(Number(tickSpacing || 0)));
    const targetHalfBps = Math.max(1, Number(bandHalfBps || 0));
    const priceFactor = 1 + targetHalfBps / 10_000;
    const targetHalfTicks = Math.max(1, Math.round(Math.log(priceFactor) / Math.log(1.0001)));
    const targetSpanTicks = Math.max(spacing, targetHalfTicks * 2);
    const baseSpanSteps = Math.max(1, Math.round(targetSpanTicks / spacing));

    let best = null;
    const consider = (tickLower, tickUpper) => {
      if (!(Number.isFinite(tickLower) && Number.isFinite(tickUpper))) return;
      if (tickUpper <= tickLower) return;
      if (!(tick > tickLower && tick < tickUpper)) return;
      const effBps = this.estimateBandHalfBpsFromTicks(tickLower, tickUpper);
      if (!(Number.isFinite(effBps) && effBps > 0)) return;
      const center = Math.round((tickLower + tickUpper) / 2);
      const widthDiff = Math.abs(effBps - targetHalfBps);
      const centerDiff = Math.abs(((tickLower + tickUpper) / 2) - tick);
      const narrowerPenalty = effBps < targetHalfBps ? 1 : 0;
      const score = widthDiff * 1_000_000 + centerDiff * 10 + narrowerPenalty;
      if (!best || score < best.score) {
        best = { score, centerTick: center, tickLower, tickUpper, bandHalfBpsEffective: effBps };
      }
    };

    for (let stepOffset = -4; stepOffset <= 4; stepOffset += 1) {
      const spanSteps = baseSpanSteps + stepOffset;
      if (spanSteps <= 0) continue;
      const span = spanSteps * spacing;
      const idealLower = tick - span / 2;
      const baseLowerCandidates = new Set([
        this.floorTick(idealLower, spacing),
        this.ceilTick(idealLower, spacing),
      ]);
      for (const baseLower of baseLowerCandidates) {
        for (const shift of [-spacing, 0, spacing]) {
          const tickLower = baseLower + shift;
          const tickUpper = tickLower + span;
          consider(tickLower, tickUpper);
        }
      }
    }

    if (best) {
      return { centerTick: best.centerTick, tickLower: best.tickLower, tickUpper: best.tickUpper };
    }

    const center = this.floorTick(tick, spacing);
    const delta = this.toTickDelta(targetHalfBps, spacing);
    let tickLower = this.floorTick(center - delta, spacing);
    let tickUpper = this.ceilTick(center + delta, spacing);
    if (tickUpper <= tickLower) tickUpper = tickLower + spacing;
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

  extractWalletErc20DeltaFromReceipt(receipt, tokenAddress) {
    let inflow = BigInt(0);
    let outflow = BigInt(0);
    for (const log of receipt?.logs || []) {
      if (!sameAddress(log.address, tokenAddress)) continue;
      try {
        const decoded = decodeEventLog({ abi: [ERC20_TRANSFER_EVENT], data: log.data, topics: log.topics });
        if (decoded.eventName !== "Transfer") continue;
        const value = BigInt(decoded.args.value ?? 0);
        if (sameAddress(decoded.args.from, this.account.address)) outflow += value;
        if (sameAddress(decoded.args.to, this.account.address)) inflow += value;
      } catch {
        // ignore unrelated logs
      }
    }
    return { inflow, outflow };
  }

  receiptHasCollectLog(receipt, npmAddress) {
    for (const log of receipt?.logs || []) {
      if (!sameAddress(log.address, npmAddress)) continue;
      try {
        const decoded = decodeEventLog({ abi: [NPM_COLLECT_EVENT], data: log.data, topics: log.topics });
        if (decoded.eventName === "Collect") return true;
      } catch {
        // ignore unrelated logs
      }
    }
    return false;
  }

  isLegacyBogusIdleDeploySwapCost(ev) {
    if (!ev || ev.type !== "error" || ev.reason !== "idle_deploy_failed") return false;
    const swapCost = Number(ev.swapCostUsd || 0);
    if (!(swapCost > 1)) return false;
    const swaps = Array.isArray(ev.swaps) ? ev.swaps : [];
    if (swaps.length === 0) return false;
    for (const sw of swaps) {
      const slippage = Number(sw?.slippageBpsReal);
      const actualOut = String(sw?.actualOut ?? "0");
      const quoteOut = String(sw?.quoteOut ?? "0");
      if ((Number.isFinite(slippage) && slippage >= 5_000) || (quoteOut !== "0" && actualOut === "0")) {
        return true;
      }
    }
    return false;
  }

  isPathologicalSwapRow(sw) {
    if (!sw || typeof sw !== "object") return false;
    const quoteOutUsd = Number(sw.quoteOutUsd || 0);
    const swapCostUsd = Number(sw.swapCostUsd || 0);
    const slippage = Number(sw.slippageBpsReal);
    const actualOutStr = String(sw.actualOut ?? "0");
    const quoteOutStr = String(sw.quoteOut ?? "0");

    if (quoteOutUsd > 1 && quoteOutStr !== "0" && actualOutStr === "0") return true;
    if (Number.isFinite(slippage) && slippage >= 5_000) return true;
    if (quoteOutUsd > 0 && swapCostUsd > quoteOutUsd * 1.1) return true;
    return false;
  }

  recomputeEventNet(ev) {
    const fees = Number(ev?.feesCollectedUsd || 0);
    const rewards = Number(ev?.rewardsUsd || 0);
    const gas = Number(ev?.gasUsd || 0);
    const swap = Number(ev?.swapCostUsd || 0);
    return fees + rewards - (gas + swap);
  }

  sanitizeLedgerEventsInPlace() {
    const ledger = Array.isArray(this.state.ledgerEvents) ? this.state.ledgerEvents : [];
    let changed = false;
    for (const ev of ledger) {
      const swaps = Array.isArray(ev?.swaps) ? ev.swaps : [];
      if (swaps.length > 0) {
        let rowChanged = false;
        let recomputedSwapCostUsd = 0;
        for (const sw of swaps) {
          if (this.isPathologicalSwapRow(sw)) {
            sw.swapCostUsd = 0;
            sw.slippageBpsReal = null;
            sw.swapCostSanitized = true;
            rowChanged = true;
          }
          const rowCost = Number(sw?.swapCostUsd || 0);
          if (Number.isFinite(rowCost) && rowCost > 0) recomputedSwapCostUsd += rowCost;
        }
        if (!Number.isFinite(recomputedSwapCostUsd) || recomputedSwapCostUsd < 0) {
          recomputedSwapCostUsd = 0;
        }
        if (Math.abs(Number(ev.swapCostUsd || 0) - recomputedSwapCostUsd) > 1e-9) {
          ev.swapCostUsd = recomputedSwapCostUsd;
          rowChanged = true;
        }
        if (rowChanged) {
          ev.netUsd = this.recomputeEventNet(ev);
          changed = true;
        }
      }

      if (this.isLegacyBogusIdleDeploySwapCost(ev) && !ev.swapCostSanitized) {
        ev.swapCostUsd = 0;
        ev.swapCostSanitized = true;
        ev.netUsd = this.recomputeEventNet(ev);
        changed = true;
      } else if (ev && typeof ev === "object" && ev.netUsd != null) {
        // Normalize old events that had net double-counted against mintBurnUsd.
        const normalizedNet = this.recomputeEventNet(ev);
        if (Number.isFinite(normalizedNet) && Math.abs(Number(ev.netUsd || 0) - normalizedNet) > 1e-9) {
          ev.netUsd = normalizedNet;
          changed = true;
        }
      }
    }
    return changed;
  }

  async backfillMissingFeesFromReceipts(limit = 100) {
    const ledger = Array.isArray(this.state.ledgerEvents) ? this.state.ledgerEvents : [];
    if (ledger.length === 0) return false;
    const spot = this.getSpotUsdcPerWeth();
    let changed = false;
    let repaired = 0;
    for (let i = ledger.length - 1; i >= 0 && repaired < limit; i -= 1) {
      const ev = ledger[i];
      if (!ev || (ev.type !== "harvest" && ev.type !== "recenter" && ev.type !== "liquidate")) continue;
      if (Number(ev.feesCollectedUsd || 0) > 0) continue;
      if (ev.feesBackfilled) continue;
      const txHashes = Array.isArray(ev.txHashes) ? ev.txHashes.filter((h) => typeof h === "string" && h.startsWith("0x")) : [];
      if (txHashes.length === 0) continue;

      let usdcRaw = 0n;
      let wethRaw = 0n;
      let sawCollect = false;
      for (const hash of txHashes) {
        try {
          const receipt = await this.publicClient.getTransactionReceipt({ hash });
          const collectOnSlip = this.receiptHasCollectLog(receipt, this.slipstreamNpm);
          const collectOnUni = this.receiptHasCollectLog(receipt, this.uniswapNpm);
          if (!collectOnSlip && !collectOnUni) continue;
          sawCollect = true;
          const usdcDelta = this.extractWalletErc20DeltaFromReceipt(receipt, this.usdc);
          const wethDelta = this.extractWalletErc20DeltaFromReceipt(receipt, this.weth);
          usdcRaw += BigInt(usdcDelta.inflow || 0n);
          wethRaw += BigInt(wethDelta.inflow || 0n);
        } catch {
          // ignore tx receipt failures; try other txs/events
        }
      }
      if (!sawCollect) continue;

      const feesUsd =
        Number(formatUnits(usdcRaw, USDC_DECIMALS)) +
        Number(formatUnits(wethRaw, WETH_DECIMALS)) * spot;
      if (feesUsd > 0) {
        ev.feesCollectedUsd = feesUsd;
        ev.feesBackfilled = true;
        ev.netUsd = this.recomputeEventNet(ev);
        changed = true;
        repaired += 1;
      } else {
        ev.feesBackfilled = true;
        changed = true;
      }
    }
    return changed;
  }

  async repairLedgerAccounting() {
    const now = Date.now();
    if (!this.ledgerRepairDirty) return false;
    if (this.ledgerRepairInFlight) return false;
    if (this.lastLedgerRepairAtMs && now - this.lastLedgerRepairAtMs < 60_000) return false;
    this.ledgerRepairInFlight = true;
    this.lastLedgerRepairAtMs = now;
    try {
      let changed = false;
      if (this.sanitizeLedgerEventsInPlace()) changed = true;
      const needsFees = this.needsLedgerFeeBackfill();
      const needsBand = this.needsLedgerBandBackfill();
      if (!needsFees && !needsBand) {
        this.ledgerRepairDirty = false;
        return changed;
      }
      if (needsFees && (await this.backfillMissingFeesFromReceipts())) changed = true;
      if (needsBand && (await this.backfillBandMetadataForRecenters())) changed = true;
      this.ledgerRepairDirty = this.needsLedgerFeeBackfill() || this.needsLedgerBandBackfill();
      return changed;
    } finally {
      this.ledgerRepairInFlight = false;
    }
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

        let amount0Used = 0n;
        let amount1Used = 0n;
        if (Array.isArray(sim.result)) {
          if (typeof sim.result[2] === "bigint") amount0Used = sim.result[2];
          if (typeof sim.result[3] === "bigint") amount1Used = sim.result[3];
        }
        const simulatedUsdc = sameAddress(token0, this.usdc)
          ? Number(formatUnits(amount0Used, USDC_DECIMALS))
          : sameAddress(token1, this.usdc)
            ? Number(formatUnits(amount1Used, USDC_DECIMALS))
            : 0;
        const simulatedWeth = sameAddress(token0, this.weth)
          ? Number(formatUnits(amount0Used, WETH_DECIMALS))
          : sameAddress(token1, this.weth)
            ? Number(formatUnits(amount1Used, WETH_DECIMALS))
            : 0;
        const rawMintValueUsd = simulatedUsdc + simulatedWeth * this.getSpotUsdcPerWeth();
        const minMintUsd = this.getMinimumMintNotionalUsd();
        if (rawMintValueUsd > 0 && rawMintValueUsd < minMintUsd) {
          const err = new Error(
            `Mint notional ${rawMintValueUsd.toFixed(4)} USD below minimum ${minMintUsd.toFixed(2)} USD`
          );
          err.uc6MintSkippedDust = true;
          err.uc6MintValueUsd = rawMintValueUsd;
          err.uc6MintMinUsd = minMintUsd;
          throw err;
        }

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

        const phaseCtx = this.lifecyclePhaseContext;
        if (phaseCtx?.positionRunId && (phaseCtx.phase === "open_mint" || phaseCtx.phase === "rebalance_mint")) {
          const gasUsdThisTx = (() => {
            const gasUsed = BigInt(receipt?.gasUsed || 0n);
            const gasPrice = BigInt(receipt?.effectiveGasPrice || 0n);
            return Number(formatUnits(gasUsed * gasPrice, 18)) * this.getSpotUsdcPerWeth();
          })();
          const usedUsdc = sameAddress(token0, this.usdc)
            ? Number(formatUnits(amount0Used, USDC_DECIMALS))
            : sameAddress(token1, this.usdc)
              ? Number(formatUnits(amount1Used, USDC_DECIMALS))
              : 0;
          const usedWeth = sameAddress(token0, this.weth)
            ? Number(formatUnits(amount0Used, WETH_DECIMALS))
            : sameAddress(token1, this.weth)
              ? Number(formatUnits(amount1Used, WETH_DECIMALS))
              : 0;
          const rawMintValueUsd = usedUsdc + usedWeth * this.getSpotUsdcPerWeth();
          await this.appendLifecycleEvent(
            this.lifecycleCommonFields({
              type: phaseCtx.phase === "open_mint" ? "OPEN_MINT" : "REBALANCE_MINT",
              positionRunId: String(phaseCtx.positionRunId),
              tokenId: tokenId.toString(),
              band: {
                bandHalfBps:
                  Number(phaseCtx.band?.bandHalfBps || this.estimateBandHalfBpsFromTicks(tickLower, tickUpper) || 0),
                tickLower,
                tickUpper,
              },
              txHashes: [hash],
              accounting: {
                gasUsd: gasUsdThisTx,
                mintBurnUsd: gasUsdThisTx,
                isEstimated: false,
              },
              details: {
                mintedTokenId: tokenId.toString(),
                liquidity: pos?.liquidity?.toString() || null,
                amount0Used: amount0Used.toString(),
                amount1Used: amount1Used.toString(),
                rawMintValueUsd,
              },
            })
          ).catch((err) => this.setLastError(err));
          if (phaseCtx.phase === "open_mint") {
            this.scheduleEntrySnapshot({
              positionRunId: String(phaseCtx.positionRunId),
              rawMintValueUsd,
            });
          }
        }

        // NOTE: auto-stake into gauge is deferred to the main loop (maybeAutoStakeIdle)
        // so that top-ups can complete first — increaseLiquidity reverts on staked NFTs.

        return {
          tokenId: tokenId.toString(),
          liquidity: pos?.liquidity?.toString() || null,
          tickLower: pos?.tickLower ?? tickLower,
          tickUpper: pos?.tickUpper ?? tickUpper,
          centerTick: Math.round((tickLower + tickUpper) / 2),
          venue,
          amount0Used,
          amount1Used,
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

  async increaseLiquidityPosition({
    npmAddress,
    tokenId,
    amount0Desired,
    amount1Desired,
  }) {
    await this.assertTxAllowed("increase_liquidity");
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
    const params = {
      tokenId: BigInt(tokenId),
      amount0Desired,
      amount1Desired,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline,
    };

    const sim = await this.publicClient.simulateContract({
      address: npmAddress,
      abi: NPM_INCREASE_LIQUIDITY_ABI,
      functionName: "increaseLiquidity",
      args: [params],
      account: this.account.address,
    });
    await this.assertTxAllowed("increase_liquidity_write");
    const hash = await this.walletClient.writeContract({
      ...sim.request,
      account: this.account,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    this.addTxToActiveAction("increase", hash, receipt);
    if (receipt.status && receipt.status !== "success") {
      throw new Error(`increaseLiquidity tx reverted on-chain hash=${hash}`);
    }

    let used0 = 0n;
    let used1 = 0n;
    let liquidityAdded = 0n;
    if (Array.isArray(sim.result)) {
      if (typeof sim.result[0] === "bigint") liquidityAdded = sim.result[0];
      if (typeof sim.result[1] === "bigint") used0 = sim.result[1];
      if (typeof sim.result[2] === "bigint") used1 = sim.result[2];
    }
    return { hash, receipt, amount0Used: used0, amount1Used: used1, liquidityAdded };
  }

  async closePosition({ npmAddress, tokenId, feeValueOverrideUsd = null, feeBreakdownOverride = null }) {
    if (!tokenId) return;
    await this.assertTxAllowed("close_position");

    // Unstake from gauge before any NFT management operations
    if (this.settings.emissions?.enabled && this.settings.emissions?.autoUnstakeOnRebalance) {
      try {
        await this.ensureUnstakedForNpmActions("close_position");
      } catch (err) {
        console.warn("[UC6] [emissions] auto-unstake before close failed:", sanitizeErrorMessage(err));
      }
    }

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

    const caps = this.getExecutionCapsConfig();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const collectParams = {
      tokenId: id,
      recipient: this.account.address,
      amount0Max: UINT128_MAX,
      amount1Max: UINT128_MAX,
    };
    const preUsdc = await this.readTokenBalance(this.usdc);
    const preWeth = await this.readTokenBalance(this.weth);

    let hashMulticall = null;
    let recMulticall = null;
    let hashDec = null;
    let recDec = null;
    let hashCollect = null;
    let recCollect = null;
    let hashBurn = null;
    let recBurn = null;

    let usedMulticall = false;
    if (Boolean(caps.useMulticallClose)) {
      try {
        const calls = [];
        if (pos.liquidity > 0n) {
          calls.push(
            encodeFunctionData({
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
            })
          );
        }
        calls.push(
          encodeFunctionData({
            abi: NPM_POSITION_ABI,
            functionName: "collect",
            args: [collectParams],
          })
        );
        calls.push(
          encodeFunctionData({
            abi: NPM_POSITION_ABI,
            functionName: "burn",
            args: [id],
          })
        );

        await this.assertTxAllowed("close_multicall");
        hashMulticall = await this.walletClient.writeContract({
          address: npmAddress,
          abi: NPM_POSITION_ABI,
          functionName: "multicall",
          args: [calls],
          account: this.account,
        });
        recMulticall = await this.publicClient.waitForTransactionReceipt({ hash: hashMulticall });
        this.addTxToActiveAction("decrease", hashMulticall, recMulticall);
        if (recMulticall.status && recMulticall.status !== "success") {
          throw new Error(`close multicall tx reverted on-chain hash=${hashMulticall}`);
        }
        usedMulticall = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err || "unknown close multicall error");
        console.warn(`[UC6] close multicall failed; falling back to legacy close: ${redactSensitiveText(msg)}`);
      }
    }

    if (!usedMulticall) {
      if (pos.liquidity > 0n) {
        await this.assertTxAllowed("close_decrease_liquidity");
        hashDec = await this.walletClient.writeContract({
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
        recDec = await this.publicClient.waitForTransactionReceipt({ hash: hashDec });
        this.addTxToActiveAction("decrease", hashDec, recDec);
      }

      await this.assertTxAllowed("close_collect");
      hashCollect = await this.walletClient.writeContract({
        address: npmAddress,
        abi: NPM_POSITION_ABI,
        functionName: "collect",
        args: [collectParams],
        account: this.account,
      });
      recCollect = await this.publicClient.waitForTransactionReceipt({ hash: hashCollect });
      this.addTxToActiveAction("collect", hashCollect, recCollect);

      try {
        await this.assertTxAllowed("close_burn");
        hashBurn = await this.walletClient.writeContract({
          address: npmAddress,
          abi: NPM_POSITION_ABI,
          functionName: "burn",
          args: [id],
          account: this.account,
        });
        recBurn = await this.publicClient.waitForTransactionReceipt({ hash: hashBurn });
        this.addTxToActiveAction("burn", hashBurn, recBurn);
      } catch {
        // Burn can fail if dust remains; position is still closed if liquidity is zero.
      }
    }

    const collectReceipt = recCollect || recMulticall;
    const decodedCollect = collectReceipt
      ? this.extractCollectedAmountsFromReceipt(collectReceipt, npmAddress, id)
      : null;

    const postUsdc = await this.readTokenBalance(this.usdc);
    const postWeth = await this.readTokenBalance(this.weth);
    const usdcDelta = postUsdc > preUsdc ? postUsdc - preUsdc : 0n;
    const wethDelta = postWeth > preWeth ? postWeth - preWeth : 0n;
    let collectUsdcRaw = usdcDelta;
    let collectWethRaw = wethDelta;
    if (decodedCollect && (decodedCollect.amount0 > 0n || decodedCollect.amount1 > 0n)) {
      let mappedUsdc = 0n;
      let mappedWeth = 0n;
      if (sameAddress(pos.token0, this.usdc)) mappedUsdc = decodedCollect.amount0;
      if (sameAddress(pos.token1, this.usdc)) mappedUsdc = decodedCollect.amount1;
      if (sameAddress(pos.token0, this.weth)) mappedWeth = decodedCollect.amount0;
      if (sameAddress(pos.token1, this.weth)) mappedWeth = decodedCollect.amount1;
      if (mappedUsdc > 0n || mappedWeth > 0n) {
        collectUsdcRaw = mappedUsdc;
        collectWethRaw = mappedWeth;
      }
    }
    const feesUsd =
      Number(formatUnits(usdcDelta, USDC_DECIMALS)) +
      Number(formatUnits(wethDelta, WETH_DECIMALS)) * this.getSpotUsdcPerWeth();
    // For rebalance close, collect() contains principal + fees after decreaseLiquidity.
    // We attribute only pre-close collectable fees (or fallback computed value if override absent).
    this.addFeesToActiveAction(feeValueOverrideUsd == null ? feesUsd : feeValueOverrideUsd);
    this.state.latest.collectableNow = { usdc: 0, weth: 0, usd: 0, isEstimated: false };

    const feeBreakdown = feeBreakdownOverride && typeof feeBreakdownOverride === "object"
      ? {
          usdc: Math.max(0, Number(feeBreakdownOverride.usdc || 0)),
          weth: Math.max(0, Number(feeBreakdownOverride.weth || 0)),
          usd: Math.max(0, Number(feeBreakdownOverride.usd || 0)),
        }
      : {
          usdc: Number(formatUnits(usdcDelta, USDC_DECIMALS)),
          weth: Number(formatUnits(wethDelta, WETH_DECIMALS)),
          usd: feeValueOverrideUsd == null ? feesUsd : Number(feeValueOverrideUsd || 0),
        };
    const collectOut = {
      usdc: Number(formatUnits(collectUsdcRaw, USDC_DECIMALS)),
      weth: Number(formatUnits(collectWethRaw, WETH_DECIMALS)),
    };
    const principalOut = {
      usdc: Math.max(0, collectOut.usdc - feeBreakdown.usdc),
      weth: Math.max(0, collectOut.weth - feeBreakdown.weth),
    };
    const closeTxHashes = Array.from(
      new Set([hashMulticall, hashDec, hashCollect, hashBurn].filter(Boolean).map(String))
    );
    const phaseCtx = this.lifecyclePhaseContext;
    if (phaseCtx?.positionRunId && (phaseCtx.phase === "rebalance_close" || phaseCtx.phase === "final_close")) {
      const gasFrom = (receipt) => {
        const gasUsed = BigInt(receipt?.gasUsed || 0n);
        const gasPrice = BigInt(receipt?.effectiveGasPrice || 0n);
        return Number(formatUnits(gasUsed * gasPrice, 18)) * this.getSpotUsdcPerWeth();
      };
      const gasUsd = [recMulticall, recDec, recCollect, recBurn].filter(Boolean).reduce((sum, receipt) => {
        return sum + gasFrom(receipt);
      }, 0);
      const lifecycleType = phaseCtx.phase === "final_close" ? "CLOSE_POSITION" : "REBALANCE_CLOSE";
      const details = {
        closedTokenId: String(tokenId),
        principalOut,
        feesOut: { usdc: feeBreakdown.usdc, weth: feeBreakdown.weth },
      };
      await this.appendLifecycleEvent(
        this.lifecycleCommonFields({
          type: lifecycleType,
          positionRunId: String(phaseCtx.positionRunId),
          tokenId: tokenId,
          band: phaseCtx.band || undefined,
          txHashes: closeTxHashes,
          accounting: {
            gasUsd,
            mintBurnUsd: gasUsd,
            feesCollectedUsd: Number(feeBreakdown.usd || 0),
            isEstimated: false,
          },
          details,
        })
      ).catch((err) => this.setLastError(err));
      if (phaseCtx.phase === "final_close") {
        const spot = this.getSpotUsdcPerWeth();
        const exitValueUsd = principalOut.usdc + principalOut.weth * spot;
        await this.appendLifecycleEvent(
          this.lifecycleCommonFields({
            type: "EXIT_SNAPSHOT",
            positionRunId: String(phaseCtx.positionRunId),
            tokenId: tokenId,
            txHashes: [],
            details: {
              exitTokens: principalOut,
              exitValueUsd,
              spotPriceUsdcPerWeth: spot,
            },
          })
        ).catch((err) => this.setLastError(err));
      }
    }

    return {
      closedTokenId: String(tokenId),
      principalOut,
      feesOut: { usdc: feeBreakdown.usdc, weth: feeBreakdown.weth, usd: feeBreakdown.usd },
      txHashes: closeTxHashes,
    };
  }

  async maybeTopUpLiquidity(snapshot) {
    const tokenId = this.state.position?.tokenId;
    if (!tokenId) return false;
    if (!snapshot) return false;
    if (this.settings.venue !== "slipstream") return false;
    const topUpRetryAtMs = Date.parse(this.state.topUpRetryAfterIso || "");
    if (Number.isFinite(topUpRetryAtMs) && topUpRetryAtMs > Date.now()) return false;
    const caps = this.getExecutionCapsConfig();
    const currentTopUps = Number(this.state.position?.topUpsThisCycle || 0);
    if (currentTopUps >= Number(caps.maxTopUpsPerCycle || 0)) return false;

    const spot = this.getSpotUsdcPerWeth();
    const wallet = this.state.latest?.wallet || {};
    const usdcBalNum = Number(wallet.usdc || 0);
    const wethBalNum = Number(wallet.weth || 0);
    const walletTotalUsd = Number(wallet.valuesUsd?.total || 0);
    const reserveTargetUsdc = this.getEffectiveReserveTargetUsdc(
      walletTotalUsd + Number(this.state.latest?.lp?.usdValue || 0)
    );
    const deployableSignalUsd = Math.max(0, usdcBalNum - reserveTargetUsdc) + (wethBalNum * spot);
    const minTopUpUsd = Math.max(
      MIN_IDLE_TOPUP_USD,
      Number(this.settings.minTopUpUsd || 0),
      Number(caps.minTopUpUsd || 0)
    );
    if (!(deployableSignalUsd > minTopUpUsd)) return false;

    const failureGate = this.getFailureCooldownGate();
    if (!failureGate.allowed) return false;

    const router = this.slipstreamRouter;
    const npm = this.slipstreamNpm;
    const keepReserveRaw = parseUnits(reserveTargetUsdc.toFixed(6), USDC_DECIMALS);
    const keepReserveTopUpRaw = keepReserveRaw + USDC_RESERVE_GUARD_RAW;
    const maxDeployRaw = parseUnits(this.settings.maxDeployUsdc.toFixed(6), USDC_DECIMALS);
    const minUsdcDeployRaw = parseUnits("1", USDC_DECIMALS);

    // Unstake if needed — increaseLiquidity reverts on NFTs owned by the gauge
    if (this.settings.emissions?.enabled && this.state.emissions?.staked) {
      try {
        await this.ensureUnstakedForNpmActions("top_up");
      } catch (err) {
        console.warn("[UC6] [emissions] auto-unstake before top-up failed:", sanitizeErrorMessage(err));
        return false;
      }
    }

    this.beginAction("topup", "idle_deploy");
    try {
      const maxSwapCount = Math.max(0, Math.min(1, Number(caps.maxSwapsOnOpen || 0)));
      let swapsUsed = 0;
      let { usdcBalanceRaw, wethBalanceRaw } = await this.readWalletPairBalances();
      const syncWalletPairBalances = async () => {
        ({ usdcBalanceRaw, wethBalanceRaw } = await this.readWalletPairBalances());
      };
      const applySwapDelta = (swapRes) => {
        if (!swapRes) return;
        const actualIn = BigInt(swapRes.actualIn || 0);
        const actualOut = BigInt(swapRes.actualOut || 0);
        if (sameAddress(swapRes.tokenIn, this.usdc)) {
          usdcBalanceRaw = usdcBalanceRaw > actualIn ? usdcBalanceRaw - actualIn : 0n;
        } else if (sameAddress(swapRes.tokenIn, this.weth)) {
          wethBalanceRaw = wethBalanceRaw > actualIn ? wethBalanceRaw - actualIn : 0n;
        }
        if (sameAddress(swapRes.tokenOut, this.usdc)) {
          usdcBalanceRaw += actualOut;
        } else if (sameAddress(swapRes.tokenOut, this.weth)) {
          wethBalanceRaw += actualOut;
        }
      };

      let freeUsdcRaw = usdcBalanceRaw > keepReserveTopUpRaw ? usdcBalanceRaw - keepReserveTopUpRaw : 0n;
      let deployableUsdcRaw = freeUsdcRaw < maxDeployRaw ? freeUsdcRaw : maxDeployRaw;

      // If wallet is WETH-heavy and no deployable USDC remains, convert to USDC first.
      if (
        deployableUsdcRaw <= minUsdcDeployRaw &&
        wethBalanceRaw > 0n &&
        swapsUsed < maxSwapCount &&
        Number(formatUnits(wethBalanceRaw, WETH_DECIMALS)) * spot >= Number(caps.minSwapUsd || 0)
      ) {
        const swapRes = await this.swapExactInputSingle({
          router,
          tokenIn: this.weth,
          tokenOut: this.usdc,
          amountIn: wethBalanceRaw,
          slippageBps: this.settings.slippageBps,
          fee: snapshot.fee,
          tickSpacing: snapshot.tickSpacing,
          snapshot,
        });
        if (swapRes) {
          applySwapDelta(swapRes);
          swapsUsed += 1;
          await syncWalletPairBalances();
        }
        freeUsdcRaw = usdcBalanceRaw > keepReserveTopUpRaw ? usdcBalanceRaw - keepReserveTopUpRaw : 0n;
        deployableUsdcRaw = freeUsdcRaw < maxDeployRaw ? freeUsdcRaw : maxDeployRaw;
      }

      if (deployableUsdcRaw <= 0n && wethBalanceRaw <= 0n) {
        this.activeAction = null;
        return false;
      }

      // Estimate the in-range token ratio for the current position and solve for a larger
      // one-shot USDC->WETH swap amount instead of defaulting to a 50/50 USD split.
      let swapIn = BigInt(0);
      if (deployableUsdcRaw > minUsdcDeployRaw) {
        let targetUsdcPerWeth = spot > 0 ? spot : Number(snapshot?.priceUsdcPerWeth || 0);
        try {
          const lower = Number(this.state.position?.tickLower);
          const upper = Number(this.state.position?.tickUpper);
          const sqrtPriceX96 = snapshot?.sqrtPriceX96 != null ? BigInt(snapshot.sqrtPriceX96) : null;
          if (Number.isFinite(lower) && Number.isFinite(upper) && sqrtPriceX96 && upper > lower) {
            const sampleLiquidity = BigInt("1000000000000000000");
            const ratioSample = this.lpAmountsFromLiquidity(
              sampleLiquidity,
              lower,
              upper,
              sqrtPriceX96,
              snapshot.token0,
              snapshot.token1
            );
            const sampleUsdc = Number(formatUnits(ratioSample.usdcRaw || BigInt(0), USDC_DECIMALS));
            const sampleWeth = Number(formatUnits(ratioSample.wethRaw || BigInt(0), WETH_DECIMALS));
            if (sampleUsdc > 0 && sampleWeth > 0) {
              targetUsdcPerWeth = sampleUsdc / sampleWeth;
            }
          }
        } catch {
          // fall back to spot-price split
        }

        const spotPx = spot > 0 ? spot : Number(snapshot?.priceUsdcPerWeth || 0);
        const usdcDeployNom = Number(formatUnits(deployableUsdcRaw, USDC_DECIMALS));
        const wethNom = Number(formatUnits(wethBalanceRaw, WETH_DECIMALS));
        if (targetUsdcPerWeth > 0 && spotPx > 0 && Number.isFinite(usdcDeployNom) && Number.isFinite(wethNom)) {
          const imbalanceUsdc = usdcDeployNom - targetUsdcPerWeth * wethNom;
          if (imbalanceUsdc > 0) {
            const xUsdc = imbalanceUsdc / (1 + targetUsdcPerWeth / spotPx);
            if (xUsdc > 0) {
              const clampedUsdc = Math.min(usdcDeployNom, Math.max(0, xUsdc));
              if (clampedUsdc > 0) {
                swapIn = parseUnits(clampedUsdc.toFixed(6), USDC_DECIMALS);
              }
            }
          }
        }

        // Fallback when ratio estimate is unavailable.
        if (swapIn <= 0n) {
          swapIn = (deployableUsdcRaw + 1n) / 2n;
        }
      }
      if (
        swapIn > 0n &&
        swapsUsed < maxSwapCount &&
        Number(formatUnits(swapIn, USDC_DECIMALS)) >= Number(caps.minSwapUsd || 0)
      ) {
        const swapRes = await this.swapExactInputSingle({
          router,
          tokenIn: this.usdc,
          tokenOut: this.weth,
          amountIn: swapIn,
          slippageBps: this.settings.slippageBps,
          fee: snapshot.fee,
          tickSpacing: snapshot.tickSpacing,
          snapshot,
        });
        if (swapRes) {
          applySwapDelta(swapRes);
          swapsUsed += 1;
          await syncWalletPairBalances();
        }
      }

      await syncWalletPairBalances();
      const usdcAfter = usdcBalanceRaw;
      const wethAfter = wethBalanceRaw;
      let usdcSpendable = usdcAfter > keepReserveTopUpRaw ? usdcAfter - keepReserveTopUpRaw : 0n;
      let usdcToUse = usdcSpendable < maxDeployRaw ? usdcSpendable : maxDeployRaw;
      let wethToUse = wethAfter;

      // One-shot corrective swap if one side is empty after split.
      if ((usdcToUse <= 0n || wethToUse <= 0n) && (usdcAfter > 0n || wethAfter > 0n) && swapsUsed < maxSwapCount) {
        if (wethToUse <= 0n && usdcToUse > 0n) {
          const topUpUsdcIn = usdcToUse / 4n;
          if (
            topUpUsdcIn > 0n &&
            swapsUsed < maxSwapCount &&
            Number(formatUnits(topUpUsdcIn, USDC_DECIMALS)) >= Number(caps.minSwapUsd || 0)
          ) {
            const swapRes = await this.swapExactInputSingle({
              router,
              tokenIn: this.usdc,
              tokenOut: this.weth,
              amountIn: topUpUsdcIn,
              slippageBps: this.settings.slippageBps,
              fee: snapshot.fee,
              tickSpacing: snapshot.tickSpacing,
              snapshot,
            });
            if (swapRes) {
              applySwapDelta(swapRes);
              swapsUsed += 1;
              await syncWalletPairBalances();
            }
          }
        } else if (usdcToUse <= 0n && wethToUse > 0n) {
          const topUpWethIn = wethToUse / 4n;
          if (
            topUpWethIn > 0n &&
            swapsUsed < maxSwapCount &&
            Number(formatUnits(topUpWethIn, WETH_DECIMALS)) * spot >= Number(caps.minSwapUsd || 0)
          ) {
            const swapRes = await this.swapExactInputSingle({
              router,
              tokenIn: this.weth,
              tokenOut: this.usdc,
              amountIn: topUpWethIn,
              slippageBps: this.settings.slippageBps,
              fee: snapshot.fee,
              tickSpacing: snapshot.tickSpacing,
              snapshot,
            });
            if (swapRes) {
              applySwapDelta(swapRes);
              swapsUsed += 1;
              await syncWalletPairBalances();
            }
          }
        }

        await syncWalletPairBalances();
        const usdcRetry = usdcBalanceRaw;
        const wethRetry = wethBalanceRaw;
        usdcSpendable = usdcRetry > keepReserveTopUpRaw ? usdcRetry - keepReserveTopUpRaw : 0n;
        usdcToUse = usdcSpendable < maxDeployRaw ? usdcSpendable : maxDeployRaw;
        wethToUse = wethRetry;
      }

      if (usdcToUse <= 0n || wethToUse <= 0n) {
        throw new Error(
          `Top-up unable to form dual-asset inventory ${JSON.stringify({
            reserveUsdc: Number(formatUnits(keepReserveRaw, USDC_DECIMALS)),
            usdcBalance: Number(formatUnits(usdcAfter, USDC_DECIMALS)),
            wethBalance: Number(formatUnits(wethAfter, WETH_DECIMALS)),
            usdcToUse: Number(formatUnits(usdcToUse > 0n ? usdcToUse : 0n, USDC_DECIMALS)),
            wethToUse: Number(formatUnits(wethToUse > 0n ? wethToUse : 0n, WETH_DECIMALS)),
          })}`
        );
      }

      const token0 = snapshot.token0;
      const token1 = snapshot.token1;
      // Re-read once before increaseLiquidity sizing, then keep a dust buffer.
      const { usdcBalanceRaw: usdcBeforeIncrease, wethBalanceRaw: wethBeforeIncrease } = await this.readWalletPairBalances();
      const usdcSpendableNow = usdcBeforeIncrease > keepReserveTopUpRaw ? usdcBeforeIncrease - keepReserveTopUpRaw : 0n;
      const usdcCap = usdcSpendableNow < maxDeployRaw ? usdcSpendableNow : maxDeployRaw;
      const wethCap = wethBeforeIncrease;
      let amount0Desired = sameAddress(token0, this.usdc) ? (usdcToUse < usdcCap ? usdcToUse : usdcCap) : (wethToUse < wethCap ? wethToUse : wethCap);
      let amount1Desired = sameAddress(token1, this.usdc) ? (usdcToUse < usdcCap ? usdcToUse : usdcCap) : (wethToUse < wethCap ? wethToUse : wethCap);
      // Leave a tiny dust buffer to avoid STF from race/rounding issues on exact wallet amounts.
      if (amount0Desired > 10n) amount0Desired = (amount0Desired * 9990n) / 10000n;
      if (amount1Desired > 10n) amount1Desired = (amount1Desired * 9990n) / 10000n;

      await this.approveIfNeeded(token0, npm, amount0Desired);
      await this.approveIfNeeded(token1, npm, amount1Desired);
      const isIncreaseLiquidityStfError = (err) => {
        const msg = err instanceof Error ? err.message : String(err || "");
        return msg.includes('function "increaseLiquidity" reverted') && /\bSTF\b/.test(msg);
      };
      // Try harder inside a single top-up cycle before giving up. This reduces the
      // common pattern: swap succeeds -> increase fails (STF) -> next loop swaps again.
      const stfHaircutRounds = [
        [10000n, 9990n, 9950n, 9900n, 9800n, 9500n, 9000n],
        [8500n, 8000n, 7500n, 7000n, 6500n, 6000n, 5500n, 5000n, 4500n, 4000n, 3500n, 3000n, 2500n, 2000n, 1500n, 1000n],
      ];
      let increaseOk = false;
      let increaseLastErr = null;
      let increaseResult = null;
      let roundAmount0Desired = amount0Desired;
      let roundAmount1Desired = amount1Desired;
      for (let roundIdx = 0; roundIdx < stfHaircutRounds.length && !increaseOk; roundIdx += 1) {
        const haircuts = stfHaircutRounds[roundIdx];
        for (const haircut of haircuts) {
          const a0 = haircut === 10000n ? roundAmount0Desired : (roundAmount0Desired * haircut) / 10000n;
          const a1 = haircut === 10000n ? roundAmount1Desired : (roundAmount1Desired * haircut) / 10000n;
          if (a0 <= 0n || a1 <= 0n) continue;
          try {
            increaseResult = await this.increaseLiquidityPosition({
              npmAddress: npm,
              tokenId,
              amount0Desired: a0,
              amount1Desired: a1,
            });
            increaseOk = true;
            break;
          } catch (err) {
            increaseLastErr = err;
            if (!isIncreaseLiquidityStfError(err)) {
              throw err;
            }
          }
        }
        if (increaseOk) break;
        if (!isIncreaseLiquidityStfError(increaseLastErr)) break;
        if (roundIdx + 1 >= stfHaircutRounds.length) break;

        // Re-read once and re-size from actual balances (no new swap) before the deeper
        // haircut ladder. This often turns "error -> next-loop topup" into one cycle.
        const { usdcBalanceRaw: usdcRetryBalance, wethBalanceRaw: wethRetryBalance } = await this.readWalletPairBalances();
        const usdcRetrySpendable = usdcRetryBalance > keepReserveTopUpRaw ? usdcRetryBalance - keepReserveTopUpRaw : 0n;
        const usdcRetryCap = usdcRetrySpendable < maxDeployRaw ? usdcRetrySpendable : maxDeployRaw;
        const wethRetryCap = wethRetryBalance;
        roundAmount0Desired = sameAddress(token0, this.usdc) ? usdcRetryCap : wethRetryCap;
        roundAmount1Desired = sameAddress(token1, this.usdc) ? usdcRetryCap : wethRetryCap;
        // Stronger base haircut for the second round; the ladder continues from there.
        if (roundAmount0Desired > 10n) roundAmount0Desired = (roundAmount0Desired * 9900n) / 10000n;
        if (roundAmount1Desired > 10n) roundAmount1Desired = (roundAmount1Desired * 9900n) / 10000n;
      }
      if (!increaseOk) {
        throw (increaseLastErr || new Error("increaseLiquidity failed after STF retries"));
      }

      this.state.pendingCompoundUsd = 0;
      this.state.position = {
        ...this.state.position,
        liquidity:
          this.state.position?.liquidity && increaseResult?.liquidityAdded != null
            ? (() => {
                try {
                  return (
                    BigInt(this.state.position.liquidity) + BigInt(increaseResult.liquidityAdded || 0n)
                  ).toString();
                } catch {
                  return this.state.position?.liquidity || null;
                }
              })()
            : this.state.position?.liquidity || null,
        topUpsThisCycle: Number(this.state.position?.topUpsThisCycle || 0) + 1,
      };
      this.setDecision({
        action: "topup",
        reason: "idle_deploy",
        txHash: this.activeAction?.txHashes?.[this.activeAction.txHashes.length - 1] || null,
      });
      {
        const action = this.activeAction ? { ...this.activeAction } : null;
        const runId = this.state.activePositionRunId ? String(this.state.activePositionRunId) : null;
        if (action && runId) {
          const token0Addr = snapshot.token0;
          const token1Addr = snapshot.token1;
          const amount0Used = BigInt(increaseResult?.amount0Used || 0n);
          const amount1Used = BigInt(increaseResult?.amount1Used || 0n);
          const principalAdded = {
            weth:
              sameAddress(token0Addr, this.weth)
                ? Number(formatUnits(amount0Used, WETH_DECIMALS))
                : sameAddress(token1Addr, this.weth)
                  ? Number(formatUnits(amount1Used, WETH_DECIMALS))
                  : 0,
            usdc:
              sameAddress(token0Addr, this.usdc)
                ? Number(formatUnits(amount0Used, USDC_DECIMALS))
                : sameAddress(token1Addr, this.usdc)
                  ? Number(formatUnits(amount1Used, USDC_DECIMALS))
                  : 0,
          };
          await this.appendLifecycleEvent(
            this.lifecycleCommonFields({
              type: "TOP_UP",
              positionRunId: runId,
              tokenId,
              band: {
                bandHalfBps: Number(this.state.position?.bandHalfBps || this.settings.bandHalfBps || 0),
                tickLower: Number(this.state.position?.tickLower || 0),
                tickUpper: Number(this.state.position?.tickUpper || 0),
              },
              txHashes: Array.isArray(action.txHashes) ? action.txHashes : [],
              accounting: {
                gasUsd: Number(action.gasUsd || 0),
                swapCostUsd: Number(action.swapCostUsd || 0),
                mintBurnUsd: Number(action.mintBurnUsd || 0),
                feesCollectedUsd: Number(action.feesCollectedUsd || 0),
                rewardsUsd: Number(action.rewardsUsd || 0),
                isEstimated: Boolean(action.isEstimated),
              },
              details: {
                method: "increaseLiquidity",
                amount0Used: amount0Used.toString(),
                amount1Used: amount1Used.toString(),
                liquidityAdded: increaseResult?.liquidityAdded ? String(increaseResult.liquidityAdded) : null,
                principalAdded,
                swapsInAction: Array.isArray(action.swaps) ? action.swaps.length : 0,
              },
            })
          ).catch((err) => this.setLastError(err));
          this.scheduleEntrySnapshot({
            positionRunId: runId,
            rawMintValueUsd: Number(this.state.pendingEntrySnapshot?.rawMintValueUsd || 0),
          });
        }
      }
      this.finalizeActiveAction("topup", "idle_deploy");
      this.state.topUpRetryAfterIso = null;
      return true;
    } catch (err) {
      this.state.topUpRetryAfterIso = new Date(Date.now() + TOP_UP_FAILURE_COOLDOWN_SEC * 1000).toISOString();
      this.setLastError(err);
      this.setDecision({
        action: "topup_failed",
        reason: "idle_deploy",
        error: err instanceof Error ? err.message : String(err || "unknown"),
        txHash: this.activeAction?.txHashes?.[this.activeAction.txHashes.length - 1] || null,
      });
      this.finalizeActiveAction("error", "idle_deploy_failed", {
        message: err instanceof Error ? err.message : String(err || "unknown"),
      });
      return false;
    }
  }

  async collectPositionFees({ npmAddress, tokenId }) {
    if (!tokenId) return { usdc: 0, weth: 0, usd: 0 };
    await this.assertTxAllowed("harvest_collect");

    // Unstake from gauge before collect (gauge holds NFT while staked)
    if (this.settings.emissions?.enabled && this.state.emissions?.staked) {
      try {
        await this.ensureUnstakedForNpmActions("collect_fees");
      } catch (err) {
        console.warn("[UC6] [emissions] auto-unstake before collect failed:", sanitizeErrorMessage(err));
      }
    }

    const id = BigInt(tokenId);
    const venueActive = this.state.position?.venue === "uniswapv3" ? "uniswapv3" : "slipstream";
    const activePool = venueActive === "uniswapv3"
      ? this.state.latest?.fallback || this.state.latest?.primary || null
      : this.state.latest?.primary || this.state.latest?.fallback || null;
    const pos = activePool ? { token0: activePool.token0, token1: activePool.token1 } : null;
    const { usdcBalanceRaw: preUsdc, wethBalanceRaw: preWeth } = await this.readWalletPairBalances();

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

    const { usdcBalanceRaw: postUsdc, wethBalanceRaw: postWeth } = await this.readWalletPairBalances();
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

  getRebalanceGate(overrides = {}) {
    this.ensureDailyCounter();
    const activeSlipstreamPositions = Number(this.state.latest?.positionInventory?.activeCount || 0);
    if (activeSlipstreamPositions > 1) {
      return {
        allowed: false,
        reason: `multiple_active_positions ${activeSlipstreamPositions}`,
        remainingSec: null,
      };
    }

    const now = Date.now();
    const lastMs = this.state.lastRebalanceAt ? Date.parse(this.state.lastRebalanceAt) : 0;
    const cooldownSec = Number.isFinite(Number(overrides.minRebalanceIntervalSec))
      ? Number(overrides.minRebalanceIntervalSec)
      : this.settings.minRebalanceIntervalSec;
    const cooldownMs = cooldownSec * 1000;
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

  getPositionTrigger(currentTick, overrides = {}) {
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
    const edgeThreshold = Number.isFinite(Number(overrides.edgeRebalancePct))
      ? Number(overrides.edgeRebalancePct)
      : this.settings.edgeRebalancePct;
    if (edgeProgress >= edgeThreshold) {
      return { trigger: true, reason: "near_edge", edgeProgress };
    }

    return { trigger: false, reason: "in_band", edgeProgress };
  }

  getExecutionCapsConfig() {
    const cfg = this.settings?.executionCaps && typeof this.settings.executionCaps === "object"
      ? this.settings.executionCaps
      : DEFAULT_SETTINGS.executionCaps;
    return {
      maxInventorySwapsPerRebalance: clamp(Math.round(Number(cfg.maxInventorySwapsPerRebalance || 0)), 0, 10),
      maxSwapsOnOpen: clamp(Math.round(Number(cfg.maxSwapsOnOpen || 0)), 0, 10),
      maxTopUpsPerCycle: clamp(Math.round(Number(cfg.maxTopUpsPerCycle || 0)), 0, 20),
      minTopUpUsd: clamp(Number(cfg.minTopUpUsd || 0), 0, 1_000_000),
      targetRatioTolerancePct: clamp(Number(cfg.targetRatioTolerancePct || 0), 0.001, 0.5),
      minSwapUsd: clamp(Number(cfg.minSwapUsd || 0), 0, 1_000_000),
      useMulticallClose: Boolean(cfg.useMulticallClose),
    };
  }

  getGasTopUpConfig() {
    const cfg = this.settings?.gasTopUp && typeof this.settings.gasTopUp === "object"
      ? this.settings.gasTopUp
      : DEFAULT_SETTINGS.gasTopUp;
    return {
      enabled: Boolean(cfg.enabled),
      minEthUsd: clamp(Number(cfg.minEthUsd || 0), 0, 1_000_000),
      topUpUsdc: clamp(Number(cfg.topUpUsdc || 0), 0.01, 1_000_000),
      minIntervalSec: clamp(Math.round(Number(cfg.minIntervalSec || 0)), 30, 86_400),
    };
  }

  async maybeTopUpEthGas(snapshot) {
    const cfg = this.getGasTopUpConfig();
    if (!cfg.enabled) return false;
    if (!this.settings.tradingEnabled || this.settings.killSwitch) return false;
    if (!snapshot) return false;

    const nowMs = Date.now();
    const lastAttemptMs = Date.parse(this.state.lastGasTopUpAttemptAt || "");
    if (Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < cfg.minIntervalSec * 1000) {
      return false;
    }

    const wallet = this.state.latest?.wallet || {};
    const ethUsd = Number(wallet?.valuesUsd?.eth || 0);
    if (!(Number.isFinite(ethUsd) && ethUsd < cfg.minEthUsd)) {
      return false;
    }

    const usdcTopUpRaw = parseUnits(cfg.topUpUsdc.toFixed(6), USDC_DECIMALS);
    const usdcBalanceRaw = await this.readTokenBalance(this.usdc);
    if (usdcBalanceRaw < usdcTopUpRaw) {
      this.state.lastGasTopUpAttemptAt = nowIso();
      this.state.lastGasTopUpSkipReason = "insufficient_usdc_for_gas_topup";
      return false;
    }

    const router = this.settings.venue === "uniswapv3" ? this.uniswapRouter : this.slipstreamRouter;
    this.state.lastGasTopUpAttemptAt = nowIso();
    this.beginAction("gas_topup", "eth_wallet_low");
    try {
      const swapRes = await this.swapExactInputSingle({
        router,
        tokenIn: this.usdc,
        tokenOut: this.weth,
        amountIn: usdcTopUpRaw,
        slippageBps: this.settings.slippageBps,
        fee: Number(snapshot.fee || 0),
        tickSpacing: Number(snapshot.tickSpacing || 0),
        snapshot,
      });
      const wethOutRaw = BigInt(swapRes?.actualOut || 0n);
      if (wethOutRaw <= 0n) {
        throw new Error("gas top-up swap produced zero WETH output");
      }

      await this.assertTxAllowed("gas_topup_unwrap_weth");
      const unwrapHash = await this.walletClient.writeContract({
        address: this.weth,
        abi: WETH_WRAPPER_ABI,
        functionName: "withdraw",
        args: [wethOutRaw],
        account: this.account,
      });
      const unwrapReceipt = await this.publicClient.waitForTransactionReceipt({ hash: unwrapHash });
      this.addTxToActiveAction("swap", unwrapHash, unwrapReceipt);
      if (unwrapReceipt.status && unwrapReceipt.status !== "success") {
        throw new Error(`WETH unwrap tx reverted on-chain hash=${unwrapHash}`);
      }

      this.state.lastGasTopUpSuccessAt = nowIso();
      this.state.lastGasTopUpSkipReason = null;
      this.setDecision({
        action: "gas_topup",
        reason: "eth_wallet_low",
        ethUsdBefore: ethUsd,
        topUpUsdc: cfg.topUpUsdc,
        txHash: unwrapHash,
      });
      this.finalizeActiveAction("gas_topup", "eth_wallet_low", {
        ethUsdBefore: ethUsd,
        topUpUsdc: cfg.topUpUsdc,
        unwrappedWeth: Number(formatUnits(wethOutRaw, WETH_DECIMALS)),
      });

      await this.refreshWalletBalancesHeavy().catch((err) => this.setLastError(err));
      return true;
    } catch (err) {
      this.state.lastGasTopUpSkipReason = err instanceof Error ? err.message : String(err || "gas top-up failed");
      this.finalizeActiveAction("error", "gas_topup_failed", {
        message: this.state.lastGasTopUpSkipReason,
      });
      this.setLastError(err);
      return false;
    }
  }

  getHodlGateConfig() {
    const cfg = this.settings?.hodlGate && typeof this.settings.hodlGate === "object"
      ? this.settings.hodlGate
      : DEFAULT_SETTINGS.hodlGate;
    return {
      enabled: Boolean(cfg.enabled),
      marginUsd: clamp(Number(cfg.marginUsd || 0), 0, 1_000_000),
      useUncollectedFees: Boolean(cfg.useUncollectedFees),
      allowCloseIfOutOfRange: Boolean(cfg.allowCloseIfOutOfRange),
      outOfRangeMaxSec: clamp(Math.round(Number(cfg.outOfRangeMaxSec || 0)), 30, 7 * 24 * 60 * 60),
      outOfRangeEmergencyMinSec: clamp(
        Math.round(Number(cfg.outOfRangeEmergencyMinSec || 0)),
        5,
        7 * 24 * 60 * 60
      ),
      outOfRangeEmergencyEdgePct: clamp(Number(cfg.outOfRangeEmergencyEdgePct || 1), 1, 5),
    };
  }

  getPositionDistanceMetrics(currentTick) {
    const p = this.state.position || {};
    const lower = Number(p.tickLower);
    const upper = Number(p.tickUpper);
    const centerRaw = Number(p.centerTick);
    const center = Number.isFinite(centerRaw) ? centerRaw : Math.round((lower + upper) / 2);
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || !Number.isFinite(center) || upper <= lower) {
      return {
        outOfRange: false,
        edgeProgress: 0,
        distanceBeyondEdgePct: 0,
      };
    }
    const halfWidth = Math.max(1, Math.abs(upper - center));
    const edgeProgress = Math.abs(currentTick - center) / halfWidth;
    const outOfRange = currentTick <= lower || currentTick >= upper;
    return {
      outOfRange,
      edgeProgress,
      distanceBeyondEdgePct: outOfRange ? edgeProgress : 0,
    };
  }

  getActiveLifecycleRecordInternal() {
    const tokenId = this.state.position?.tokenId ? String(this.state.position.tokenId) : null;
    if (!tokenId) return null;
    let rec = this.positionRecordsById.get(tokenId);
    if (!rec && Array.isArray(this.positionRecords)) {
      rec = this.positionRecords.find((r) => String(r?.tokenId || r?.id || "") === tokenId) || null;
      if (rec) this.positionRecordsById.set(tokenId, rec);
    }
    if (!rec) {
      rec = this.ensureActiveLifecycleRecordFromTrackedPosition();
    }
    if (!rec || rec.status === "CLOSED") return null;
    return rec;
  }

  computeHodlGateSnapshot() {
    const gateCfg = this.getHodlGateConfig();
    const rec = this.getActiveLifecycleRecordInternal();
    const latest = this.state.latest || {};
    const activeTick = Number(latest?.primary?.tick ?? latest?.fallback?.tick ?? 0);
    const dist = this.getPositionDistanceMetrics(activeTick);
    const outSinceMs = Date.parse(this.state.outOfRangeSinceIso || "");
    const outOfRangeDurationSec =
      dist.outOfRange && Number.isFinite(outSinceMs) && Date.now() > outSinceMs
        ? Math.round((Date.now() - outSinceMs) / 1000)
        : 0;

    const collectableNowUsd = Number(latest?.collectableNow?.usd || 0);
    const totalCostsToDateUsd = Number(rec?.performance?.totalCostsUsd || 0);
    const feesCollectedUsd = Number(rec?.performance?.feesCollectedUsd || 0);
    const rewardsClaimedUsd = Number(rec?.performance?.rewardsUsd || 0);
    const claimableAeroUsd = this.getClaimableAeroUsd();
    const feesNetLiveUsd =
      feesCollectedUsd +
      rewardsClaimedUsd +
      (gateCfg.useUncollectedFees ? collectableNowUsd : 0) +
      claimableAeroUsd -
      totalCostsToDateUsd;

    const spot = this.getSpotUsdcPerWeth();
    const baselineSource = rec?._internal?.entryCaptured
      ? "internal"
      : rec?.entry?.entryTokens
        ? "entry_tokens"
        : "missing";
    const baselineWeth = Number(
      rec?._internal?.entryCaptured ? rec?._internal?.baselineWeth : rec?.entry?.entryTokens?.weth || 0
    );
    const baselineUsdc = Number(
      rec?._internal?.entryCaptured ? rec?._internal?.baselineUsdc : rec?.entry?.entryTokens?.usdc || 0
    );
    const hasBaseline = Math.abs(baselineWeth) > 0 || Math.abs(baselineUsdc) > 0;
    const hodlNowUsd = hasBaseline && spot > 0 ? baselineWeth * spot + baselineUsdc : 0;
    const lpNowUsd = this.estimateTrackedLpUsdValueFromLatest();
    const divVsHodlLiveUsd = hasBaseline && spot > 0 ? lpNowUsd - hodlNowUsd : 0;
    const alphaLiveUsd = feesNetLiveUsd + divVsHodlLiveUsd;
    const requiredFeesToBeatHodlLiveUsd = Math.max(0, -divVsHodlLiveUsd);

    let overrideAllowed = false;
    let overrideReason = null;
    if (
      gateCfg.allowCloseIfOutOfRange &&
      dist.outOfRange &&
      (
        outOfRangeDurationSec >= gateCfg.outOfRangeMaxSec ||
        (
          outOfRangeDurationSec >= gateCfg.outOfRangeEmergencyMinSec &&
          dist.distanceBeyondEdgePct >= gateCfg.outOfRangeEmergencyEdgePct
        )
      )
    ) {
      overrideAllowed = true;
      overrideReason =
        outOfRangeDurationSec >= gateCfg.outOfRangeMaxSec
          ? "out_of_range_timeout"
          : "out_of_range_emergency_edge";
    }

    return {
      enabled: gateCfg.enabled,
      marginUsd: gateCfg.marginUsd,
      useUncollectedFees: gateCfg.useUncollectedFees,
      alphaLiveUsd,
      feesNetLiveUsd,
      divVsHodlLiveUsd,
      requiredFeesToBeatHodlLiveUsd,
      hasBaseline,
      baselineSource,
      baselineWeth,
      baselineUsdc,
      hodlNowUsd,
      lpNowUsd,
      collectableNowUsd,
      totalCostsToDateUsd,
      feesCollectedUsd,
      rewardsClaimedUsd,
      claimableAeroUsd,
      outOfRange: dist.outOfRange,
      outOfRangeDurationSec,
      distanceBeyondEdgePct: dist.distanceBeyondEdgePct,
      overrideAllowed,
      overrideReason,
    };
  }

  evaluateHodlGateForClose() {
    const snap = this.computeHodlGateSnapshot();
    if (!snap.enabled) {
      return { allowed: true, reason: "disabled", snapshot: snap };
    }
    if (!(snap.alphaLiveUsd < -snap.marginUsd)) {
      return { allowed: true, reason: "ok", snapshot: snap };
    }
    if (snap.overrideAllowed) {
      return {
        allowed: true,
        reason: `override_${snap.overrideReason || "out_of_range"}`,
        snapshot: snap,
      };
    }
    return {
      allowed: false,
      reason: `hodl_gate alpha=${snap.alphaLiveUsd.toFixed(4)} < -${snap.marginUsd.toFixed(4)}`,
      snapshot: snap,
    };
  }

  buildTrendEscapeEvaluation(primary, trendCtx, { tradingAllowed = true } = {}) {
    const cfg = this.getTrendEscapeSettings();
    const mode = this.getStrategyMode();
    const hodl = this.computeHodlGateSnapshot();
    const cooldownRemainingSec = this.cooldownRemainingSec(this.state.reEntryCooldownUntilIso);
    const emergencyAllowed =
      Boolean(hodl.outOfRange) &&
      Number(hodl.outOfRangeDurationSec || 0) >= cfg.emergencyMinOutOfRangeSec &&
      Number(hodl.distanceBeyondEdgePct || 0) >= cfg.emergencyOutOfRangeEdgePct;
    let holdTarget = cfg.fallbackHold;
    if (trendCtx?.direction === "up") holdTarget = cfg.uptrendHold;
    else if (trendCtx?.direction === "down") holdTarget = cfg.downtrendHold;

    let eligible = true;
    let reasonIfBlocked = "ok";
    if (!cfg.enabled) {
      eligible = false;
      reasonIfBlocked = "disabled";
    } else if (this.settings.venue === "uniswapv3") {
      eligible = false;
      reasonIfBlocked = "venue_read_only";
    } else if (mode !== "LP_ACTIVE") {
      eligible = false;
      reasonIfBlocked = `mode_${mode.toLowerCase()}`;
    } else if (!this.state.position?.tokenId) {
      eligible = false;
      reasonIfBlocked = "no_active_lp";
    } else if (!tradingAllowed) {
      eligible = false;
      reasonIfBlocked = "trading_blocked";
    } else if (cooldownRemainingSec > 0) {
      eligible = false;
      reasonIfBlocked = "reentry_cooldown";
    } else if (!this.settings?.regime?.enabled) {
      eligible = false;
      reasonIfBlocked = "regime_disabled";
    } else if (String(trendCtx?.regimeLabel || "unknown") !== cfg.requireRegimeLabel) {
      eligible = false;
      reasonIfBlocked = "regime_label_mismatch";
    } else if (Number(trendCtx?.regimeConfidence || 0) < cfg.minRegimeConfidence) {
      eligible = false;
      reasonIfBlocked = "regime_confidence_low";
    } else if (!Number.isFinite(Number(trendCtx?.trendMovePct))) {
      eligible = false;
      reasonIfBlocked = "trend_move_unavailable";
    } else if (!(Math.abs(Number(trendCtx?.trendMovePct || 0)) >= cfg.minTrendMovePct)) {
      eligible = false;
      reasonIfBlocked = "trend_move_too_small";
    } else if (Number(trendCtx?.trendingConfirmSec || 0) < cfg.minTrendConfirmSec) {
      eligible = false;
      reasonIfBlocked = "trend_not_confirmed";
    } else if (!(Number(hodl.alphaLiveUsd || 0) >= cfg.minAlphaUsdToEscape || emergencyAllowed)) {
      eligible = false;
      reasonIfBlocked = "alpha_gate";
    }

    return {
      enabled: cfg.enabled,
      eligible,
      holdTargetIfEscape: holdTarget,
      reasonIfBlocked,
      cooldownUntilIso: this.state.reEntryCooldownUntilIso || null,
      cooldownRemainingSec,
      emergencyAllowed,
      hodlSnapshot: hodl,
    };
  }

  buildReEntryEvaluation(primary, trendCtx, { tradingAllowed = true } = {}) {
    const cfg = this.getReEntrySettings();
    const mode = this.getStrategyMode();
    const holdStartedAtMs = this.isoMs(this.state.holdStartedAtIso);
    const minHoldReadyAtMs = Number.isFinite(holdStartedAtMs) ? holdStartedAtMs + cfg.minHoldSec * 1000 : NaN;
    const escapeCooldownMs = this.isoMs(this.state.escapeCooldownUntilIso);
    const reEntryCooldownMs = this.isoMs(this.state.reEntryCooldownUntilIso);
    const eligibleAtMs = [minHoldReadyAtMs, escapeCooldownMs, reEntryCooldownMs]
      .filter((ms) => Number.isFinite(ms))
      .reduce((max, ms) => Math.max(max, ms), 0);
    let eligible = true;
    let reasonIfBlocked = "ok";
    if (!cfg.enabled) {
      eligible = false;
      reasonIfBlocked = "disabled";
    } else if (this.settings.venue === "uniswapv3") {
      eligible = false;
      reasonIfBlocked = "venue_read_only";
    } else if (!mode.startsWith("HOLD_")) {
      eligible = false;
      reasonIfBlocked = "not_in_hold_mode";
    } else if (this.state.position?.tokenId) {
      eligible = false;
      reasonIfBlocked = "active_lp_conflict";
    } else if (!tradingAllowed) {
      eligible = false;
      reasonIfBlocked = "trading_blocked";
    } else if (Number.isFinite(eligibleAtMs) && Date.now() < eligibleAtMs) {
      eligible = false;
      reasonIfBlocked =
        Number.isFinite(minHoldReadyAtMs) && Date.now() < minHoldReadyAtMs
          ? "min_hold_not_met"
          : Number.isFinite(escapeCooldownMs) && Date.now() < escapeCooldownMs
            ? "escape_cooldown"
            : "reentry_cooldown";
    } else if (!this.settings?.regime?.enabled) {
      eligible = false;
      reasonIfBlocked = "regime_disabled";
    } else if (String(trendCtx?.regimeLabel || "unknown") !== cfg.requireRegimeLabel) {
      eligible = false;
      reasonIfBlocked = "regime_label_mismatch";
    } else if (Number(trendCtx?.regimeConfidence || 0) < cfg.minRegimeConfidence) {
      eligible = false;
      reasonIfBlocked = "regime_confidence_low";
    } else if (Number(trendCtx?.meanRevertConfirmSec || 0) < cfg.minMeanRevertConfirmSec) {
      eligible = false;
      reasonIfBlocked = "mean_revert_not_confirmed";
    } else if (!Number.isFinite(Number(trendCtx?.distanceFromMuPct))) {
      eligible = false;
      reasonIfBlocked = "distance_from_mu_unavailable";
    } else if (Number(trendCtx?.distanceFromMuPct || 0) > cfg.maxDistanceFromMuPct) {
      eligible = false;
      reasonIfBlocked = "too_far_from_mu";
    }
    return {
      enabled: cfg.enabled,
      eligible,
      reasonIfBlocked,
      meanRevertConfirmSec: Number(trendCtx?.meanRevertConfirmSec || 0),
      distanceFromMuPct:
        Number.isFinite(Number(trendCtx?.distanceFromMuPct)) ? Number(trendCtx.distanceFromMuPct) : null,
      eligibleAtIso: Number.isFinite(eligibleAtMs) && eligibleAtMs > 0 ? new Date(eligibleAtMs).toISOString() : null,
      holdElapsedSec: Number.isFinite(holdStartedAtMs)
        ? Math.max(0, (Date.now() - holdStartedAtMs) / 1000)
        : 0,
      holdRequiredSec: cfg.minHoldSec,
      escapeCooldownUntilIso: this.state.escapeCooldownUntilIso || null,
      reEntryCooldownUntilIso: this.state.reEntryCooldownUntilIso || null,
      regimeLabel: String(trendCtx?.regimeLabel || "unknown"),
      regimeConfidence: Number(trendCtx?.regimeConfidence || 0),
      requiredRegimeLabel: cfg.requireRegimeLabel,
      requiredMinConfidence: cfg.minRegimeConfidence,
      requiredMeanRevertConfirmSec: cfg.minMeanRevertConfirmSec,
      maxDistanceFromMuPct: cfg.maxDistanceFromMuPct,
    };
  }

  async appendStrategyLifecycleEvent(type, { positionRunId = null, tokenId = null, details = {}, band = null, txHashes = [] } = {}) {
    const runId = positionRunId || this.state.activePositionRunId || null;
    if (!runId) return null;
    return await this.appendLifecycleEvent(
      this.lifecycleCommonFields({
        type,
        positionRunId: String(runId),
        tokenId: tokenId == null ? this.state.position?.tokenId || null : tokenId,
        band: band || undefined,
        txHashes,
        details,
      })
    ).catch((err) => {
      this.setLastError(err);
      return null;
    });
  }

  async rebalanceWalletToTargetMix({ snapshot, router, target = "50_50", maxSwaps = 1, reserveUsdc = null, eventType = null, positionRunId = null }) {
    const caps = this.getExecutionCapsConfig();
    const maxSwapCount = Math.max(0, Math.min(Math.round(Number(maxSwaps || 0)), Math.round(Number(caps.maxInventorySwapsPerRebalance || 0)), 2));
    if (maxSwapCount <= 0) return { swaps: [], holdTarget: target };
    const minSwapUsd = Number(caps.minSwapUsd || 0);
    const reserveTargetUsdc = reserveUsdc == null ? 0 : Math.max(0, Number(reserveUsdc || 0));
    let swapsUsed = 0;
    const swaps = [];

    while (swapsUsed < maxSwapCount) {
      const usdcRaw = await this.readTokenBalance(this.usdc);
      const wethRaw = await this.readTokenBalance(this.weth);
      const usdc = Number(formatUnits(usdcRaw, USDC_DECIMALS));
      const weth = Number(formatUnits(wethRaw, WETH_DECIMALS));
      const spot = Number(snapshot?.priceUsdcPerWeth || this.getSpotUsdcPerWeth() || 0);
      if (!(spot > 0)) break;
      let plannedSwap = null;

      if (target === "WETH") {
        const swappableUsdc = Math.max(0, usdc - reserveTargetUsdc);
        if (swappableUsdc >= minSwapUsd) {
          plannedSwap = {
            tokenIn: this.usdc,
            tokenOut: this.weth,
            amountIn: parseUnits(swappableUsdc.toFixed(6), USDC_DECIMALS),
          };
        }
      } else if (target === "USDC") {
        const wethUsd = weth * spot;
        if (wethUsd >= minSwapUsd) {
          plannedSwap = {
            tokenIn: this.weth,
            tokenOut: this.usdc,
            amountIn: parseUnits(weth.toFixed(18), WETH_DECIMALS),
          };
        }
      } else {
        const totalUsd = Math.max(0, usdc - reserveTargetUsdc) + weth * spot;
        const deployableUsdc = Math.max(0, usdc - reserveTargetUsdc);
        if (totalUsd > 0) {
          const desiredUsdc = totalUsd / 2;
          const deltaUsdc = deployableUsdc - desiredUsdc;
          const tolHalf = Number(caps.targetRatioTolerancePct || 0) / 2;
          const share = deployableUsdc / totalUsd;
          if (share > 0.5 + tolHalf && deltaUsdc >= minSwapUsd) {
            plannedSwap = {
              tokenIn: this.usdc,
              tokenOut: this.weth,
              amountIn: parseUnits(deltaUsdc.toFixed(6), USDC_DECIMALS),
            };
          } else if (share < 0.5 - tolHalf) {
            const deltaUsd = desiredUsdc - deployableUsdc;
            const wethIn = Math.min(weth, deltaUsd / spot);
            if (wethIn * spot >= minSwapUsd && wethIn > 0) {
              plannedSwap = {
                tokenIn: this.weth,
                tokenOut: this.usdc,
                amountIn: parseUnits(wethIn.toFixed(18), WETH_DECIMALS),
              };
            }
          }
        }
      }

      if (!plannedSwap?.amountIn || plannedSwap.amountIn <= 0n) break;
      const swapRes = await this.swapExactInputSingle({
        router,
        tokenIn: plannedSwap.tokenIn,
        tokenOut: plannedSwap.tokenOut,
        amountIn: plannedSwap.amountIn,
        slippageBps: this.settings.slippageBps,
        fee: snapshot?.fee,
        tickSpacing: snapshot?.tickSpacing,
        snapshot,
      });
      if (!swapRes) break;
      swaps.push(swapRes);
      swapsUsed += 1;
      if (eventType) {
        await this.appendStrategyLifecycleEvent(eventType, {
          positionRunId,
          txHashes: this.activeAction?.txHashes?.length ? [this.activeAction.txHashes[this.activeAction.txHashes.length - 1]] : [],
          details: {
            holdTarget: target,
            tokenIn: swapRes.tokenIn,
            tokenOut: swapRes.tokenOut,
            actualIn: String(swapRes.actualIn || 0n),
            actualOut: String(swapRes.actualOut || 0n),
            quoteOut: String(swapRes.quoteOut || 0n),
            slippageBpsReal:
              swapRes.slippageBpsReal == null || !Number.isFinite(Number(swapRes.slippageBpsReal))
                ? null
                : Number(swapRes.slippageBpsReal),
          },
        });
      }
      if (target === "WETH" || target === "USDC") break;
    }

    return { swaps, holdTarget: target };
  }

  async executeTrendEscape(primary, trendCtx, escapeEval) {
    const currentTokenId = this.state.position?.tokenId;
    if (!currentTokenId) return false;
    const runId = this.ensureActivePositionRun({
      reason: "trend_escape",
      snapshot: primary,
      tokenId: currentTokenId,
    });
    const holdTarget = escapeEval?.holdTargetIfEscape || "50_50";
    const holdMode = this.holdModeFromTarget(holdTarget);
    const currentBand = {
      bandHalfBps: Number(this.state.position?.bandHalfBps || this.settings.bandHalfBps || 0),
      tickLower: Number(this.state.position?.tickLower || 0),
      tickUpper: Number(this.state.position?.tickUpper || 0),
    };
    await this.appendStrategyLifecycleEvent("TREND_ESCAPE_START", {
      positionRunId: runId,
      tokenId: currentTokenId,
      band: currentBand,
      details: {
        reason: "trend_escape",
        holdTarget,
        trendMovePct: Number(trendCtx?.trendMovePct || 0),
        direction: String(trendCtx?.direction || "flat"),
        alphaLiveUsd: Number(escapeEval?.hodlSnapshot?.alphaLiveUsd || 0),
        regime: {
          label: String(trendCtx?.regimeLabel || "unknown"),
          confidence: Number(trendCtx?.regimeConfidence || 0),
          halfLifeSec: Number(this.state.latest?.regime?.halfLifeSec || 0) || null,
        },
      },
    });

    this.beginAction("trend_escape", "trend_escape");
    let closeResult = null;
    try {
      let preCloseCollectable = this.state.latest?.collectableNow || { usdc: 0, weth: 0, usd: 0 };
      try {
        preCloseCollectable = await this.collectableNowSnapshot();
      } catch {}
      this.setLifecyclePhaseContext({
        phase: "final_close",
        positionRunId: runId,
        tokenId: currentTokenId,
        band: currentBand,
      });
      try {
        closeResult = await this.closePosition({
          npmAddress: this.slipstreamNpm,
          tokenId: currentTokenId,
          feeValueOverrideUsd: Number(preCloseCollectable?.usd || 0),
          feeBreakdownOverride: preCloseCollectable,
        });
      } finally {
        this.clearLifecyclePhaseContext();
      }
      this.state.position = {
        ...this.state.position,
        tokenId: null,
        bandHalfBps: null,
        tickLower: null,
        tickUpper: null,
        centerTick: null,
        liquidity: null,
        inRange: null,
      };
      await this.appendStrategyLifecycleEvent("TREND_ESCAPE_CLOSE_LP", {
        positionRunId: runId,
        tokenId: currentTokenId,
        txHashes: Array.isArray(closeResult?.txHashes) ? closeResult.txHashes : [],
        details: closeResult || {},
      });

      const walletSnapshot = this.state.latest?.wallet;
      const reserveTargetUsdc = this.getEffectiveReserveTargetUsdc(Number(walletSnapshot?.valuesUsd?.total || 0));
      await this.rebalanceWalletToTargetMix({
        snapshot: primary,
        router: this.slipstreamRouter,
        target: holdTarget,
        maxSwaps: 1,
        reserveUsdc: holdTarget === "WETH" ? reserveTargetUsdc : 0,
        eventType: "TREND_ESCAPE_HOLD_SWAP",
        positionRunId: runId,
      });
      const holdStartedAtIso = nowIso();
      this.setStrategyModeState(holdMode, {
        holdStartedAtIso,
        escapeCooldownUntilIso:
          this.getReEntrySettings().minHoldSec >= 0
            ? new Date(Date.now() + this.getTrendEscapeSettings().cooldownAfterEscapeSec * 1000).toISOString()
            : null,
      });
      this.state.pendingEntrySnapshot = null;
      this.setDecision({
        action: "trend_escape",
        reason: "trend_escape",
        mode: holdMode,
        holdTarget,
        trendMovePct: Number(trendCtx?.trendMovePct || 0),
        alphaLiveUsd: Number(escapeEval?.hodlSnapshot?.alphaLiveUsd || 0),
      });
      await this.refreshWalletBalancesHeavy().catch((err) => this.setLastError(err));
      this.finalizeActiveAction("trend_escape", "trend_escape", {
        mode: holdMode,
        holdTarget,
      });
      await this.appendStrategyLifecycleEvent("TREND_ESCAPE_DONE", {
        positionRunId: runId,
        details: { mode: holdMode, holdTarget },
      });
      return true;
    } catch (err) {
      if (!this.state.position?.tokenId && closeResult) {
        const holdStartedAtIso = nowIso();
        this.setStrategyModeState("HOLD_50_50", {
          holdStartedAtIso,
          escapeCooldownUntilIso: new Date(
            Date.now() + this.getTrendEscapeSettings().cooldownAfterEscapeSec * 1000
          ).toISOString(),
        });
      }
      this.finalizeActiveAction("error", "trend_escape_failed", {
        message: err instanceof Error ? err.message : String(err || "unknown"),
      });
      this.setLastError(err);
      return false;
    }
  }

  async executeReEntry(primary, effectiveBandHalfBps, trendCtx) {
    if (this.state.position?.tokenId) {
      await this.syncStrategyModeInvariant({ persist: true });
      this.setDecision({
        action: "monitor",
        reason: "active_lp_conflict",
        mode: this.getStrategyMode(),
        tokenId: String(this.state.position.tokenId),
      });
      return false;
    }
    const runId = this.ensureActivePositionRun({
      reason: "reentry",
      snapshot: primary,
      tokenId: null,
      bandHalfBpsOverride: effectiveBandHalfBps,
    });
    const priorMode = this.getStrategyMode();
    await this.appendStrategyLifecycleEvent("REENTRY_START", {
      positionRunId: runId,
      details: {
        priorMode,
        distanceFromMuPct:
          Number.isFinite(Number(trendCtx?.distanceFromMuPct)) ? Number(trendCtx.distanceFromMuPct) : null,
        regime: {
          label: String(trendCtx?.regimeLabel || "unknown"),
          confidence: Number(trendCtx?.regimeConfidence || 0),
          halfLifeSec: Number(this.state.latest?.regime?.halfLifeSec || 0) || null,
        },
      },
    });
    this.beginAction("reentry", "mean_reversion_reentry");
    try {
      await this.rebalanceSlipstream(primary, { bandHalfBps: effectiveBandHalfBps });
      if (!this.state.position?.tokenId) {
        throw new Error("reentry finished without active LP token");
      }
      this.setStrategyModeState("LP_ACTIVE", {
        holdStartedAtIso: null,
        escapeCooldownUntilIso: null,
        reEntryCooldownUntilIso: new Date(
          Date.now() + this.getReEntrySettings().cooldownAfterReEntrySec * 1000
        ).toISOString(),
      });
      const mintedTokenId = String(this.state.position?.tokenId || "");
      await this.appendStrategyLifecycleEvent("REENTRY_MINT", {
        positionRunId: runId,
        tokenId: mintedTokenId,
        band: this.currentBandDescriptor(),
        txHashes: this.activeAction?.txHashes || [],
        details: {
          tokenId: mintedTokenId,
          bandHalfBps: Number(this.state.position?.bandHalfBps || effectiveBandHalfBps || 0),
        },
      });
      this.setDecision({
        action: "reentry",
        reason: "mean_reversion_reentry",
        mode: "LP_ACTIVE",
        tokenId: mintedTokenId,
      });
      this.finalizeActiveAction("reentry", "mean_reversion_reentry", {
        mode: "LP_ACTIVE",
        tokenId: mintedTokenId,
      });
      await this.appendStrategyLifecycleEvent("REENTRY_DONE", {
        positionRunId: runId,
        tokenId: mintedTokenId,
        details: { mode: "LP_ACTIVE", tokenId: mintedTokenId },
      });
      return true;
    } catch (err) {
      this.state.reEntryCooldownUntilIso = new Date(
        Date.now() + this.getReEntrySettings().cooldownAfterReEntrySec * 1000
      ).toISOString();
      this.finalizeActiveAction("error", "reentry_failed", {
        message: err instanceof Error ? err.message : String(err || "unknown"),
      });
      this.setLastError(err);
      return false;
    }
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
      if (!(Number.isFinite(Number(this.state.position.bandHalfBps)) && Number(this.state.position.bandHalfBps) > 0)) {
        this.state.position.bandHalfBps = this.estimateBandHalfBpsFromTicks(pos.tickLower, pos.tickUpper);
      }
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

  async refreshOwnedSlipstreamPositionInventory() {
    const snapshot = this.state.latest?.primary || null;
    const sqrtPriceX96Raw = snapshot?.sqrtPriceX96 ? BigInt(snapshot.sqrtPriceX96) : null;
    const currentTick = Number(snapshot?.tick ?? 0);
    const inventory = {
      ownerNftCount: 0,
      activeCount: 0,
      totalUsdValue: 0,
      active: [],
    };

    try {
      const ownedRaw = await this.publicClient.readContract({
        address: this.slipstreamNpm,
        abi: NPM_POSITION_ABI,
        functionName: "balanceOf",
        args: [this.account.address],
      });
      const owned = Number(ownedRaw || 0n);
      inventory.ownerNftCount = Number.isFinite(owned) ? owned : 0;

      const scanCount = Math.min(inventory.ownerNftCount, 200);
      // Always include staked tokenIds — they won't appear in balanceOf/tokenOfOwnerByIndex
      // because the gauge owns them, but positions(tokenId) still works.
      const stakedTokenIds = [];
      if (this.state.emissions?.staked && this.state.emissions?.stakedTokenId) {
        stakedTokenIds.push(BigInt(this.state.emissions.stakedTokenId));
      }
      if (scanCount > 0 || stakedTokenIds.length > 0) {
        const tokenIds = [...stakedTokenIds];
        for (const batch of chunkArray(Array.from({ length: scanCount }, (_, i) => i), MULTICALL_BATCH_SIZE)) {
          let batchResults = null;
          try {
            batchResults = await this.publicClient.multicall({
              allowFailure: true,
              contracts: batch.map((i) => ({
                address: this.slipstreamNpm,
                abi: NPM_POSITION_ABI,
                functionName: "tokenOfOwnerByIndex",
                args: [this.account.address, BigInt(i)],
              })),
            });
          } catch {
            batchResults = null;
          }
          if (!Array.isArray(batchResults)) {
            for (const i of batch) {
              try {
                const tokenIdRaw = await this.publicClient.readContract({
                  address: this.slipstreamNpm,
                  abi: NPM_POSITION_ABI,
                  functionName: "tokenOfOwnerByIndex",
                  args: [this.account.address, BigInt(i)],
                });
                tokenIds.push(tokenIdRaw);
              } catch {
                // skip missing index
              }
            }
            continue;
          }
          for (const entry of batchResults) {
            if (entry?.status === "success") tokenIds.push(entry.result);
          }
        }

        for (const batch of chunkArray(tokenIds, MULTICALL_BATCH_SIZE)) {
          let posResults = null;
          try {
            posResults = await this.publicClient.multicall({
              allowFailure: true,
              contracts: batch.map((tokenIdRaw) => ({
                address: this.slipstreamNpm,
                abi: NPM_POSITION_ABI,
                functionName: "positions",
                args: [BigInt(tokenIdRaw)],
              })),
            });
          } catch {
            posResults = null;
          }
          const normalizedResults = Array.isArray(posResults)
            ? posResults
            : await Promise.all(
                batch.map(async (tokenIdRaw) => {
                  try {
                    const result = await this.publicClient.readContract({
                      address: this.slipstreamNpm,
                      abi: NPM_POSITION_ABI,
                      functionName: "positions",
                      args: [BigInt(tokenIdRaw)],
                    });
                    return { status: "success", result };
                  } catch (err) {
                    return { status: "failure", error: err };
                  }
                })
              );

          for (let idx = 0; idx < batch.length; idx += 1) {
            const tokenIdRaw = batch[idx];
            const posEntry = normalizedResults[idx];
            if (posEntry?.status !== "success") {
              const msg = posEntry?.error instanceof Error ? posEntry.error.message : String(posEntry?.error || "");
              if (msg.includes('function "positions" reverted') && /\bID\b/.test(msg)) continue;
              continue;
            }

            const pos = this.parsePositionResult(posEntry.result);
            if (!pos || pos.liquidity <= 0n) continue;

            let usdValue = 0;
            let inRange = null;
            if (sqrtPriceX96Raw && Number.isFinite(currentTick)) {
              try {
                const amounts = this.lpAmountsFromLiquidity(
                  pos.liquidity,
                  pos.tickLower,
                  pos.tickUpper,
                  sqrtPriceX96Raw,
                  pos.token0,
                  pos.token1
                );
                const usdc = Number(formatUnits(amounts.usdcRaw, USDC_DECIMALS));
                const weth = Number(formatUnits(amounts.wethRaw, WETH_DECIMALS));
                usdValue = usdc + weth * this.getSpotUsdcPerWeth();
                inRange = currentTick > pos.tickLower && currentTick < pos.tickUpper;
              } catch {
                usdValue = 0;
                inRange = null;
              }
            }

            inventory.active.push({
              tokenId: tokenIdRaw.toString(),
              tickLower: pos.tickLower,
              tickUpper: pos.tickUpper,
              liquidity: pos.liquidity.toString(),
              usdValue,
              inRange,
            });
          }
        }
      }

      inventory.active.sort((a, b) => Number(b.usdValue || 0) - Number(a.usdValue || 0));
      inventory.activeCount = inventory.active.length;
      inventory.totalUsdValue = inventory.active.reduce((sum, p) => sum + Number(p.usdValue || 0), 0);
      this.state.latest.positionInventory = inventory;
    } catch (err) {
      this.setLastError(err);
      this.state.latest.positionInventory = this.state.latest.positionInventory || inventory;
    }
  }

  enforceSinglePositionInvariant() {
    const inventory = this.state.latest?.positionInventory;
    if (!inventory || !Array.isArray(inventory.active)) return;
    const activeCount = Number(inventory.activeCount || 0);
    if (activeCount !== 1) return;
    const only = inventory.active[0];
    if (!only?.tokenId) return;

    const trackedTokenId = this.state.position?.tokenId ? String(this.state.position.tokenId) : null;
    if (trackedTokenId === String(only.tokenId)) return;

    // Auto-adopt the single active on-chain position to prevent accidental second mints
    // when local state lost the tokenId during prior reconcile/mint race conditions.
    this.state.position = {
      ...this.state.position,
      venue: "slipstream",
      tokenId: String(only.tokenId),
      bandHalfBps: this.estimateBandHalfBpsFromTicks(only.tickLower, only.tickUpper),
      tickLower: Number.isFinite(Number(only.tickLower)) ? Number(only.tickLower) : null,
      tickUpper: Number.isFinite(Number(only.tickUpper)) ? Number(only.tickUpper) : null,
      centerTick:
        Number.isFinite(Number(only.tickLower)) && Number.isFinite(Number(only.tickUpper))
          ? Math.round((Number(only.tickLower) + Number(only.tickUpper)) / 2)
          : null,
      liquidity: only.liquidity != null ? String(only.liquidity) : null,
      inRange: typeof only.inRange === "boolean" ? only.inRange : this.state.position?.inRange ?? null,
      topUpsThisCycle: Number(this.state.position?.topUpsThisCycle || 0),
    };
  }

  async maybeHarvestOnly() {
    if (this.settings.compoundMode !== "threshold_harvest") return false;
    const tokenId = this.state.position?.tokenId;
    if (!tokenId) return false;
    await this.refreshCollectableNowMaybe({ force: false });
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
      {
        const action = this.activeAction ? { ...this.activeAction } : null;
        const runId = this.state.activePositionRunId ? String(this.state.activePositionRunId) : null;
        if (action && runId) {
          await this.appendLifecycleEvent(
            this.lifecycleCommonFields({
              type: "HARVEST_COLLECT",
              positionRunId: runId,
              tokenId,
              txHashes: Array.isArray(action.txHashes) ? action.txHashes : [],
              accounting: {
                gasUsd: Number(action.gasUsd || 0),
                swapCostUsd: Number(action.swapCostUsd || 0),
                mintBurnUsd: Number(action.mintBurnUsd || 0),
                feesCollectedUsd: Number(collected.usd || action.feesCollectedUsd || 0),
                rewardsUsd: Number(action.rewardsUsd || 0),
                isEstimated: Boolean(action.isEstimated),
              },
              details: {
                thresholdUsd: Number(this.settings.harvestThresholdUsd || 0),
                collectableBeforeUsd: collectableUsd,
                collected: { weth: Number(collected.weth || 0), usdc: Number(collected.usdc || 0) },
                collectedUsd: Number(collected.usd || 0),
              },
            })
          ).catch((err) => this.setLastError(err));
        }
      }
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

  async rebalanceSlipstream(snapshot, options = {}) {
    const router = this.slipstreamRouter;
    const npm = this.slipstreamNpm;
    const executionCaps = this.getExecutionCapsConfig();
    const effectiveBandHalfBps = Number.isFinite(Number(options.bandHalfBps))
      ? Number(options.bandHalfBps)
      : Number(this.settings.bandHalfBps || 0);

    const currentTokenId = this.state.position?.tokenId;
    const existingBand = currentTokenId
      ? {
          bandHalfBps: Number(this.state.position?.bandHalfBps || this.settings.bandHalfBps || 0),
          tickLower: Number(this.state.position?.tickLower || 0),
          tickUpper: Number(this.state.position?.tickUpper || 0),
        }
      : null;
    const plannedBand = {
      bandHalfBps: effectiveBandHalfBps,
      ...(this.computeTargetRange(snapshot.tick, snapshot.tickSpacing, effectiveBandHalfBps) || {}),
    };
    const runId = this.ensureActivePositionRun({
      reason: currentTokenId ? "auto_rebalance" : "auto",
      snapshot,
      tokenId: currentTokenId || null,
      bandHalfBpsOverride: effectiveBandHalfBps,
    });
    if (currentTokenId && runId) {
      await this.appendLifecycleEvent(
        this.lifecycleCommonFields({
          type: "REBALANCE_START",
          positionRunId: runId,
          tokenId: currentTokenId,
          band: existingBand || undefined,
          accounting: this.emptyLifecycleAccounting(),
          details: {
            reason: String(this.activeAction?.reason || "auto"),
            prevBand: existingBand,
            newBand: plannedBand,
          },
        })
      ).catch((err) => this.setLastError(err));
    }

    const runSwapStep = async (fn) => {
      if (!runId) return await fn();
      this.setLifecyclePhaseContext({
        phase: currentTokenId || closedExistingPosition ? "rebalance_inventory_swap" : "open_swap",
        positionRunId: runId,
        tokenId: this.state.position?.tokenId || currentTokenId || null,
        band: plannedBand,
      });
      try {
        return await fn();
      } finally {
        this.clearLifecyclePhaseContext();
      }
    };

    let closedExistingPosition = false;
    if (currentTokenId) {
      let preCloseCollectable = this.state.latest?.collectableNow || {
        usdc: 0,
        weth: 0,
        usd: Number(this.state.latest?.collectableNow?.usd || 0),
      };
      try {
        const freshCollectable = await this.collectableNowSnapshot();
        preCloseCollectable = freshCollectable;
      } catch {
        // use latest cached collectable snapshot
      }
      this.setLifecyclePhaseContext({
        phase: "rebalance_close",
        positionRunId: runId,
        tokenId: currentTokenId,
        band: existingBand || undefined,
      });
      try {
        await this.closePosition({
          npmAddress: npm,
          tokenId: currentTokenId,
          feeValueOverrideUsd: Number(preCloseCollectable?.usd || 0),
          feeBreakdownOverride: preCloseCollectable,
        });
      } finally {
        this.clearLifecyclePhaseContext();
      }
      this.state.position = {
        ...this.state.position,
        tokenId: null,
        bandHalfBps: null,
        liquidity: null,
        inRange: null,
      };
      closedExistingPosition = true;
    }

    // Do not force a full normalization leg on close; this creates avoidable churn.
    // Inventory shaping below uses capped swaps and a tolerance band.
    const maxSwapCount = Math.max(
      0,
      Math.round(
        Number(
          closedExistingPosition
            ? executionCaps.maxInventorySwapsPerRebalance
            : executionCaps.maxSwapsOnOpen
        )
      )
    );
    let swapsUsed = 0;

    let usdcBalanceRaw = await this.readTokenBalance(this.usdc);
    let wethBalanceRaw = await this.readTokenBalance(this.weth);
    const walletSnapshot = this.state.latest?.wallet;
    const totalValueUsd = Number(walletSnapshot?.valuesUsd?.total || 0);
    const effectiveReserveUsdc = this.getEffectiveReserveTargetUsdc(totalValueUsd);
    const keepReserveRaw = parseUnits(effectiveReserveUsdc.toFixed(6), USDC_DECIMALS);
    const keepReserveRebalanceRaw = keepReserveRaw + USDC_RESERVE_GUARD_RAW;
    const maxInitialMintRaw = parseUnits(this.settings.maxInitialMintUsdc.toFixed(6), USDC_DECIMALS);

    let freeUsdcRaw = usdcBalanceRaw > keepReserveRebalanceRaw ? usdcBalanceRaw - keepReserveRebalanceRaw : 0n;
    let deployableUsdcRaw = freeUsdcRaw < maxInitialMintRaw ? freeUsdcRaw : maxInitialMintRaw;
    if (
      deployableUsdcRaw <= 0n &&
      wethBalanceRaw > 0n &&
      swapsUsed < maxSwapCount &&
      Number(formatUnits(wethBalanceRaw, WETH_DECIMALS)) * this.getSpotUsdcPerWeth() >= Number(executionCaps.minSwapUsd || 0)
    ) {
      // If wallet drifted to WETH while no position exists, restore deployable USDC once.
      await runSwapStep(async () =>
        await this.swapExactInputSingle({
          router,
          tokenIn: this.weth,
          tokenOut: this.usdc,
          amountIn: wethBalanceRaw,
          slippageBps: this.settings.slippageBps,
          fee: snapshot.fee,
          tickSpacing: snapshot.tickSpacing,
          snapshot,
        })
      );
      swapsUsed += 1;
      usdcBalanceRaw = await this.readTokenBalance(this.usdc);
      wethBalanceRaw = await this.readTokenBalance(this.weth);
      freeUsdcRaw = usdcBalanceRaw > keepReserveRebalanceRaw ? usdcBalanceRaw - keepReserveRebalanceRaw : 0n;
      deployableUsdcRaw = freeUsdcRaw < maxInitialMintRaw ? freeUsdcRaw : maxInitialMintRaw;
    }
    if (deployableUsdcRaw <= 0n) {
      throw new Error(
        `No deployable USDC after reserve and maxDeploy limits ${JSON.stringify({
          reserveUsdc: Number(formatUnits(keepReserveRaw, USDC_DECIMALS)),
          reserveGuardUsdc: Number(formatUnits(USDC_RESERVE_GUARD_RAW, USDC_DECIMALS)),
          maxInitialMintUsdc: Number(this.settings.maxInitialMintUsdc || 0),
          usdcBalance: Number(formatUnits(usdcBalanceRaw, USDC_DECIMALS)),
          wethBalance: Number(formatUnits(wethBalanceRaw, WETH_DECIMALS)),
          freeUsdc: Number(formatUnits(freeUsdcRaw, USDC_DECIMALS)),
        })}`
      );
    }

    // Single-swap ratio shaping toward 50/50 (within tolerance) to avoid swap churn.
    let plannedSwap = null;
    const spot = this.getSpotUsdcPerWeth();
    const deployableUsdc = Number(formatUnits(deployableUsdcRaw, USDC_DECIMALS));
    const wethBalanceNum = Number(formatUnits(wethBalanceRaw, WETH_DECIMALS));
    if (spot > 0 && Number.isFinite(deployableUsdc) && Number.isFinite(wethBalanceNum)) {
      const totalUsd = deployableUsdc + wethBalanceNum * spot;
      if (totalUsd > 0) {
        const usdcShare = deployableUsdc / totalUsd;
        const tolHalf = Number(executionCaps.targetRatioTolerancePct || 0) / 2;
        const lowerShare = Math.max(0, 0.5 - tolHalf);
        const upperShare = Math.min(1, 0.5 + tolHalf);
        if (usdcShare > upperShare) {
          const deltaUsdc = deployableUsdc - totalUsd / 2;
          if (deltaUsdc >= Number(executionCaps.minSwapUsd || 0)) {
            plannedSwap = {
              tokenIn: this.usdc,
              tokenOut: this.weth,
              amountIn: parseUnits(deltaUsdc.toFixed(6), USDC_DECIMALS),
              amountUsd: deltaUsdc,
            };
          }
        } else if (usdcShare < lowerShare) {
          const deltaUsd = totalUsd / 2 - deployableUsdc;
          if (deltaUsd >= Number(executionCaps.minSwapUsd || 0)) {
            const wethIn = Math.min(wethBalanceNum, deltaUsd / spot);
            if (wethIn > 0) {
              plannedSwap = {
                tokenIn: this.weth,
                tokenOut: this.usdc,
                amountIn: parseUnits(wethIn.toFixed(18), WETH_DECIMALS),
                amountUsd: wethIn * spot,
              };
            }
          }
        }
      }
    }
    if (
      plannedSwap?.amountIn > 0n &&
      swapsUsed < maxSwapCount &&
      Number(plannedSwap.amountUsd || 0) >= Number(executionCaps.minSwapUsd || 0)
    ) {
      await runSwapStep(async () =>
        await this.swapExactInputSingle({
          router,
          tokenIn: plannedSwap.tokenIn,
          tokenOut: plannedSwap.tokenOut,
          amountIn: plannedSwap.amountIn,
          slippageBps: this.settings.slippageBps,
          fee: snapshot.fee,
          tickSpacing: snapshot.tickSpacing,
          snapshot,
        })
      );
      swapsUsed += 1;
    }

    const usdcAfter = await this.readTokenBalance(this.usdc);
    const wethAfter = await this.readTokenBalance(this.weth);

    let usdcSpendable = usdcAfter > keepReserveRebalanceRaw ? usdcAfter - keepReserveRebalanceRaw : 0n;
    let usdcToUse = usdcSpendable < maxInitialMintRaw ? usdcSpendable : maxInitialMintRaw;
    let wethToUse = wethAfter;

    // Recovery path: if one side is unexpectedly empty, do a one-shot top-up swap.
    if ((usdcToUse <= 0n || wethToUse <= 0n) && (usdcAfter > 0n || wethAfter > 0n) && swapsUsed < maxSwapCount) {
      if (wethToUse <= 0n && usdcToUse > 0n) {
        const topUpUsdcIn = usdcToUse / 4n;
        if (
          topUpUsdcIn > 0n &&
          swapsUsed < maxSwapCount &&
          Number(formatUnits(topUpUsdcIn, USDC_DECIMALS)) >= Number(executionCaps.minSwapUsd || 0)
        ) {
          await runSwapStep(async () =>
            await this.swapExactInputSingle({
              router,
              tokenIn: this.usdc,
              tokenOut: this.weth,
              amountIn: topUpUsdcIn,
              slippageBps: this.settings.slippageBps,
              fee: snapshot.fee,
              tickSpacing: snapshot.tickSpacing,
              snapshot,
            })
          );
          swapsUsed += 1;
        }
      } else if (usdcToUse <= 0n && wethToUse > 0n) {
        const topUpWethIn = wethToUse / 4n;
        if (
          topUpWethIn > 0n &&
          swapsUsed < maxSwapCount &&
          Number(formatUnits(topUpWethIn, WETH_DECIMALS)) * this.getSpotUsdcPerWeth() >= Number(executionCaps.minSwapUsd || 0)
        ) {
          await runSwapStep(async () =>
            await this.swapExactInputSingle({
              router,
              tokenIn: this.weth,
              tokenOut: this.usdc,
              amountIn: topUpWethIn,
              slippageBps: this.settings.slippageBps,
              fee: snapshot.fee,
              tickSpacing: snapshot.tickSpacing,
              snapshot,
            })
          );
          swapsUsed += 1;
        }
      }

      const usdcRetry = await this.readTokenBalance(this.usdc);
      const wethRetry = await this.readTokenBalance(this.weth);
      usdcSpendable = usdcRetry > keepReserveRebalanceRaw ? usdcRetry - keepReserveRebalanceRaw : 0n;
      usdcToUse = usdcSpendable < maxInitialMintRaw ? usdcSpendable : maxInitialMintRaw;
      wethToUse = wethRetry;
    }

    if (usdcToUse <= 0n || wethToUse <= 0n) {
      const diag = {
        reserveUsdc: Number(formatUnits(keepReserveRaw, USDC_DECIMALS)),
        reserveGuardUsdc: Number(formatUnits(USDC_RESERVE_GUARD_RAW, USDC_DECIMALS)),
        maxInitialMintUsdc: Number(this.settings.maxInitialMintUsdc || 0),
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
    let targetRange = this.computeTargetRange(mintBasis.tick, mintBasis.tickSpacing, effectiveBandHalfBps);
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
          effectiveBandHalfBps
        );
      } else {
        try {
          mintBasis = await this.getPoolSnapshot(this.slipstreamPool, "slipstream");
          targetRange = this.computeTargetRange(
            mintBasis.tick,
            mintBasis.tickSpacing,
            effectiveBandHalfBps
          );
        } catch {
          // Keep provided snapshot on first attempt if refresh fails.
        }
      }

      try {
        this.setLifecyclePhaseContext({
          phase: closedExistingPosition ? "rebalance_mint" : "open_mint",
          positionRunId: runId,
          tokenId: null,
          band: {
            bandHalfBps: Number(effectiveBandHalfBps || 0),
            tickLower: targetRange.tickLower,
            tickUpper: targetRange.tickUpper,
          },
        });
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
        } finally {
          this.clearLifecyclePhaseContext();
        }
        break;
      } catch (err) {
        lastMintErr = err;
        preflightErrors.push(
          `attempt${attempt}: ${err instanceof Error ? err.message : String(err || "unknown")}`
        );
        if (err && typeof err === "object" && err.uc6MintSkippedDust) {
          break;
        }
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
      bandHalfBps: effectiveBandHalfBps,
      tickLower: minted.tickLower,
      tickUpper: minted.tickUpper,
      centerTick: minted.centerTick,
      liquidity: minted.liquidity,
      inRange: snapshot.tick > minted.tickLower && snapshot.tick < minted.tickUpper,
      topUpsThisCycle: 0,
    };
  }

  async evaluateAndAct() {
    const primary = this.state.latest?.primary;
    if (!primary) {
      this.setDecision({ action: "monitor", reason: "no_market_data" });
      return;
    }

    // Defensive adoption before trigger evaluation to avoid false `no_position`
    // decisions when local tokenId briefly desyncs from on-chain inventory.
    if (!this.state.position?.tokenId) {
      await this.maybeRefreshPositionInventory({ force: true }).catch(() => {});
      this.enforceSinglePositionInvariant();
    }
    this.ensureActiveLifecycleRecordFromTrackedPosition();

    const forceRequestedAt = this.state.forceRebalanceRequestedAt || null;
    const forceRebalance = Boolean(forceRequestedAt);
    const gateBase = this.getRebalanceGate();
    const triggerBase = this.getPositionTrigger(primary.tick);
    const regimeDecisionCtx = this.estimateRegimeAndAdvice({ triggerBase, gateBase });
    const effectiveThresholds = regimeDecisionCtx?.effectiveSettings || {
      edgeRebalancePct: Number(this.settings.edgeRebalancePct || 0),
      minRebalanceIntervalSec: Number(this.settings.minRebalanceIntervalSec || 0),
      bandHalfBps: Number(this.settings.bandHalfBps || 0),
    };
    const trendCtx = this.buildTrendContext(primary);
    const gate = this.getRebalanceGate({
      minRebalanceIntervalSec: effectiveThresholds.minRebalanceIntervalSec,
    });
    const trigger = this.getPositionTrigger(primary.tick, {
      edgeRebalancePct: effectiveThresholds.edgeRebalancePct,
    });
    const recoveryRetry = Boolean(this.state.forceRebalanceRecoveryPending) && trigger.reason === "no_position";
    let effectiveTrigger = forceRebalance
      ? { ...trigger, trigger: true, reason: "manual_force" }
      : recoveryRetry
        ? { ...trigger, trigger: true, reason: "recovery_retry" }
      : trigger;
    if (
      !forceRebalance &&
      !recoveryRetry &&
      effectiveTrigger.trigger &&
      effectiveTrigger.reason === "near_edge" &&
      regimeDecisionCtx?.advice?.waitRecommended
    ) {
      effectiveTrigger = {
        ...effectiveTrigger,
        trigger: false,
        reason: "regime_wait_near_edge",
      };
    }
    if (effectiveTrigger.trigger && effectiveTrigger.reason === "no_position" && (forceRebalance || recoveryRetry || gate.allowed)) {
      await this.maybeRefreshPositionInventory({ force: true });
      this.enforceSinglePositionInvariant();
    }
    await this.syncStrategyModeInvariant();
    const strategyMode = this.getStrategyMode();
    const tradingAllowed = !this.settings.killSwitch && Boolean(this.settings.tradingEnabled);
    const trendEscapeEval = this.buildTrendEscapeEvaluation(primary, trendCtx, { tradingAllowed });
    const reEntryEval = this.buildReEntryEvaluation(primary, trendCtx, { tradingAllowed });
    const activeSlipstreamPositions = Number(this.state.latest?.positionInventory?.activeCount || 0);
    if (activeSlipstreamPositions > 1) {
      const reason = `multiple_active_positions ${activeSlipstreamPositions}`;
      this.setDecision({
        action: "monitor",
        reason,
        mode: strategyMode,
        gate: { allowed: false, reason, remainingSec: null },
      });
      this.pushEvent({ type: "blocked", reason });
      return;
    }

    if (this.settings.killSwitch) {
      this.setDecision({
        action: "monitor",
        reason: "kill_switch_active",
        mode: strategyMode,
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
        mode: strategyMode,
        tradingEnabled: false,
        gate,
        forceRebalanceRequestedAt: forceRequestedAt,
      });
      this.pushEvent({ type: "blocked", reason: "trading_disabled" });
      return;
    }

    if (strategyMode !== "LP_ACTIVE") {
      if (reEntryEval.eligible) {
        await this.executeReEntry(primary, effectiveThresholds.bandHalfBps, trendCtx);
        return;
      }
      this.setDecision({
        action: "hold",
        reason: reEntryEval.reasonIfBlocked || "hold_mode",
        mode: strategyMode,
        trendMovePct: Number.isFinite(Number(trendCtx?.trendMovePct)) ? Number(trendCtx.trendMovePct) : null,
        reEntryEligible: Boolean(reEntryEval.eligible),
      });
      return;
    }

    if (trendEscapeEval.eligible) {
      await this.executeTrendEscape(primary, trendCtx, trendEscapeEval);
      return;
    }

    if (!effectiveTrigger.trigger) {
      if (trigger.reason === "in_band") {
        const toppedUp = await this.maybeTopUpLiquidity(primary);
        if (toppedUp) return;
        // Auto-stake once all top-ups are done (can't increaseLiquidity while staked)
        const staked = await this.maybeAutoStakeIdle();
        if (staked) return;
      }
      const harvested = await this.maybeHarvestOnly();
      if (harvested) return;
      this.setDecision({
        action: "monitor",
        reason: trigger.reason,
        mode: strategyMode,
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
        mode: strategyMode,
        note: "uniswapv3 execution path is intentionally read-only in this version",
      });
      return;
    }

    const hodlGate = this.evaluateHodlGateForClose();
    if (!hodlGate.allowed) {
      const harvested = await this.maybeHarvestOnly();
      if (harvested) return;
      const activeRec = this.getActiveLifecycleRecordInternal();
      if (activeRec) {
        activeRec.activity.closeGateBlockedCount = Number(activeRec.activity.closeGateBlockedCount || 0) + 1;
        activeRec.activity.closeGateOverrideReason = null;
        activeRec.updatedAtIso = nowIso();
        void this.persistPositionRecords().catch((err) => this.setLastError(err));
      }
      const gateBlock = {
        allowed: false,
        reason: hodlGate.reason,
        remainingSec: null,
      };
      this.setDecision({
        action: "skipped",
        reason: effectiveTrigger.reason,
        mode: strategyMode,
        gate: gateBlock,
        hodlGate: {
          alphaLiveUsd: Number(hodlGate.snapshot?.alphaLiveUsd || 0),
          requiredFeesToBeatHodlLiveUsd: Number(hodlGate.snapshot?.requiredFeesToBeatHodlLiveUsd || 0),
        },
      });
      this.pushEvent({ type: "blocked", reason: hodlGate.reason });
      return;
    }

    if (forceRebalance) this.state.forceRebalanceRequestedAt = null;
    if (recoveryRetry) this.state.forceRebalanceRecoveryPending = false;
    const activeRec = this.getActiveLifecycleRecordInternal();
    if (activeRec) {
      activeRec.activity.closeGateOverrideReason =
        hodlGate.reason && hodlGate.reason.startsWith("override_")
          ? hodlGate.reason
          : null;
      activeRec.updatedAtIso = nowIso();
      void this.persistPositionRecords().catch((err) => this.setLastError(err));
    }
    const preRecenterMeta = (() => {
      const hasExisting = Boolean(this.state.position?.tokenId);
      if (!hasExisting) return {};
      const closedBandHalfBps = Number(this.state.position?.bandHalfBps);
      const closedTickLower = Number(this.state.position?.tickLower);
      const closedTickUpper = Number(this.state.position?.tickUpper);
      const closedBandHalfBpsEffective = this.estimateBandHalfBpsFromTicks(closedTickLower, closedTickUpper);
      const lastRebalanceMs = this.state.lastRebalanceAt ? Date.parse(this.state.lastRebalanceAt) : NaN;
      const nowMs = Date.now();
      const runDurationSec =
        Number.isFinite(lastRebalanceMs) && nowMs > lastRebalanceMs ? Math.round((nowMs - lastRebalanceMs) / 1000) : null;
      const lpBaseUsdAtClose = this.estimateTrackedLpUsdValueFromLatest();
      return {
        closedBandHalfBps: Number.isFinite(closedBandHalfBps) ? closedBandHalfBps : null,
        closedBandHalfBpsEffective:
          Number.isFinite(Number(closedBandHalfBpsEffective)) && Number(closedBandHalfBpsEffective) > 0
            ? Number(closedBandHalfBpsEffective)
            : null,
        closedTickLower: Number.isFinite(closedTickLower) ? closedTickLower : null,
        closedTickUpper: Number.isFinite(closedTickUpper) ? closedTickUpper : null,
        runDurationSec,
        lpBaseUsdAtClose,
        closeGateOverrideReason:
          activeRec?.activity?.closeGateOverrideReason || null,
      };
    })();
    this.beginAction("recenter", effectiveTrigger.reason);
    try {
      await this.rebalanceSlipstream(primary, {
        bandHalfBps: effectiveThresholds.bandHalfBps,
      });
      if (!this.state.position?.tokenId) {
        throw new Error("Rebalance finished without an active LP position (tokenId missing)");
      }
      this.markRebalanceSuccess(effectiveTrigger.reason, "slipstream");
      this.finalizeActiveAction("recenter", effectiveTrigger.reason, {
        ...preRecenterMeta,
        ...(forceRebalance ? { requestedAt: forceRequestedAt } : {}),
      });
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
    const headSeen = this.settings.wsEnabled ? this.wsHeadWatcher.consumeHeadSeen() : false;
    const snapshots = await this.refreshSnapshots({ headSeen });
    await this.maybeRefreshPositionFromChain();
    await this.maybeRefreshPositionInventory();
    this.enforceSinglePositionInvariant();
    try {
      await this.repairLedgerAccounting();
    } catch (err) {
      this.setLastError(err);
    }
    await this.refreshCollectableNowMaybe();
    await this.maybeEmitPendingEntrySnapshot().catch((err) => this.setLastError(err));
    await this.maybeTopUpEthGas(
      this.settings.venue === "uniswapv3"
        ? snapshots.fallback || snapshots.primary || this.state.latest?.fallback || this.state.latest?.primary
        : snapshots.primary || this.state.latest?.primary || snapshots.fallback || this.state.latest?.fallback
    ).catch((err) => this.setLastError(err));

    const tokenId = this.state.position?.tokenId;
    if (tokenId && this.state.position?.tickLower != null && this.state.position?.tickUpper != null) {
      const tick = snapshots.primary.tick;
      this.state.position.inRange = tick > this.state.position.tickLower && tick < this.state.position.tickUpper;
      if (this.state.position.inRange) {
        this.state.outOfRangeSinceIso = null;
      } else if (!this.state.outOfRangeSinceIso) {
        this.state.outOfRangeSinceIso = nowIso();
      }
    } else {
      this.state.outOfRangeSinceIso = null;
    }
    this.updateCapitalStats(this.estimateAggregatedLpUsdValueFromLatest(), Date.now());
    this.updateRangeStats(Date.now());

    await this.refreshEmissionsMaybe();
    await this.evaluateAndAct();
    this.maybeStartPoolComparisonJob();
  }

  async mainLoop() {
    while (!this.stopRequested) {
      const started = Date.now();
      let loopOk = false;
      let persistOk = false;
      try {
        await this.loopOnce();
        loopOk = true;
      } catch (err) {
        this.setLastError(err);
      }

      try {
        await this.persistState();
        persistOk = true;
      } catch (err) {
        this.setLastError(err);
      }

      if (loopOk && persistOk) {
        this.markSuccessfulLoop();
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
    const hasActivePosition = Boolean(pos.tokenId);
    const token0 = activePool?.token0 || this.weth;
    const token1 = activePool?.token1 || this.usdc;
    const tickLower = hasActivePosition ? Number(pos.tickLower) : NaN;
    const tickUpper = hasActivePosition ? Number(pos.tickUpper) : NaN;
    const hasRange = Number.isFinite(tickLower) && Number.isFinite(tickUpper) && tickUpper > tickLower;
    const liquidityRaw = hasActivePosition && pos.liquidity ? BigInt(pos.liquidity) : 0n;
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

    const distance = hasActivePosition ? this.distanceToEdge(pos, Number(activePool?.tick ?? 0)) : null;
    const positionInventory = latest.positionInventory || null;
    const aggregatedLpUsdValue = this.estimateAggregatedLpUsdValueFromLatest() || lpUsdValue;
    const reserveTargetUsdc = this.getEffectiveReserveTargetUsdc(walletValueUsd + aggregatedLpUsdValue);
    const reserveTargetUsd = reserveTargetUsdc;
    const portfolioTotalUsd = walletValueUsd + aggregatedLpUsdValue;
    const deployedPct = portfolioTotalUsd > 0 ? (aggregatedLpUsdValue / portfolioTotalUsd) * 100 : 0;

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
    const bandPerformance = this.summarizeBandPerformance(eventsAll);

    const collectableNow = latest.collectableNow || { usdc: 0, weth: 0, usd: 0, isEstimated: true };
    const avgCapitalToday = this.averageDeployedUsdSince(todayStart, aggregatedLpUsdValue, now);
    const avgCapital7d = this.averageDeployedUsdSince(now - 7 * 24 * 60 * 60 * 1000, aggregatedLpUsdValue, now);
    const avgCapital30d = this.averageDeployedUsdSince(now - 30 * 24 * 60 * 60 * 1000, aggregatedLpUsdValue, now);
    const aprToday = avgCapitalToday > 0 ? (todayStats.netUsd / avgCapitalToday) * (365 / 1) : null;
    const apr7d = avgCapital7d > 0 ? (stats7d.netUsd / avgCapital7d) * (365 / 7) : null;
    const apr30d = events30d.length > 0 && avgCapital30d > 0 ? (stats30d.netUsd / avgCapital30d) * (365 / 30) : null;
    const churnRatioToday = Number.isFinite(todayStats.churnRatio) ? todayStats.churnRatio : null;
    const rangeStats = this.state.rangeStats || {};
    const inRangeEligibleMs = Number(rangeStats.inRangeMs || 0);
    const eligibleTradingMs = Number(rangeStats.eligibleMs || 0);
    const timeInRangePct = eligibleTradingMs > 0 ? inRangeEligibleMs / eligibleTradingMs : null;
    const hodlGateEval = this.evaluateHodlGateForClose();
    const hodlGateSnapshot = hodlGateEval.snapshot || this.computeHodlGateSnapshot();
    const strategyMode = this.getStrategyMode();
    const trendCtx = this.buildTrendContext(primary || fallback || null, { persistState: false });
    const tradingAllowed = !this.settings.killSwitch && Boolean(this.settings.tradingEnabled);
    const trendEscapeEval = this.buildTrendEscapeEvaluation(primary || fallback || null, trendCtx, {
      tradingAllowed,
    });
    const reEntryEval = this.buildReEntryEvaluation(primary || fallback || null, trendCtx, {
      tradingAllowed,
    });

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
        wsEnabled: this.settings.wsEnabled,
        slot0RefreshEverySec: this.settings.slot0RefreshEverySec,
        balancesRefreshEverySec: this.settings.balancesRefreshEverySec,
        positionRefreshEverySec: this.settings.positionRefreshEverySec,
        inventoryRefreshEverySec: this.settings.inventoryRefreshEverySec,
        collectableRefreshEverySec: this.settings.collectableRefreshEverySec,
        dashboardRecommendedPollMs: this.settings.dashboardRecommendedPollMs,
        regime: this.settings.regime,
        hodlGate: this.settings.hodlGate,
        trendEscape: this.settings.trendEscape,
        reEntry: this.settings.reEntry,
        executionCaps: this.settings.executionCaps,
        gasTopUp: this.settings.gasTopUp,
        poolComparison: this.settings.poolComparison,
        maxDeployUsdc: this.settings.maxDeployUsdc,
        maxInitialMintUsdc: this.settings.maxInitialMintUsdc,
        minTopUpUsd: this.settings.minTopUpUsd,
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
        tickLower: hasActivePosition ? (pos.tickLower ?? null) : null,
        tickUpper: hasActivePosition ? (pos.tickUpper ?? null) : null,
        centerTick: hasActivePosition ? (pos.centerTick ?? null) : null,
        inRange: hasActivePosition && typeof pos.inRange === "boolean" ? pos.inRange : null,
        distanceToEdge: distance,
        liquidity: hasActivePosition ? (pos.liquidity || null) : null,
        amountsInLP: {
          usdc: hasActivePosition ? lpUsdc : 0,
          weth: hasActivePosition ? lpWeth : 0,
          usdValue: hasActivePosition ? lpUsdValue : 0,
          sideUsd: hasActivePosition ? sideUsd : { usdc: 0, weth: 0 },
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
          lpDeployed: aggregatedLpUsdValue,
          reserveTarget: reserveTargetUsd,
        },
        deployedPct,
      },
      fees: {
        collectableNow,
        collectedTodayUsd: todayStats.feesUsd,
        collected7dUsd: stats7d.feesUsd,
        collected30dUsd: stats30d.feesUsd,
        collectedTotalUsd: statsAll.feesUsd,
        rewardsTodayUsd: todayStats.rewardsUsd,
        rewards7dUsd: stats7d.rewardsUsd,
        rewards30dUsd: stats30d.rewardsUsd,
        rewardsTotalUsd: statsAll.rewardsUsd,
        pendingCompoundUsd: Number(this.state.pendingCompoundUsd || 0),
      },
      costs: {
        gasTodayUsd: todayStats.gasUsd,
        gas7dUsd: stats7d.gasUsd,
        gas30dUsd: stats30d.gasUsd,
        gasTotalUsd: statsAll.gasUsd,
        swapCostsTodayUsd: todayStats.swapCostsUsd,
        swapCosts7dUsd: stats7d.swapCostsUsd,
        swapCosts30dUsd: stats30d.swapCostsUsd,
        swapCostsTotalUsd: statsAll.swapCostsUsd,
        mintBurnTodayUsd: todayStats.mintBurnUsd,
        mintBurn7dUsd: stats7d.mintBurnUsd,
        mintBurn30dUsd: stats30d.mintBurnUsd,
        mintBurnTotalUsd: statsAll.mintBurnUsd,
        totalTodayUsd: todayStats.totalCostsUsd,
        total7dUsd: stats7d.totalCostsUsd,
        total30dUsd: stats30d.totalCostsUsd,
        totalTotalUsd: statsAll.totalCostsUsd,
      },
      pnl: {
        netTodayUsd: todayStats.netUsd,
        net7dUsd: stats7d.netUsd,
        net30dUsd: stats30d.netUsd,
        netTotalUsd: statsAll.netUsd,
        aprToday,
        apr7d,
        apr30d,
      },
      analytics: {
        bandPerformance,
      },
      regime: latest.regime || {
        enabled: Boolean(this.settings.regime?.enabled),
        ok: false,
        label: "unknown",
        theta: null,
        halfLifeSec: null,
        sigma: null,
        mu: null,
        confidence: 0,
        updatedAtIso: null,
        sampleCount: 0,
        requiredMinSamples: Number(this.settings.regime?.minSamples || 0),
        feasibleSamples: null,
        windowSec: Number(this.settings.regime?.windowSec || 0),
      },
      decision: latest.regimeDecision || {
        baseThresholds: {
          edgeRebalancePct: Number(this.settings.edgeRebalancePct || 0),
          minRebalanceIntervalSec: Number(this.settings.minRebalanceIntervalSec || 0),
          bandHalfBps: Number(this.settings.bandHalfBps || 0),
        },
        effectiveThresholds: {
          edgeRebalancePct: Number(this.settings.edgeRebalancePct || 0),
          minRebalanceIntervalSec: Number(this.settings.minRebalanceIntervalSec || 0),
          bandHalfBps: Number(this.settings.bandHalfBps || 0),
        },
        adviceReason: this.settings.regime?.enabled ? "regime_not_estimated_yet" : "regime_disabled",
        waitRecommended: false,
      },
      strategyMode,
      trend: {
        movePct:
          trendCtx?.trendMovePct == null || !Number.isFinite(Number(trendCtx.trendMovePct))
            ? null
            : Number(trendCtx.trendMovePct),
        direction: String(trendCtx?.direction || "flat"),
        lookbackSec: Number(trendCtx?.lookbackSec || this.getTrendEscapeSettings().directionLookbackSec),
        confirmSec: Number(trendCtx?.trendingConfirmSec || 0),
        meanRevertConfirmSec: Number(trendCtx?.meanRevertConfirmSec || 0),
        distanceFromMuPct:
          trendCtx?.distanceFromMuPct == null || !Number.isFinite(Number(trendCtx.distanceFromMuPct))
            ? null
            : Number(trendCtx.distanceFromMuPct),
        muPriceUsdcPerWeth:
          trendCtx?.muPrice == null || !Number.isFinite(Number(trendCtx.muPrice))
            ? null
            : Number(trendCtx.muPrice),
      },
      trendEscape: {
        enabled: Boolean(trendEscapeEval.enabled),
        eligible: Boolean(trendEscapeEval.eligible),
        holdTargetIfEscape: trendEscapeEval.holdTargetIfEscape || null,
        reasonIfBlocked: String(trendEscapeEval.reasonIfBlocked || "ok"),
        cooldownUntilIso: trendEscapeEval.cooldownUntilIso || null,
      },
      reEntry: {
        enabled: Boolean(reEntryEval.enabled),
        eligible: Boolean(reEntryEval.eligible),
        reasonIfBlocked: String(reEntryEval.reasonIfBlocked || "ok"),
        meanRevertConfirmSec: Number(reEntryEval.meanRevertConfirmSec || 0),
        distanceFromMuPct:
          reEntryEval.distanceFromMuPct == null || !Number.isFinite(Number(reEntryEval.distanceFromMuPct))
            ? null
            : Number(reEntryEval.distanceFromMuPct),
        eligibleAtIso: reEntryEval.eligibleAtIso || null,
        holdElapsedSec: Number(reEntryEval.holdElapsedSec || 0),
        holdRequiredSec: Number(reEntryEval.holdRequiredSec || 0),
        escapeCooldownUntilIso: reEntryEval.escapeCooldownUntilIso || null,
        reEntryCooldownUntilIso: reEntryEval.reEntryCooldownUntilIso || null,
        regimeLabel: String(reEntryEval.regimeLabel || "unknown"),
        regimeConfidence: Number(reEntryEval.regimeConfidence || 0),
        requiredRegimeLabel: String(reEntryEval.requiredRegimeLabel || "mean_reverting"),
        requiredMinConfidence: Number(reEntryEval.requiredMinConfidence || 0),
        requiredMeanRevertConfirmSec: Number(reEntryEval.requiredMeanRevertConfirmSec || 0),
        maxDistanceFromMuPct: Number(reEntryEval.maxDistanceFromMuPct || 0),
      },
      hodlGate: {
        enabled: Boolean(hodlGateSnapshot.enabled),
        marginUsd: Number(hodlGateSnapshot.marginUsd || 0),
        alphaLiveUsd: Number(hodlGateSnapshot.alphaLiveUsd || 0),
        feesNetLiveUsd: Number(hodlGateSnapshot.feesNetLiveUsd || 0),
        divVsHodlLiveUsd: Number(hodlGateSnapshot.divVsHodlLiveUsd || 0),
        requiredFeesToBeatHodlLiveUsd: Number(hodlGateSnapshot.requiredFeesToBeatHodlLiveUsd || 0),
        hasBaseline: Boolean(hodlGateSnapshot.hasBaseline),
        baselineSource: String(hodlGateSnapshot.baselineSource || "missing"),
        baselineWeth: Number(hodlGateSnapshot.baselineWeth || 0),
        baselineUsdc: Number(hodlGateSnapshot.baselineUsdc || 0),
        hodlNowUsd: Number(hodlGateSnapshot.hodlNowUsd || 0),
        lpNowUsd: Number(hodlGateSnapshot.lpNowUsd || 0),
        collectableNowUsd: Number(hodlGateSnapshot.collectableNowUsd || 0),
        totalCostsToDateUsd: Number(hodlGateSnapshot.totalCostsToDateUsd || 0),
        feesCollectedUsd: Number(hodlGateSnapshot.feesCollectedUsd || 0),
        rewardsClaimedUsd: Number(hodlGateSnapshot.rewardsClaimedUsd || 0),
        claimableAeroUsd: Number(hodlGateSnapshot.claimableAeroUsd || 0),
        outOfRangeDurationSec: Number(hodlGateSnapshot.outOfRangeDurationSec || 0),
        distanceBeyondEdgePct: Number(hodlGateSnapshot.distanceBeyondEdgePct || 0),
        lastGateDecision: {
          allowed: Boolean(hodlGateEval.allowed),
          reason: String(hodlGateEval.reason || "unknown"),
        },
      },
      positionsSummary: this.getPositionsSummary(POSITION_SUMMARY_LIMIT),
      positionsTaxSummary: this.getPositionsTaxSummary(),
      activePositionId: this.state.position?.tokenId ? String(this.state.position.tokenId) : null,
      activePositionRecord: this.getActivePositionRecord(),
      poolComparison: this.getPoolComparisonStatusPayload(),
      providers: {
        http: this.httpPool.snapshotStatus(),
        ws: this.wsHeadWatcher.status(),
      },
      refresh: latest.refresh || {},
      ops: {
        rebalancesToday: this.state.rebalancesToday,
        rebalances24h: stats24h.rebalances,
        rebalances7d: stats7d.rebalances,
        churnRatioToday,
        timeInRange: {
          sinceIso: rangeStats.sinceIso || null,
          eligibleMs: eligibleTradingMs,
          inRangeMs: inRangeEligibleMs,
          pct: timeInRangePct,
        },
        lastRebalanceAtIso: this.state.lastRebalanceAt,
        cooldownRemainingSec: gate.remainingSec,
        gasTopUp: {
          lastAttemptAtIso: this.state.lastGasTopUpAttemptAt || null,
          lastSuccessAtIso: this.state.lastGasTopUpSuccessAt || null,
          lastSkipReason: this.state.lastGasTopUpSkipReason || null,
          ethUsd: Number(walletState.valuesUsd?.eth || 0),
        },
        forceRebalanceRequestedAtIso: this.state.forceRebalanceRequestedAt || null,
        forceRebalanceRecoveryPending: Boolean(this.state.forceRebalanceRecoveryPending),
        positionInventory: positionInventory
          ? {
              ownerNftCount: Number(positionInventory.ownerNftCount || 0),
              activeCount: Number(positionInventory.activeCount || 0),
              totalUsdValue: Number(positionInventory.totalUsdValue || 0),
              active: Array.isArray(positionInventory.active) ? positionInventory.active.slice(0, 20) : [],
            }
          : null,
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
      emissions: this.getEmissionsStatusPayload(),
      lastDecision: this.state.lastDecision,
      lastError: this.state.lastError,
    };
  }

  getClaimableAeroUsd() {
    const em = this.state.emissions || {};
    const aeroPrice = em.aeroPrice?.aeroUsd || 0;
    const claimableAero = em.claimable?.aero || 0;
    return claimableAero * aeroPrice;
  }

  getEmissionsStatusPayload() {
    const em = this.state.emissions || {};
    const s = this.settings.emissions || {};
    const aeroUsd = em.aeroPrice?.aeroUsd || 0;
    const claimableAero = em.claimable?.aero || 0;
    const walletAero = em.walletAero?.aero || 0;
    return {
      enabled: Boolean(s.enabled),
      poolAddress: this.slipstreamPool,
      gaugeAddress: em.gaugeAddress || null,
      gaugeAlive: em.gaugeAlive ?? null,
      gaugeMeta: em.gaugeMeta || null,
      staked: Boolean(em.staked),
      tokenId: em.stakedTokenId || null,
      autoStakeEligible: em.autoStakeEligible ?? null,
      autoStakeBlockedReason: em.autoStakeBlockedReason || null,
      rewardToken: em.rewardToken || null,
      claimable: {
        aero: claimableAero,
        usd: claimableAero * aeroUsd,
        updatedAtIso: em.claimable?.updatedAtIso || null,
      },
      walletBalance: {
        aero: walletAero,
        usd: walletAero * aeroUsd,
        updatedAtIso: em.walletAero?.updatedAtIso || null,
      },
      price: em.aeroPrice || { aeroUsd: 0, updatedAtIso: null, source: null },
      lastStakeAtIso: em.lastStakeAtIso || null,
      lastUnstakeAtIso: em.lastUnstakeAtIso || null,
      lastClaimAtIso: em.lastClaimAtIso || null,
      settings: {
        autoStakeOnMint: Boolean(s.autoStakeOnMint),
        autoUnstakeOnRebalance: Boolean(s.autoUnstakeOnRebalance),
        autoClaim: Boolean(s.autoClaim),
        claimMinUsd: Number(s.claimMinUsd || 0),
        claimCooldownSec: Number(s.claimCooldownSec || 0),
        approvalMode: s.approvalMode || "approve_token",
      },
    };
  }

  async handleOwnerSettings(req, res) {
    const ip = extractIp(req);
    const rl = this.ownerSettingsRateLimiter.take(ip);
    if (!rl.ok) return tooMany(res, rl.retryAfterSec);

    const auth = String(req.headers.authorization || "");
    if (!safeBearerMatch(ENV.adminToken, auth)) return unauthorized(res);

    try {
      const body = await readJsonBody(req, HTTP_JSON_MAX_BYTES);
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
      const nonceExpiry = Date.parse(parsed.expiresAt) + 60_000;
      this.ownerNonceUsed.set(parsed.nonce, nonceExpiry);

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

      this.setDecision({ action: "settings_updated", by: this.ownerAddress });
      this.pushEvent({ type: "action", reason: "settings_updated" });
      await this.persistState();

      return jsonResponse(res, 200, { ok: true, settings: this.settings });
    } catch (err) {
      const msg = sanitizeErrorMessage(err, "Bad request");
      return jsonResponse(res, requestErrorStatus(msg), { error: msg });
    }
  }

  async handleOwnerForceRebalance(req, res) {
    const ip = extractIp(req);
    const rl = this.ownerActionRateLimiter.take(ip);
    if (!rl.ok) return tooMany(res, rl.retryAfterSec);

    const auth = String(req.headers.authorization || "");
    if (!safeBearerMatch(ENV.adminToken, auth)) return unauthorized(res);

    try {
      const body = await readJsonBody(req, HTTP_JSON_MAX_BYTES);
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
      const nonceExpiry = Date.parse(parsed.expiresAt) + 60_000;
      this.ownerNonceUsed.set(parsed.nonce, nonceExpiry);

      this.state.forceRebalanceRequestedAt = nowIso();
      this.setDecision({ action: "force_rebalance_requested", by: this.ownerAddress });
      this.pushEvent({ type: "action", reason: "force_rebalance_requested" });
      await this.persistState();

      return jsonResponse(res, 200, {
        ok: true,
        forceRebalanceRequestedAt: this.state.forceRebalanceRequestedAt,
      });
    } catch (err) {
      const msg = sanitizeErrorMessage(err, "Bad request");
      return jsonResponse(res, requestErrorStatus(msg), { error: msg });
    }
  }

  async handleOwnerLiquidateAndPause(req, res) {
    const ip = extractIp(req);
    const rl = this.ownerActionRateLimiter.take(ip);
    if (!rl.ok) return tooMany(res, rl.retryAfterSec);

    const auth = String(req.headers.authorization || "");
    if (!safeBearerMatch(ENV.adminToken, auth)) return unauthorized(res);

    try {
      const body = await readJsonBody(req, HTTP_JSON_MAX_BYTES);
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
        expectedAction: "liquidate_and_pause",
      });

      this.pruneUsedNonces();
      if (this.ownerNonceUsed.has(parsed.nonce)) {
        return jsonResponse(res, 409, { error: "Owner nonce already used" });
      }
      const nonceExpiry = Date.parse(parsed.expiresAt) + 60_000;
      this.ownerNonceUsed.set(parsed.nonce, nonceExpiry);

      await this.loadSettings(false);
      const tokenId = this.state.position?.tokenId || null;
      const venue = this.state.position?.venue === "uniswapv3" ? "uniswapv3" : "slipstream";
      const npmAddress = venue === "uniswapv3" ? this.uniswapNpm : this.slipstreamNpm;
      let liquidated = false;

      if (tokenId) {
        this.beginAction("liquidate", "owner_liquidate_and_pause");
        try {
          const activeSnapshot = this.state.latest?.primary || this.state.latest?.fallback || null;
          const runId = this.ensureActivePositionRun({
            reason: "manual",
            snapshot: activeSnapshot,
            tokenId,
          });
          await this.appendLifecycleEvent(
            this.lifecycleCommonFields({
              type: "CLOSE_POSITION_START",
              positionRunId: runId,
              tokenId,
              band: this.currentBandDescriptor(),
              accounting: this.emptyLifecycleAccounting(),
              details: { reason: "owner_liquidate_and_pause" },
            })
          ).catch((err) => this.setLastError(err));
          let preCloseCollectableUsd = Number(this.state.latest?.collectableNow?.usd || 0);
          let preCloseCollectable = this.state.latest?.collectableNow || {
            usdc: 0,
            weth: 0,
            usd: preCloseCollectableUsd,
          };
          try {
            const freshCollectable = await this.collectableNowSnapshot();
            this.state.latest.collectableNow = freshCollectable;
            preCloseCollectableUsd = Number(freshCollectable?.usd || preCloseCollectableUsd || 0);
            preCloseCollectable = freshCollectable;
          } catch {
            // keep last known collectable snapshot if refresh fails
          }
          this.setLifecyclePhaseContext({
            phase: "final_close",
            positionRunId: runId,
            tokenId,
            band: this.currentBandDescriptor(),
          });
          try {
            await this.closePosition({
              npmAddress,
              tokenId,
              feeValueOverrideUsd: preCloseCollectableUsd,
              feeBreakdownOverride: preCloseCollectable,
            });
          } finally {
            this.clearLifecyclePhaseContext();
          }
          this.state.position = {
            ...this.state.position,
            venue,
            tokenId: null,
            tickLower: null,
            tickUpper: null,
            centerTick: null,
            liquidity: null,
            inRange: null,
          };
          this.state.pendingCompoundUsd = 0;
          this.state.pendingEntrySnapshot = null;
          this.state.activePositionRunId = null;
          this.state.latest.collectableNow = { usdc: 0, weth: 0, usd: 0, isEstimated: false };
          this.finalizeActiveAction("liquidate", "owner_liquidate_and_pause");
          liquidated = true;
        } catch (err) {
          this.setLastError(err);
          this.finalizeActiveAction("error", "owner_liquidate_and_pause_failed", {
            message: err instanceof Error ? err.message : String(err || "unknown"),
          });
          throw err;
        }
      }

      const nextSettings = normalizeSettings(
        {
          ...this.settings,
          tradingEnabled: false,
          killSwitch: true,
        },
        this.settings
      );
      nextSettings.tradingEnabled = false;
      nextSettings.killSwitch = true;

      await writeJsonAtomic(SETTINGS_PATH, nextSettings);
      this.settings = nextSettings;
      try {
        const st = await fsp.stat(SETTINGS_PATH);
        this.settingsMtimeMs = st.mtimeMs;
      } catch {}

      this.state.forceRebalanceRequestedAt = null;
      this.state.forceRebalanceRecoveryPending = false;
      this.setDecision({
        action: "owner_liquidate_and_pause",
        by: this.ownerAddress,
        liquidated,
        tokenId,
      });
      await this.persistState();

      return jsonResponse(res, 200, {
        ok: true,
        liquidated,
        tokenId,
        settings: this.settings,
      });
    } catch (err) {
      const msg = sanitizeErrorMessage(err, "Bad request");
      return jsonResponse(res, requestErrorStatus(msg), { error: msg });
    }
  }

  async handleOwnerEmissionsStake(req, res) {
    const ip = extractIp(req);
    const rl = this.ownerActionRateLimiter.take(ip);
    if (!rl.ok) return tooMany(res, rl.retryAfterSec);

    const auth = String(req.headers.authorization || "");
    if (!safeBearerMatch(ENV.adminToken, auth)) return unauthorized(res);

    try {
      const body = await readJsonBody(req, HTTP_JSON_MAX_BYTES);
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
        expectedAction: "emissions_stake",
      });

      this.pruneUsedNonces();
      if (this.ownerNonceUsed.has(parsed.nonce)) {
        return jsonResponse(res, 409, { error: "Owner nonce already used" });
      }
      const nonceExpiry = Date.parse(parsed.expiresAt) + 60_000;
      this.ownerNonceUsed.set(parsed.nonce, nonceExpiry);

      if (this.settings.killSwitch || !this.settings.tradingEnabled) {
        return jsonResponse(res, 409, { error: "Trading disabled or kill switch active" });
      }
      if (!this.settings.emissions?.enabled) {
        return jsonResponse(res, 409, { error: "Emissions feature not enabled" });
      }

      const tokenId = this.state.position?.tokenId;
      if (!tokenId) {
        return jsonResponse(res, 409, { error: "No active position to stake" });
      }
      if (this.state.emissions?.staked) {
        return jsonResponse(res, 409, { error: "Position already staked" });
      }

      const venue = this.state.position?.venue === "uniswapv3" ? "uniswapv3" : "slipstream";
      const npmAddress = venue === "uniswapv3" ? this.uniswapNpm : this.slipstreamNpm;

      await this.autoStakeAfterMint(tokenId, npmAddress);
      await this.persistState();

      return jsonResponse(res, 200, {
        ok: true,
        emissions: this.getEmissionsStatusPayload(),
      });
    } catch (err) {
      const msg = sanitizeErrorMessage(err, "Bad request");
      return jsonResponse(res, requestErrorStatus(msg), { error: msg });
    }
  }

  async handleOwnerEmissionsUnstake(req, res) {
    const ip = extractIp(req);
    const rl = this.ownerActionRateLimiter.take(ip);
    if (!rl.ok) return tooMany(res, rl.retryAfterSec);

    const auth = String(req.headers.authorization || "");
    if (!safeBearerMatch(ENV.adminToken, auth)) return unauthorized(res);

    try {
      const body = await readJsonBody(req, HTTP_JSON_MAX_BYTES);
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
        expectedAction: "emissions_unstake",
      });

      this.pruneUsedNonces();
      if (this.ownerNonceUsed.has(parsed.nonce)) {
        return jsonResponse(res, 409, { error: "Owner nonce already used" });
      }
      const nonceExpiry = Date.parse(parsed.expiresAt) + 60_000;
      this.ownerNonceUsed.set(parsed.nonce, nonceExpiry);

      // Unstake is allowed even if killSwitch (recovery action)
      if (!this.state.emissions?.staked) {
        return jsonResponse(res, 409, { error: "Position is not staked" });
      }

      await this.ensureUnstakedForNpmActions("owner_unstake");
      await this.persistState();

      return jsonResponse(res, 200, {
        ok: true,
        emissions: this.getEmissionsStatusPayload(),
      });
    } catch (err) {
      const msg = sanitizeErrorMessage(err, "Bad request");
      return jsonResponse(res, requestErrorStatus(msg), { error: msg });
    }
  }

  async handleOwnerEmissionsClaim(req, res) {
    const ip = extractIp(req);
    const rl = this.ownerActionRateLimiter.take(ip);
    if (!rl.ok) return tooMany(res, rl.retryAfterSec);

    const auth = String(req.headers.authorization || "");
    if (!safeBearerMatch(ENV.adminToken, auth)) return unauthorized(res);

    try {
      const body = await readJsonBody(req, HTTP_JSON_MAX_BYTES);
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
        expectedAction: "emissions_claim",
      });

      this.pruneUsedNonces();
      if (this.ownerNonceUsed.has(parsed.nonce)) {
        return jsonResponse(res, 409, { error: "Owner nonce already used" });
      }
      const nonceExpiry = Date.parse(parsed.expiresAt) + 60_000;
      this.ownerNonceUsed.set(parsed.nonce, nonceExpiry);

      // Claim is allowed even if killSwitch (recovery action)
      const em = this.state.emissions;
      if (!em?.staked) {
        return jsonResponse(res, 409, { error: "Position is not staked — cannot claim" });
      }
      const gaugeAddress = em.gaugeAddress;
      if (!gaugeAddress) {
        return jsonResponse(res, 409, { error: "No gauge address available" });
      }
      const tokenId = em.stakedTokenId || this.state.position?.tokenId;
      if (!tokenId) {
        return jsonResponse(res, 409, { error: "No token ID for claim" });
      }

      const aeroPrice = em.aeroPrice?.aeroUsd || 0;
      const result = await claimAeroRewards(
        this.walletClient,
        this.publicClient,
        gaugeAddress,
        tokenId,
        this.account,
        (msg) => console.log(`[UC6] [emissions] ${msg}`),
      );

      if (result.success) {
        const gasUsd =
          Number(formatUnits(result.gasCostWei, 18)) * this.getSpotUsdcPerWeth();
        em.lastClaimAtIso = nowIso();

        await this.appendLifecycleEvent(
          this.lifecycleCommonFields({
            type: "EMISSIONS_CLAIM",
            tokenId: String(tokenId),
            txHashes: [result.txHash],
            accounting: {
              gasUsd,
              rewardsUsd: result.aeroClaimed * aeroPrice,
              isEstimated: false,
            },
            details: {
              aeroClaimed: result.aeroClaimed,
              aeroPrice,
              gaugeAddress,
              trigger: "owner_manual",
            },
          }),
        ).catch((err) => this.setLastError(err));
      }

      await this.persistState();

      return jsonResponse(res, 200, {
        ok: true,
        aeroClaimed: result.aeroClaimed,
        emissions: this.getEmissionsStatusPayload(),
      });
    } catch (err) {
      const msg = sanitizeErrorMessage(err, "Bad request");
      return jsonResponse(res, requestErrorStatus(msg), { error: msg });
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
      const rl = this.publicStatusRateLimiter.take(extractIp(req));
      if (!rl.ok) return tooMany(res, rl.retryAfterSec);
      return jsonResponse(res, 200, this.statusPayload());
    }

    if (req.method === "GET" && u.pathname === "/positions") {
      const rl = this.publicPositionsRateLimiter.take(extractIp(req));
      if (!rl.ok) return tooMany(res, rl.retryAfterSec);
      const page = Number(u.searchParams.get("page") || 1);
      const pageSize = Number(u.searchParams.get("pageSize") || POSITION_PAGE_SIZE_DEFAULT);
      return jsonResponse(res, 200, this.getPositionRecordsPage(page, pageSize));
    }

    if (u.pathname.startsWith("/owner/")) {
      if (req.method === "POST" && u.pathname === "/owner/settings") {
        return await this.handleOwnerSettings(req, res);
      }
      if (req.method === "POST" && u.pathname === "/owner/force-rebalance") {
        return await this.handleOwnerForceRebalance(req, res);
      }
      if (req.method === "POST" && u.pathname === "/owner/liquidate-and-pause") {
        return await this.handleOwnerLiquidateAndPause(req, res);
      }
      if (req.method === "POST" && u.pathname === "/owner/emissions/stake") {
        return await this.handleOwnerEmissionsStake(req, res);
      }
      if (req.method === "POST" && u.pathname === "/owner/emissions/unstake") {
        return await this.handleOwnerEmissionsUnstake(req, res);
      }
      if (req.method === "POST" && u.pathname === "/owner/emissions/claim") {
        return await this.handleOwnerEmissionsClaim(req, res);
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
        this.setLastError(err);
        jsonResponse(res, 500, { error: "Internal server error" });
      }
    });
    this.server.requestTimeout = HTTP_SERVER_REQUEST_TIMEOUT_MS;
    this.server.headersTimeout = HTTP_SERVER_HEADERS_TIMEOUT_MS;
    this.server.keepAliveTimeout = HTTP_SERVER_KEEPALIVE_TIMEOUT_MS;
    this.server.maxHeadersCount = 64;

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
    await this.wsHeadWatcher.shutdown().catch(() => {});
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
    console.error("[UC6] unhandled rejection", sanitizeErrorMessage(reason, "unhandled rejection"));
  });
  process.on("uncaughtException", (err) => {
    console.error("[UC6] uncaught exception", sanitizeErrorMessage(err, "uncaught exception"));
  });

  await bot.start();
}

main().catch((err) => {
  console.error("[UC6] fatal", sanitizeErrorMessage(err, "fatal error"));
  process.exit(1);
});
