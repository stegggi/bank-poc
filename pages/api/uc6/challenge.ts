import type { NextApiRequest, NextApiResponse } from "next";
import { getAddress } from "ethers";
import {
  bestEffortRateLimit,
  getClientIp,
  makeOwnerMessage,
  type OwnerAction,
  normalizeOwnerSettings,
  randomNonce,
  saveChallenge,
  sha256HexFromObject,
} from "../../../use-cases/uc6-lp-automation/lib/uc6OwnerAuth";

type ChallengeRequest = {
  address?: string;
  action?: OwnerAction | string;
  payload?: unknown;
};

const CHALLENGE_TTL_MS = 3 * 60_000;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "64kb",
    },
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const ip = getClientIp({
    headers: req.headers as Record<string, string | string[] | undefined>,
    remoteAddress: req.socket.remoteAddress,
  });
  const rl = bestEffortRateLimit({
    namespace: "uc6:challenge",
    ip,
    limit: 10,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    res.setHeader("retry-after", String(rl.retryAfterSec));
    return res.status(429).json({ error: "Too many requests" });
  }

  const ownerRaw = process.env.UC6_OWNER_ADDRESS || process.env.NEXT_PUBLIC_UC6_OWNER_ADDRESS || "";
  if (!ownerRaw) {
    return res.status(500).json({ error: "Missing UC6 owner address configuration" });
  }

  let owner = "";
  try {
    owner = getAddress(ownerRaw);
  } catch {
    return res.status(500).json({ error: "UC6 owner address is invalid" });
  }

  try {
    const body = (req.body || {}) as ChallengeRequest;
    const action = String(body.action || "") as OwnerAction;
    const supportedActions: OwnerAction[] = [
      "update_settings", "force_rebalance", "liquidate_and_pause",
      "emissions_stake", "emissions_unstake", "emissions_claim",
    ];
    if (!supportedActions.includes(action)) {
      return res.status(400).json({ error: "Unsupported action" });
    }
    const address = getAddress(String(body.address || ""));
    if (address !== owner) {
      return res.status(403).json({ error: "Only the configured owner can request a challenge" });
    }

    const normalizedPayload = action === "update_settings" ? normalizeOwnerSettings(body.payload || {}) : {};
    const payloadSha256 = sha256HexFromObject(normalizedPayload);
    const nonce = randomNonce(16);
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
    const message = makeOwnerMessage({
      action,
      owner,
      issuedAt,
      expiresAt,
      nonce,
      payloadSha256,
    });

    saveChallenge({
      nonce,
      action,
      owner,
      payloadSha256,
      issuedAt,
      expiresAt,
      createdAtMs: Date.now(),
    });

    res.setHeader("cache-control", "no-store");
    return res.status(200).json({
      ok: true,
      message,
      expiresAt,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Bad request";
    return res.status(400).json({ error: message });
  }
}
