import type { NextApiRequest, NextApiResponse } from "next";
import { getVmConfigCached } from "../../../use-cases/uc5-perp-trading/lib/vmRuntime";

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const cfg = await getVmConfigCached(15_000);
    const base = cfg.etherealApiBase || "https://api.ethereal.trade";
    const ticker = cfg.ticker || "BTCUSD";
    const owner = cfg.ownerAddress || process.env.UC5_OWNER_ADDRESS || process.env.NEXT_PUBLIC_UC5_OWNER_ADDRESS || "";
    const subaccountId = cfg.subaccountId || "";

    // product by ticker
    const pr = await fetch(`${base}/v1/product?ticker=${encodeURIComponent(ticker)}`, { cache: "no-store" });
    const pj = await pr.json();
    const product = pj?.data?.[0] || null;
    const productId = product?.id;

    // market price array endpoint
    let market: unknown = null;
    if (productId) {
      const params = new URLSearchParams();
      params.append("productIds", productId);
      const mr = await fetch(`${base}/v1/product/market-price?${params.toString()}`, { cache: "no-store" });
      const mj = await mr.json();
      market = mj?.data?.[0] || null;
    }

    // points summary (public)
    let points: unknown = null;
    if (owner) {
      const rr = await fetch(`${base}/v1/points/summary?address=${encodeURIComponent(owner)}`, { cache: "no-store" });
      const rj = await rr.json().catch(() => null);
      // Normalize: pick the first season summary if present
      if (rj?.data?.length) {
        const s = rj.data[0];
        points = { season: s.season, totalPoints: s.totalPoints, breakdown: s.breakdown || null };
      }
    }

    // (Optional) subaccount balances (may be restricted; fail silently)
    let balances: unknown = null;
    if (subaccountId) {
      try {
        const br = await fetch(`${base}/v1/subaccount/balance?subaccountId=${encodeURIComponent(subaccountId)}`, { cache: "no-store" });
        const bj = await br.json();
        balances = bj?.data || null;
      } catch {}
    }

    res.setHeader("cache-control", "no-store");
    return res.status(200).json({ product, market, points, balances });
  } catch (e: unknown) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "Failed to load state" });
  }
}
