import fs from "fs";
import path from "path";
import { list, put, del } from "@vercel/blob";

// Local FS fallback when BLOB_READ_WRITE_TOKEN is not set (dev).
const USE_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;

const LOCAL_ROOT = path.join(
  process.cwd(),
  "use-cases",
  "uc8-sof-verification",
  "data"
);

function localPathFor(pathname: string): string {
  return path.join(LOCAL_ROOT, pathname);
}

async function findBlobUrl(pathname: string): Promise<string | null> {
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
  try {
    const url = await findBlobUrl(pathname);
    if (!url) return null;
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
  await put(pathname, body, {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
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
