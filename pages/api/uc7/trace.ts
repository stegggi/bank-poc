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
  // - Explicit `chains` argument wins (used for per-chain retry from the UI).
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

  // Hop 1 only — the UI is a flat per-chain inflow list à la Etherscan.
  const hopDepth = Math.min(caseFile.settings.maxHopDepth ?? 1, 1);

  // Trace each chain SEQUENTIALLY. Parallel Promise.all flooded the
  // shared Etherscan rate limiter and individual chains intermittently
  // came back empty when their queued calls got starved. Sequential
  // gives predictable per-chain timing and per-chain logging.
  const results: TraceResult[] = [];
  for (const ch of chains) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const t = await traceBackward(address, ch, { maxHopDepth: hopDepth });
      results.push(t);
    } catch {
      results.push({
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
      } as TraceResult);
    }
  }

  // Merge into wallet.traces:
  // - If `chains` was explicit (UI retry of one chain), splice the results
  //   into the existing `traces` array, replacing matching chains and
  //   keeping the rest intact.
  // - Otherwise replace the whole array.
  if (explicit && explicit.length > 0 && wallet.traces && wallet.traces.length > 0) {
    const merged = [...wallet.traces];
    for (const t of results) {
      const idx = merged.findIndex((x) => x.chain === t.chain);
      if (idx >= 0) merged[idx] = t;
      else merged.push(t);
    }
    wallet.traces = merged;
  } else {
    wallet.traces = results;
  }

  delete wallet.trace;
  if (!wallet.primaryChain) wallet.primaryChain = chains[0];
  await writeCase(caseFile);
  return res.status(200).json({ traces: wallet.traces });
}
