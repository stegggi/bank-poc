import { erc20Abi, formatUnits, parseAbi } from "viem";

// ── Constants ────────────────────────────────────────────────────────────────
export const AERO_ADDRESS = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
export const VOTER_ADDRESS = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";

// ── Minimal ABIs ─────────────────────────────────────────────────────────────
const VOTER_ABI = parseAbi([
  "function gauges(address pool) view returns (address)",
  "function isAlive(address gauge) view returns (bool)",
]);

const CLGAUGE_ABI = parseAbi([
  "function deposit(uint256 tokenId)",
  "function withdraw(uint256 tokenId)",
  "function getReward(uint256 tokenId)",
  "function earned(address account, uint256 tokenId) view returns (uint256)",
  "function stakedContains(address depositor, uint256 tokenId) view returns (bool)",
  "function periodFinish() view returns (uint256)",
  "function rewardRate() view returns (uint256)",
  "function rewardToken() view returns (address)",
  "function left() view returns (uint256)",
]);

const ERC721_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function approve(address to, uint256 tokenId)",
  "function setApprovalForAll(address operator, bool approved)",
]);

// ── Gauge resolution cache ───────────────────────────────────────────────────
const _gaugeCache = new Map(); // poolAddress → { data, expiresAt }
const GAUGE_CACHE_TTL_MS = 15 * 60 * 1000;

export function invalidateGaugeCache(poolAddress) {
  if (poolAddress) _gaugeCache.delete(poolAddress.toLowerCase());
  else _gaugeCache.clear();
}

/**
 * Discover the CLGauge for a pool via the Aerodrome Voter contract.
 * Results are cached for 15 min per pool.
 */
export async function resolveGauge(publicClient, poolAddress, settings) {
  const key = poolAddress.toLowerCase();
  const now = Date.now();
  const cached = _gaugeCache.get(key);
  if (cached && cached.expiresAt > now) return cached.data;

  const voterAddr =
    settings?.emissions?.voterAddress || VOTER_ADDRESS;

  // Allow per-pool gauge override
  const overrideAddr =
    settings?.emissions?.gaugeOverrideByPool?.[poolAddress] ||
    settings?.emissions?.gaugeOverrideByPool?.[key];

  let gaugeAddress;
  if (overrideAddr) {
    gaugeAddress = overrideAddr;
  } else {
    try {
      gaugeAddress = await publicClient.readContract({
        address: voterAddr,
        abi: VOTER_ABI,
        functionName: "gauges",
        args: [poolAddress],
      });
    } catch (err) {
      const result = _noGaugeResult("voter_call_failed", err.message);
      _gaugeCache.set(key, { data: result, expiresAt: now + 60_000 });
      return result;
    }
  }

  if (
    !gaugeAddress ||
    gaugeAddress === "0x0000000000000000000000000000000000000000"
  ) {
    const result = _noGaugeResult("no_gauge");
    _gaugeCache.set(key, { data: result, expiresAt: now + GAUGE_CACHE_TTL_MS });
    return result;
  }

  // Check alive status
  let gaugeAlive = false;
  try {
    gaugeAlive = await publicClient.readContract({
      address: voterAddr,
      abi: VOTER_ABI,
      functionName: "isAlive",
      args: [gaugeAddress],
    });
  } catch {
    // treat call failure as not alive
  }

  if (!gaugeAlive) {
    const result = {
      gaugeAddress,
      gaugeAlive: false,
      rewardToken: null,
      gaugeMeta: null,
      reason: "gauge_not_alive",
    };
    _gaugeCache.set(key, { data: result, expiresAt: now + GAUGE_CACHE_TTL_MS });
    return result;
  }

  // Multicall for gauge metadata
  let rewardToken = null;
  let periodFinish = 0n;
  let rewardRate = 0n;
  let left = null;

  try {
    const results = await publicClient.multicall({
      contracts: [
        { address: gaugeAddress, abi: CLGAUGE_ABI, functionName: "rewardToken" },
        { address: gaugeAddress, abi: CLGAUGE_ABI, functionName: "periodFinish" },
        { address: gaugeAddress, abi: CLGAUGE_ABI, functionName: "rewardRate" },
        { address: gaugeAddress, abi: CLGAUGE_ABI, functionName: "left" },
      ],
      allowFailure: true,
    });

    if (results[0].status === "success") rewardToken = results[0].result;
    if (results[1].status === "success") periodFinish = results[1].result;
    if (results[2].status === "success") rewardRate = results[2].result;
    if (results[3].status === "success") left = results[3].result;
  } catch {
    // fallback: try sequential
    try {
      rewardToken = await publicClient.readContract({
        address: gaugeAddress, abi: CLGAUGE_ABI, functionName: "rewardToken",
      });
      periodFinish = await publicClient.readContract({
        address: gaugeAddress, abi: CLGAUGE_ABI, functionName: "periodFinish",
      });
      rewardRate = await publicClient.readContract({
        address: gaugeAddress, abi: CLGAUGE_ABI, functionName: "rewardRate",
      });
    } catch {
      // best effort
    }
    try {
      left = await publicClient.readContract({
        address: gaugeAddress, abi: CLGAUGE_ABI, functionName: "left",
      });
    } catch {
      // left() may not exist on older gauges
    }
  }

  const rewardTokenMismatch =
    rewardToken &&
    rewardToken.toLowerCase() !== AERO_ADDRESS.toLowerCase();

  const gaugeMeta = {
    periodFinish: Number(periodFinish),
    rewardRate: rewardRate.toString(),
    left: left != null ? left.toString() : null,
    checkedAtIso: new Date().toISOString(),
  };

  const result = {
    gaugeAddress,
    gaugeAlive: true,
    rewardToken: rewardToken
      ? {
          address: rewardToken,
          symbol: rewardTokenMismatch ? "UNKNOWN" : "AERO",
          decimals: 18,
        }
      : null,
    gaugeMeta,
    reason: null,
    rewardTokenMismatch,
  };

  _gaugeCache.set(key, { data: result, expiresAt: now + GAUGE_CACHE_TTL_MS });
  return result;
}

