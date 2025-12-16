// lib/cryptoEnvelope.ts
import nacl from 'tweetnacl';
import { encode as cborEncode } from 'cbor-x';
import { gzip } from 'pako';

// Base64URL helpers
export const toB64u = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export const fromB64u = (s: string) => {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  const base64 = s.replace(/-/g,'+').replace(/_/g,'/') + pad;
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
  return out;
};

// HKDF-SHA256 using WebCrypto
async function hkdf(secret: Uint8Array, salt: Uint8Array, info: Uint8Array, len=32) {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    len * 8,
  );
  return new Uint8Array(bits);
}

// AES-GCM encrypt/decrypt
export async function aesGcmEncrypt(keyBytes: Uint8Array, plaintext: Uint8Array) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv, ciphertext: new Uint8Array(ct) };
}
export async function aesGcmDecrypt(keyBytes: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new Uint8Array(pt);
}

// Build envelope for on-chain (bytes)
// pubKey: Bank B’s X25519 public key (Uint8Array length 32)
export async function buildEnvelope(pubKey: Uint8Array, payloadObj: any) {
  // 1) CBOR → gzip
  const cbor = cborEncode(payloadObj);
  const zipped = gzip(cbor);

  // 2) Ephemeral X25519
  const eph = nacl.box.keyPair(); // {publicKey, secretKey}
  const shared = nacl.scalarMult(eph.secretKey, pubKey); // 32 bytes

  // 3) Derive AES key via HKDF
  const salt = new Uint8Array(32); // zeros ok for demo
  const info = new TextEncoder().encode('finalix-demo-envelope-v1');
  const key = await hkdf(shared, salt, info, 32);

  // 4) AES-GCM
  const { iv, ciphertext } = await aesGcmEncrypt(key, zipped);

  // 5) Pack envelope as CBOR { kem: "x25519", ephPub, iv, ct }
  const env = cborEncode({
    k: 'x25519',
    epk: eph.publicKey, // 32 bytes
    iv,
    ct: ciphertext,
  });

  // Return raw bytes (Uint8Array) — you’ll pass as `payload` to submitPayment
  return new Uint8Array(env);
}

// Decrypt on Bank B side
export async function decryptEnvelope(privKeyB64u: string, envelopeBytes: Uint8Array) {
  const obj = (await import('cbor-x')).decode(envelopeBytes) as any;
  const epk = new Uint8Array(obj.epk);
  const iv  = new Uint8Array(obj.iv);
  const ct  = new Uint8Array(obj.ct);

  const sk = fromB64u(privKeyB64u);
  const shared = nacl.scalarMult(sk, epk);

  const salt = new Uint8Array(32);
  const info = new TextEncoder().encode('finalix-demo-envelope-v1');
  const key = await hkdf(shared, salt, info, 32);

  const plainZ = await aesGcmDecrypt(key, iv, ct);
  const payload = (await import('cbor-x')).decode(plainZ);
  return payload;
}
