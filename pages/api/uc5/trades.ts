import type { NextApiRequest, NextApiResponse } from "next";
import { fetchVm } from "../../../use-cases/uc5-perp-trading/lib/vmRuntime";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit ?? "10"), 10) || 10));
  const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
  try {
    const r = await fetchVm(`/uc5/trades?limit=${limit}&offset=${offset}`, { headers: { accept: "application/json" } }, 8000);
    if (!r.ok) throw new Error(`VM /uc5/trades ${r.status}`);
    const data = await r.json();
    res.setHeader("cache-control", "no-store");
    return res.status(200).json(data);
  } catch {
    res.setHeader("cache-control", "no-store");
    return res.status(200).json({ trades: [], total: 0, limit, offset });
  }
}
