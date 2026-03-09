import fs from "fs/promises";
import path from "path";

export type Uc4BankId = "bank-a" | "bank-b";

export type Uc4BlobRefs = {
  bank: Uc4BankId;
  owner: string;
  moduleId: string;
  bundleUrl?: string;
  contextUrl?: string;
  dekUrl?: string;
  updatedAtIso: string;
};

type StoreData = {
  refs: Record<string, Uc4BlobRefs>;
};

const DEFAULT_PATH = path.join(process.env.TMPDIR || "/tmp", "uc4-blob-refs.json");
const STORE_PATH = process.env.UC4_BLOB_REF_STORE_PATH || DEFAULT_PATH;

let loaded = false;
let cache: StoreData = { refs: {} };
let persistChain: Promise<void> = Promise.resolve();

function keyOf(bank: Uc4BankId, owner: string, moduleId: string): string {
  return `${bank}:${owner.toLowerCase()}:${moduleId.toLowerCase()}`;
}

async function loadStoreIfNeeded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreData>;
    if (parsed && parsed.refs && typeof parsed.refs === "object") {
      cache = { refs: parsed.refs };
    }
  } catch {
    cache = { refs: {} };
  }
}

async function persistStore(): Promise<void> {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(cache, null, 2), "utf8");
}

function enqueuePersist(): Promise<void> {
  persistChain = persistChain.then(persistStore, persistStore);
  return persistChain;
}

export async function saveUc4BlobRefs(input: Omit<Uc4BlobRefs, "updatedAtIso"> & { updatedAtIso?: string }): Promise<Uc4BlobRefs> {
  await loadStoreIfNeeded();
  const entry: Uc4BlobRefs = {
    ...input,
    owner: input.owner.toLowerCase(),
    moduleId: input.moduleId.toLowerCase(),
    updatedAtIso: input.updatedAtIso || new Date().toISOString(),
  };
  cache.refs[keyOf(entry.bank, entry.owner, entry.moduleId)] = entry;
  await enqueuePersist();
  return entry;
}

export async function getUc4BlobRefs(bank: Uc4BankId, owner: string, moduleId: string): Promise<Uc4BlobRefs | null> {
  await loadStoreIfNeeded();
  return cache.refs[keyOf(bank, owner, moduleId)] ?? null;
}