// ── Staking eligibility ──────────────────────────────────────────────────────

export function isAutoStakeEligible(gaugeResult) {
  if (!gaugeResult) return { eligible: false, blockedReason: "no_gauge_data" };
  if (!gaugeResult.gaugeAddress)
    return { eligible: false, blockedReason: "no_gauge" };
  if (!gaugeResult.gaugeAlive)
    return { eligible: false, blockedReason: "gauge_not_alive" };

  const meta = gaugeResult.gaugeMeta;
  if (!meta) return { eligible: false, blockedReason: "no_gauge_meta" };

  const nowSec = Math.floor(Date.now() / 1000);
  if (meta.periodFinish && nowSec >= meta.periodFinish)
    return { eligible: false, blockedReason: "emissions_finished" };
  if (meta.rewardRate === "0")
    return { eligible: false, blockedReason: "reward_rate_zero" };
  if (meta.left != null && meta.left === "0")
    return { eligible: false, blockedReason: "no_rewards_left" };

  return { eligible: true, blockedReason: null };
}

// ── On-chain staked status ───────────────────────────────────────────────────

export async function checkStakedOnChain(
  publicClient,
  gaugeAddress,
  account,
  tokenId,
) {
  if (!gaugeAddress || !account || tokenId == null) return false;
  try {
    return await publicClient.readContract({
      address: gaugeAddress,
      abi: CLGAUGE_ABI,
      functionName: "stakedContains",
      args: [account, BigInt(tokenId)],
    });
  } catch {
    return false;
  }
}

// ── Read claimable & wallet AERO ─────────────────────────────────────────────

export async function readEmissionsMetrics(
  publicClient,
  gaugeAddress,
  account,
  tokenId,
  staked,
) {
  let claimableRaw = 0n;
  let walletRaw = 0n;

  try {
    const calls = [
      {
        address: AERO_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      },
    ];
    if (staked && gaugeAddress && tokenId != null) {
      calls.push({
        address: gaugeAddress,
        abi: CLGAUGE_ABI,
        functionName: "earned",
        args: [account, BigInt(tokenId)],
      });
    }
    const results = await publicClient.multicall({
      contracts: calls,
      allowFailure: true,
    });
    if (results[0].status === "success") walletRaw = results[0].result;
    else console.warn("[emissions] multicall balanceOf failed:", results[0].error?.message || "unknown");
    if (results.length > 1) {
      if (results[1].status === "success") claimableRaw = results[1].result;
      else console.warn("[emissions] multicall earned failed:", results[1].error?.message || "unknown");
    }
  } catch (mcErr) {
    console.warn("[emissions] multicall threw, falling back to sequential:", mcErr?.message || "unknown");
    // fallback sequential
    try {
      walletRaw = await publicClient.readContract({
        address: AERO_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      });
    } catch {}
    if (staked && gaugeAddress && tokenId != null) {
      try {
        claimableRaw = await publicClient.readContract({
          address: gaugeAddress,
          abi: CLGAUGE_ABI,
          functionName: "earned",
          args: [account, BigInt(tokenId)],
        });
      } catch (earnErr) {
        console.warn("[emissions] sequential earned failed:", earnErr?.message || "unknown");
      }
    }
  }

  return {
    claimableAero: Number(formatUnits(claimableRaw, 18)),
    walletAero: Number(formatUnits(walletRaw, 18)),
    updatedAtIso: new Date().toISOString(),
  };
}

