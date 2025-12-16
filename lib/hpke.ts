// lib/hpke.ts
// Minimal HPKE (RFC 9180) implementation for this MVP.
//
// Suite (hardcoded for the demo):
//   KEM:  DHKEM(X25519, HKDF-SHA256)  kem_id = 0x0020
//   KDF:  HKDF-SHA256                kdf_id = 0x0001
//   AEAD: AES-128-GCM                aead_id = 0x0001
//
// We only use "mode_base" (no PSK, no sender auth) and a single-shot API.
// - `info` provides domain separation (we bind it to the PaymentHub address).
// - `aad` binds the ciphertext to the on-chain txRef (bytes32).

import nacl from "tweetnacl";

export type Hex = `0x${string}`;

// ----- constants -----
const HPKE_VERSION_LABEL = "HPKE-v1";

const KEM_ID = 0x0020; // DHKEM(X25519, HKDF-SHA256)
const KDF_ID = 0x0001; // HKDF-SHA256
const AEAD_ID = 0x0001; // AES-128-GCM

const Nh = 32; // SHA-256 output bytes
const Nk = 16; // AES-128 key bytes
const Nn = 12; // AES-GCM nonce bytes
const Nsecret = 32; // KEM shared secret bytes for X25519 HKDF-SHA256

// ----- small byte helpers -----
export const hexToBytes = (hex: Hex): Uint8Array => {
  const clean = (hex || "0x").startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

export const bytesToHex = (b: Uint8Array): Hex => {
  let hex = "0x";
  for (let i = 0; i < b.length; i += 1) {
    hex += b[i].toString(16).padStart(2, "0");
  }
  return hex as Hex;
};

const concatBytes = (...parts: Uint8Array[]) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (let i = 0; i < parts.length; i += 1) {
    out.set(parts[i], off);
    off += parts[i].length;
  }
  return out;
};

const xorBytes = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) throw new Error("XOR length mismatch");
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] ^ b[i];
  return out;
};

const i2osp = (n: number, len: number) => {
  if (n < 0) throw new Error("i2osp: negative");
  const out = new Uint8Array(len);
  let x = n;
  for (let i = len - 1; i >= 0; i -= 1) {
    out[i] = x & 0xff;
    x = Math.floor(x / 256);
  }
  if (x !== 0) throw new Error("i2osp: too large");
  return out;
};

const utf8 = (s: string) => new TextEncoder().encode(s);

// ----- crypto primitives (WebCrypto) -----
const getSubtle = () => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto subtle API not available");
  return subtle;
};

const hmacSha256 = async (keyBytes: Uint8Array, data: Uint8Array) => {
  const subtle = getSubtle();
  const key = await subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await subtle.sign("HMAC", key, data);
  return new Uint8Array(sig);
};

// HKDF per RFC 5869
const hkdfExtract = async (salt: Uint8Array, ikm: Uint8Array) => {
  const realSalt =
    salt.length === 0 ? new Uint8Array(Nh) : new Uint8Array(salt);
  return hmacSha256(realSalt, ikm);
};

const hkdfExpand = async (prk: Uint8Array, info: Uint8Array, L: number) => {
  if (L < 0) throw new Error("hkdfExpand: negative L");
  const n = Math.ceil(L / Nh);
  if (n > 255) throw new Error("hkdfExpand: too much output");
  let t = new Uint8Array(0);
  const okm = new Uint8Array(n * Nh);

  for (let i = 1; i <= n; i += 1) {
    const input = concatBytes(t, info, new Uint8Array([i]));
    t = await hmacSha256(prk, input);
    okm.set(t, (i - 1) * Nh);
  }
  return okm.slice(0, L);
};

// ----- HPKE labeled extract/expand (RFC 9180) -----
const suiteIdKEM = concatBytes(utf8("KEM"), i2osp(KEM_ID, 2));
const suiteIdHPKE = concatBytes(
  utf8("HPKE"),
  i2osp(KEM_ID, 2),
  i2osp(KDF_ID, 2),
  i2osp(AEAD_ID, 2)
);

const labeledExtract = async (
  suiteId: Uint8Array,
  salt: Uint8Array,
  label: string,
  ikm: Uint8Array
) => {
  const labeledIkm = concatBytes(
    utf8(HPKE_VERSION_LABEL),
    suiteId,
    utf8(label),
    ikm
  );
  return hkdfExtract(salt, labeledIkm);
};

