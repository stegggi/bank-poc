// lib/uc5/blobStore.ts
import { list, put } from "@vercel/blob";

async function findBlobUrl(pathname: string): Promise<string | null> {
  const res = await list({ prefix: pathname, limit: 5 });
  const hit = res.blobs.find((b) => b.pathname === pathname) || res.blobs[0];
  return hit?.url || null;
}

export async function readJsonBlob<T>(pathname: string, fallback: T): Promise<T> {
  try {
    const url = await findBlobUrl(pathname);
    if (!url) return fallback;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return fallback;
    return (await r.json()) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonBlob(pathname: string, data: any): Promise<void> {
  // NOTE: Vercel Blob overwrites only if addRandomSuffix=false
  await put(pathname, JSON.stringify(data, null, 2), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false as any, // keep TS happy if SDK type differs
  } as any);
}