// ── AERO price ───────────────────────────────────────────────────────────────

let _priceCache = { aeroUsd: 0, updatedAtIso: null, source: null };

export async function fetchAeroPrice(settings) {
  const refreshSec = settings?.emissions?.priceSource?.refreshSec ?? 900;
  if (
    _priceCache.updatedAtIso &&
    Date.now() - new Date(_priceCache.updatedAtIso).getTime() <
      refreshSec * 1000
  ) {
    return _priceCache;
  }

  try {
    const url =
      "https://api.geckoterminal.com/api/v2/networks/base/tokens/" +
      AERO_ADDRESS.toLowerCase();
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const priceStr = json?.data?.attributes?.price_usd;
    if (priceStr) {
      _priceCache = {
        aeroUsd: parseFloat(priceStr),
        updatedAtIso: new Date().toISOString(),
        source: "geckoterminal",
      };
    }
  } catch {
    // keep last known price
  }
  return _priceCache;
}

// ── Execution: stake NFT ─────────────────────────────────────────────────────

export async function stakeNft(
  walletClient,
  publicClient,
  npmAddress,
  gaugeAddress,
  tokenId,
  account,
  approvalMode,
  log,
) {
  const _log = log || (() => {});
  const txHashes = [];
  const tid = BigInt(tokenId);
  const accountAddress = typeof account === "string" ? account : account.address;

  // Check existing approval
  let approved = false;
  try {
    if (approvalMode === "approve_for_all") {
      approved = await publicClient.readContract({
        address: npmAddress,
        abi: ERC721_ABI,
        functionName: "isApprovedForAll",
        args: [accountAddress, gaugeAddress],
      });
    } else {
      const currentApproved = await publicClient.readContract({
        address: npmAddress,
        abi: ERC721_ABI,
        functionName: "getApproved",
        args: [tid],
      });
      approved =
        currentApproved &&
        currentApproved.toLowerCase() === gaugeAddress.toLowerCase();
    }
  } catch {
    // assume not approved
  }

  if (!approved) {
    _log("Approving NFT for gauge deposit…");
    let approveTx;
    if (approvalMode === "approve_for_all") {
      approveTx = await walletClient.writeContract({
        address: npmAddress,
        abi: ERC721_ABI,
        functionName: "setApprovalForAll",
        args: [gaugeAddress, true],
        account,
        chain: walletClient.chain,
      });
    } else {
      approveTx = await walletClient.writeContract({
        address: npmAddress,
        abi: ERC721_ABI,
        functionName: "approve",
        args: [gaugeAddress, tid],
        account,
        chain: walletClient.chain,
      });
    }
    txHashes.push(approveTx);
    await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 60_000 });
    _log(`Approval tx: ${approveTx}`);
  }

  // Deposit into gauge
  _log("Depositing NFT into gauge…");
  const depositTx = await walletClient.writeContract({
    address: gaugeAddress,
    abi: CLGAUGE_ABI,
    functionName: "deposit",
    args: [tid],
    account,
    chain: walletClient.chain,
  });
  txHashes.push(depositTx);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: depositTx,
    timeout: 60_000,
  });
  _log(`Deposit tx: ${depositTx}`);

  const gasUsed = receipt.gasUsed ?? 0n;
  const effectiveGasPrice = receipt.effectiveGasPrice ?? 0n;
  const gasCostWei = gasUsed * effectiveGasPrice;

  return {
    txHashes,
    gasCostWei,
    success: receipt.status === "success",
  };
}

// ── Execution: unstake NFT ───────────────────────────────────────────────────

