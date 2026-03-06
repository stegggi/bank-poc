// pages/api/uc5/bot/commands.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getVmCommands, postVmCommandUpdates } from "../../../../use-cases/uc5-perp-trading/lib/vmRuntime";

function requireBotToken(req: NextApiRequest) {
  const expected = process.env.UC5_BOT_TOKEN || "";
  const got = String(req.headers["x-uc5-bot-token"] || "");
  return expected && got && got === expected;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!requireBotToken(req)) return res.status(403).json({ error: "Forbidden" });

  if (req.method === "GET") {
    const file = await getVmCommands();
    return res.status(200).json(file);
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const updates: Array<{ id: string; status: "DONE" | "ERROR"; result?: unknown }> = body.updates || [];
    await postVmCommandUpdates(updates);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
