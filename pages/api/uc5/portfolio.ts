import type { NextApiRequest, NextApiResponse } from "next";
import { getVmPortfolioCached } from "../../../lib/uc5/vmRuntime";

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  const raw = await getVmPortfolioCached(3_000);
  const data = {
    ...raw,
    usedMarginUsd: raw.usedMarginUsd ?? 0,
    usedMarginPct: raw.usedMarginPct ?? 0,
    unrealizedPnl: raw.unrealizedPnl ?? 0,
    realizedPnlToday: raw.realizedPnlToday ?? 0,
    realizedPnlTotal: raw.realizedPnlTotal ?? 0,
  };
  res.setHeader("cache-control", "no-store");
  return res.status(200).json(data);
}
