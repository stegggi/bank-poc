// pages/api/uc5/config.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { Uc5ConfigSchema, type Uc5Config } from "../../../lib/uc5/types";
import { readJsonBlob, writeJsonBlob } from "../../../lib/uc5/blobStore";
import { verifyAdminSignature, normAddr } from "../../../lib/uc5/auth";

const CONFIG_PATH = "uc5/config.json";

function defaultConfig(): Uc5Config {
  const owner = process.env.UC5_OWNER_ADDRESS || process.env.NEXT_PUBLIC_UC5_OWNER_ADDRESS || "";
  return Uc5ConfigSchema.parse({
    ownerAddress: owner,
    etherealApiBase: "https://api.ethereal.trade",
    etherealArchiveBase: "https://archive.ethereal.trade",
    ticker: "BTCUSD",
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const cfg = await readJsonBlob<Uc5Config>(CONFIG_PATH, defaultConfig());
    return res.status(200).json(cfg);
  }

  if (req.method === "POST") {
    try {
      const body = req.body || {};
      const cfg = Uc5ConfigSchema.parse(body.config);

      const owner = cfg.ownerAddress || process.env.UC5_OWNER_ADDRESS || "";
      if (!owner) return res.status(400).json({ error: "Missing UC5_OWNER_ADDRESS" });

      const auth = body.auth || {};
      const v = verifyAdminSignature({
        owner,
        address: auth.address || "",
        signature: auth.signature || "",
        action: "SET_CONFIG",
        nonce: auth.nonce || "",
        issuedAt: Number(auth.issuedAt || 0),
        payload: cfg,
      });

      if (!v.ok) return res.status(403).json({ error: v.error || "Forbidden" });

      // normalize owner formatting
      (cfg as any).ownerAddress = normAddr(owner);

      await writeJsonBlob(CONFIG_PATH, cfg);
      return res.status(200).json({ ok: true });
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || "Bad request" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
