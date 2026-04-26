import type { NextApiRequest, NextApiResponse } from "next";
import { traceBackward } from "../../../use-cases/uc7-sow-verification/lib/backwardTrace";
import { readCase, writeCase } from "../../../use-cases/uc7-sow-verification/lib/caseStore";
import type { TraceResult } from "../../../use-cases/uc7-sow-verification/lib/types";

// Multi-chain trace can take 30–60s with the Etherscan rate limiter.
export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};
  const caseReference = String(body.caseReference || "").trim();
  const address = String(body.address || "").trim();

  if (!caseReference || !address) {
    return res.status(400).json({ error: "caseReference and address are required" });
  }

  const caseFile = await readCase(caseReference);
  if (!caseFile) return res.status(404).json({ error: "Case not found" });
  const wallet = caseFile.wallets.find(
    (w) => w.address.toLowerCase() === address.toLowerCase()
  );
  if (!wallet) return res.status(404).json({ error: "Wallet not found in case" });

  // Decide which chains to trace.
  // - Explicit `chains` argument wins.
  // - Otherwise scan every chain that the wallet has on-chain activity on.
  // - Fall back to a single inferred chain for legacy data.
  const explicit: string[] | undefined = Array.isArray(body.chains)
    ? body.chains.map((c: unknown) => String(c))
    : body.chain
      ? [String(body.chain)]
      : undefined;

  const fromScan =
    wallet.scan?.chains.filter((c) => c.hasActivity).map((c) => c.chain) ?? [];

  const fallback =
    wallet.primaryChain ??
    (wallet.chainFamily === "bitcoin"
      ? "bitcoin"
      : wallet.chainFamily === "solana"
      ? "solana"
      : "ethereum");

  const chains: string[] =
    explicit && explicit.length > 0
      ? explicit
      : fromScan.length > 0
        ? fromScan
        : [fallback];

  try {
    // Trace each chain in parallel — the Etherscan rate-limiter naturally
    // serializes the API calls underneath, so this won't blow the rate limit
    // and total wall-clock time is roughly the same as sequential.
    const results = await Promise.all(
      chains.map((ch) =>
        traceBackward(address, ch, {
          maxHopDepth: caseFile.settings.maxHopDepth,
        })
      )
    );

    // Keep only chains where the trace had at least one source — empty
    // chains add noise.
    const traces: TraceResult[] = results.filter(
      (t) => t.totalIncomingValueChf > 0 || t.sources.length > 0
    );

    wallet.traces = traces.length > 0 ? traces : results;
    // Drop the legacy single-chain field once we've populated `traces`.
    delete wallet.trace;
    if (!wallet.primaryChain) wallet.primaryChain = chains[0];
    await writeCase(caseFile);
    return res.status(200).json({ traces: wallet.traces });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Trace failed",
    });
  }
}
