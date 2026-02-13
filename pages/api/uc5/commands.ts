// pages/api/uc5/commands.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { readJsonBlob, writeJsonBlob } from "../../../lib/uc5/blobStore";
import { verifyAdminSignature, verifyLinkSignerSenderSig } from "../../../lib/uc5/auth";
import type { Uc5Command, Uc5Config } from "../../../lib/uc5/types";

const COMMANDS_PATH = "uc5/commands.json";
const CONFIG_PATH = "uc5/config.json";

type CommandsFile = { commands: Uc5Command[] };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cfg = await readJsonBlob<Uc5Config>(CONFIG_PATH, {
    version: 1,
    ownerAddress: process.env.UC5_OWNER_ADDRESS || "",
    etherealApiBase: "https://api.ethereal.trade",
    etherealArchiveBase: "https://archive.ethereal.trade",
    ticker: "BTCUSD",
    tradingEnabled: true,
    killSwitch: false,
    pollIntervalSeconds: 3,
    predictionHorizonSeconds: 60,
    maxLeverage: 2,
    maxMarginUsd: 100,
    confidenceThreshold: 0.6,
    minHoldSeconds: 60,
    maxHoldSeconds: 900,
    maxOrdersPerHour: 120,
    productId: "",
    subaccountId: "",
    subaccountName: "",
  } as any);

  const owner = cfg.ownerAddress || process.env.UC5_OWNER_ADDRESS || "";
  if (!owner) return res.status(400).json({ error: "Missing UC5 owner address" });

  if (req.method === "GET") {
    const file = await readJsonBlob<CommandsFile>(COMMANDS_PATH, { commands: [] });
    return res.status(200).json(file);
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const type = body.type as string;

    // Load current commands
    const file = await readJsonBlob<CommandsFile>(COMMANDS_PATH, { commands: [] });

    // Keep file bounded
    const trimmed = file.commands.slice(-200);

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

      const cmd: Uc5Command = {
        id: randomUUID(),
        type: "FLATTEN",
        createdAt: Date.now(),
        status: "NEW",
      };
      await writeJsonBlob(COMMANDS_PATH, { commands: [...trimmed, cmd] });
      return res.status(200).json({ ok: true, id: cmd.id });
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

      const cmd: Uc5Command = {
        id: randomUUID(),
        type: "LINK_SIGNER",
        createdAt: Date.now(),
        status: "NEW",
        payload: {
          subaccountId,
          sender,
          subaccount,
          signer,
          nonce: String(nonce),
          signedAt: Number(signedAt),
          senderSignature,
        },
      };

      await writeJsonBlob(COMMANDS_PATH, { commands: [...trimmed, cmd] });
      return res.status(200).json({ ok: true, id: cmd.id });
    }

    return res.status(400).json({ error: `Unknown command type: ${type}` });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
