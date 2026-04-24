import type { NextApiRequest, NextApiResponse } from "next";
import { generateChallenge } from "../../../use-cases/uc7-sow-verification/lib/ownershipChallenge";
import { saveChallenge } from "../../../use-cases/uc7-sow-verification/lib/challengeStore";
import { readCase, writeCase } from "../../../use-cases/uc7-sow-verification/lib/caseStore";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};
  const caseReference = String(body.caseReference || "").trim();
  const address = String(body.address || "").trim();
  if (!caseReference || !address) {
    return res.status(400).json({ error: "caseReference and address are required" });
  }

  const caseFile = await readCase(caseReference);
  if (!caseFile) {
    return res.status(404).json({ error: "Case not found" });
  }
  const wallet = caseFile.wallets.find(
    (w) => w.address.toLowerCase() === address.toLowerCase()
  );
  if (!wallet) {
    return res.status(404).json({ error: "Wallet not found in case" });
  }

  const challenge = generateChallenge({ caseReference, address });
  await saveChallenge(challenge);
  wallet.challenge = challenge;
  await writeCase(caseFile);

  return res.status(200).json({ challenge });
}
