// lib/payments.ts
import { keccak256, toBytes, hexToBytes, bytesToHex } from 'viem';

export function uuidV4Bytes16(): Uint8Array {
  // Quick UUID v4
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b;
}

export function bytes16ToBytes32(b16: Uint8Array) {
  const b32 = new Uint8Array(32);
  b32.set(b16, 0); // left-pad with zeros on the right
  return b32;
}

export function bytesTo0x(b: Uint8Array): `0x${string}` {
  return ('0x' + Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join('')) as `0x${string}`;
}

export async function grantIfLow(addr: `0x${string}`, minWei = BigInt(2_0_000_000_000_000)) {
  // ~0.00002 ETH default
  try {
    const r = await fetch('/api/grant', {
      method:'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ to: addr })
    });
    // We optimistically call without reading balance first to keep the code short.
    // Your server can ignore if balance high.
    await r.json().catch(()=>{});
  } catch {}
}
