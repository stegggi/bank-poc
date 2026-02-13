import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Ethereal linked signer concept + message signing uses domain/signatureTypes from /v1/rpc/config :contentReference[oaicite:8]{index=8}
    const base = process.env.UC5_ETHEREAL_API_BASE || "https://api.ethereal.trade";

    const {
      subaccountId,
      sender,
      signer,
      subaccount,
      nonce,
      signedAt,
      signature,
      signerSignature,
    } = req.body || {};

    if (!subaccountId || !sender || !signer || !subaccount || !nonce || !signedAt || !signature || !signerSignature) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const r = await fetch(`${base}/v1/linked-signer/link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subaccountId,
        sender,
        signer,
        subaccount,
        nonce,
        signedAt,
        signature,
        signerSignature,
      }),
    });

    const out = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: out?.message || out?.error || "Link signer failed", out });

    return res.status(200).json(out);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
