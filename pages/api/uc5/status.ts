// pages/api/uc5/status.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getVmStatusCached } from "../../../use-cases/uc5-perp-trading/lib/vmRuntime";

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  const status = await getVmStatusCached(2_000);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(status);
}
