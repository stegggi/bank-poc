// pages/api/uc5/bot/status.ts
import type { NextApiRequest, NextApiResponse } from "next";

function withTimeout(ms: number) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { controller, id };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const base = (process.env.UC5_BOT_TELEMETRY_URL || "").replace(/\/+$/, "");
  if (!base) {
    res.status(500).json({ error: "Missing env UC5_BOT_TELEMETRY_URL on Vercel" });
    return;
  }

  // We only support GET for the UI. POST is accepted but ignored (compat during rollout).
  if (req.method === "POST") {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { controller, id } = withTimeout(8000);
  try {
    const r = await fetch(`${base}/status`, {
      method: "GET",
      signal: controller.signal,
      headers: { "accept": "application/json" },
    });

    const text = await r.text();
    res.setHeader("Cache-Control", "no-store");
    res.status(r.status).send(text);
  } catch (e: any) {
    res.status(502).json({ error: "Failed to reach bot telemetry", detail: String(e?.message || e) });
  } finally {
    clearTimeout(id);
  }
}