const labeledExpand = async (
  suiteId: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  L: number
) => {
  const labeledInfo = concatBytes(
    i2osp(L, 2),
    utf8(HPKE_VERSION_LABEL),
    suiteId,
    utf8(label),
    info
  );
  return hkdfExpand(prk, labeledInfo, L);
};

// ----- KEM (DHKEM X25519) -----
const extractAndExpandKEM = async (dh: Uint8Array, kemContext: Uint8Array) => {
  // RFC 9180, DHKEM: shared_secret = LabeledExpand(LabeledExtract("", "eae_prk", dh), "shared_secret", kem_context, Nsecret)
  const eaePrk = await labeledExtract(suiteIdKEM, new Uint8Array(0), "eae_prk", dh);
  const sharedSecret = await labeledExpand(
    suiteIdKEM,
    eaePrk,
    "shared_secret",
    kemContext,
    Nsecret
  );
  return sharedSecret;
};

const encap = async (pkR: Uint8Array) => {
  if (pkR.length !== 32) throw new Error("pkR must be 32 bytes (X25519)");
  const kpE = nacl.box.keyPair(); // X25519 keypair
  const dh = nacl.scalarMult(kpE.secretKey, pkR);
  const enc = kpE.publicKey;
  const kemContext = concatBytes(enc, pkR);
  const sharedSecret = await extractAndExpandKEM(dh, kemContext);
  return { sharedSecret, enc };
};

const decap = async (enc: Uint8Array, skR: Uint8Array) => {
  if (enc.length !== 32) throw new Error("enc must be 32 bytes (X25519)");
  if (skR.length !== 32) throw new Error("skR must be 32 bytes (X25519)");
  const pkE = enc;
  const dh = nacl.scalarMult(skR, pkE);
  const pkRm = nacl.scalarMult.base(skR);
  const kemContext = concatBytes(enc, pkRm);
  const sharedSecret = await extractAndExpandKEM(dh, kemContext);
  return sharedSecret;
};

// ----- Key schedule (mode_base only) -----
const keyScheduleBase = async (sharedSecret: Uint8Array, info: Uint8Array) => {
  const modeBase = new Uint8Array([0x00]);

  const empty = new Uint8Array(0);
  const pskIdHash = await labeledExtract(
    suiteIdHPKE,
    empty,
    "psk_id_hash",
    empty
  );
  const infoHash = await labeledExtract(suiteIdHPKE, empty, "info_hash", info);

  const keyScheduleContext = concatBytes(modeBase, pskIdHash, infoHash);

  const secret = await labeledExtract(
    suiteIdHPKE,
    sharedSecret,
    "secret",
    empty
  );
  const key = await labeledExpand(
    suiteIdHPKE,
    secret,
    "key",
    keyScheduleContext,
    Nk
  );
  const baseNonce = await labeledExpand(
    suiteIdHPKE,
    secret,
    "base_nonce",
    keyScheduleContext,
    Nn
  );

  return { key, baseNonce };
};

const aesGcmEncrypt = async (
  keyBytes: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  pt: Uint8Array
) => {
  const subtle = getSubtle();
  const key = await subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad },
    key,
    pt
  );
  return new Uint8Array(ct);
};

const aesGcmDecrypt = async (
  keyBytes: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ct: Uint8Array
) => {
  const subtle = getSubtle();
  const key = await subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "decrypt",
  ]);
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad },
    key,
    ct
  );
  return new Uint8Array(pt);
};

// ----- Public API used by the app -----
export const buildHpkeInfo = (hubAddress: string) => {
  // Keep it simple + deterministic; both the browser and API route will build the same bytes.
  const hub = (hubAddress || "").toLowerCase();
  return utf8(`xbank-hpke-envelope:v1:${hub}`);
};

export type HpkeSealInput = {
  recipientPubKey: Uint8Array; // 32 bytes
  info: Uint8Array;
  aad: Uint8Array;
  plaintext: Uint8Array;
};

export type HpkeOpenInput = {
  recipientSecretKey: Uint8Array; // 32 bytes
  info: Uint8Array;
  aad: Uint8Array;
  envelope: Uint8Array;
};

