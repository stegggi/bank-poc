// pages/api/tempo/act1-send.ts
//
// UC8 · Task 3 / Step 4 — Act 1 live settlement leg.
// Seals an (off-chain) travel-rule envelope, commits its keccak256 hash as the 32-byte memo,
// and performs a LIVE mUSDC transferWithMemo on the allowlisted rail (A -> B from task 2).
// Identity data never goes on-chain — only the commitment hash does.
//
// The on-chain recipient is the allowlisted demo address B (mUSDC enforces the TIP-403
// whitelist). The human-facing recipient name is display-only.
import type { NextApiRequest, NextApiResponse } from "next";
import type { Address } from "viem";
import { MUSDC_ADDRESS } from "../../../shared/lib/tempo";
import { commitMemo, sendWithMemo, explorerTx } from "../../../shared/lib/tempo-server";

const CORRIDOR_CCY: Record<string, string> = { NG: "NGN", US: "USD", EU: "EUR" };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  try {
    const { amountCHF, corridor = "NG", recipientName = "Recipient", purpose = "Family support" } = (req.body || {}) as {
      amountCHF?: number; corridor?: string; recipientName?: string; purpose?: string;
    };
    const amt = Number(amountCHF);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000) {
      return res.status(400).json({ ok: false, error: "amountCHF must be a number in (0, 1,000,000]" });
    }
    const musdc = MUSDC_ADDRESS as Address;
    if (!musdc) return res.status(500).json({ ok: false, error: "TEMPO_MUSDC_ADDRESS not set — run scripts/tempo-factory-policy.mjs (task 2)" });
    const railRecipient = (process.env.TEMPO_PARTY_B_ADDRESS || "").trim() as Address;
    if (!railRecipient) return res.status(500).json({ ok: false, error: "TEMPO_PARTY_B_ADDRESS not set — run scripts/tempo-factory-policy.mjs (task 2)" });

    // 1) Seal the travel-rule envelope OFF-CHAIN (AMLO-FINMA Art. 10 minimum fields). In production
    //    this is HPKE-encrypted to the recipient bank's key (see UC2). Here we commit its hash.
    const ref = `LIMMAT-CH${corridor}-${Date.now().toString(36).toUpperCase()}`;
    const envelope = {
      originator: { name: "Amara Okafor", bank: "Limmat Bank (CH)", account: "CH93-LIMM-****-2031" },
      beneficiary: { name: recipientName, ccy: CORRIDOR_CCY[corridor] || "—" },
      purpose,
      corridor: `CH→${corridor}`,
      amountCHF: amt,
      ref,
      ts: new Date().toISOString(),
    };
    const memo = commitMemo(envelope); // 32-byte keccak256 commitment -> goes on-chain

    // 2) LIVE settlement on the mUSDC rail (1 mUSDC ≈ 1 CHF for the demo // VERIFY: no FX here).
    const units = BigInt(Math.round(amt)) * BigInt(1_000_000); // 6 decimals
    const r = await sendWithMemo(musdc, railRecipient, units, memo);

    return res.status(200).json({
      ok: true,
      hash: r.hash,
      explorer: explorerTx(r.hash),
      memo,
      status: r.status,
      elapsedMs: r.elapsedMs,
      blockNumber: r.blockNumber,
      amountMUSDC: amt,
      token: musdc,
      railRecipient,
      // non-sensitive summary of what was sealed (identity stays off-chain; values are synthetic demo data)
      envelope: { originator: envelope.originator.name, beneficiary: envelope.beneficiary.name, purpose, ref, corridor: envelope.corridor },
    });
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    return res.status(502).json({ ok: false, error: err?.shortMessage || err?.message || String(e) });
  }
}
