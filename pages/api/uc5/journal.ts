import type { NextApiRequest, NextApiResponse } from "next";
import { list, put } from "@vercel/blob";

const KEY = "uc5/journal.json";

async function readJsonFromBlob(key: string) {
  const res = await list({ prefix: key });
  const match = res.blobs.find((b) => b.pathname === key);
  if (!match?.url) return null;

  const r = await fetch(match.url, { cache: "no-store" });
  if (!r.ok) return null;
  return await r.json();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === "GET") {
      const stored = await readJsonFromBlob(KEY);
      res.setHeader("cache-control", "no-store");
      return res.status(200).json(stored || { updatedAt: 0, events: [] });
    }

    if (req.method === "POST") {
      const token = process.env.UC5_BOT_TOKEN || "";
      const got = String(req.headers["x-uc5-bot-token"] || "");
      if (!token) return res.status(500).json({ error: "Missing UC5_BOT_TOKEN env var." });
      if (got !== token) return res.status(403).json({ error: "Bad bot token." });

      const body = req.body || {};
      const payload = {
        updatedAt: Date.now(),
        events: Array.isArray(body.events) ? body.events : [],
      };

      await put(KEY, new Blob([JSON.stringify(payload)], { type: "application/json" }), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
      });

      res.setHeader("cache-control", "no-store");
      return res.status(200).json({ ok: true });
    }

    res.setHeader("allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
