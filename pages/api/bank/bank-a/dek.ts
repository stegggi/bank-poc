import type { NextApiRequest, NextApiResponse } from "next";
import { put } from "@vercel/blob";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

const BANK: "bank-a" = "bank-a";

function isAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
}
function isBytes32(s: unknown): s is string {
  return typeof s === "string" && /^0x[a-fA-F0-9]{64}$/.test(s);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) return res.status(500).json({ error: "Missing BLOB_READ_WRITE_TOKEN in server env (.env.local). Restart dev server." });

    const { owner, moduleId, payload } = (req.body ?? {}) as any;
    if (!isAddress(owner)) return res.status(400).json({ error: "Invalid owner address." });
    if (!isBytes32(moduleId)) return res.status(400).json({ error: "Invalid moduleId (bytes32)." });
    if (!payload || typeof payload !== "object") return res.status(400).json({ error: "Missing payload object." });

    const pathname = `uc4/${BANK}/dek/${owner.toLowerCase()}/${moduleId.toLowerCase()}.json`;

    const result = await put(pathname, JSON.stringify(payload), {
      access: "public", // wrapped DEK (still needs private key)
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
      token,
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (e: any) {
    console.error("[bank-a/dek] error:", e);
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
}
