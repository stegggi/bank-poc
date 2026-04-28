import fs from "fs";
import path from "path";
import { list, put, del } from "@vercel/blob";

// Local FS fallback when BLOB_READ_WRITE_TOKEN is not set (dev).
const USE_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;

// Vercel Blob's `list` is an "advanced" billed operation (~10x the price of
// reads/writes). We used to call it on every readJson() to discover the
// blob URL — that single hot-path was burning the bulk of our quota.
//
// With `addRandomSuffix: false` + `allowOverwrite: true`, the blob URL is
// deterministic: `https://<storeId>.public.blob.vercel-storage.com/<path>`.
// We parse the storeId out of BLOB_READ_WRITE_TOKEN and reconstruct the URL
// ourselves, so reads become a plain (cheap) public fetch.
//
// As a backstop we also cache the URL `put()` returned, in case the token
// format ever changes or the store uses a non-default host.
const recentWrites = new Map<string, { body: string; ts: number }>();
const RECENT_TTL_MS = 30_000;
const urlCache = new Map<string, string>();

function deriveBaseUrlFromToken(): string | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN || "";
  // Token format: `vercel_blob_rw_<storeId>_<random>`. Store id makes up the
  // first segment of the public host.
  const m = token.match(/^vercel_blob_rw_([A-Za-z0-9]+)_/);
  if (!m) return null;
  return `https://${m[1].toLowerCase()}.public.blob.vercel-storage.com`;
}

const TOKEN_BASE_URL = deriveBaseUrlFromToken();

function predictUrl(pathname: string): string | null {
  const cached = urlCache.get(pathname);
  if (cached) return cached;
  if (TOKEN_BASE_URL) return `${TOKEN_BASE_URL}/${pathname}`;
  return null;
}

const LOCAL_ROOT = path.join(
  process.cwd(),
  "use-cases",
  "uc7-sow-verification",
  "data"
);

function localPathFor(pathname: string): string {
  return path.join(LOCAL_ROOT, pathname);
}

// Last-resort lookup if a constructed URL 404s — only used when both the
// token-derived host and the put-cache miss.
async function findBlobUrlViaList(pathname: string): Promise<string | null> {
  const res = await list({ prefix: pathname, limit: 5 });
  const exact = res.blobs.find((b) => b.pathname === pathname);
  return exact?.url ?? null;
}

export async function readJson<T>(pathname: string): Promise<T | null> {
  if (!USE_BLOB) {
    try {
      const raw = await fs.promises.readFile(localPathFor(pathname), "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  // If this Lambda just wrote to this pathname, return the in-memory copy —
  // bypasses Vercel Blob's eventual-consistency window for `list`.
  const recent = recentWrites.get(pathname);
  if (recent && Date.now() - recent.ts < RECENT_TTL_MS) {
    try {
      return JSON.parse(recent.body) as T;
    } catch {
      /* fall through to network read */
    }
  }
  // Try the deterministic URL first — a plain public fetch, billed as a
  // simple operation.
  const predicted = predictUrl(pathname);
  if (predicted) {
    try {
      const r = await fetch(predicted, { cache: "no-store" });
      if (r.ok) return (await r.json()) as T;
      if (r.status === 404) return null; // genuinely doesn't exist
    } catch {
      /* network blip — fall through to the slow path */
    }
  }
  // Backstop: if we have no predicted URL (no token parse + no prior put),
  // do one list() call. This should be rare; it only runs on cold-start
  // reads of paths we've never written from this Lambda.
  try {
    const url = await findBlobUrlViaList(pathname);
    if (!url) return null;
    urlCache.set(pathname, url);
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function writeJson(pathname: string, data: unknown): Promise<void> {
  const body = JSON.stringify(data, null, 2);
  if (!USE_BLOB) {
    const full = localPathFor(pathname);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, body, "utf-8");
    return;
  }
  const written = await put(pathname, body, {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  // Cache the canonical URL so future reads in this Lambda always skip
  // list(). Also remember the body for read-after-write determinism.
  if (written?.url) urlCache.set(pathname, written.url);
  recentWrites.set(pathname, { body, ts: Date.now() });
}

export async function listJson<T>(prefix: string): Promise<T[]> {
  if (!USE_BLOB) {
    const dir = localPathFor(prefix);
    try {
      const entries = await fs.promises.readdir(dir);
      const files = entries.filter((f) => f.endsWith(".json"));
      const items = await Promise.all(
        files.map(async (f) => {
          try {
            const raw = await fs.promises.readFile(path.join(dir, f), "utf-8");
            return JSON.parse(raw) as unknown;
          } catch {
            return null;
          }
        })
      );
      return items.filter((x): x is unknown => x !== null) as T[];
    } catch {
      return [];
    }
  }
  const res = await list({ prefix, limit: 1000 });
  const items = await Promise.all(
    res.blobs.map(async (b) => {
      try {
        const r = await fetch(b.url, { cache: "no-store" });
        if (!r.ok) return null;
        return (await r.json()) as unknown;
      } catch {
        return null;
      }
    })
  );
  return items.filter((x): x is unknown => x !== null) as T[];
}

export async function deleteJson(pathname: string): Promise<void> {
  recentWrites.delete(pathname);
  urlCache.delete(pathname);
  if (!USE_BLOB) {
    try {
      await fs.promises.unlink(localPathFor(pathname));
    } catch {
      // ignore
    }
    return;
  }
  try {
    await del(pathname);
  } catch {
    // ignore
  }
}
