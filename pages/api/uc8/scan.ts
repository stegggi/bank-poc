import type { NextApiRequest, NextApiResponse } from "next";
import { detectChain } from "../../../use-cases/uc8-sof-verification/lib/chainDetect";
import { scanWallet } from "../../../use-cases/uc8-sof-verification/lib/multiChainScan";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const address = String((req.body && req.body.address) || "").trim();
  if (!address) {
    return res.status(400).json({ error: "address is required" });
  }

  const detection = detectChain(address);
  if (detection.chainFamily === "unknown") {
    return res.status(200).json({
      address,
      detection,
      scan: null,
      warning: "Unable to detect chain family for this address",
    });
  }

  try {
    const scan = await scanWallet(address);
    return res.status(200).json({ address, detection, scan });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Scan failed",
    });
  }
}
