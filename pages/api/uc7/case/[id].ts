import type { NextApiRequest, NextApiResponse } from "next";
import {
  deleteCase,
  readCase,
  writeCase,
} from "../../../../use-cases/uc7-sow-verification/lib/caseStore";
import type { CaseFile } from "../../../../use-cases/uc7-sow-verification/lib/types";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id || "");
  const existing = await readCase(id);
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
    const saved = await writeCase(next);
    return res.status(200).json({ case: saved });
  }

  if (req.method === "DELETE") {
    const ok = await deleteCase(id);
    return res.status(200).json({ deleted: ok });
  }

  res.setHeader("allow", "GET, PUT, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
