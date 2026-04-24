import type { NextApiRequest, NextApiResponse } from "next";
import { readCase, writeCase } from "../../../../use-cases/uc8-sof-verification/lib/caseStore";
import type { CaseFile } from "../../../../use-cases/uc8-sof-verification/lib/types";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id || "");
  const existing = readCase(id);
  if (!existing) {
    return res.status(404).json({ error: "Case not found" });
  }

  if (req.method === "GET") {
    return res.status(200).json({ case: existing });
  }

  if (req.method === "PUT") {
    const body = (req.body || {}) as Partial<CaseFile>;
    const next: CaseFile = {
      ...existing,
      ...body,
      caseReference: existing.caseReference,
      createdAt: existing.createdAt,
      wallets: body.wallets ?? existing.wallets,
      settings: { ...existing.settings, ...(body.settings || {}) },
    };
    const saved = writeCase(next);
    return res.status(200).json({ case: saved });
  }

  res.setHeader("allow", "GET, PUT");
  return res.status(405).json({ error: "Method not allowed" });
}
