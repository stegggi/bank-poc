import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const base = process.env.UC5_ETHEREAL_API_BASE || "https://api.ethereal.trade";
    const r = await fetch(`${base}/v1/rpc/config`, { cache: "no-store" });
    const j = await r.json();
    res.setHeader("cache-control", "no-store");
    return res.status(200).json(j);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Failed to fetch rpc config" });
  }
}
