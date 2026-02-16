import type { NextApiRequest, NextApiResponse } from "next";
import { verifyAdminSignature } from "../../../lib/uc5/auth";
import { getVmConfigCached, getVmIngestionCached, postVmConfig } from "../../../lib/uc5/vmRuntime";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const status = await getVmIngestionCached(2_000);
    res.setHeader("cache-control", "no-store");
    return res.status(200).json(status);
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
        action: "SET_INGESTION",
        nonce: auth.nonce || "",
        issuedAt: Number(auth.issuedAt || 0),
        payload,
      });
      if (!v.ok) return res.status(403).json({ error: v.error || "Forbidden" });

      const nextCfg = { ...cfg, ingestionEnabled: enabled };
      await postVmConfig(nextCfg);
      return res.status(200).json({ ok: true, ingestionEnabled: enabled });
    } catch (e: unknown) {
      return res.status(400).json({ error: e instanceof Error ? e.message : "Bad request" });
    }
  }

  res.setHeader("allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
