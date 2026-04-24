import fs from "fs";
import path from "path";
import type { CaseFile, CaseSummary } from "./types";

const CASES_DIR = path.join(process.cwd(), "use-cases", "uc8-sof-verification", "data", "cases");

function ensureDir() {
  if (!fs.existsSync(CASES_DIR)) {
    fs.mkdirSync(CASES_DIR, { recursive: true });
  }
}

function caseFilePath(ref: string): string {
  return path.join(CASES_DIR, `${ref}.json`);
}

function isValidRef(ref: string): boolean {
  return /^SOF-\d{4}-\d{5}$/.test(ref);
}

export function generateCaseReference(): string {
  const year = new Date().getUTCFullYear();
  const rand = Math.floor(Math.random() * 90000) + 10000;
  return `SOF-${year}-${rand}`;
}

export function createCase(init: Omit<CaseFile, "createdAt" | "updatedAt" | "status"> & Partial<Pick<CaseFile, "status">>): CaseFile {
  ensureDir();
  const now = new Date().toISOString();
  const file: CaseFile = {
    ...init,
    status: init.status ?? "draft",
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(caseFilePath(file.caseReference), JSON.stringify(file, null, 2));
  return file;
}

export function readCase(ref: string): CaseFile | null {
  if (!isValidRef(ref)) return null;
  ensureDir();
  const p = caseFilePath(ref);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as CaseFile;
  } catch {
    return null;
  }
}

export function writeCase(file: CaseFile): CaseFile {
  if (!isValidRef(file.caseReference)) {
    throw new Error(`Invalid case reference: ${file.caseReference}`);
  }
  ensureDir();
  file.updatedAt = new Date().toISOString();
  fs.writeFileSync(caseFilePath(file.caseReference), JSON.stringify(file, null, 2));
  return file;
}

export function listCases(): CaseSummary[] {
  ensureDir();
  const files = fs.readdirSync(CASES_DIR).filter((f) => f.endsWith(".json"));
  const summaries: CaseSummary[] = [];
  for (const f of files) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), "utf-8")) as CaseFile;
      summaries.push({
        caseReference: content.caseReference,
        clientName: content.clientName,
        createdAt: content.createdAt,
        updatedAt: content.updatedAt,
        status: content.status,
        walletCount: content.wallets?.length ?? 0,
        overallRisk: content.overallRisk,
      });
    } catch {
      // skip invalid file
    }
  }
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return summaries;
}
