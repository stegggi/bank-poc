import type { NextApiRequest, NextApiResponse } from "next";
import QRCode from "qrcode";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const data = String(req.query.data || "").trim();
  if (!data) return res.status(400).json({ error: "data is required" });

  try {
    const svg = await QRCode.toString(data, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      color: {
        dark: "#111111",
        light: "#ffffff",
      },
      width: 220,
    });
    res.setHeader("content-type", "image/svg+xml; charset=utf-8");
    res.setHeader("cache-control", "public, max-age=60");
    return res.status(200).send(svg);
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "QR generation failed",
    });
  }
}
