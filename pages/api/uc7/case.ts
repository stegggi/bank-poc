import type { NextApiRequest, NextApiResponse } from "next";
import {
  createCase,
  generateCaseReference,
  listCases,
} from "../../../use-cases/uc7-sow-verification/lib/caseStore";
import type { CaseFile, CaseSettings } from "../../../use-cases/uc7-sow-verification/lib/types";

const DEFAULT_SETTINGS: CaseSettings = {
  // Hop 1 only by default — Etherscan-style flat list of incoming transfers.
  // Override with MAX_HOP_DEPTH if you want recursive drill-down later.
  maxHopDepth: Number(process.env.MAX_HOP_DEPTH || 1),
  greenThreshold: 0.9,
  amberThreshold: 0.6,
  ttpProvider: (process.env.TTP_PROVIDER as CaseSettings["ttpProvider"]) || "mock",
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const summaries = await listCases();
    return res.status(200).json({ cases: summaries });
  }

  if (req.method === "POST") {
    const body = (req.body || {}) as Partial<CaseFile>;
    const clientName = String(body.clientName || "").trim();
    if (!clientName) {
      return res.status(400).json({ error: "clientName is required" });
    }
    const caseReference = body.caseReference || generateCaseReference();
    const file = await createCase({
      caseReference,
      clientName,
      wallets: [],
      settings: { ...DEFAULT_SETTINGS, ...(body.settings || {}) },
    });
    return res.status(201).json({ case: file });
  }

  res.setHeader("allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
