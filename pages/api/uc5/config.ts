// pages/api/uc5/config.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { Uc5ConfigSchema, type Uc5Config } from "../../../lib/uc5/types";
import { verifyAdminSignature, normAddr } from "../../../lib/uc5/auth";
import { getVmConfigCached, postVmConfig } from "../../../lib/uc5/vmRuntime";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const cfg = await getVmConfigCached(15_000);
    res.setHeader("cache-control", "no-store");
    return res.status(200).json(cfg);
  }

  if (req.method === "POST") {
    try {
      const body = req.body || {};
      const current = await getVmConfigCached(15_000);
      const rawCfg = body.config;
      if (!rawCfg || typeof rawCfg !== "object" || Array.isArray(rawCfg)) {
        return res.status(400).json({ error: "Invalid config payload" });
      }

      const owner = current.ownerAddress || process.env.UC5_OWNER_ADDRESS || process.env.NEXT_PUBLIC_UC5_OWNER_ADDRESS || "";
      if (!owner) return res.status(400).json({ error: "Missing UC5_OWNER_ADDRESS" });

      const auth = body.auth || {};
      const v = verifyAdminSignature({
        owner,
        address: auth.address || "",
        signature: auth.signature || "",
        action: "SET_CONFIG",
        nonce: auth.nonce || "",
        issuedAt: Number(auth.issuedAt || 0),
        payload: rawCfg,
      });

      if (!v.ok) return res.status(403).json({ error: v.error || "Forbidden" });

      const cfg = Uc5ConfigSchema.parse({
        ...current,
        ...rawCfg,
      });

      // Keep owner stable; only owner wallet can update config.
      // Preserve signer-link state from current config so normal "Save settings"
      // cannot accidentally reset one-time LINK_SIGNER setup.
      const nextCfg: Uc5Config = {
        ...cfg,
        ownerAddress: normAddr(owner),
        botSignerAddress: current.botSignerAddress || "",
        botSignerLinked: Boolean(current.botSignerLinked),
        pollIntervalSeconds: Math.max(1, Math.round(Number(cfg.ingestIntervalSec || current.ingestIntervalSec || 0.5))),
        reassessIntervalSec: Number(cfg.inPositionReassessIntervalSec || current.inPositionReassessIntervalSec || 8),
        cooldownAfterCloseSec: Number(cfg.flipCooldownSec || current.flipCooldownSec || current.cooldownAfterCloseSec || 15),
        entryMakerPreferred: true,
        entryMarketFallbackEnabled: false,
        minExpectedMoveBps: 0,
        edgeCostMultiplier: 0,
        emergencyBreakoutEnabled: false,
      };

      await postVmConfig(nextCfg);
      return res.status(200).json({ ok: true });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Bad request";
      return res.status(400).json({ error: message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
