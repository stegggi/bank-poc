// pages/api/uc5/ethereal.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getVmConfigCached } from "../../../lib/uc5/vmRuntime";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cfg = await getVmConfigCached(15_000);

  const path = (req.query.path as string) || "";
  if (!path.startsWith("/v1/")) return res.status(400).json({ error: "path must start with /v1/" });

  const url = new URL(`${cfg.etherealApiBase}${path}`);
  // pass through query parameters (except path itself)
  for (const [k, v] of Object.entries(req.query)) {
    if (k === "path") continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  }

  const r = await fetch(url.toString(), { cache: "no-store" });
  const text = await r.text();
  res.status(r.status);
  res.setHeader("Content-Type", r.headers.get("content-type") || "application/json");
  return res.send(text);
}
