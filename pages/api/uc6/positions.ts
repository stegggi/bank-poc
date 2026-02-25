import type { NextApiRequest, NextApiResponse } from "next";
import { bestEffortRateLimit, getClientIp } from "../../../lib/uc6OwnerAuth";

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

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
    namespace: "uc6:positions",
    ip,
    limit: 120,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    res.setHeader("retry-after", String(rl.retryAfterSec));
    return res.status(429).json({ error: "Too many requests" });
  }

  const base = String(process.env.UC6_BOT_BASE_URL || "").replace(/\/+$/, "");
  if (!base) {
    return res.status(500).json({ error: "Missing UC6_BOT_BASE_URL" });
  }

  const page = Math.max(1, Number(req.query.page || 1) || 1);
  const pageSize = Math.max(1, Number(req.query.pageSize || 10) || 10);
  const upstreamUrl = `${base}/positions?page=${encodeURIComponent(String(page))}&pageSize=${encodeURIComponent(String(pageSize))}`;

  try {
    const upstream = await fetchWithTimeout(upstreamUrl, 10_000);
    const text = await upstream.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    res.setHeader("cache-control", "no-store");
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: "UC6 bot positions request failed",
        details: json,
      });
    }
    return res.status(200).json(json);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to fetch UC6 bot positions";
    return res.status(502).json({ error: message });
  }
}
