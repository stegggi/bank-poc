export type UserModulePackageV1 = {
  version: 1;
  moduleId: string; // 0x bytes32
  label: string;
  policy: string;
  uri: string;

  // AES-GCM ciphertext (WebCrypto output includes tag)
  ciphertextB64: string;
  ivB64: string;

  // DEK (raw AES key) — only kept in the user’s package, never uploaded to banks
  dekB64: string;

  // helpful for integrity/debug
  plaintextSha256: string;        // sha256(plaintext)
  ciphertextKeccak256: string;    // keccak256(ciphertext)
  createdAtIso: string;
};

export type BankStoredPackageV1 = {
  version: 1;
  moduleId: string;
  owner: string;
  label: string;
  uri: string;

  ciphertextB64: string;
  ivB64: string;

  ciphertextKeccak256: string;
  storedAtIso: string;
};

export type BankWrappedDekV1 = {
  version: 1;
  moduleId: string;
  owner: string;
  algo: "RSA-OAEP-SHA256";
  encDekB64: string; // RSA wrapped DEK
  wrappedAtIso: string;
};

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function bytesToUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export function randomBytes(length: number): Uint8Array {
  const b = new Uint8Array(length);
  crypto.getRandomValues(b);
  return b;
}

export function randomBytes32Hex(): string {
  const b = randomBytes(32);
  return "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  return "0x" + Array.from(bytes).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function encryptAesGcm(plaintext: string): Promise<{
  ciphertextB64: string;
  ivB64: string;
  dekB64: string;
}> {
  const iv = randomBytes(12);
  const dekRaw = randomBytes(32);

  const key = await crypto.subtle.importKey(
    "raw",
    dekRaw,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    utf8ToBytes(plaintext)
  );

  return {
    ciphertextB64: bytesToB64(new Uint8Array(ciphertext)),
    ivB64: bytesToB64(iv),
    dekB64: bytesToB64(dekRaw),
  };
}

export async function decryptAesGcm(ciphertextB64: string, ivB64: string, dekB64: string): Promise<string> {
  const iv = b64ToBytes(ivB64);
  const dekRaw = b64ToBytes(dekB64);
  const ciphertext = b64ToBytes(ciphertextB64);

  const key = await crypto.subtle.importKey(
    "raw",
    dekRaw,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return bytesToUtf8(new Uint8Array(plaintext));
}

// ---- RSA-OAEP wrap (demo key release) ----

function pemToArrayBufferSpki(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s+/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function wrapDekRsaOaepB64(publicKeyPem: string, dekB64: string): Promise<string> {
  const dekRaw = b64ToBytes(dekB64);
  const pubKey = await crypto.subtle.importKey(
    "spki",
    pemToArrayBufferSpki(publicKeyPem),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );

  const enc = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pubKey, dekRaw);
  return bytesToB64(new Uint8Array(enc));
}

export function toBankStoredPackage(user: UserModulePackageV1, owner: string): BankStoredPackageV1 {
  return {
    version: 1,
    moduleId: user.moduleId,
    owner,
    label: user.label,
    uri: user.uri,
    ciphertextB64: user.ciphertextB64,
    ivB64: user.ivB64,
    ciphertextKeccak256: user.ciphertextKeccak256,
    storedAtIso: new Date().toISOString(),
  };
}

export function downloadJson(filename: string, obj: unknown) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
