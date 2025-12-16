// lib/envelope.ts
// Demo "Travel-Rule envelope": JSON --> gzip --> Curve25519 box (tweetnacl)
// Pack as: [ephemeralPubKey(32) | nonce(24) | ciphertext(variable)]
// Decrypt with Bank B's private key.
// NOTE: This is demo-grade; real HPKE can be added later.

import nacl from 'tweetnacl';
import { gzip, ungzip } from 'pako';

const enc = new TextEncoder();
const dec = new TextDecoder();

// hex ⇄ bytes helpers
export const hexToBytes = (hex: string): Uint8Array => {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const arr = new Uint8Array(h.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(h.substr(i*2, 2), 16);
  return arr;
};
export const bytesToHex = (b: Uint8Array): `0x${string}` => {
  const hex = [...b].map(v => v.toString(16).padStart(2, '0')).join('');
  return ('0x' + hex) as `0x${string}`;
};

export type EnvelopeCleartext = Record<string, any>;

/**
 * Encrypt for Bank B using its Curve25519 public key (32 bytes, hex).
 * Returns 0x-prefixed packed envelope bytes.
 */
export function encryptEnvelope(clear: EnvelopeCleartext, bankBPubHex: string): `0x${string}` {
  const pubB = hexToBytes(bankBPubHex);
  if (pubB.length !== 32) throw new Error('Bank B pubkey must be 32 bytes');

  const eph = nacl.box.keyPair(); // ephemeral Curve25519
  const nonce = nacl.randomBytes(24);

  const json = JSON.stringify(clear);
  const zipped = gzip(enc.encode(json)); // Uint8Array

  const boxed = nacl.box(zipped, nonce, pubB, eph.secretKey);

  const packed = new Uint8Array(32 + 24 + boxed.length);
  packed.set(eph.publicKey, 0);
  packed.set(nonce, 32);
  packed.set(boxed, 56);

  return bytesToHex(packed);
}

/**
 * Decrypt with Bank B's Curve25519 private key (32 bytes, hex).
 * Accepts packed 0x envelope.
 */
export function decryptEnvelope(packedHex: string, bankBPrivHex: string): EnvelopeCleartext {
  const privB = hexToBytes(bankBPrivHex);
  if (privB.length !== 32) throw new Error('Bank B privkey must be 32 bytes');

  const packed = hexToBytes(packedHex);
  if (packed.length < 56) throw new Error('Envelope too short');

  const ephPub = packed.slice(0, 32);
  const nonce  = packed.slice(32, 56);
  const boxed  = packed.slice(56);

  const opened = nacl.box.open(boxed, nonce, ephPub, privB);
  if (!opened) throw new Error('Decrypt failed');

  const json = dec.decode(ungzip(opened));
  return JSON.parse(json);
}
