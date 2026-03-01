import type { NextApiRequest, NextApiResponse } from "next";
import { getVmTradesSummaryCached } from "../../../lib/uc5/vmRuntime";

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  const raw = await getVmTradesSummaryCached(5_000);
  const data = {
    totalTrades: Number(raw.totalTrades || 0),
    winRate: Number(raw.winRate || 0),
    avgWin: Number(raw.avgWin || 0),
    avgLoss: Number(raw.avgLoss || 0),
    realizedPnlTotal: Number(raw.realizedPnlTotal || 0),
    realizedPnlToday: Number(raw.realizedPnlToday || 0),
    closedByRegimeEnd: Number(raw.closedByRegimeEnd || 0),
    closedByRegimeFlip: Number(raw.closedByRegimeFlip || 0),
    closedByConfidence: Number(raw.closedByConfidence || 0),
    closedByRiskLoop: Number(raw.closedByRiskLoop || 0),
    closedByOther: Number(raw.closedByOther || 0),
  };
  res.setHeader("cache-control", "no-store");
  return res.status(200).json(data);
}
