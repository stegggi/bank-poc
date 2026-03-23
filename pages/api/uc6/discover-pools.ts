import type { NextApiRequest, NextApiResponse } from "next";
import {
  bestEffortRateLimit,
  getClientIp,
} from "../../../use-cases/uc6-lp-automation/lib/uc6OwnerAuth";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const ip = getClientIp({
    headers: req.headers as Record<string, string | string[] | undefined>,
    remoteAddress: req.socket.remoteAddress,
  });
  const rl = bestEffortRateLimit({
    namespace: "uc6:discover-pools",
    ip,
    limit: 2,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    res.setHeader("retry-after", String(rl.retryAfterSec));
    return res.status(429).json({ error: "Too many requests" });
  }

  const base = String(process.env.UC6_BOT_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return res.status(500).json({ error: "Missing UC6_BOT_BASE_URL" });

  const { tokenA, tokenB } = req.query;
  if (!tokenA || !tokenB) return res.status(400).json({ error: "tokenA and tokenB required" });

  try {
    const url = `${base}/discover-pools?tokenA=${encodeURIComponent(String(tokenA))}&tokenB=${encodeURIComponent(String(tokenB))}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const r = await fetch(url, {
        headers: { accept: "application/json" },
        signal: controller.signal,
        cache: "no-store",
      });
      const text = await r.text();
      let json: unknown = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      res.setHeader("cache-control", "no-store");
      return res.status(r.ok ? 200 : r.status).json(json);
    } finally {
      clearTimeout(timer);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to discover pools";
    return res.status(502).json({ error: message });
  }
}
