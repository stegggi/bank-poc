import type { NextApiRequest, NextApiResponse } from "next";
import { verifySignature } from "../../../use-cases/uc7-sow-verification/lib/ownershipChallenge";
import { readChallenge, updateChallenge } from "../../../use-cases/uc7-sow-verification/lib/challengeStore";
import { readCase, writeCase } from "../../../use-cases/uc7-sow-verification/lib/caseStore";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const body = req.body || {};
  const challengeId = String(body.challengeId || "").trim();
  const signature = String(body.signature || "").trim();
  const publicKey = body.publicKey ? String(body.publicKey) : undefined;

  if (!challengeId || !signature) {
    return res.status(400).json({ error: "challengeId and signature are required" });
  }

  const challenge = await readChallenge(challengeId);
  if (!challenge) return res.status(404).json({ error: "Challenge not found" });

  const result = await verifySignature(challenge, signature, { publicKey });

  const updated = {
    ...challenge,
    signature,
    status: result.ok ? ("verified" as const) : ("failed" as const),
    verifiedAt: result.ok ? new Date().toISOString() : undefined,
    failReason: result.ok ? undefined : result.error,
  };
  await updateChallenge(updated);

  // Mirror to case file
  const caseFile = await readCase(challenge.caseReference);
  if (caseFile) {
    const wallet = caseFile.wallets.find(
      (w) => w.address.toLowerCase() === challenge.address.toLowerCase()
    );
    if (wallet) {
      wallet.challenge = updated;
      await writeCase(caseFile);
    }
  }

  return res.status(200).json({ result, challenge: updated });
}
