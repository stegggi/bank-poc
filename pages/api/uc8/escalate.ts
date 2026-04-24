import type { NextApiRequest, NextApiResponse } from "next";
import { escalateAddress } from "../../../use-cases/uc8-sof-verification/lib/ttpEscalation";
import { readCase, writeCase } from "../../../use-cases/uc8-sof-verification/lib/caseStore";

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

  const caseFile = readCase(caseReference);
  if (!caseFile) return res.status(404).json({ error: "Case not found" });
  const wallet = caseFile.wallets.find(
    (w) => w.address.toLowerCase() === address.toLowerCase()
  );
  if (!wallet) return res.status(404).json({ error: "Wallet not found" });

  const chain =
    wallet.primaryChain ||
    wallet.scan?.chains.find((c) => c.hasActivity)?.chain ||
    "ethereum";

  try {
    const report = await escalateAddress(address, chain);
    wallet.ttp = report;
    caseFile.status = "escalated";
    writeCase(caseFile);
    return res.status(200).json({ report });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Escalation failed",
    });
  }
}
