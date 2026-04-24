import type { NextApiRequest, NextApiResponse } from "next";
import { readCase, writeCase } from "../../../../use-cases/uc8-sof-verification/lib/caseStore";
import { generateReportHtml } from "../../../../use-cases/uc8-sof-verification/pdf/generateReport";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const caseId = String(req.query.caseId || "");
  const caseFile = readCase(caseId);
  if (!caseFile) return res.status(404).json({ error: "Case not found" });

  const html = generateReportHtml(caseFile);

  if (req.method === "POST") {
    caseFile.reportGenerated = true;
    caseFile.reportGeneratedAt = new Date().toISOString();
    if (caseFile.status !== "escalated") caseFile.status = "completed";
    writeCase(caseFile);
  }

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("content-disposition", `inline; filename="${caseFile.caseReference}.html"`);
  return res.status(200).send(html);
}
