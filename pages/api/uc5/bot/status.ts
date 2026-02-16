// pages/api/uc5/bot/status.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getVmStatusCached } from "../../../../lib/uc5/vmRuntime";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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

  try {
    const status = await getVmStatusCached(2_000);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(status);
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e ?? "unknown error");
    res.status(502).json({ error: "Failed to reach bot telemetry", detail });
  }
}
