// pages/api/hpke-open.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { webcrypto } from "crypto";
import { hpkeOpenEnvelopeHexToJson, type Hex } from "../../lib/hpke";

export const config = {
  api: { bodyParser: { sizeLimit: "2mb" } },
};

// Base64url decode for Node (server only).
const b64urlToBytes = (s: string) => {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 === 0 ? "" : "=".repeat(4 - (norm.length % 4));
  const buf = Buffer.from(norm + pad, "base64");
  return new Uint8Array(buf);
};

const ensureWebCrypto = () => {
  // In some Node/Next runtimes, globalThis.crypto may not be set.
  const g: any = globalThis as any;
  if (!g.crypto?.subtle && (webcrypto as any)?.subtle) {
    g.crypto = webcrypto as any;
  }
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    ensureWebCrypto();

    const { payloadHex, txRef } = (req.body || {}) as {
      payloadHex?: Hex;
      txRef?: Hex;
    };

    if (!payloadHex || typeof payloadHex !== "string" || !payloadHex.startsWith("0x")) {
      return res.status(400).json({ ok: false, error: "Missing payloadHex" });
    }
    if (!txRef || typeof txRef !== "string" || !txRef.startsWith("0x")) {
      return res.status(400).json({ ok: false, error: "Missing txRef" });
    }

    // Option A: key stays in .env.local (server-side only).
    const skB64url = process.env.BANK_B_HPKE_SECRET_B64URL || "";

    // Helpful debug that does NOT leak the key itself
    const debug = {
      node: process.version,
      hasEnv: Boolean(skB64url),
      envLen: skB64url.length,
      hasSubtle: Boolean((globalThis as any).crypto?.subtle),
      hubEnvPresent: Boolean(process.env.NEXT_PUBLIC_PAYMENT_HUB_ADDRESS),
    };

    if (!skB64url) {
      return res.status(400).json({
        ok: false,
        error:
          "Server missing BANK_B_HPKE_SECRET_B64URL. Put it in .env.local at the project root and restart `npm run dev`.",
        debug,
      });
    }

    const skR = b64urlToBytes(skB64url);

    const hubAddress = (process.env.NEXT_PUBLIC_PAYMENT_HUB_ADDRESS || "").toString();
    const obj = await hpkeOpenEnvelopeHexToJson({
      recipientSecretKey: skR,
      envelopeHex: payloadHex,
      hubAddress,
      txRefHex: txRef,
    });

    return res.status(200).json({ ok: true, obj });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    return res.status(400).json({ ok: false, error: msg });
  }
}
