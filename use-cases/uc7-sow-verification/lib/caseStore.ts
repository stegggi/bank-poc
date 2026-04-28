import type { CaseFile, CaseSummary } from "./types";
import { readJson, writeJson, listJson, deleteJson } from "./blobStore";

const CASES_PREFIX = "cases/";
const CHALLENGE_PREFIX = "challenges/";

function casePath(ref: string): string {
  return `${CASES_PREFIX}${ref}.json`;
}

function isValidRef(ref: string): boolean {
  // Accept SOW- (current) and legacy SOF- prefixes for cases created pre-rename.
  return /^(SOW|SOF)-\d{4}-\d{5}$/.test(ref);
}

export function generateCaseReference(): string {
  const year = new Date().getUTCFullYear();
  const rand = Math.floor(Math.random() * 90000) + 10000;
  return `SOW-${year}-${rand}`;
}

export async function createCase(
  init: Omit<CaseFile, "createdAt" | "updatedAt" | "status"> &
    Partial<Pick<CaseFile, "status">>
): Promise<CaseFile> {
  const now = new Date().toISOString();
  const file: CaseFile = {
    ...init,
    status: init.status ?? "draft",
    createdAt: now,
    updatedAt: now,
  };
  await writeJson(casePath(file.caseReference), file);
  return file;
}

export async function readCase(ref: string): Promise<CaseFile | null> {
  if (!isValidRef(ref)) return null;
  return await readJson<CaseFile>(casePath(ref));
}

export async function writeCase(file: CaseFile): Promise<CaseFile> {
  if (!isValidRef(file.caseReference)) {
    throw new Error(`Invalid case reference: ${file.caseReference}`);
  }
  file.updatedAt = new Date().toISOString();
  await writeJson(casePath(file.caseReference), file);
  return file;
}

export async function deleteCase(ref: string): Promise<boolean> {
  if (!isValidRef(ref)) return false;
  const existing = await readCase(ref);
  if (!existing) {
    // Still try to delete the case file in case it exists but didn't parse.
    await deleteJson(casePath(ref));
    return false;
  }
  // Delete every per-wallet ownership challenge that lived under this case.
  // Challenge ids are stored on the wallet record, so we walk the wallets.
  const challengeIds = (existing.wallets ?? [])
    .map((w) => w.challenge?.challengeId)
    .filter((id): id is string => !!id);
  await Promise.all(
    challengeIds.map((id) =>
      deleteJson(`${CHALLENGE_PREFIX}${id}.json`).catch(() => {}),
    ),
  );
  await deleteJson(casePath(ref));
  return true;
}

export async function listCases(): Promise<CaseSummary[]> {
  const cases = await listJson<CaseFile>(CASES_PREFIX);
  const summaries: CaseSummary[] = cases.map((c) => ({
    caseReference: c.caseReference,
    clientName: c.clientName,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    status: c.status,
    walletCount: c.wallets?.length ?? 0,
    overallRisk: c.overallRisk,
  }));
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return summaries;
}
