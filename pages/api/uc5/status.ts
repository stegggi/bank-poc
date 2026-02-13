// pages/api/uc5/status.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { readJsonBlob } from "../../../lib/uc5/blobStore";
import type { Uc5Status } from "../../../lib/uc5/types";

const STATUS_PATH = "uc5/status.json";

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  const fallback: Uc5Status = {
    updatedAt: Date.now(),
    bot: { alive: false, message: "No status yet (bot not posting)." },
  };

  const status = await readJsonBlob<Uc5Status>(STATUS_PATH, fallback);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(status);
}
