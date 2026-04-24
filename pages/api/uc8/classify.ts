import type { NextApiRequest, NextApiResponse } from "next";
import { classifyTrace, aggregateRisk } from "../../../use-cases/uc8-sof-verification/lib/riskClassifier";
import { readCase, writeCase } from "../../../use-cases/uc8-sof-verification/lib/caseStore";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};
  const caseReference = String(body.caseReference || "").trim();
  const address = body.address ? String(body.address).trim() : undefined;

  if (!caseReference) {
    return res.status(400).json({ error: "caseReference is required" });
  }

  const caseFile = readCase(caseReference);
  if (!caseFile) return res.status(404).json({ error: "Case not found" });

  const wallets = address
    ? caseFile.wallets.filter((w) => w.address.toLowerCase() === address.toLowerCase())
    : caseFile.wallets;

  for (const w of wallets) {
    if (!w.trace) continue;
    w.classification = classifyTrace(w.trace, {
      greenThreshold: caseFile.settings.greenThreshold,
      amberThreshold: caseFile.settings.amberThreshold,
    });
  }

  caseFile.overallRisk = aggregateRisk(caseFile.wallets.map((w) => w.classification));
  caseFile.status = "classified";
  writeCase(caseFile);

  return res.status(200).json({
    classifications: wallets.map((w) => ({
      address: w.address,
      classification: w.classification,
    })),
    overallRisk: caseFile.overallRisk,
  });
}
