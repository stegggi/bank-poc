// scripts/gen-x25519.js
const nacl = require('tweetnacl');

// Base64URL helpers
const b64u = (u8) =>
  Buffer.from(u8).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');

const kp = nacl.box.keyPair(); // X25519
console.log('Public (base64url):', b64u(kp.publicKey));
console.log('Secret (base64url):', b64u(kp.secretKey));
// For Registry.setBank hpkePubKey (we’ll treat as "pubkey bytes"):
console.log('Public (0x...):', '0x' + Buffer.from(kp.publicKey).toString('hex'));
