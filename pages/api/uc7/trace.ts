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

  // Trace each chain in parallel — the Etherscan rate-limiter naturally
  // serializes the API calls underneath, so this won't blow the rate limit
  // and total wall-clock time is roughly the same as sequential.
  // Hop 1 only — the UI is a flat per-chain inflow list à la Etherscan.
  const hopDepth = Math.min(caseFile.settings.maxHopDepth ?? 1, 1);

  // Per-chain try/catch so a single chain failing (e.g. Etherscan returning
  // garbage) doesn't kill the entire trace. Empty traces are also retained
  // so the user sees "no incoming transactions on this chain" rather than
  // the chain disappearing silently.
  const results: TraceResult[] = await Promise.all(
    chains.map(async (ch) => {
      try {
        return await traceBackward(address, ch, { maxHopDepth: hopDepth });
      } catch {
        return {
          walletAddress: address,
          chain: ch,
          totalIncomingValueChf: 0,
          totalIncomingValueUsd: 0,
          attributedValueChf: 0,
          attributedValueUsd: 0,
          attributedPercentage: 0,
          sources: [],
          hopsUsed: 0,
          maxHopsConfigured: hopDepth,
          sanctionsHits: [],
          nodes: [],
          edges: [],
          inflowsByParent: {},
          tracedAt: new Date().toISOString(),
        } as TraceResult;
      }
    })
  );

  wallet.traces = results;
  // Drop the legacy single-chain field once we've populated `traces`.
  delete wallet.trace;
  if (!wallet.primaryChain) wallet.primaryChain = chains[0];
  await writeCase(caseFile);
  return res.status(200).json({ traces: wallet.traces });
}
