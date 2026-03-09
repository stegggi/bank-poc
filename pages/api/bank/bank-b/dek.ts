import type { NextApiRequest, NextApiResponse } from "next";
import { put } from "@vercel/blob";
import { recordUc4Write } from "../../../../shared/lib/uc4/blobMetrics";
import { getUc4BlobRefs, saveUc4BlobRefs } from "../../../../shared/lib/uc4/blobRefStore";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

const BANK = "bank-b" as const;

function isAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
}
function isBytes32(s: unknown): s is string {
  return typeof s === "string" && /^0x[a-fA-F0-9]{64}$/.test(s);
}
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) return res.status(500).json({ error: "Missing BLOB_READ_WRITE_TOKEN in server env (.env.local). Restart dev server." });

    const body = (req.body ?? {}) as { owner?: unknown; moduleId?: unknown; payload?: unknown };
    const owner = body.owner;
    const moduleId = body.moduleId;
    const payload = body.payload;
    if (!isAddress(owner)) return res.status(400).json({ error: "Invalid owner address." });
    if (!isBytes32(moduleId)) return res.status(400).json({ error: "Invalid moduleId (bytes32)." });
    if (!payload || typeof payload !== "object") return res.status(400).json({ error: "Missing payload object." });

    const ownerLc = owner.toLowerCase();
    const moduleIdLc = moduleId.toLowerCase();
    const pathname = `uc4/${BANK}/dek/${ownerLc}/${moduleIdLc}.json`;

    const result = await put(pathname, JSON.stringify(payload), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
      token,
    });
    const existing = await getUc4BlobRefs(BANK, ownerLc, moduleIdLc);
    await saveUc4BlobRefs({
      bank: BANK,
      owner: ownerLc,
      moduleId: moduleIdLc,
      bundleUrl: existing?.bundleUrl,
      contextUrl: existing?.contextUrl,
      dekUrl: result.url,
    });
    recordUc4Write(BANK, "legacy_dek_put");

    return res.status(200).json({ ok: true, ...result });
  } catch (e: unknown) {
    console.error("[bank-b/dek] error:", e);
    return res.status(500).json({ error: errorMessage(e) });
  }
}
