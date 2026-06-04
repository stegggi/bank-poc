// pages/api/tempo/treasury.ts
//
// UC8 · Task 3 / Step 6 — read-only live treasury state for the Act 2 console.
// Returns each sub-account's on-rail tCHF balance (HQ/FRA/NYC/LAG). No keys are used.
import type { NextApiRequest, NextApiResponse } from "next";
import { getTreasuryState } from "../../../shared/lib/tempo-treasury";

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const state = await getTreasuryState();
    res.status(200).json({ ok: true, ...state });
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    res.status(502).json({ ok: false, error: err?.shortMessage || err?.message || String(e) });
  }
}
