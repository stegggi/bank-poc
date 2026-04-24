import type { NextApiRequest, NextApiResponse } from "next";
import { readChallenge } from "../../../../use-cases/uc7-sow-verification/lib/challengeStore";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const id = String(req.query.id || "");
  const ch = await readChallenge(id);
  if (!ch) return res.status(404).json({ error: "Challenge not found" });
  return res.status(200).json({ challenge: ch });
}
