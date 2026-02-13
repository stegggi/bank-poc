// pages/api/uc5/bot/status.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { writeJsonBlob } from "../../../../lib/uc5/blobStore";
import type { Uc5Status } from "../../../../lib/uc5/types";

const STATUS_PATH = "uc5/status.json";

function requireBotToken(req: NextApiRequest) {
  const expected = process.env.UC5_BOT_TOKEN || "";
  const got = String(req.headers["x-uc5-bot-token"] || "");
  return expected && got && got === expected;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!requireBotToken(req)) return res.status(403).json({ error: "Forbidden" });

  const status = (req.body || {}) as Uc5Status;
  status.updatedAt = Date.now();
  await writeJsonBlob(STATUS_PATH, status);
  return res.status(200).json({ ok: true });
}
