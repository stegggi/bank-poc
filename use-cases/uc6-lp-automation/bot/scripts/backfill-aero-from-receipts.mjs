#!/usr/bin/env node
/**
 * Backfills AERO rewards in lifecycle events by fetching on-chain tx receipts
 * and summing AERO Transfer events that credit the bot's account.
 *
 * The bot's previous unstake/claim path computed `aeroClaimed` from
 * balanceOf-before-vs-after — when the RPC reads failed, it recorded 0 even
 * though AERO was paid out on-chain. This script reads each EMISSIONS_UNSTAKE
 * and EMISSIONS_CLAIM tx receipt directly and writes corrections for any
 * event where the on-chain amount exceeds what was recorded.
 *
 * Usage:
 *   UC6_RPC_URL=https://… UC6_OWNER_ADDRESS=0x… \
 *     node backfill-aero-from-receipts.mjs \
 *       --events /opt/uc6-bot/events.jsonl \
 *       --corrections /opt/uc6-bot/corrections.json \
 *       [--aero-price 0.5] [--dry-run]
 *
 * Output: writes/merges corrections.json. Restart the bot after to apply.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import {
  createPublicClient,
  decodeEventLog,
  formatUnits,
  http,
} from "viem";
import { base } from "viem/chains";

const AERO_ADDRESS = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const AERO_TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
};

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, fallback = null) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
  };
  return {
    eventsPath: get("--events", "/opt/uc6-bot/events.jsonl"),
    correctionsPath: get("--corrections", "/opt/uc6-bot/corrections.json"),
    fallbackAeroPrice: Number(get("--aero-price", "0")) || null,
    dryRun: args.includes("--dry-run"),
  };
}

function maskRpcUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return "(unparseable rpc url)";
  }
}

function main() {
  const cfg = parseArgs();
  const rpcUrl =
    process.env.UC6_RPC_URL ||
    process.env.UC6_HTTP_ALCHEMY_URL ||
    process.env.UC6_HTTP_INFURA_URL ||
    process.env.UC6_HTTP_ANKR_URL ||
    process.env.UC6_HTTP_PUBLIC_URL ||
    "";
  const ownerAddress = process.env.UC6_OWNER_ADDRESS;
  if (!rpcUrl) {
    console.error("Missing RPC URL — set UC6_RPC_URL, UC6_HTTP_ALCHEMY_URL, UC6_HTTP_INFURA_URL, or UC6_HTTP_ANKR_URL");
    process.exit(1);
  }
  console.log(`Using RPC: ${maskRpcUrl(rpcUrl)}`);
  if (!ownerAddress || !/^0x[a-fA-F0-9]{40}$/.test(ownerAddress)) {
    console.error("Missing or invalid UC6_OWNER_ADDRESS env var");
    process.exit(1);
  }

  const recipient = ownerAddress.toLowerCase();
  const aeroAddrLower = AERO_ADDRESS.toLowerCase();

  if (!existsSync(cfg.eventsPath)) {
    console.error(`events file not found: ${cfg.eventsPath}`);
    process.exit(1);
  }

  const raw = readFileSync(cfg.eventsPath, "utf-8");
  const events = raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
  console.log(`Loaded ${events.length} events from ${cfg.eventsPath}`);

  const existingCorrections = existsSync(cfg.correctionsPath)
    ? (() => {
        try {
          const j = JSON.parse(readFileSync(cfg.correctionsPath, "utf-8"));
          return j?.corrections && typeof j.corrections === "object" ? j.corrections : {};
        } catch { return {}; }
      })()
    : {};

  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

  const targets = events.filter((ev) => {
    const t = String(ev.type || "");
    if (t !== "EMISSIONS_UNSTAKE" && t !== "EMISSIONS_CLAIM") return false;
    if (!Array.isArray(ev.txHashes) || ev.txHashes.length === 0) return false;
    return Boolean(ev.id);
  });
  console.log(`Found ${targets.length} EMISSIONS_UNSTAKE/CLAIM events with tx hashes`);

  const newCorrections = { ...existingCorrections };
  let fixed = 0;
  let unchanged = 0;
  let alreadyCorrect = 0;
  let receiptErrors = 0;

  return (async () => {
    for (let i = 0; i < targets.length; i++) {
      const ev = targets[i];
      const recordedAero = Number(ev.details?.aeroClaimed || 0);
      const recordedUsd = Number(ev.accounting?.rewardsUsd || 0);

      let totalAeroRaw = 0n;
      let receiptOk = false;
      for (const txHash of ev.txHashes) {
        try {
          const receipt = await client.getTransactionReceipt({ hash: txHash });
          receiptOk = true;
          for (const log of receipt.logs || []) {
            if (!log.address || log.address.toLowerCase() !== aeroAddrLower) continue;
            try {
              const decoded = decodeEventLog({
                abi: [AERO_TRANSFER_EVENT],
                data: log.data,
                topics: log.topics,
              });
              if (decoded.eventName !== "Transfer") continue;
              if (String(decoded.args.to).toLowerCase() !== recipient) continue;
              totalAeroRaw += BigInt(decoded.args.value ?? 0);
            } catch {
              // unrelated log
            }
          }
        } catch (err) {
          console.warn(
            `  [${i + 1}/${targets.length}] receipt fetch failed for tx=${txHash.slice(0, 10)}…: ${err?.shortMessage || err?.message || err}`
          );
          receiptErrors++;
        }
      }

      if (!receiptOk) continue;

      const onChainAero = Number(formatUnits(totalAeroRaw, 18));
      // Only correct when on-chain credit clearly exceeds what was recorded
      // (or the record had nothing while the chain shows AERO).
      if (onChainAero <= recordedAero + 1e-9) {
        if (recordedAero > 0 && recordedUsd > 0) alreadyCorrect++;
        else unchanged++;
        continue;
      }

      const priceFromEvent = Number(ev.details?.aeroPrice || 0);
      const priceToUse = priceFromEvent > 0 ? priceFromEvent : (cfg.fallbackAeroPrice || 0);
      if (!(priceToUse > 0)) {
        console.warn(
          `  [${i + 1}/${targets.length}] event ${ev.id.slice(0, 8)} has on-chain AERO=${onChainAero.toFixed(6)} ` +
          `but no price available (event aeroPrice=${priceFromEvent}, --aero-price not set) — skipping`
        );
        continue;
      }
      const newRewardsUsd = onChainAero * priceToUse;

      const existing = newCorrections[ev.id] || {};
      newCorrections[ev.id] = {
        ...existing,
        accounting: {
          ...(existing.accounting || {}),
          rewardsUsd: newRewardsUsd,
        },
        details: {
          ...(existing.details || {}),
          aeroClaimed: onChainAero,
          aeroPrice: priceToUse,
          backfillSource: "on_chain_receipt",
        },
      };
      fixed++;
      console.log(
        `  [${i + 1}/${targets.length}] event ${ev.id.slice(0, 8)} type=${ev.type} ` +
        `tokenId=${ev.tokenId || "?"}: recorded=${recordedAero.toFixed(6)} AERO ($${recordedUsd.toFixed(4)}) → ` +
        `on-chain=${onChainAero.toFixed(6)} AERO ($${newRewardsUsd.toFixed(4)})`
      );
    }

    console.log("\n── Summary ─────────────────────────────────────");
    console.log(`  Fixed (correction written):  ${fixed}`);
    console.log(`  Already correct:             ${alreadyCorrect}`);
    console.log(`  Unchanged (zero on-chain):   ${unchanged}`);
    console.log(`  Receipt fetch errors:        ${receiptErrors}`);
    console.log(`  Total corrections in file:   ${Object.keys(newCorrections).length}`);

    if (cfg.dryRun) {
      console.log("\n--dry-run set — no file written.");
      return;
    }

    const output = {
      version: 1,
      generatedAtIso: new Date().toISOString(),
      corrections: newCorrections,
    };
    writeFileSync(cfg.correctionsPath, JSON.stringify(output, null, 2));
    console.log(`\nWrote ${cfg.correctionsPath}. Restart the bot to apply corrections during replay.`);
  })();
}

main().catch((err) => {
  console.error("backfill failed:", err);
  process.exit(1);
});
