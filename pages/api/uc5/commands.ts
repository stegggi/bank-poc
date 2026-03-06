// pages/api/uc5/commands.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { verifyAdminSignature, verifyLinkSignerSenderSig } from "../../../use-cases/uc5-perp-trading/lib/auth";
import { getVmCommands, getVmConfigCached, postVmCommand } from "../../../use-cases/uc5-perp-trading/lib/vmRuntime";

function commandId(out: unknown): string {
  if (!out || typeof out !== "object") return "";
  if (!("id" in out)) return "";
  return String((out as { id?: unknown }).id || "");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cfg = await getVmConfigCached(15_000);

  const owner = cfg.ownerAddress || process.env.UC5_OWNER_ADDRESS || "";
  if (!owner) return res.status(400).json({ error: "Missing UC5 owner address" });

  if (req.method === "GET") {
    const file = await getVmCommands();
    return res.status(200).json(file);
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const type = body.type as string;

    if (type === "FLATTEN") {
      const auth = body.auth || {};
      const v = verifyAdminSignature({
        owner,
        address: auth.address || "",
        signature: auth.signature || "",
        action: "CMD_FLATTEN",
        nonce: auth.nonce || "",
        issuedAt: Number(auth.issuedAt || 0),
        payload: { type },
      });
      if (!v.ok) return res.status(403).json({ error: v.error || "Forbidden" });

      const out = await postVmCommand({ type: "FLATTEN" });
      return res.status(200).json({ ok: true, id: commandId(out) });
    }

    if (type === "LINK_SIGNER") {
      // LINK_SIGNER: we authenticate by verifying the owner's EIP-712 LinkSigner signature itself
      // (So you don't have to sign twice.)
      const payload = body.payload || {};
      const { sender, signer, subaccount, nonce, signedAt, senderSignature, subaccountId } = payload;

      if (!subaccountId || !sender || !signer || !subaccount || !nonce || !signedAt || !senderSignature) {
        return res.status(400).json({ error: "Missing payload fields for LINK_SIGNER" });
      }

      // Fetch domain from Ethereal
      const rpc = await fetch(`${cfg.etherealApiBase}/v1/rpc/config`, { cache: "no-store" }).then((r) => r.json());
      const domain = rpc?.domain;
      if (!domain) return res.status(500).json({ error: "Could not fetch Ethereal EIP-712 domain" });

      const v = verifyLinkSignerSenderSig({
        owner,
        domain,
        values: { sender, signer, subaccount, nonce, signedAt: Number(signedAt) },
        signature: senderSignature,
      });
      if (!v.ok) return res.status(403).json({ error: v.error || "Forbidden" });

      const commandPayload = {
        subaccountId,
        sender,
        subaccount,
        signer,
        nonce: String(nonce),
        signedAt: Number(signedAt),
        senderSignature,
      };

      const out = await postVmCommand({ type: "LINK_SIGNER", payload: commandPayload });
      return res.status(200).json({ ok: true, id: commandId(out) });
    }

    return res.status(400).json({ error: `Unknown command type: ${type}` });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
