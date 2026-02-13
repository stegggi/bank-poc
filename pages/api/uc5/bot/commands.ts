// pages/api/uc5/bot/commands.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { readJsonBlob, writeJsonBlob } from "../../../../lib/uc5/blobStore";
import type { Uc5Command } from "../../../../lib/uc5/types";

const COMMANDS_PATH = "uc5/commands.json";

type CommandsFile = { commands: Uc5Command[] };

function requireBotToken(req: NextApiRequest) {
  const expected = process.env.UC5_BOT_TOKEN || "";
  const got = String(req.headers["x-uc5-bot-token"] || "");
  return expected && got && got === expected;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!requireBotToken(req)) return res.status(403).json({ error: "Forbidden" });

  const file = await readJsonBlob<CommandsFile>(COMMANDS_PATH, { commands: [] });

  if (req.method === "GET") {
    return res.status(200).json(file);
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const updates: Array<{ id: string; status: "DONE" | "ERROR"; result?: any }> = body.updates || [];

    const map = new Map(updates.map((u) => [u.id, u]));
    const next = file.commands.map((c) => {
      const u = map.get(c.id);
      if (!u) return c;
      return { ...c, status: u.status, result: u.result } as any;
    });

    await writeJsonBlob(COMMANDS_PATH, { commands: next });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
