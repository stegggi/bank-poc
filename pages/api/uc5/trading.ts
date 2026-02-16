import type { NextApiRequest, NextApiResponse } from "next";
import { verifyAdminSignature } from "../../../lib/uc5/auth";
import { getVmConfigCached, getVmStatusCached, getVmTradingCached, postVmCommand, postVmConfig } from "../../../lib/uc5/vmRuntime";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const trading = await getVmTradingCached(2_000);
    res.setHeader("cache-control", "no-store");
    return res.status(200).json(trading);
  }

  if (req.method === "POST") {
    try {
      const body = req.body || {};
      const enabled = Boolean(body.enabled);
      const cfg = await getVmConfigCached(15_000);
      const owner = cfg.ownerAddress || process.env.UC5_OWNER_ADDRESS || process.env.NEXT_PUBLIC_UC5_OWNER_ADDRESS || "";
      if (!owner) return res.status(400).json({ error: "Missing UC5 owner address" });

      const auth = body.auth || {};
      const payload = { enabled };
      const v = verifyAdminSignature({
        owner,
        address: auth.address || "",
        signature: auth.signature || "",
        action: "SET_TRADING",
        nonce: auth.nonce || "",
        issuedAt: Number(auth.issuedAt || 0),
        payload,
      });
      if (!v.ok) return res.status(403).json({ error: v.error || "Forbidden" });

      let flattened = false;
      if (!enabled) {
        const s0 = await getVmStatusCached(250);
        if (s0.position?.open) {
          await postVmCommand({ type: "FLATTEN" });
          const started = Date.now();
          while (Date.now() - started < 25_000) {
            await sleep(1_000);
            const sx = await getVmStatusCached(250);
            if (!sx.position?.open) {
              flattened = true;
              break;
            }
          }
        } else {
          flattened = true;
        }
        if (!flattened) {
          return res.status(409).json({ error: "Could not confirm position close. Trading remains enabled." });
        }
      }

      const nextCfg = { ...cfg, tradingEnabled: enabled };
      await postVmConfig(nextCfg);
      return res.status(200).json({ ok: true, tradingEnabled: enabled, flattened });
    } catch (e: unknown) {
      return res.status(400).json({ error: e instanceof Error ? e.message : "Bad request" });
    }
  }

  res.setHeader("allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
