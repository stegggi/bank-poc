import type { NextApiRequest, NextApiResponse } from "next";
import { getAddress } from "ethers";
import {
  bestEffortRateLimit,
  consumeChallenge,
  getClientIp,
  parseOwnerMessage,
  readChallenge,
  verifyOwnerSignatureOrThrow,
} from "../../../../lib/uc6OwnerAuth";

type ForceRebalanceRequest = {
  message?: string;
  signature?: string;
  payload?: unknown;
};

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

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
    namespace: "uc6:owner:force-rebalance",
    ip,
    limit: 20,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    res.setHeader("retry-after", String(rl.retryAfterSec));
    return res.status(429).json({ error: "Too many requests" });
  }

  const base = String(process.env.UC6_BOT_BASE_URL || "").replace(/\/+$/, "");
  const token = String(process.env.UC6_BOT_ADMIN_TOKEN || "");
  const ownerRaw = process.env.UC6_OWNER_ADDRESS || process.env.NEXT_PUBLIC_UC6_OWNER_ADDRESS || "";
  if (!base) return res.status(500).json({ error: "Missing UC6_BOT_BASE_URL" });
  if (!token) return res.status(500).json({ error: "Missing UC6_BOT_ADMIN_TOKEN" });
  if (!ownerRaw) return res.status(500).json({ error: "Missing UC6 owner address" });

  let owner = "";
  try {
    owner = getAddress(ownerRaw);
  } catch {
    return res.status(500).json({ error: "UC6 owner address is invalid" });
  }

  try {
    const body = (req.body || {}) as ForceRebalanceRequest;
    const message = String(body.message || "");
    const signature = String(body.signature || "");
    const payload = {};
    if (!message || !signature) {
      return res.status(400).json({ error: "Missing message or signature" });
    }

    const parsed = parseOwnerMessage(message);
    const challenge = readChallenge(parsed.nonce);
    if (!challenge) return res.status(403).json({ error: "Challenge missing or expired" });
    if (challenge.usedAtMs) return res.status(403).json({ error: "Challenge was already used" });
    if (challenge.action !== parsed.action || challenge.payloadSha256 !== parsed.payloadSha256) {
      return res.status(403).json({ error: "Challenge payload mismatch" });
    }

    verifyOwnerSignatureOrThrow({
      ownerAddress: owner,
      message,
      signature,
      payload,
      expectedAction: "force_rebalance",
      clockSkewSec: 30,
    });
    consumeChallenge(parsed.nonce, Date.now());

    const upstream = await fetchWithTimeout(
      `${base}/owner/force-rebalance`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message, signature, payload }),
      },
      12_000
    );

    const text = await upstream.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    res.setHeader("cache-control", "no-store");
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: "UC6 bot rejected force rebalance",
        details: json,
      });
    }
    return res.status(200).json(json);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Bad request";
    return res.status(400).json({ error: message });
  }
}
