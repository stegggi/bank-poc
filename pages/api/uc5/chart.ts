import type { NextApiRequest, NextApiResponse } from "next";
import { getVmChartCached } from "../../../use-cases/uc5-perp-trading/lib/vmRuntime";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const range = typeof req.query.range === "string" ? req.query.range : "24h";
  const resolution = typeof req.query.resolution === "string" ? req.query.resolution : "1m";
  const data = await getVmChartCached(range, resolution, 4_000);
  res.setHeader("cache-control", "no-store");
  return res.status(200).json(data);
}
