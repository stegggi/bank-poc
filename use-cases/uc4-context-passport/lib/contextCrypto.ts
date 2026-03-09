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
  bankBlobRefs?: Partial<
    Record<
      "bank-a" | "bank-b",
      {
        owner?: string;
        bundleUrl?: string;
        contextUrl?: string;
        dekUrl?: string;
        updatedAtIso?: string;
      }
    >
  >;
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

export type BankStoredBundleV1 = {
  version: 1;
  moduleId: string;
  owner: string;
  label: string;
  uri: string;
  ciphertextB64: string;
  ivB64: string;
  ciphertextKeccak256: string;
  encDekB64: string;
  algo: "RSA-OAEP-SHA256";
  storedAtIso: string;
  wrappedAtIso: string;
};

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function normalizeBase64(input: string): string {
  const cleaned = String(input || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/^"+|"+$/g, "");
  const base = cleaned.replace(/[^A-Za-z0-9+/=]/g, "");
  const pad = base.length % 4;
  if (pad === 0) return base;
  return base + "=".repeat(4 - pad);
}

export function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(normalizeBase64(b64));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Force an ArrayBuffer-backed copy to satisfy WebCrypto typings in strict builds.
  const copy = new Uint8Array(bytes);
  return copy.buffer;
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
  // Ensure ArrayBuffer-backed view for WebCrypto (avoids SharedArrayBuffer typing issues in CI)
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(data));
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
    toArrayBuffer(dekRaw),
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(utf8ToBytes(plaintext))
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
    toArrayBuffer(dekRaw),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(ciphertext)
  );

  return bytesToUtf8(new Uint8Array(plaintext));
}

// ---- RSA-OAEP wrap (demo key release) ----

function pemToArrayBufferSpki(pem: string): ArrayBuffer {
  const cleaned = String(pem || "")
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/\s+/g, "")
    .replace(/^"+|"+$/g, "");
  const binary = atob(normalizeBase64(cleaned));
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

  const enc = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pubKey, toArrayBuffer(dekRaw));
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

export function toBankStoredBundle(user: UserModulePackageV1, owner: string, encDekB64: string): BankStoredBundleV1 {
  const now = new Date().toISOString();
  return {
    version: 1,
    moduleId: user.moduleId,
    owner,
    label: user.label,
    uri: user.uri,
    ciphertextB64: user.ciphertextB64,
    ivB64: user.ivB64,
    ciphertextKeccak256: user.ciphertextKeccak256,
    encDekB64,
    algo: "RSA-OAEP-SHA256",
    storedAtIso: now,
    wrappedAtIso: now,
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
