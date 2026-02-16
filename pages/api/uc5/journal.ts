import type { NextApiRequest, NextApiResponse } from "next";

type JournalState = { updatedAt: number; events: unknown[] };
const g = globalThis as typeof globalThis & { __uc5JournalState?: JournalState };

function getJournalState(): JournalState {
  if (!g.__uc5JournalState) g.__uc5JournalState = { updatedAt: 0, events: [] };
  return g.__uc5JournalState;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === "GET") {
      res.setHeader("cache-control", "no-store");
      return res.status(200).json(getJournalState());
    }

    if (req.method === "POST") {
      const token = process.env.UC5_BOT_TOKEN || "";
      const got = String(req.headers["x-uc5-bot-token"] || "");
      if (!token) return res.status(500).json({ error: "Missing UC5_BOT_TOKEN env var." });
      if (got !== token) return res.status(403).json({ error: "Bad bot token." });

      const body = req.body || {};
      const nextEvents = Array.isArray(body.events) ? body.events.slice(-500) : [];
      const payload = {
        updatedAt: Date.now(),
        events: nextEvents,
      };

      g.__uc5JournalState = payload;

      res.setHeader("cache-control", "no-store");
      return res.status(200).json({ ok: true });
    }

    res.setHeader("allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e: unknown) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "Server error" });
  }
}
