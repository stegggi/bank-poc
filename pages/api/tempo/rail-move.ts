// pages/api/tempo/rail-move.ts
//
// UC8 · Task 3 / Step 7 — LIVE internal rail move (step 1 of the agent flow).
// POST { fromId, toId, amount } → moveOnRail(fromId, toId, amount) (tCHF transferWithMemo).
// This is the only LIVE leg of the agent run; the FX + local top-up are narrated client-side.
import type { NextApiRequest, NextApiResponse } from "next";
import { moveOnRail, SUB_ACCOUNTS, type SubId } from "../../../shared/lib/tempo-treasury";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  try {
    const { fromId, toId, amount } = (req.body || {}) as { fromId?: string; toId?: string; amount?: number };
    const ids = SUB_ACCOUNTS.map((s) => s.id) as string[];
    if (!fromId || !toId || !ids.includes(fromId) || !ids.includes(toId) || fromId === toId) {
      return res.status(400).json({ ok: false, error: `fromId/toId must be distinct sub-accounts (${ids.join(", ")})` });
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 10_000_000) {
      return res.status(400).json({ ok: false, error: "amount must be in (0, 10,000,000]" });
    }
    const m = await moveOnRail(fromId as SubId, toId as SubId, amt);
    return res.status(m.status === "success" ? 200 : 502).json({ ok: m.status === "success", ...m });
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    return res.status(502).json({ ok: false, error: err?.shortMessage || err?.message || String(e) });
  }
}
