// lib/cryptoEnvelope.ts
import nacl from 'tweetnacl';
import { encode as cborEncode } from 'cbor-x';
import { gzip } from 'pako';

// Convert Uint8Array -> exact ArrayBuffer slice (not ArrayBufferLike) to satisfy WebCrypto BufferSource typing.
const toArrayBuffer = (u8: Uint8Array): ArrayBuffer => {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
};

// Base64URL helpers
export const toB64u = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export const fromB64u = (s: string) => {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  const b64 = (s + pad).replace(/-/g,'+').replace(/_/g,'/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
  return out;
};

// HKDF-SHA256 using WebCrypto
async function hkdf(secret: Uint8Array, salt: Uint8Array, info: Uint8Array, len=32) {
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(secret), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: toArrayBuffer(salt), info: toArrayBuffer(info) },
    key,
    len * 8,
  );
  return new Uint8Array(bits);
}

// AES-GCM encrypt/decrypt
export async function aesGcmEncrypt(keyBytes: Uint8Array, plaintext: Uint8Array) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(keyBytes), 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(plaintext));
  return { iv, ciphertext: new Uint8Array(ct) };
}
export async function aesGcmDecrypt(keyBytes: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(keyBytes), 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(ciphertext));
  return new Uint8Array(pt);
}

// Build envelope for on-chain (bytes)
// pubKey: Bank B’s X25519 public key (Uint8Array length 32)
export async function buildEnvelope(pubKey: Uint8Array, payloadObj: any) {
  // 1) CBOR → gzip
  const cbor = cborEncode(payloadObj);
  const zipped = gzip(cbor);

  // 2) Ephemeral X25519
  const eph = nacl.box.keyPair();
  const shared = nacl.scalarMult(eph.secretKey, pubKey); // 32 bytes

  // 3) Derive AEAD key via HKDF
  const salt = new Uint8Array(32); // all zeros OK for demo (real HPKE uses labeled extracts)
  const info = new TextEncoder().encode('xbank-envelope-v1');
  const key = await hkdf(shared, salt, info, 32);

  // 4) Encrypt zipped payload
  const { iv, ciphertext } = await aesGcmEncrypt(key, zipped);

  // 5) Pack envelope: [ephPub(32) | iv(12) | ct(...)]
  const out = new Uint8Array(32 + 12 + ciphertext.length);
  out.set(eph.publicKey, 0);
  out.set(iv, 32);
  out.set(ciphertext, 44);
  return out;
}

// Open envelope (client-side)
export async function openEnvelope(envelope: Uint8Array, recipientPriv: Uint8Array) {
  if (envelope.length < 44) throw new Error('Envelope too short');
  const ephPub = envelope.slice(0, 32);
  const iv = envelope.slice(32, 44);
  const ct = envelope.slice(44);

  const shared = nacl.scalarMult(recipientPriv, ephPub);
  const salt = new Uint8Array(32);
  const info = new TextEncoder().encode('xbank-envelope-v1');
  const key = await hkdf(shared, salt, info, 32);

  const zipped = await aesGcmDecrypt(key, iv, ct);
  return zipped;
}