// Envelope wire-format (versioned):
// [0]      : 1-byte version (=1)
// [1..6]   : suite ids: kem_id(2) || kdf_id(2) || aead_id(2)
// [7..8]   : enc_len u16 (big endian)
// [..]     : enc bytes (32)
// [..]     : ct_len u32 (big endian)
// [..]     : ciphertext bytes (includes AEAD tag)

const encodeEnvelopeV1 = (enc: Uint8Array, ct: Uint8Array) => {
  const ver = new Uint8Array([0x01]);
  const suite = concatBytes(i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2));
  const encLen = i2osp(enc.length, 2);
  const ctLen = i2osp(ct.length, 4);
  return concatBytes(ver, suite, encLen, enc, ctLen, ct);
};

const decodeEnvelopeV1 = (buf: Uint8Array) => {
  if (buf.length < 1 + 6 + 2 + 32 + 4) throw new Error("Envelope too short");
  const ver = buf[0];
  if (ver !== 0x01) throw new Error("Unsupported envelope version");
  const kemId = (buf[1] << 8) | buf[2];
  const kdfId = (buf[3] << 8) | buf[4];
  const aeadId = (buf[5] << 8) | buf[6];
  if (kemId !== KEM_ID || kdfId !== KDF_ID || aeadId !== AEAD_ID) {
    throw new Error("Unsupported HPKE suite");
  }
  const encLen = (buf[7] << 8) | buf[8];
  let off = 9;
  if (buf.length < off + encLen + 4) throw new Error("Envelope truncated");
  const enc = buf.slice(off, off + encLen);
  off += encLen;
  const ctLen =
    (buf[off] << 24) |
    (buf[off + 1] << 16) |
    (buf[off + 2] << 8) |
    buf[off + 3];
  off += 4;
  if (ctLen < 0) throw new Error("Invalid ctLen");
  if (buf.length < off + ctLen) throw new Error("Envelope truncated (ct)");
  const ct = buf.slice(off, off + ctLen);
  return { enc, ct };
};

export const hpkeSealToEnvelopeBytes = async (input: HpkeSealInput) => {
  const { sharedSecret, enc: kemEnc } = await encap(input.recipientPubKey);
  const { key, baseNonce } = await keyScheduleBase(sharedSecret, input.info);

  // Single-shot: seq = 0 => nonce = baseNonce XOR I2OSP(0, Nn) = baseNonce
  const ct = await aesGcmEncrypt(key, baseNonce, input.aad, input.plaintext);
  return encodeEnvelopeV1(kemEnc, ct);
};

export const hpkeOpenFromEnvelopeBytes = async (input: HpkeOpenInput) => {
  const { enc, ct } = decodeEnvelopeV1(input.envelope);
  const sharedSecret = await decap(enc, input.recipientSecretKey);
  const { key, baseNonce } = await keyScheduleBase(sharedSecret, input.info);
  const pt = await aesGcmDecrypt(key, baseNonce, input.aad, ct);
  return pt;
};

// Convenience helpers for this MVP -------------------------

export const hpkeSealJsonToEnvelopeHex = async (args: {
  recipientPubKeyHex: Hex;
  hubAddress: string;
  txRefHex: Hex; // bytes32 hex
  obj: any;
}) => {
  const pkR = hexToBytes(args.recipientPubKeyHex);
  const info = buildHpkeInfo(args.hubAddress);
  const aad = hexToBytes(args.txRefHex);
  const pt = utf8(JSON.stringify(args.obj));
  const envBytes = await hpkeSealToEnvelopeBytes({
    recipientPubKey: pkR,
    info,
    aad,
    plaintext: pt,
  });
  return bytesToHex(envBytes);
};

export const hpkeOpenEnvelopeHexToJson = async (args: {
  recipientSecretKey: Uint8Array;
  envelopeHex: Hex;
  hubAddress: string;
  txRefHex: Hex;
}) => {
  const env = hexToBytes(args.envelopeHex);
  const info = buildHpkeInfo(args.hubAddress);
  const aad = hexToBytes(args.txRefHex);
  const ptBytes = await hpkeOpenFromEnvelopeBytes({
    recipientSecretKey: args.recipientSecretKey,
    info,
    aad,
    envelope: env,
  });
  const txt = new TextDecoder().decode(ptBytes);
  return JSON.parse(txt);
};
