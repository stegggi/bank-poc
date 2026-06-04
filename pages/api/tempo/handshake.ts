// pages/api/tempo/handshake.ts
//
// UC8 · Task 1 — server-side Tempo Testnet (Moderato) connectivity handshake.
//
// GET /api/tempo/handshake          → connectivity + pathUSD balance of the dev address
// GET /api/tempo/handshake?fund=1   → also mints from the faucet first, then re-reads
//
// The dev address is read from TEMPO_DEV_ADDRESS (.env.local, gitignored). The private
// key is NEVER read or returned here — funding/reading need no signature.
import type { NextApiRequest, NextApiResponse } from "next";
import type { Address } from "viem";
import { runHandshake, type HandshakeResult } from "../../../shared/lib/tempo";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<HandshakeResult>,
) {
  const address = (process.env.TEMPO_DEV_ADDRESS || "").trim();
  const fund = req.query.fund === "1" || req.query.fund === "true";

  const result = await runHandshake({
    address: address ? (address as Address) : null,
    fund,
  });

  // 200 when the chain is reachable; 502 if the RPC handshake failed.
  res.status(result.connected ? 200 : 502).json(result);
}