export async function unstakeNft(
  walletClient,
  publicClient,
  gaugeAddress,
  tokenId,
  account,
  log,
  npmAddress,
) {
  const _log = log || (() => {});
  const tid = BigInt(tokenId);
  const accountAddress = typeof account === "string" ? account : account.address;

  // Record AERO balance before
  let aeroBefore = 0n;
  try {
    aeroBefore = await publicClient.readContract({
      address: AERO_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [accountAddress],
    });
  } catch {}

  _log("Withdrawing NFT from gauge…");
  const withdrawTx = await walletClient.writeContract({
    address: gaugeAddress,
    abi: CLGAUGE_ABI,
    functionName: "withdraw",
    args: [tid],
    account,
    chain: walletClient.chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: withdrawTx,
    timeout: 60_000,
  });
  _log(`Withdraw tx: ${withdrawTx}`);

  // Record AERO balance after
  let aeroAfter = 0n;
  try {
    aeroAfter = await publicClient.readContract({
      address: AERO_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [accountAddress],
    });
  } catch {}

  const aeroDelta = aeroAfter - aeroBefore;
  const aeroClaimed = Number(formatUnits(aeroDelta > 0n ? aeroDelta : 0n, 18));

  const gasUsed = receipt.gasUsed ?? 0n;
  const effectiveGasPrice = receipt.effectiveGasPrice ?? 0n;
  const gasCostWei = gasUsed * effectiveGasPrice;

  // Verify NFT still exists after withdrawal (gauge may burn it)
  // Retry with backoff to avoid false burn detection from RPC 429s/timeouts
  let nftExists = false;
  if (npmAddress && receipt.status === "success") {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
        const owner = await publicClient.readContract({
          address: npmAddress,
          abi: ERC721_ABI,
          functionName: "ownerOf",
          args: [tid],
        });
        nftExists = owner?.toLowerCase() === accountAddress.toLowerCase();
        break; // got a definitive answer
      } catch (err) {
        const msg = String(err?.message || err || "");
        // ERC721 revert = NFT genuinely doesn't exist
        if (msg.includes("ERC721") || msg.includes("nonexistent") || msg.includes("invalid token")) {
          _log(`ownerOf reverted with ERC721 error — NFT is genuinely burned`);
          nftExists = false;
          break;
        }
        // Network/RPC error — retry
        _log(`ownerOf check attempt ${attempt + 1}/3 failed (${msg.slice(0, 80)})`);
        if (attempt === 2) {
          // After 3 failed attempts, assume NFT exists (safe default)
          nftExists = true;
          _log("⚠ ownerOf check failed after 3 attempts (RPC issues) — assuming NFT exists");
        }
      }
    }
    _log(nftExists ? "NFT confirmed owned after withdraw" : "⚠ NFT no longer exists after withdraw (gauge burned it)");
  } else if (receipt.status === "success") {
    // No npmAddress provided — assume NFT exists (backwards compat)
    nftExists = true;
  }

  return {
    txHash: withdrawTx,
    gasCostWei,
    aeroClaimed,
    success: receipt.status === "success",
    nftExists,
  };
}

// ── Execution: claim rewards ─────────────────────────────────────────────────

export async function claimRewards(
  walletClient,
  publicClient,
  gaugeAddress,
  tokenId,
  account,
  log,
) {
  const _log = log || (() => {});
  const tid = BigInt(tokenId);
  const accountAddress = typeof account === "string" ? account : account.address;

  // Record AERO balance before
  let aeroBefore = 0n;
  try {
    aeroBefore = await publicClient.readContract({
      address: AERO_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [accountAddress],
    });
  } catch {}

  _log("Claiming AERO rewards…");
  const claimTx = await walletClient.writeContract({
    address: gaugeAddress,
    abi: CLGAUGE_ABI,
    functionName: "getReward",
    args: [tid],
    account,
    chain: walletClient.chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: claimTx,
    timeout: 60_000,
  });
  _log(`Claim tx: ${claimTx}`);

  // Record AERO balance after
  let aeroAfter = 0n;
  try {
    aeroAfter = await publicClient.readContract({
      address: AERO_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [accountAddress],
    });
  } catch {}

  const aeroDelta = aeroAfter - aeroBefore;
  const aeroClaimed = Number(formatUnits(aeroDelta > 0n ? aeroDelta : 0n, 18));

  const gasUsed = receipt.gasUsed ?? 0n;
  const effectiveGasPrice = receipt.effectiveGasPrice ?? 0n;
  const gasCostWei = gasUsed * effectiveGasPrice;

  return {
    txHash: claimTx,
    gasCostWei,
    aeroClaimed,
    success: receipt.status === "success",
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _noGaugeResult(reason, detail) {
  return {
    gaugeAddress: null,
    gaugeAlive: null,
    rewardToken: null,
    gaugeMeta: null,
    reason,
    detail: detail || null,
  };
}
