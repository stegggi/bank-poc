import type { NextApiRequest, NextApiResponse } from "next";
import { traceBackward } from "../../../use-cases/uc8-sof-verification/lib/backwardTrace";
import { readCase, writeCase } from "../../../use-cases/uc8-sof-verification/lib/caseStore";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};
  const caseReference = String(body.caseReference || "").trim();
  const address = String(body.address || "").trim();
  const chainOverride = body.chain ? String(body.chain) : undefined;

  if (!caseReference || !address) {
    return res.status(400).json({ error: "caseReference and address are required" });
  }

  const caseFile = readCase(caseReference);
  if (!caseFile) return res.status(404).json({ error: "Case not found" });
  const wallet = caseFile.wallets.find(
    (w) => w.address.toLowerCase() === address.toLowerCase()
  );
  if (!wallet) return res.status(404).json({ error: "Wallet not found in case" });

  // Determine chain: explicit override, wallet.primaryChain, first active scan, or chain family
  const chain =
    chainOverride ||
    wallet.primaryChain ||
    wallet.scan?.chains.find((c) => c.hasActivity)?.chain ||
    (wallet.chainFamily === "bitcoin"
      ? "bitcoin"
      : wallet.chainFamily === "solana"
      ? "solana"
      : "ethereum");

  try {
    const trace = await traceBackward(address, chain, {
      maxHopDepth: caseFile.settings.maxHopDepth,
    });
    wallet.trace = trace;
    wallet.primaryChain = chain;
    writeCase(caseFile);
    return res.status(200).json({ trace });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Trace failed",
    });
  }
}
