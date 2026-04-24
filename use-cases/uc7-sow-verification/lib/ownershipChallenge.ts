import { randomBytes } from "crypto";
import { verifyMessage } from "ethers";
import nacl from "tweetnacl";
import type { Challenge, ChainFamily } from "./types";
import { detectChain } from "./chainDetect";

function hex(n: number): string {
  return randomBytes(n).toString("hex");
}

// Base58 decoder for Solana pubkeys (no external dep)
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s: string): Uint8Array {
  const alphabet = B58_ALPHABET;
  const map: Record<string, number> = {};
  for (let i = 0; i < alphabet.length; i++) map[alphabet[i]] = i;

  const bytes: number[] = [0];
  for (const ch of s) {
    const v = map[ch];
    if (v === undefined) throw new Error("invalid base58 character");
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      const x = bytes[j] * 58 + carry;
      bytes[j] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry = carry >> 8;
    }
  }
  // Leading zero padding
  for (const ch of s) {
    if (ch === "1") bytes.push(0); else break;
  }
  return new Uint8Array(bytes.reverse());
}

export function buildChallengeMessage(params: {
  caseReference: string;
  nonce: string;
  timestamp: string;
}): string {
  return [
    "LGT Digital Asset Onboarding",
    `Reference: ${params.caseReference}`,
    `Nonce: ${params.nonce}`,
    `Timestamp: ${params.timestamp}`,
  ].join("\n");
}

export function generateChallenge(params: {
  caseReference: string;
  address: string;
}): Challenge {
  const detection = detectChain(params.address);
  const nonce = hex(8);
  const timestamp = new Date().toISOString();
  const message = buildChallengeMessage({
    caseReference: params.caseReference,
    nonce,
    timestamp,
  });
  const challengeId = hex(16);
  return {
    challengeId,
    caseReference: params.caseReference,
    nonce,
    timestamp,
    message,
    address: params.address,
    chainFamily: detection.chainFamily,
    status: "pending",
  };
}

export type VerificationResult = {
  ok: boolean;
  recoveredAddress?: string;
  error?: string;
};

export async function verifySignature(
  challenge: Challenge,
  signature: string,
  extra?: { publicKey?: string }
): Promise<VerificationResult> {
  const family: ChainFamily = challenge.chainFamily;

  try {
    if (family === "evm") {
      const recovered = verifyMessage(challenge.message, signature);
      const ok = recovered.toLowerCase() === challenge.address.toLowerCase();
      return ok
        ? { ok: true, recoveredAddress: recovered }
        : { ok: false, error: "Recovered address does not match claimed address" };
    }

    if (family === "solana") {
      // Signature and publicKey are expected to be base58 or hex
      let sigBytes: Uint8Array;
      if (/^0x[0-9a-fA-F]+$/.test(signature)) {
        sigBytes = Uint8Array.from(Buffer.from(signature.slice(2), "hex"));
      } else {
        try {
          sigBytes = base58Decode(signature);
        } catch {
          sigBytes = Uint8Array.from(Buffer.from(signature, "base64"));
        }
      }
      const pubKey = extra?.publicKey || challenge.address;
      const pubBytes = base58Decode(pubKey);
      const msgBytes = new TextEncoder().encode(challenge.message);
      const ok = nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);
      return ok
        ? { ok: true, recoveredAddress: pubKey }
        : { ok: false, error: "Ed25519 signature verification failed" };
    }

    if (family === "bitcoin") {
      // Bitcoin BIP-137 signature verification requires bitcoinjs-message.
      // For the prototype this is marked as manual-review.
      return {
        ok: false,
        error: "Bitcoin signature verification requires manual review in this prototype. Upload the signature out-of-band.",
      };
    }

    return { ok: false, error: `Signature verification not supported for ${family}` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown verification error",
    };
  }
}
