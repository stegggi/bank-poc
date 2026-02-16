import type { NextApiRequest, NextApiResponse } from "next";
import { getVmPortfolioCached } from "../../../lib/uc5/vmRuntime";

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  const data = await getVmPortfolioCached(3_000);
  res.setHeader("cache-control", "no-store");
  return res.status(200).json(data);
}
