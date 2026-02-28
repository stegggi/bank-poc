import type { NextApiRequest, NextApiResponse } from "next";
import { head } from "@vercel/blob";
import { privateDecrypt, webcrypto } from "crypto";
import { ethers } from "ethers";

// IMPORTANT: this file is expected at: pages/api/bank/[bank]/plain.ts
// The ABI import path assumes: /lib/ContextPassportABI.ts|json at project root.
import CONTEXT_PASSPORT_ABI from "../../../../lib/ContextPassportABI";

function isHexAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}
function isBytes32(s: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(s);
}
const BANK: "bank-a" = "bank-a";
function pemFromEnv(value?: string): string {
  if (!value) return "";
  const cleaned = value.replace(/^"+|"+$/g, "").replace(/\r/g, "");
  return cleaned.includes("\\n") ? cleaned.replace(/\\n/g, "\n") : cleaned;
}
function contextPath(bank: string, owner: string, moduleId: string): string {
  // Must match put() path in /api/bank/<bank>/context
  return `uc4/${bank}/context/${owner.toLowerCase()}/${moduleId.toLowerCase()}.json`;
}
function dekPath(bank: string, owner: string, moduleId: string): string {
  // Must match put() path in /api/bank/<bank>/dek
  return `uc4/${bank}/dek/${owner.toLowerCase()}/${moduleId.toLowerCase()}.json`;
}
function b64ToBytes(b64: string): Uint8Array {
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function fetchBlobJson(primaryUrl?: string | null, fallbackPath?: string | null) {
  if (primaryUrl && isHttpUrl(primaryUrl)) {
    const resp = await fetch(primaryUrl, { cache: "no-store" });
    if (resp.ok) return await resp.json();
  }
  if (!fallbackPath) {
    throw new Error("Blob URL unavailable.");
  }
  const meta = await head(fallbackPath);
  const resp = await fetch(meta.url, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error("Blob fetch failed.");
  }
  return await resp.json();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const bank = BANK;

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "Method not allowed." });
    }

    const owner = String(req.query.owner || "");
    const moduleId = String(req.query.moduleId || "");
    const ctxUrl = String(req.query.ctxUrl || "");
    const dekUrl = String(req.query.dekUrl || "");

    if (!isHexAddress(owner)) return res.status(400).json({ ok: false, error: "Invalid owner address." });
    if (!isBytes32(moduleId)) return res.status(400).json({ ok: false, error: "Invalid moduleId (bytes32)." });

    const contractAddr = process.env.NEXT_PUBLIC_CONTEXT_PASSPORT_ADDRESS || "";
    if (!ethers.isAddress(contractAddr)) {
      return res.status(500).json({ ok: false, error: "Missing NEXT_PUBLIC_CONTEXT_PASSPORT_ADDRESS." });
    }

    const rpcUrl = process.env.RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || "";
    if (!rpcUrl) return res.status(500).json({ ok: false, error: "Missing RPC_URL (server-side)." });

    const bankAddress =
      bank === "bank-a"
        ? (process.env.NEXT_PUBLIC_BANK_A_ADDRESS || "")
        : (process.env.NEXT_PUBLIC_BANK_B_ADDRESS || "");

    if (!ethers.isAddress(bankAddress)) {
      return res.status(500).json({ ok: false, error: "Missing NEXT_PUBLIC_BANK_*_ADDRESS." });
    }

    // 1) Verify on-chain access for this bank
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(contractAddr, CONTEXT_PASSPORT_ABI as any, provider);

    const allowed: boolean = await contract.hasAccess(moduleId, bankAddress);
    if (!allowed) {
      return res.status(403).json({ ok: false, error: "No onchain access (grant missing/expired/revoked)." });
    }

    // 2) Load ciphertext package (public blob)
    let ctxPkg;
    try {
      ctxPkg = await fetchBlobJson(ctxUrl, contextPath(bank, owner, moduleId));
    } catch {
      return res.status(404).json({ ok: false, error: "Ciphertext not found in bank storage." });
    }

    // 3) Load wrapped DEK package (public blob)
    let dekPkg;
    try {
      dekPkg = await fetchBlobJson(dekUrl, dekPath(bank, owner, moduleId));
    } catch {
      return res.status(404).json({ ok: false, error: "Wrapped DEK not found in bank storage." });
    }

    const ciphertextB64 = String(ctxPkg.ciphertextB64 || "");
    const ivB64 = String(ctxPkg.ivB64 || "");
    const encDekB64 = String(dekPkg.encDekB64 || "");

    if (!ciphertextB64 || !ivB64 || !encDekB64) {
      return res.status(400).json({ ok: false, error: "Stored packages missing required fields." });
    }

    // 4) Optional: verify ciphertext hash matches onchain commitment
    const moduleOnchain = await contract.getModule(moduleId);
    const ciphertextBytes = b64ToBytes(ciphertextB64);
    const computedHash = ethers.keccak256(ciphertextBytes);
    const onchainHash = String(moduleOnchain.contentHash || "");
    if (onchainHash && onchainHash.toLowerCase() !== computedHash.toLowerCase()) {
      return res.status(409).json({ ok: false, error: "Ciphertext hash mismatch vs onchain commitment." });
    }

    // 5) Decrypt DEK using this bank's private RSA key
    const privPem =
      bank === "bank-a"
        ? pemFromEnv(process.env.BANK_A_RSA_PRIVATE_KEY_PEM)
        : pemFromEnv(process.env.BANK_B_RSA_PRIVATE_KEY_PEM);

    if (!privPem) return res.status(500).json({ ok: false, error: "Missing bank private key env var." });

    const dekRaw = privateDecrypt({ key: privPem, oaepHash: "sha256" }, Buffer.from(encDekB64, "base64"));

    // 6) Decrypt AES-GCM (WebCrypto expects ciphertext+tag in one buffer)
    const key = await webcrypto.subtle.importKey("raw", new Uint8Array(dekRaw), { name: "AES-GCM" }, false, ["decrypt"]);

    const plaintextBuf = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(ivB64) }, key, ciphertextBytes);
    const plaintext = new TextDecoder().decode(new Uint8Array(plaintextBuf));

    return res.status(200).json({
      ok: true,
      bank,
      owner,
      moduleId,
      plaintext,
      verifiedHash: true,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
}
