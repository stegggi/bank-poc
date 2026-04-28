import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import NavBar from "../shared/components/NavBar";
import FundFlowDiagram from "../use-cases/uc7-sow-verification/components/FundFlowDiagram";
import ExchangeTierBadge from "../use-cases/uc7-sow-verification/components/ExchangeTierBadge";
import { detectChain, chainFamilyLabel } from "../use-cases/uc7-sow-verification/lib/chainDetect";
import { formatChf, formatMoney, type Currency } from "../use-cases/uc7-sow-verification/lib/format";
import type {
  CaseFile,
  CaseSummary,
  ChainActivity,
  RiskTier,
  TraceResult,
  TraceTx,
  WalletRecord,
  WalletScanResult,
} from "../use-cases/uc7-sow-verification/lib/types";

const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

type Step = "setup" | "ownership" | "scan" | "classify" | "ttp" | "report";

const STEP_ORDER: Step[] = ["setup", "ownership", "scan", "classify", "ttp", "report"];

const STEP_LABELS: Record<Step, string> = {
  setup: "1. Case setup",
  ownership: "2. Ownership",
  scan: "3. Source trace",
  classify: "4. Classify",
  ttp: "5. Escalation",
  report: "6. Report",
};

const UC7_ACCENT = "#ec4899";

function useCurrency(): [Currency, (c: Currency) => void] {
  const [currency, setCurrencyState] = useState<Currency>("CHF");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem("uc7:currency");
    if (stored === "CHF" || stored === "USD") setCurrencyState(stored);
  }, []);
  const setCurrency = useCallback((c: Currency) => {
    setCurrencyState(c);
    if (typeof window !== "undefined") window.localStorage.setItem("uc7:currency", c);
  }, []);
  return [currency, setCurrency];
}

function pickValue(chf: number, usd: number, currency: Currency): number {
  return currency === "USD" ? usd : chf;
}

export default function Uc7Page() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [activeCase, setActiveCase] = useState<CaseFile | null>(null);
  const [step, setStep] = useState<Step>("setup");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [currency, setCurrency] = useCurrency();

  const loadCases = useCallback(async () => {
    try {
      const res = await fetch("/api/uc7/case");
      const json = await res.json();
      setCases(json.cases ?? []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadCases();
  }, [loadCases]);

  const refreshCase = useCallback(async (ref: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/uc7/case/${ref}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error || `Case ${ref} could not be loaded (HTTP ${res.status}).`);
        return false;
      }
      const json = await res.json();
      setActiveCase(json.case);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to load ${ref}`);
      return false;
    }
  }, []);

  return (
    <>
      <style jsx global>{`
        @keyframes uc7spin { to { transform: rotate(360deg); } }
        .uc7-spin { animation: uc7spin 0.9s linear infinite; transform-origin: center; }
      `}</style>
      <NavBar active="uc7" />
      <main style={pageRoot}>
        <header style={headerWrap}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 280 }}>
              <div style={eyebrow}>UC7 · Source of Wealth Verification</div>
              <h1 style={h1}>Crypto Onboarding · Source of Wealth</h1>
              <p style={subtitle}>
                Verify wallet ownership, trace incoming wealth to regulated sources, classify risk, and produce
                a FINMA-ready compliance report per client. The compliance PDF is always denominated in CHF.
              </p>
            </div>
            <CurrencyToggle currency={currency} onChange={setCurrency} />
          </div>
        </header>

        <div style={contentWrap}>
          <section style={cardStyle}>
            {!activeCase ? (
              <CaseListView
                cases={cases}
                onCreate={async (clientName) => {
                  setLoading(true);
                  setError("");
                  try {
                    const res = await fetch("/api/uc7/case", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ clientName }),
                    });
                    if (!res.ok) {
                      const j = await res.json();
                      throw new Error(j.error || "Failed to create case");
                    }
                    const json = await res.json();
                    setActiveCase(json.case);
                    setStep("setup");
                    loadCases();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Failed");
                  } finally {
                    setLoading(false);
                  }
                }}
                onOpen={async (ref) => {
                  setError("");
                  const ok = await refreshCase(ref);
                  if (ok) setStep("setup");
                }}
                onDelete={async (ref, clientName) => {
                  if (
                    !confirm(
                      `Delete case ${ref} (${clientName}) and all its data — wallets, ownership challenges, scans, traces, classifications? This cannot be undone.`,
                    )
                  ) {
                    return;
                  }
                  setError("");
                  try {
                    const res = await fetch(`/api/uc7/case/${ref}`, { method: "DELETE" });
                    if (!res.ok) {
                      const body = (await res.json().catch(() => ({}))) as { error?: string };
                      throw new Error(body.error || `Delete failed (HTTP ${res.status})`);
                    }
                    await loadCases();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : `Failed to delete ${ref}`);
                  }
                }}
                loading={loading}
                error={error}
              />
            ) : (
              <>
                <CaseHeader
                  caseFile={activeCase}
                  onClose={() => {
                    setActiveCase(null);
                    loadCases();
                  }}
                />

                <Stepper step={step} onChange={setStep} caseFile={activeCase} />

                {step === "setup" && (
                  <StepSetup
                    caseFile={activeCase}
                    setActiveCase={setActiveCase}
                    onUpdated={refreshCase}
                    onNext={() => setStep("ownership")}
                    currency={currency}
                  />
                )}
                {step === "ownership" && (
                  <StepOwnership
                    caseFile={activeCase}
                    onUpdated={refreshCase}
                    onNext={() => setStep("scan")}
                  />
                )}
                {step === "scan" && (
                  <StepScan
                    caseFile={activeCase}
                    onUpdated={refreshCase}
                    onNext={() => setStep("classify")}
                    currency={currency}
                  />
                )}
                {step === "classify" && (
                  <StepClassify
                    caseFile={activeCase}
                    onUpdated={refreshCase}
                    onNext={() =>
                      activeCase.wallets.some((w) => w.classification?.requiresTTP)
                        ? setStep("ttp")
                        : setStep("report")
                    }
                  />
                )}
                {step === "ttp" && (
                  <StepTtp
                    caseFile={activeCase}
                    onUpdated={refreshCase}
                    onNext={() => setStep("report")}
                  />
                )}
                {step === "report" && (
                  <StepReport caseFile={activeCase} onUpdated={refreshCase} />
                )}
              </>
            )}
          </section>
        </div>
      </main>
    </>
  );
}

/* ── Currency toggle ── */
function CurrencyToggle({
  currency,
  onChange,
}: {
  currency: Currency;
  onChange: (c: Currency) => void;
}) {
  const item = (label: Currency) => {
    const active = currency === label;
    return (
      <button
        key={label}
        onClick={() => onChange(label)}
        style={{
          padding: "6px 14px",
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: "0.04em",
          border: "none",
          background: active ? "rgba(255,255,255,0.12)" : "transparent",
          color: active ? "#fff" : "rgba(255,255,255,0.55)",
          cursor: active ? "default" : "pointer",
          borderRadius: 6,
        }}
        aria-pressed={active}
      >
        {label}
      </button>
    );
  };
  return (
    <div
      style={{
        display: "inline-flex",
        gap: 2,
        padding: 3,
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(255,255,255,0.04)",
        borderRadius: 8,
        marginTop: 4,
      }}
      role="group"
      aria-label="Display currency"
    >
      {item("CHF")}
      {item("USD")}
    </div>
  );
}

/* ── Spinner ── */
function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="uc7-spin"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ display: "inline-block", verticalAlign: "middle" }}
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ── Case list ── */
function CaseListView({
  cases,
  onCreate,
  onOpen,
  onDelete,
  loading,
  error,
}: {
  cases: CaseSummary[];
  onCreate: (name: string) => void;
  onOpen: (ref: string) => void;
  onDelete: (ref: string, clientName: string) => void;
  loading: boolean;
  error: string;
}) {
  const [deletingRef, setDeletingRef] = useState<string | null>(null);
  const [name, setName] = useState("");
  return (
    <div>
      <h2 style={h2}>Start a new onboarding case</h2>
      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Client name (internal reference)"
          style={inputStyle}
        />
        <button
          style={primaryBtn}
          onClick={() => name.trim() && onCreate(name.trim())}
          disabled={loading || !name.trim()}
        >
          {loading ? <><Spinner /> &nbsp;Creating…</> : "Create case"}
        </button>
      </div>
      {error && <div style={errorBox}>{error}</div>}
      <h3 style={{ ...h3, marginTop: 32 }}>Existing cases ({cases.length})</h3>
      {cases.length === 0 ? (
        <div style={mutedBlock}>No cases yet.</div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Reference</th>
              <th style={thStyle}>Client</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Risk</th>
              <th style={thStyle}>Wallets</th>
              <th style={thStyle}>Updated</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {cases.map((c) => (
              <tr key={c.caseReference} style={trStyle}>
                <td style={tdStyle}>
                  <code style={{ fontSize: 12 }}>{c.caseReference}</code>
                </td>
                <td style={tdStyle}>{c.clientName}</td>
                <td style={tdStyle}>{c.status}</td>
                <td style={tdStyle}>
                  {c.overallRisk ? <RiskPill tier={c.overallRisk} /> : "—"}
                </td>
                <td style={tdStyle}>{c.walletCount}</td>
                <td style={tdStyle}>{new Date(c.updatedAt).toLocaleDateString()}</td>
                <td style={tdStyle}>
                  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <button style={linkBtn} onClick={() => onOpen(c.caseReference)}>
                      Open
                    </button>
                    <button
                      onClick={async () => {
                        setDeletingRef(c.caseReference);
                        try {
                          await onDelete(c.caseReference, c.clientName);
                        } finally {
                          setDeletingRef(null);
                        }
                      }}
                      disabled={deletingRef === c.caseReference}
                      title={`Delete case ${c.caseReference} and all its data`}
                      aria-label={`Delete case ${c.caseReference}`}
                      style={{
                        background: "transparent",
                        border: "1px solid rgba(239,68,68,0.4)",
                        color: "#fca5a5",
                        borderRadius: 4,
                        padding: "2px 8px",
                        fontSize: 12,
                        cursor: deletingRef === c.caseReference ? "wait" : "pointer",
                        opacity: deletingRef === c.caseReference ? 0.6 : 1,
                      }}
                    >
                      {deletingRef === c.caseReference ? "…" : "🗑 Delete"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ── Case header ── */
function CaseHeader({ caseFile, onClose }: { caseFile: CaseFile; onClose: () => void }) {
  return (
    <div style={caseHeaderStyle}>
      <div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Case {caseFile.caseReference}
        </div>
        <h2 style={{ ...h2, margin: "4px 0 0" }}>{caseFile.clientName}</h2>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginTop: 4 }}>
          Status: {caseFile.status}
          {caseFile.overallRisk && (
            <>
              {" · Overall risk: "}
              <RiskPill tier={caseFile.overallRisk} />
            </>
          )}
        </div>
      </div>
      <button style={secondaryBtn} onClick={onClose}>
        ← All cases
      </button>
    </div>
  );
}

/* ── Stepper ── */
function Stepper({
  step,
  onChange,
  caseFile,
}: {
  step: Step;
  onChange: (s: Step) => void;
  caseFile: CaseFile;
}) {
  const active = STEP_ORDER.indexOf(step);
  return (
    <div style={stepperStyle}>
      {STEP_ORDER.map((s, i) => {
        const isDone = i < active;
        const isActive = i === active;
        return (
          <button
            key={s}
            onClick={() => onChange(s)}
            style={{
              ...stepBtn,
              ...(isActive ? stepBtnActive : {}),
              ...(isDone ? stepBtnDone : {}),
            }}
          >
            {STEP_LABELS[s]}
          </button>
        );
      })}
    </div>
  );
}

/* ── Step 1: setup (add wallets + scan chains) ── */
function StepSetup({
  caseFile,
  setActiveCase,
  onUpdated,
  onNext,
  currency,
}: {
  caseFile: CaseFile;
  setActiveCase: (c: CaseFile) => void;
  onUpdated: (ref: string) => void;
  onNext: () => void;
  currency: Currency;
}) {
  const [addr, setAddr] = useState("");
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [rescanning, setRescanning] = useState<string | null>(null);

  const addWallet = useCallback(async () => {
    const trimmed = addr.trim();
    if (!trimmed) return;
    const detection = detectChain(trimmed);
    if (detection.chainFamily === "unknown") {
      setError("Could not detect chain family for this address");
      return;
    }
    if (caseFile.wallets.some((w) => w.address.toLowerCase() === trimmed.toLowerCase())) {
      setError("Wallet already added");
      return;
    }
    setScanning(true);
    setError("");

    // Optimistic insert — wallet appears immediately while scan runs.
    const optimisticWallet: WalletRecord = {
      address: trimmed,
      chainFamily: detection.chainFamily,
      primaryChain:
        detection.chainFamily === "bitcoin"
          ? "bitcoin"
          : detection.chainFamily === "solana"
          ? "solana"
          : undefined,
    };
    const optimisticCase: CaseFile = {
      ...caseFile,
      wallets: [...caseFile.wallets, optimisticWallet],
    };
    setActiveCase(optimisticCase);
    setAddr("");

    // Persist the wallet (without scan data) FIRST so it survives a scan
    // failure. The scan is the slow part — if Vercel times out the function
    // and returns an HTML error page, the user shouldn't lose the address
    // they just typed. They can hit Re-scan to retry.
    try {
      const persistRes = await fetch(`/api/uc7/case/${caseFile.caseReference}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallets: optimisticCase.wallets }),
      });
      const persistJson = (await persistRes.json().catch(() => ({}))) as { case?: CaseFile };
      if (persistJson.case) setActiveCase(persistJson.case);
    } catch {
      // Persisting failed — fall through to scan attempt; we'll try again
      // after the scan finishes.
    }

    // Helper: read response as text first, then JSON-parse. If the body
    // isn't JSON (e.g. Vercel's HTML "An error occurred" gateway page when
    // a function times out), surface a clean message instead of crashing
    // on `Unexpected token 'A', "An error o"…`.
    async function readJson(res: Response): Promise<{ json: unknown | null; text: string }> {
      const text = await res.text();
      try {
        return { json: JSON.parse(text), text };
      } catch {
        return { json: null, text };
      }
    }

    try {
      const scanRes = await fetch("/api/uc7/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: trimmed }),
      });
      const { json: scanJsonRaw, text: scanText } = await readJson(scanRes);
      if (!scanRes.ok || scanJsonRaw == null) {
        const snippet = scanText.slice(0, 120).replace(/\s+/g, " ").trim();
        throw new Error(
          scanRes.status === 504 || /timeout|time.*out|gateway/i.test(snippet)
            ? "Wallet scan timed out before all chains responded. The wallet has been saved — click Re-scan to try again."
            : `Scan failed (HTTP ${scanRes.status}). ${snippet || "No response body."}`,
        );
      }
      const scanJson = scanJsonRaw as { scan?: WalletScanResult };

      const scan: WalletScanResult | undefined = scanJson.scan ?? undefined;
      const newWallet: WalletRecord = {
        address: trimmed,
        chainFamily: detection.chainFamily,
        scan,
        primaryChain:
          scan?.chains.find((c) => c.hasActivity)?.chain ||
          optimisticWallet.primaryChain,
      };
      const updated: CaseFile = {
        ...optimisticCase,
        wallets: optimisticCase.wallets.map((w) =>
          w.address === trimmed ? newWallet : w
        ),
      };
      setActiveCase(updated);

      // Use the PUT response as the new state of truth — re-fetching via
      // refreshCase here can hit Vercel Blob's eventual-consistency window
      // and return a stale snapshot (without the wallet we just wrote),
      // which then overwrites the freshly-scanned data and makes the row
      // appear to vanish a moment after it shows up.
      const putRes = await fetch(`/api/uc7/case/${caseFile.caseReference}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallets: updated.wallets }),
      });
      const { json: putJsonRaw } = await readJson(putRes);
      const putJson = (putJsonRaw ?? {}) as { case?: CaseFile };
      if (putJson.case) setActiveCase(putJson.case);
    } catch (err) {
      // Wallet is already persisted — leave it on screen so the user can
      // hit Re-scan from the row instead of having to retype the address.
      setError(err instanceof Error ? err.message : "Wallet scan failed");
    } finally {
      setScanning(false);
    }
  }, [addr, caseFile, setActiveCase]);

  const removeWallet = useCallback(
    async (address: string) => {
      const wallets = caseFile.wallets.filter((w) => w.address !== address);
      const updated = { ...caseFile, wallets };
      setActiveCase(updated);
      const putRes = await fetch(`/api/uc7/case/${caseFile.caseReference}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallets }),
      });
      const putJson = (await putRes.json().catch(() => ({}))) as { case?: CaseFile };
      if (putJson.case) setActiveCase(putJson.case);
    },
    [caseFile, setActiveCase]
  );

  const rescan = useCallback(
    async (address: string) => {
      setRescanning(address);
      try {
        const scanRes = await fetch("/api/uc7/scan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address }),
        });
        const scanJson = await scanRes.json();
        const scan: WalletScanResult | undefined = scanJson.scan ?? undefined;
        const wallets = caseFile.wallets.map((w) =>
          w.address === address
            ? {
                ...w,
                scan,
                primaryChain: scan?.chains.find((c) => c.hasActivity)?.chain || w.primaryChain,
              }
            : w
        );
        const updated = { ...caseFile, wallets };
        setActiveCase(updated);
        const putRes = await fetch(`/api/uc7/case/${caseFile.caseReference}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ wallets }),
        });
        const putJson = (await putRes.json().catch(() => ({}))) as { case?: CaseFile };
        if (putJson.case) setActiveCase(putJson.case);
      } finally {
        setRescanning(null);
      }
    },
    [caseFile, setActiveCase]
  );

  return (
    <div>
      <h3 style={h3}>Wallet intake</h3>
      <p style={para}>
        Enter each wallet address the client controls. The system detects the chain family and scans for
        activity across supported networks (native + USDC / USDT / DAI / WETH / WBTC).
      </p>
      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
        <input
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          placeholder="0x… / bc1… / Solana pubkey"
          style={{ ...inputStyle, fontFamily: "monospace" }}
        />
        <button style={primaryBtn} onClick={addWallet} disabled={scanning || !addr.trim()}>
          {scanning ? (
            <>
              <Spinner /> &nbsp;Scanning…
            </>
          ) : (
            "Add wallet"
          )}
        </button>
      </div>
      {error && <div style={errorBox}>{error}</div>}

      <h4 style={h4}>Wallets in case ({caseFile.wallets.length})</h4>
      {caseFile.wallets.length === 0 ? (
        <div style={mutedBlock}>No wallets yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
          {caseFile.wallets.map((w) => {
            const detection = detectChain(w.address);
            const isScanning =
              (scanning && w.address === addr.trim()) || rescanning === w.address;
            const hasScan = !!w.scan;
            const chains = w.scan?.chains ?? [];
            const hasChains = chains.length > 0;
            return (
              <div key={w.address} style={walletCardStyle}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <code style={{ fontSize: 13, color: "#fff" }}>{w.address}</code>
                      {isScanning && <Spinner />}
                    </div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginTop: 4 }}>
                      {chainFamilyLabel(detection.chainFamily)}
                      {detection.subtype && ` · ${detection.subtype}`}
                    </div>
                    {hasScan && (
                      <div style={{ fontSize: 20, fontWeight: 800, color: "#fff", marginTop: 8 }}>
                        {formatMoney(
                          pickValue(
                            w.scan!.totalValueChf,
                            w.scan!.totalValueUsd ?? 0,
                            currency
                          ),
                          currency
                        )}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    {hasScan && !isScanning && (
                      <button style={secondaryBtn} onClick={() => rescan(w.address)}>
                        Re-scan
                      </button>
                    )}
                    <button style={dangerBtn} onClick={() => removeWallet(w.address)}>
                      Remove
                    </button>
                  </div>
                </div>

                {hasScan && w.scan?.warning && (
                  <div style={{ ...errorBox, marginTop: 10 }}>
                    {w.scan.warning}
                  </div>
                )}

                {hasScan && hasChains && (
                  <>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                      {chains.map((c) => (
                        <ChainPill key={c.chain} chain={c} currency={currency} />
                      ))}
                    </div>
                    <details style={{ marginTop: 10 }}>
                      <summary
                        style={{
                          cursor: "pointer",
                          fontSize: 12,
                          color: "rgba(255,255,255,0.55)",
                        }}
                      >
                        View holdings breakdown
                      </summary>
                      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                        {chains.map((c) => (
                          <ChainBreakdown key={c.chain} chain={c} currency={currency} />
                        ))}
                      </div>
                    </details>
                  </>
                )}

                {hasScan && !hasChains && !w.scan?.warning && (
                  <div style={{ ...mutedBlock, marginTop: 10, textAlign: "left" }}>
                    No on-chain activity detected on supported networks.
                  </div>
                )}

                {hasScan && (w.scan?.spamChains?.length ?? 0) > 0 && (
                  <div
                    style={{
                      marginTop: 10,
                      padding: "8px 12px",
                      borderRadius: 6,
                      border: "1px solid rgba(255,255,255,0.08)",
                      background: "rgba(255,255,255,0.02)",
                      color: "rgba(255,255,255,0.55)",
                      fontSize: 12,
                    }}
                  >
                    Excluded as spam-only:{" "}
                    {(w.scan?.spamChains ?? [])
                      .map((sc) => `${sc.chain} (${sc.spamTokenCount} airdrop token${sc.spamTokenCount === 1 ? "" : "s"})`)
                      .join(", ")}
                    .
                  </div>
                )}

                {!hasScan && isScanning && (
                  <div style={{ marginTop: 10, color: "rgba(255,255,255,0.65)", fontSize: 13 }}>
                    <Spinner /> &nbsp;Scanning {detection.chainFamily === "evm" ? "6 EVM chains" : "on-chain activity"}…
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <button style={primaryBtn} onClick={onNext} disabled={caseFile.wallets.length === 0}>
          Proceed to ownership verification →
        </button>
      </div>
    </div>
  );
}

function ChainPill({ chain, currency }: { chain: ChainActivity; currency: Currency }) {
  const total = pickValue(chain.totalChf, chain.totalUsd ?? 0, currency);
  const native = pickValue(chain.nativeBalanceChf, chain.nativeBalanceUsd ?? 0, currency);
  const tokens = pickValue(chain.tokenValueChf, chain.tokenValueUsd ?? 0, currency);
  const tokenSummary = chain.tokenBalances
    .filter((t) => (currency === "USD" ? (t.usd ?? 0) : t.chf) > 0)
    .map((t) => `${t.amount.toLocaleString("de-CH", { maximumFractionDigits: 4 })} ${t.symbol}`)
    .join(", ");
  const title = [
    `${chain.chain}`,
    `Native: ${chain.nativeBalance} (${formatMoney(native, currency)})`,
    tokenSummary ? `Tokens: ${tokenSummary} (${formatMoney(tokens, currency)})` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        padding: "5px 10px",
        background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 6,
        color: "rgba(255,255,255,0.9)",
      }}
    >
      <span style={{ fontWeight: 700, textTransform: "capitalize" }}>{chain.chain}</span>
      <span style={{ color: "rgba(255,255,255,0.55)" }}>·</span>
      <span>{formatMoney(total, currency)}</span>
    </span>
  );
}

function ChainBreakdown({ chain, currency }: { chain: ChainActivity; currency: Currency }) {
  const hasNative = Number(chain.nativeBalance) > 0;
  const tokens = chain.tokenBalances;
  const totalForCurrency = pickValue(chain.totalChf, chain.totalUsd ?? 0, currency);
  const nativeForCurrency = pickValue(chain.nativeBalanceChf, chain.nativeBalanceUsd ?? 0, currency);
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.02)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 6,
        padding: "8px 10px",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: "rgba(255,255,255,0.7)",
          textTransform: "capitalize",
          marginBottom: 6,
        }}
      >
        {chain.chain} · {formatMoney(totalForCurrency, currency)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "2px 12px", fontSize: 12 }}>
        {hasNative && (
          <>
            <span style={{ color: "rgba(255,255,255,0.85)" }}>Native</span>
            <span style={{ color: "rgba(255,255,255,0.7)", textAlign: "right", fontFamily: "monospace" }}>
              {Number(chain.nativeBalance).toLocaleString("de-CH", { maximumFractionDigits: 6 })}
            </span>
            <span style={{ color: "#fff", textAlign: "right" }}>
              {formatMoney(nativeForCurrency, currency)}
            </span>
          </>
        )}
        {tokens.map((t) => {
          const dim = !!t.suspicious;
          const labelColor = dim ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.85)";
          const valueColor = dim ? "rgba(255,255,255,0.4)" : "#fff";
          const tokenValue = pickValue(t.chf, t.usd ?? 0, currency);
          const isUnpriced = !t.suspicious && t.chf === 0 && (t.usd ?? 0) === 0;
          return (
            <span key={t.contractAddress || t.symbol} style={{ display: "contents" }}>
              <span style={{ color: labelColor }} title={t.contractAddress}>
                {t.symbol}
                {t.suspicious ? (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 10,
                      color: "#fca5a5",
                      border: "1px solid rgba(239,68,68,0.4)",
                      padding: "0 4px",
                      borderRadius: 3,
                    }}
                    title="Likely airdrop spam — excluded from total"
                  >
                    spam
                  </span>
                ) : isUnpriced ? (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 10,
                      color: "#fbbf24",
                      border: "1px solid rgba(245,158,11,0.3)",
                      padding: "0 4px",
                      borderRadius: 3,
                    }}
                  >
                    unpriced
                  </span>
                ) : null}
              </span>
              <span style={{ color: dim ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.7)", textAlign: "right", fontFamily: "monospace" }}>
                {t.amount.toLocaleString("de-CH", { maximumFractionDigits: 4 })}
              </span>
              <span style={{ color: valueColor, textAlign: "right" }}>
                {formatMoney(tokenValue, currency)}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ── Step 2: ownership ── */
function StepOwnership({
  caseFile,
  onUpdated,
  onNext,
}: {
  caseFile: CaseFile;
  onUpdated: (ref: string) => void;
  onNext: () => void;
}) {
  const [loadingAddr, setLoadingAddr] = useState<string | null>(null);

  const generateChallenge = useCallback(
    async (address: string) => {
      setLoadingAddr(address);
      try {
        await fetch("/api/uc7/challenge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ caseReference: caseFile.caseReference, address }),
        });
        onUpdated(caseFile.caseReference);
      } finally {
        setLoadingAddr(null);
      }
    },
    [caseFile, onUpdated]
  );

  useEffect(() => {
    const anyPending = caseFile.wallets.some((w) => w.challenge && w.challenge.status === "pending");
    if (!anyPending) return;
    const id = setInterval(() => onUpdated(caseFile.caseReference), 4000);
    return () => clearInterval(id);
  }, [caseFile, onUpdated]);

  const allVerified = caseFile.wallets.every((w) => w.challenge?.status === "verified");

  return (
    <div>
      <h3 style={h3}>Ownership verification</h3>
      <p style={para}>
        Generate a challenge per wallet. The client scans the QR code with their phone (or opens the link),
        signs the challenge in their wallet app, and control is cryptographically proven.
      </p>
      {caseFile.wallets.length === 0 && <div style={mutedBlock}>No wallets yet.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 12 }}>
        {caseFile.wallets.map((w) => (
          <OwnershipRow
            key={w.address}
            wallet={w}
            loading={loadingAddr === w.address}
            onGenerate={() => generateChallenge(w.address)}
            caseReference={caseFile.caseReference}
            onUpdated={onUpdated}
          />
        ))}
      </div>
      <div style={{ marginTop: 24 }}>
        <button style={primaryBtn} onClick={onNext} disabled={!allVerified}>
          Proceed to source trace →
        </button>
        {!allVerified && (
          <span style={{ marginLeft: 12, color: "rgba(255,255,255,0.55)", fontSize: 12 }}>
            All wallets must be verified to continue
          </span>
        )}
      </div>
    </div>
  );
}

function OwnershipRow({
  wallet,
  loading,
  onGenerate,
  caseReference,
  onUpdated,
}: {
  wallet: WalletRecord;
  loading: boolean;
  onGenerate: () => void;
  caseReference: string;
  onUpdated: (ref: string) => void;
}) {
  const challenge = wallet.challenge;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const signUrl = challenge ? `${origin}/uc7-sign/${challenge.challengeId}` : "";
  // Per-EVM-challenge WalletConnect session. When the user scans the WC QR
  // with any compatible mobile wallet (MetaMask, Trust, Rainbow, Argent,
  // Safe, OKX, Zerion, Ledger Live, Coinbase, …) the wallet pairs with
  // this page, we push a personal_sign request, the user signs in their
  // app, and the signature flows back to /api/uc7/verify-signature — no
  // browser hop required.
  const [wcUri, setWcUri] = useState<string | null>(null);
  const [wcPhase, setWcPhase] = useState<
    "idle" | "init" | "awaiting-scan" | "signing" | "verifying" | "error"
  >("idle");
  const [wcError, setWcError] = useState("");
  const [wcRetryKey, setWcRetryKey] = useState(0);

  // Pull stable primitives off the challenge so the effect below doesn't
  // re-run (and tear down the live WalletConnect session) every 4 seconds
  // when the parent polls /api/uc7/case and produces a new challenge object
  // reference. Effect dependencies must be primitives that only change when
  // the challenge identity or content actually changes.
  const challengeId = challenge?.challengeId;
  const challengeMessage = challenge?.message;
  const challengeStatus = challenge?.status;
  const walletAddress = wallet.address;
  const walletChainFamily = wallet.chainFamily;

  useEffect(() => {
    if (challengeStatus !== "pending") return;
    if (walletChainFamily !== "evm") return;
    if (!challengeId || !challengeMessage) return;
    if (!WC_PROJECT_ID) return;

    let cancelled = false;
    type WcProvider = {
      accounts?: string[];
      on: (event: string, cb: (...args: unknown[]) => void) => void;
      connect: () => Promise<void>;
      disconnect: () => Promise<void>;
      request: (args: { method: string; params: unknown[] }) => Promise<unknown>;
    };
    let provider: WcProvider | null = null;

    setWcPhase("init");
    setWcError("");
    setWcUri(null);

    (async () => {
      try {
        const mod = await import("@walletconnect/ethereum-provider");
        const inited = await mod.EthereumProvider.init({
          projectId: WC_PROJECT_ID,
          chains: [1],
          optionalChains: [10, 56, 137, 8453, 42161, 43114],
          showQrModal: false,
          metadata: {
            name: "Wallet Ownership Verification",
            description: "Sign a challenge to prove control of your wallet.",
            url: typeof window !== "undefined" ? window.location.origin : "",
            icons: [],
          },
        });
        provider = inited as unknown as WcProvider;

        provider.on("display_uri", (...args: unknown[]) => {
          if (cancelled) return;
          const uri = typeof args[0] === "string" ? args[0] : "";
          if (uri) {
            setWcUri(uri);
            setWcPhase("awaiting-scan");
          }
        });

        await provider.connect();
        if (cancelled) {
          await provider.disconnect().catch(() => {});
          return;
        }

        const accounts = provider.accounts || [];
        const signingAddr = (accounts[0] || "").toLowerCase();
        if (!signingAddr) {
          throw new Error("Wallet did not return a signing account");
        }
        if (signingAddr !== walletAddress.toLowerCase()) {
          setWcError(
            `The wallet you connected (${signingAddr}) does not match the expected address. Reconnect with the correct account in your wallet app.`,
          );
          setWcPhase("error");
          await provider.disconnect().catch(() => {});
          return;
        }

        setWcPhase("signing");
        // personal_sign requires the message as a 0x-prefixed hex string in
        // many wallets (Rabby, certain Trust builds, hardware-wallet flows
        // routed via WC). Plain strings work for some MetaMask paths but not
        // universally — hex-encoding is the safe choice and is what the
        // EIP-191 spec describes anyway.
        const messageHex =
          "0x" +
          Array.from(new TextEncoder().encode(challengeMessage))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
        const sig = await provider.request({
          method: "personal_sign",
          params: [messageHex, signingAddr],
        });
        const signature = typeof sig === "string" ? sig : "";
        if (cancelled) {
          await provider.disconnect().catch(() => {});
          return;
        }

        setWcPhase("verifying");
        const res = await fetch("/api/uc7/verify-signature", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ challengeId, signature }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          result?: { ok?: boolean; error?: string };
        };
        if (cancelled) {
          await provider.disconnect().catch(() => {});
          return;
        }
        if (json.result?.ok) {
          onUpdated(caseReference);
        } else {
          setWcError(json.result?.error || "Signature verification failed");
          setWcPhase("error");
        }
        await provider.disconnect().catch(() => {});
      } catch (err) {
        if (cancelled) return;
        setWcError(err instanceof Error ? err.message : "WalletConnect failed");
        setWcPhase("error");
        if (provider) {
          await provider.disconnect().catch(() => {});
        }
      }
    })();

    return () => {
      cancelled = true;
      if (provider) provider.disconnect().catch(() => {});
    };
  }, [
    challengeId,
    challengeMessage,
    challengeStatus,
    walletAddress,
    walletChainFamily,
    caseReference,
    onUpdated,
    wcRetryKey,
  ]);

  // What goes into the QR. For EVM with a live WC session, that's the wc:
  // URI the wallet apps know how to handle. Otherwise we fall back to a
  // chain-appropriate URL: MetaMask universal link for EVM, bare sign URL
  // for Solana/Bitcoin (Phantom etc. won't follow metamask.app.link).
  const qrData =
    wallet.chainFamily === "evm" && wcUri
      ? wcUri
      : wallet.chainFamily === "evm" && challenge && origin
        ? `https://metamask.app.link/dapp/${origin.replace(/^https?:\/\//, "")}/uc7-sign/${challenge.challengeId}`
        : signUrl;

  const qrUsesWc = wallet.chainFamily === "evm" && !!wcUri;
  const qrCaption = qrUsesWc
    ? "Scan with any mobile wallet — MetaMask, Trust, Rainbow, Argent, Safe, Coinbase, …"
    : wallet.chainFamily === "evm"
      ? "Opens inside MetaMask's in-app browser. Other wallets: use the link below."
      : "Scan to open the signing page on your phone.";

  return (
    <div style={walletCardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <code style={{ fontSize: 13, color: "#fff" }}>{wallet.address}</code>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginTop: 4 }}>
            {chainFamilyLabel(wallet.chainFamily)}
            {challenge?.status === "verified" && (
              <span style={{ marginLeft: 10, color: "#6ee7b7", fontWeight: 700 }}>✓ Verified</span>
            )}
            {challenge?.status === "failed" && (
              <span style={{ marginLeft: 10, color: "#fca5a5", fontWeight: 700 }}>✗ Failed</span>
            )}
            {challenge?.status === "pending" && wcPhase === "signing" && (
              <span style={{ marginLeft: 10, color: "#fbbf24" }}>✍️ Awaiting wallet signature…</span>
            )}
            {challenge?.status === "pending" && wcPhase === "verifying" && (
              <span style={{ marginLeft: 10, color: "#fbbf24" }}>⏳ Verifying signature…</span>
            )}
            {challenge?.status === "pending" && wcPhase !== "signing" && wcPhase !== "verifying" && (
              <span style={{ marginLeft: 10, color: "#fbbf24" }}>⏳ Waiting for signature</span>
            )}
          </div>
        </div>
        {!challenge || challenge.status === "failed" ? (
          <button style={primaryBtn} onClick={onGenerate} disabled={loading}>
            {loading ? <><Spinner /> &nbsp;Generating…</> : "Generate challenge"}
          </button>
        ) : null}
      </div>

      {challenge && challenge.status !== "verified" && (
        <div style={{ marginTop: 14, display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", marginBottom: 6 }}>
              {qrUsesWc ? "WalletConnect QR — sign in any mobile wallet" : "QR code"}
            </div>
            {wallet.chainFamily === "evm" && wcPhase === "init" && !wcUri ? (
              <div
                style={{
                  width: 180,
                  height: 180,
                  background: "rgba(255,255,255,0.03)",
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "rgba(255,255,255,0.55)",
                  fontSize: 12,
                }}
              >
                <Spinner /> &nbsp;Opening session…
              </div>
            ) : (
              <img
                alt="Sign challenge"
                src={`/api/uc7/qr?data=${encodeURIComponent(qrData)}`}
                style={{ width: 180, height: 180, background: "#fff", borderRadius: 8, padding: 6 }}
              />
            )}
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginTop: 6, lineHeight: 1.4, maxWidth: 180 }}>
              {qrCaption}
            </div>
            {wallet.chainFamily === "evm" && wcPhase === "error" && wcError && (
              <div style={{ ...errorBox, marginTop: 8, maxWidth: 180, fontSize: 11 }}>
                {wcError}
                <button
                  style={{ ...secondaryBtn, marginTop: 6, padding: "4px 10px", fontSize: 11 }}
                  onClick={() => setWcRetryKey((k) => k + 1)}
                >
                  Retry connection
                </button>
              </div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", marginBottom: 4 }}>Challenge message</div>
            <pre style={preBlock}>{challenge.message}</pre>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", marginTop: 10, marginBottom: 4 }}>
              Shareable link (send to client)
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <code style={{ ...codeInline, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {signUrl}
              </code>
              <button
                style={secondaryBtn}
                onClick={() => navigator.clipboard?.writeText(signUrl)}
              >
                Copy
              </button>
            </div>
            {challenge.failReason && (
              <div style={{ ...errorBox, marginTop: 8 }}>{challenge.failReason}</div>
            )}
          </div>
        </div>
      )}

      {challenge && challenge.status === "verified" && (
        <VerificationProof challenge={challenge} origin={origin} />
      )}
    </div>
  );
}

/**
 * Shows the cryptographic proof for a verified ownership signature.
 * EIP-191 / Ed25519 signatures are off-chain — there's no transaction
 * hash to link to — but the message + signature + recovered address
 * are sufficient evidence for any auditor.
 */
function VerificationProof({
  challenge,
  origin,
}: {
  challenge: NonNullable<WalletRecord["challenge"]>;
  origin: string;
}) {
  const verifyUrl = `${origin}/uc7-verify/${challenge.challengeId}`;
  const sig = challenge.signature || "";

  const labelStyle: CSSProperties = {
    fontSize: 11,
    color: "rgba(255,255,255,0.55)",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    fontWeight: 700,
    marginBottom: 4,
  };
  const codeBox: CSSProperties = {
    background: "rgba(0,0,0,0.25)",
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: 6,
    padding: 10,
    fontSize: 11,
    color: "#fff",
    fontFamily: "monospace",
    wordBreak: "break-all",
  };

  return (
    <div
      style={{
        marginTop: 14,
        padding: 14,
        borderRadius: 8,
        background: "rgba(16,185,129,0.05)",
        border: "1px solid rgba(16,185,129,0.25)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, color: "#6ee7b7" }}>
          ✓ Cryptographic ownership proof
        </div>
        <a
          href={verifyUrl}
          target="_blank"
          rel="noreferrer"
          style={{
            fontSize: 12,
            color: "#93c5fd",
            textDecoration: "none",
            border: "1px solid rgba(147,197,253,0.4)",
            padding: "4px 10px",
            borderRadius: 4,
          }}
        >
          Open public verification page ↗
        </a>
      </div>
      <div
        style={{
          fontSize: 11,
          color: "rgba(255,255,255,0.55)",
          marginBottom: 10,
          lineHeight: 1.5,
        }}
      >
        Off-chain {challenge.chainFamily === "evm" ? "EIP-191" : "Ed25519"} signature — no
        gas, no on-chain transaction. The data below is the complete proof and can be
        re-verified independently with{" "}
        <code style={{ background: "rgba(255,255,255,0.05)", padding: "1px 4px", borderRadius: 3 }}>
          {challenge.chainFamily === "evm" ? "ethers.verifyMessage(...)" : "nacl.sign.detached.verify(...)"}
        </code>{" "}
        or any standard verifier.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 12px" }}>
        <div style={labelStyle}>Wallet</div>
        <div style={codeBox}>{challenge.address}</div>

        <div style={labelStyle}>Verified at</div>
        <div style={codeBox}>{challenge.verifiedAt}</div>

        <div style={labelStyle}>Nonce</div>
        <div style={codeBox}>{challenge.nonce}</div>

        <div style={labelStyle}>Signature</div>
        <div style={codeBox}>
          {sig ? sig : "—"}
          {sig && (
            <button
              onClick={() => navigator.clipboard?.writeText(sig)}
              style={{
                marginLeft: 8,
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.15)",
                color: "rgba(255,255,255,0.65)",
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 3,
                cursor: "pointer",
              }}
            >
              Copy
            </button>
          )}
        </div>

        <div style={labelStyle}>Verifier link</div>
        <div style={codeBox}>
          <a href={verifyUrl} target="_blank" rel="noreferrer" style={{ color: "#93c5fd" }}>
            {verifyUrl}
          </a>
        </div>
      </div>
    </div>
  );
}

/* ── Step 3: source trace ── */
const TRACE_PROGRESS_STAGES = [
  "Pulling incoming transactions…",
  "Resolving counterparties via label DB…",
  "Screening against OFAC SDN list…",
  "Evaluating multi-hop provenance…",
];

function StepScan({
  caseFile,
  onUpdated,
  onNext,
  currency,
}: {
  caseFile: CaseFile;
  onUpdated: (ref: string) => void;
  onNext: () => void;
  currency: Currency;
}) {
  const [runningSet, setRunningSet] = useState<Set<string>>(new Set());
  // Tracks per-(wallet,chain) retries: key = "address::chain"
  const [retryingChains, setRetryingChains] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const runTrace = useCallback(
    async (address: string, chains?: string[]) => {
      setRunningSet((prev) => new Set(prev).add(address));
      if (chains) {
        setRetryingChains((prev) => {
          const next = new Set(prev);
          for (const c of chains) next.add(`${address.toLowerCase()}::${c}`);
          return next;
        });
      }
      try {
        await fetch("/api/uc7/trace", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            caseReference: caseFile.caseReference,
            address,
            ...(chains && chains.length > 0 ? { chains } : {}),
          }),
        });
        onUpdated(caseFile.caseReference);
      } finally {
        setRunningSet((prev) => {
          const next = new Set(prev);
          next.delete(address);
          return next;
        });
        if (chains) {
          setRetryingChains((prev) => {
            const next = new Set(prev);
            for (const c of chains) next.delete(`${address.toLowerCase()}::${c}`);
            return next;
          });
        }
      }
    },
    [caseFile.caseReference, onUpdated]
  );

  const runAll = useCallback(async () => {
    const addresses = caseFile.wallets.map((w) => w.address);
    setProgress({ done: 0, total: addresses.length });
    for (let i = 0; i < addresses.length; i++) {
      setProgress({ done: i, total: addresses.length });
      await runTrace(addresses[i]);
    }
    setProgress(null);
  }, [caseFile.wallets, runTrace]);

  const allTraced = caseFile.wallets.every(
    (w) => (w.traces && w.traces.length > 0) || w.trace
  );
  const anyRunning = runningSet.size > 0;

  return (
    <div>
      <h3 style={h3}>Backward source trace</h3>
      <p style={para}>
        Pull incoming transactions, identify counterparties via Etherscan labels, eth-labels, and OFAC screening,
        and build a hop-by-hop picture of where the wealth came from. Maximum depth: {caseFile.settings.maxHopDepth} hops.
      </p>
      <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 16 }}>
        <button style={primaryBtn} onClick={runAll} disabled={anyRunning}>
          {anyRunning ? <><Spinner /> &nbsp;Tracing…</> : "Run trace on all wallets"}
        </button>
        {progress && (
          <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 13 }}>
            Wallet {Math.min(progress.done + 1, progress.total)} / {progress.total}
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {caseFile.wallets.map((w) => (
          <TraceRow
            key={w.address}
            wallet={w}
            running={runningSet.has(w.address)}
            onRun={() => runTrace(w.address)}
            onRunChain={(chain) => runTrace(w.address, [chain])}
            retryingChains={retryingChains}
            currency={currency}
          />
        ))}
      </div>
      <div style={{ marginTop: 24 }}>
        <button style={primaryBtn} onClick={onNext} disabled={!allTraced}>
          Proceed to classification →
        </button>
      </div>
    </div>
  );
}

function TraceRow({
  wallet,
  running,
  onRun,
  onRunChain,
  retryingChains,
  currency,
}: {
  wallet: WalletRecord;
  running: boolean;
  onRun: () => void;
  onRunChain: (chain: string) => void;
  retryingChains: Set<string>;
  currency: Currency;
}) {
  // Prefer the new multi-chain `traces` array; fall back to the legacy single
  // `trace` field for cases that haven't been re-traced since the rewrite.
  const traces: TraceResult[] =
    (wallet.traces && wallet.traces.length > 0
      ? wallet.traces
      : wallet.trace
        ? [wallet.trace]
        : []) as TraceResult[];

  // Hint for cases where the on-disk data is the old single-chain shape but
  // the wallet's scan reports more active chains than the trace covers.
  const scanChains =
    wallet.scan?.chains.filter((c) => c.hasActivity).map((c) => c.chain) ?? [];
  const tracedChains = new Set(traces.map((t) => t.chain));
  const missingChains = scanChains.filter((c) => !tracedChains.has(c));
  const showStaleHint =
    traces.length > 0 && !wallet.traces && missingChains.length > 0;
  const showMissingHint =
    !!wallet.traces && missingChains.length > 0;

  const [stage, setStage] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (running) {
      setStage(0);
      timerRef.current = setInterval(() => {
        setStage((s) => (s + 1) % TRACE_PROGRESS_STAGES.length);
      }, 2200);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [running]);

  // Wallet-level aggregates across all traced chains.
  const walletTotalChf = traces.reduce((s, t) => s + t.totalIncomingValueChf, 0);
  const walletTotalUsd = traces.reduce((s, t) => s + (t.totalIncomingValueUsd ?? 0), 0);
  const walletAttributedChf = traces.reduce((s, t) => s + t.attributedValueChf, 0);
  const walletAttributedUsd = traces.reduce(
    (s, t) => s + (t.attributedValueUsd ?? 0),
    0
  );
  const walletAttributedPct = walletTotalChf > 0 ? walletAttributedChf / walletTotalChf : 0;
  const walletSanctionsCount = traces.reduce((s, t) => s + t.sanctionsHits.length, 0);

  return (
    <div style={walletCardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <code style={{ fontSize: 13, color: "#fff" }}>{wallet.address}</code>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginTop: 4 }}>
            {chainFamilyLabel(wallet.chainFamily)}
            {traces.length > 0 && ` · traced on ${traces.map((t) => t.chain).join(", ")}`}
          </div>
        </div>
        <button style={primaryBtn} onClick={onRun} disabled={running}>
          {running ? (
            <>
              <Spinner /> &nbsp;Tracing…
            </>
          ) : traces.length > 0 ? (
            "Re-run trace"
          ) : (
            "Run trace"
          )}
        </button>
      </div>

      {running && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 14px",
            background: "rgba(59,130,246,0.08)",
            border: "1px solid rgba(59,130,246,0.25)",
            borderRadius: 8,
            color: "#cbd5f5",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Spinner /> {TRACE_PROGRESS_STAGES[stage]}
        </div>
      )}

      {!running && traces.length > 0 && (
        <div style={{ marginTop: 14 }}>
          {/* Wallet-level aggregate header */}
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 16 }}>
            <Stat
              label="Total coverage"
              value={`${(walletAttributedPct * 100).toFixed(1)}%`}
              color={
                walletAttributedPct >= 0.9
                  ? "#10b981"
                  : walletAttributedPct >= 0.6
                  ? "#f59e0b"
                  : "#ef4444"
              }
            />
            <Stat
              label="Attributed"
              value={formatMoney(
                pickValue(walletAttributedChf, walletAttributedUsd, currency),
                currency
              )}
            />
            <Stat
              label="Total inflow"
              value={formatMoney(
                pickValue(walletTotalChf, walletTotalUsd, currency),
                currency
              )}
            />
            <Stat label="Chains traced" value={`${traces.length}`} />
            <Stat
              label="Sanctions"
              value={walletSanctionsCount > 0 ? `${walletSanctionsCount} hit` : "Clean"}
              color={walletSanctionsCount > 0 ? "#ef4444" : "#10b981"}
            />
          </div>

          {(showStaleHint || showMissingHint) && (
            <div
              style={{
                marginBottom: 12,
                padding: "10px 14px",
                borderRadius: 8,
                background: "rgba(245,158,11,0.08)",
                border: "1px solid rgba(245,158,11,0.35)",
                color: "#fbbf24",
                fontSize: 13,
              }}
            >
              {showStaleHint
                ? `This trace was run before multi-chain support. The wallet has activity on ${missingChains.join(", ")} which haven't been traced yet — click `
                : `${missingChains.join(", ")} ${missingChains.length === 1 ? "is" : "are"} active per the scan but missing from the trace results. Click `}
              <strong>Re-run trace</strong>
              {" "}above to scan {missingChains.length === 1 ? "it" : "them"} too.
            </div>
          )}

          {/* One card per chain with its own hop tree */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {traces.map((trace) => (
              <ChainTraceCard
                key={trace.chain}
                trace={trace}
                currency={currency}
                onRetry={() => onRunChain(trace.chain)}
                retrying={retryingChains.has(`${wallet.address.toLowerCase()}::${trace.chain}`)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Per-chain trace card with hop tree ── */
function ChainTraceCard({
  trace,
  currency,
  onRetry,
  retrying,
}: {
  trace: TraceResult;
  currency: Currency;
  onRetry: () => void;
  retrying: boolean;
}) {
  const noActivity = trace.sources.length === 0 && trace.totalIncomingValueChf === 0;

  return (
    <div
      style={{
        border: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(255,255,255,0.02)",
        borderRadius: 10,
        padding: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#fff", textTransform: "capitalize" }}>
            {trace.chain}
          </div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginTop: 2 }}>
            {(trace.attributedPercentage * 100).toFixed(1)}% attributed ·{" "}
            {formatMoney(
              pickValue(trace.attributedValueChf, trace.attributedValueUsd ?? 0, currency),
              currency
            )}{" "}
            of{" "}
            {formatMoney(
              pickValue(trace.totalIncomingValueChf, trace.totalIncomingValueUsd ?? 0, currency),
              currency
            )}{" "}
            inflow · hops {trace.hopsUsed}/{trace.maxHopsConfigured}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {trace.sanctionsHits.length > 0 && (
            <span
              style={{
                fontSize: 11,
                color: "#fca5a5",
                background: "rgba(239,68,68,0.12)",
                border: "1px solid rgba(239,68,68,0.4)",
                padding: "3px 8px",
                borderRadius: 4,
                fontWeight: 700,
              }}
            >
              ⚠ {trace.sanctionsHits.length} OFAC HIT
            </span>
          )}
          <button
            onClick={onRetry}
            disabled={retrying}
            style={{
              ...secondaryBtn,
              fontSize: 12,
              padding: "4px 10px",
              opacity: retrying ? 0.7 : 1,
              cursor: retrying ? "default" : "pointer",
            }}
            title={`Re-run trace for ${trace.chain} only`}
          >
            {retrying ? (
              <>
                <Spinner /> &nbsp;Retrying…
              </>
            ) : (
              "↻ Retry chain"
            )}
          </button>
        </div>
      </div>

      {trace.sanctionsHits.length > 0 && (
        <div style={{ ...errorBox, marginTop: 10 }}>
          <strong>OFAC SDN match:</strong>{" "}
          {trace.sanctionsHits.map((h) => h.reason).join(", ")}
        </div>
      )}

      {trace.warning && (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            background: "rgba(245,158,11,0.08)",
            border: "1px solid rgba(245,158,11,0.4)",
            borderRadius: 6,
            color: "#fbbf24",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          ⚠ {trace.warning}
        </div>
      )}

      {noActivity ? (
        <div style={{ ...mutedBlock, textAlign: "left", marginTop: 12 }}>
          {retrying
            ? "Retrying…"
            : "No priced inflows detected on this chain. Try Retry chain — sometimes Etherscan rate-limits one chain while the others succeed."}
        </div>
      ) : (
        <>
          <div style={{ marginTop: 14 }}>
            <details open style={{ marginBottom: 8 }}>
              <summary
                style={{
                  cursor: "pointer",
                  fontSize: 12,
                  color: "rgba(255,255,255,0.65)",
                  marginBottom: 8,
                }}
              >
                Fund flow diagram
              </summary>
              <FundFlowDiagram trace={trace} height={320} currency={currency} />
            </details>
          </div>
          <h5 style={{ ...h4, fontSize: 12 }}>Hop 1 incoming transactions</h5>
          <Hop1InflowTable trace={trace} currency={currency} />
        </>
      )}
    </div>
  );
}

/* ── Hop-1 inflow table (Etherscan-style, one per chain) ── */
type TxStatus = "identified" | "sanctioned" | "infrastructure" | "unknown";

function txStatus(tx: TraceTx): TxStatus {
  const l = tx.fromLabel;
  if (!l) return "unknown";
  if (l.sanctioned || l.entityType === "mixer") return "sanctioned";
  if (l.entityType === "exchange") return "identified";
  if (l.entityType === "mining_pool" || l.entityType === "staking") return "identified";
  if (l.entityType === "dex" || l.entityType === "bridge" || l.entityType === "contract") {
    return "infrastructure";
  }
  return "unknown";
}

function shortHex(s: string, head = 6, tail = 4): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function timeAgo(ms: number): string {
  const days = Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24));
  if (days < 1) return "today";
  if (days === 1) return "1 day ago";
  if (days < 60) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months} mo ago`;
  return `${Math.floor(days / 365)} y ago`;
}

function explorerBase(chain: string): string | null {
  const map: Record<string, string> = {
    ethereum: "https://etherscan.io",
    arbitrum: "https://arbiscan.io",
    base: "https://basescan.org",
    polygon: "https://polygonscan.com",
    bsc: "https://bscscan.com",
    optimism: "https://optimistic.etherscan.io",
    avalanche: "https://snowtrace.io",
    monad: "https://monadexplorer.com",
  };
  return map[chain] ?? null;
}

function Hop1InflowTable({
  trace,
  currency,
}: {
  trace: TraceResult;
  currency: Currency;
}) {
  const txs = trace.inflowsByParent?.[trace.walletAddress.toLowerCase()] ?? [];

  if (txs.length === 0) {
    return (
      <div
        style={{
          fontSize: 12,
          color: "rgba(255,255,255,0.45)",
          padding: 14,
          background: "rgba(255,255,255,0.02)",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 6,
          textAlign: "center",
        }}
      >
        No incoming transactions detected on this chain.
      </div>
    );
  }

  const explorer = explorerBase(trace.chain);
  const labeledCount = txs.filter((t) => txStatus(t) === "identified" || txStatus(t) === "sanctioned").length;

  const colHeader: CSSProperties = {
    fontSize: 10,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.55)",
    fontWeight: 700,
    padding: "6px 8px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    textAlign: "left",
    whiteSpace: "nowrap",
  };
  const cell: CSSProperties = {
    padding: "8px 8px",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
    fontSize: 12,
    verticalAlign: "middle",
    color: "rgba(255,255,255,0.85)",
  };

  return (
    <div>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", marginBottom: 6 }}>
        Latest {txs.length} ERC-20 + native incoming transfer{txs.length === 1 ? "" : "s"} ·{" "}
        <span style={{ color: "#6ee7b7" }}>{labeledCount} labeled</span>{" "}
        / <span style={{ color: "#fbbf24" }}>{txs.length - labeledCount} unknown</span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ ...colHeader, width: 10 }}></th>
              <th style={colHeader}>Tx Hash</th>
              <th style={colHeader}>Block</th>
              <th style={colHeader}>Age</th>
              <th style={colHeader}>From</th>
              <th style={{ ...colHeader, textAlign: "center" }}>Dir</th>
              <th style={{ ...colHeader, textAlign: "right" }}>Amount</th>
              <th style={colHeader}>Token</th>
              <th style={{ ...colHeader, textAlign: "right" }}>Value</th>
            </tr>
          </thead>
          <tbody>
            {txs.map((tx, i) => {
              const status = txStatus(tx);
              const tier = tx.fromLabel?.exchangeTier;
              const dotColor =
                status === "sanctioned"
                  ? "#ef4444"
                  : status === "identified"
                  ? "#10b981"
                  : status === "infrastructure"
                  ? "#cbd5f5"
                  : "#fbbf24";
              const rowBg =
                status === "sanctioned" ? "rgba(239,68,68,0.06)" : "transparent";
              const value = pickValue(tx.valueChf, tx.valueUsd, currency);
              const fromExplorerUrl = explorer ? `${explorer}/address/${tx.fromAddress}` : null;
              const txExplorerUrl = explorer ? `${explorer}/tx/${tx.txHash}` : null;

              return (
                <tr key={`${tx.txHash}-${i}`} style={{ background: rowBg }}>
                  <td style={cell}>
                    <span
                      title={
                        status === "sanctioned"
                          ? "Sanctioned (OFAC SDN)"
                          : status === "identified"
                          ? "Identified entity"
                          : status === "infrastructure"
                          ? "Infrastructure (DEX / bridge / contract)"
                          : "Unknown sender"
                      }
                      style={{
                        display: "inline-block",
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        background: dotColor,
                      }}
                    />
                  </td>
                  <td style={{ ...cell, fontFamily: "monospace", fontSize: 11 }}>
                    {txExplorerUrl ? (
                      <a
                        href={txExplorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: "#93c5fd", textDecoration: "none" }}
                        title={tx.txHash}
                      >
                        {shortHex(tx.txHash, 8, 4)}
                      </a>
                    ) : (
                      <span title={tx.txHash}>{shortHex(tx.txHash, 8, 4)}</span>
                    )}
                  </td>
                  <td style={{ ...cell, fontFamily: "monospace", color: "rgba(255,255,255,0.6)" }}>
                    {tx.blockNumber ?? "—"}
                  </td>
                  <td style={{ ...cell, color: "rgba(255,255,255,0.6)", whiteSpace: "nowrap" }}>
                    {timeAgo(tx.timestamp)}
                  </td>
                  <td style={cell}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      {tx.fromLabel?.name ? (
                        <>
                          {fromExplorerUrl ? (
                            <a
                              href={fromExplorerUrl}
                              target="_blank"
                              rel="noreferrer"
                              style={{
                                color: "#fff",
                                fontWeight: 600,
                                textDecoration: "none",
                              }}
                            >
                              {tx.fromLabel.name}
                            </a>
                          ) : (
                            <span style={{ color: "#fff", fontWeight: 600 }}>
                              {tx.fromLabel.name}
                            </span>
                          )}
                          {tier && <ExchangeTierBadge tier={tier} size="sm" />}
                          {status === "sanctioned" && (
                            <span
                              style={{
                                fontSize: 9,
                                color: "#fca5a5",
                                border: "1px solid rgba(239,68,68,0.5)",
                                padding: "0 4px",
                                borderRadius: 3,
                                fontWeight: 800,
                                letterSpacing: "0.04em",
                              }}
                            >
                              OFAC
                            </span>
                          )}
                        </>
                      ) : (
                        <span style={{ color: "rgba(255,255,255,0.5)" }}>Unknown</span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: "rgba(255,255,255,0.45)",
                        fontFamily: "monospace",
                        marginTop: 2,
                      }}
                    >
                      {fromExplorerUrl ? (
                        <a
                          href={fromExplorerUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "rgba(255,255,255,0.45)", textDecoration: "none" }}
                          title={tx.fromAddress}
                        >
                          {shortHex(tx.fromAddress, 10, 6)}
                        </a>
                      ) : (
                        <span title={tx.fromAddress}>{shortHex(tx.fromAddress, 10, 6)}</span>
                      )}
                    </div>
                  </td>
                  <td style={{ ...cell, textAlign: "center" }}>
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 800,
                        letterSpacing: "0.05em",
                        color: "#6ee7b7",
                        background: "rgba(16,185,129,0.1)",
                        border: "1px solid rgba(16,185,129,0.4)",
                        padding: "1px 6px",
                        borderRadius: 4,
                      }}
                    >
                      IN
                    </span>
                  </td>
                  <td style={{ ...cell, textAlign: "right", fontFamily: "monospace" }}>
                    {tx.amount.toLocaleString("de-CH", { maximumFractionDigits: 6 })}
                  </td>
                  <td style={{ ...cell, fontWeight: 600 }}>{tx.token}</td>
                  <td style={{ ...cell, textAlign: "right" }}>
                    {tx.unpriced ? (
                      <span style={{ color: "rgba(255,255,255,0.4)" }}>unpriced</span>
                    ) : (
                      formatMoney(value, currency)
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Step 4: classify ── */
function StepClassify({
  caseFile,
  onUpdated,
  onNext,
}: {
  caseFile: CaseFile;
  onUpdated: (ref: string) => void;
  onNext: () => void;
}) {
  const [running, setRunning] = useState(false);

  const classify = useCallback(async () => {
    setRunning(true);
    try {
      await fetch("/api/uc7/classify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseReference: caseFile.caseReference }),
      });
      onUpdated(caseFile.caseReference);
    } finally {
      setRunning(false);
    }
  }, [caseFile, onUpdated]);

  const allClassified = caseFile.wallets.every((w) => w.classification);
  const hasRed = caseFile.wallets.some((w) => w.classification?.requiresTTP);

  return (
    <div>
      <h3 style={h3}>Risk classification</h3>
      <p style={para}>
        Apply deterministic rules to each wallet's trace results. Thresholds: GREEN ≥{" "}
        {(caseFile.settings.greenThreshold * 100).toFixed(0)}%, AMBER ≥{" "}
        {(caseFile.settings.amberThreshold * 100).toFixed(0)}%.
      </p>
      <div style={{ marginBottom: 16 }}>
        <button style={primaryBtn} onClick={classify} disabled={running}>
          {running ? <><Spinner /> &nbsp;Classifying…</> : "Run classification"}
        </button>
        {caseFile.overallRisk && (
          <span style={{ marginLeft: 16 }}>
            Overall: <RiskPill tier={caseFile.overallRisk} />
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {caseFile.wallets.map((w) => (
          <div key={w.address} style={walletCardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <code style={{ fontSize: 13, color: "#fff" }}>{w.address}</code>
              {w.classification ? (
                <RiskPill tier={w.classification.tier} />
              ) : (
                <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 12 }}>Not classified</span>
              )}
            </div>
            {w.classification && (
              <ul style={{ marginTop: 10, paddingLeft: 20, fontSize: 13, color: "rgba(255,255,255,0.75)" }}>
                {w.classification.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 24 }}>
        <button style={primaryBtn} onClick={onNext} disabled={!allClassified}>
          {hasRed ? "Proceed to TTP escalation →" : "Proceed to report →"}
        </button>
      </div>
    </div>
  );
}

/* ── Step 5: TTP escalation (all wallets visible) ── */
function StepTtp({
  caseFile,
  onUpdated,
  onNext,
}: {
  caseFile: CaseFile;
  onUpdated: (ref: string) => void;
  onNext: () => void;
}) {
  const [runningSet, setRunningSet] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const escalate = useCallback(
    async (address: string) => {
      setRunningSet((prev) => new Set(prev).add(address));
      try {
        await fetch("/api/uc7/escalate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ caseReference: caseFile.caseReference, address }),
        });
        onUpdated(caseFile.caseReference);
        // Auto-expand report panel on completion
        setExpanded((prev) => new Set(prev).add(address));
      } finally {
        setRunningSet((prev) => {
          const next = new Set(prev);
          next.delete(address);
          return next;
        });
      }
    },
    [caseFile, onUpdated]
  );

  const toggleExpand = useCallback((address: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  }, []);

  const tierRank: Record<RiskTier, number> = { RED: 0, AMBER: 1, GREEN: 2 };

  const sortedWallets = useMemo(
    () =>
      [...caseFile.wallets].sort((a, b) => {
        const ta = a.classification?.tier ?? "GREEN";
        const tb = b.classification?.tier ?? "GREEN";
        return tierRank[ta] - tierRank[tb];
      }),
    [caseFile.wallets]
  );

  const redWallets = caseFile.wallets.filter((w) => w.classification?.requiresTTP);
  const redPending = redWallets.filter((w) => !w.ttp);
  const canProceed = redWallets.length > 0 && redPending.length === 0;

  return (
    <div>
      <h3 style={h3}>Third-party forensic escalation</h3>
      <p style={para}>
        RED-classified wallets <strong>must</strong> be sent to a third-party forensic analytics provider
        before the compliance report can be issued. AMBER and GREEN wallets can optionally be submitted
        for additional evidence. Provider: <code>{caseFile.settings.ttpProvider}</code>.
      </p>

      {redWallets.length === 0 && (
        <div style={mutedBlock}>
          No RED wallets were flagged. Screening is optional for this case — you may proceed to the report.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 12 }}>
        {sortedWallets.map((w) => {
          const tier = w.classification?.tier;
          const isRunning = runningSet.has(w.address);
          const isExpanded = expanded.has(w.address);
          const isRequired = !!w.classification?.requiresTTP;
          const hasReport = !!w.ttp;

          let actionNode: React.ReactNode;
          if (isRunning) {
            actionNode = (
              <button style={{ ...primaryBtn, opacity: 0.85 }} disabled>
                <Spinner /> &nbsp;Awaiting result…
              </button>
            );
          } else if (hasReport) {
            actionNode = (
              <div style={{ display: "flex", gap: 8 }}>
                <button style={secondaryBtn} onClick={() => toggleExpand(w.address)}>
                  {isExpanded ? "Hide report" : "See result"}
                </button>
                <button style={linkBtn} onClick={() => escalate(w.address)}>
                  Re-run
                </button>
              </div>
            );
          } else if (isRequired) {
            actionNode = (
              <button style={primaryBtn} onClick={() => escalate(w.address)}>
                Send to TTP
              </button>
            );
          } else {
            actionNode = (
              <button style={secondaryBtn} onClick={() => escalate(w.address)}>
                Send to TTP (optional)
              </button>
            );
          }

          return (
            <div
              key={w.address}
              style={{
                ...walletCardStyle,
                ...(isRequired && !hasReport
                  ? { borderColor: "rgba(239,68,68,0.5)", background: "rgba(239,68,68,0.05)" }
                  : {}),
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <code style={{ fontSize: 13, color: "#fff" }}>{w.address}</code>
                    {tier && <RiskPill tier={tier} />}
                    {isRequired && !hasReport && !isRunning && (
                      <span style={{ fontSize: 11, color: "#fca5a5", fontWeight: 700 }}>
                        REQUIRED
                      </span>
                    )}
                    {hasReport && (
                      <span style={{ fontSize: 11, color: "#6ee7b7", fontWeight: 700 }}>
                        ✓ Report received
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginTop: 4 }}>
                    {chainFamilyLabel(w.chainFamily)}
                    {w.primaryChain && ` · ${w.primaryChain}`}
                  </div>
                </div>
                {actionNode}
              </div>

              {hasReport && isExpanded && w.ttp && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 10 }}>
                    <Stat label="Provider" value={w.ttp.provider} />
                    <Stat
                      label="Risk score"
                      value={`${w.ttp.riskScore}/100`}
                      color={
                        w.ttp.riskLevel === "critical"
                          ? "#ef4444"
                          : w.ttp.riskLevel === "high"
                          ? "#f59e0b"
                          : "#10b981"
                      }
                    />
                    <Stat label="Risk level" value={w.ttp.riskLevel.toUpperCase()} />
                    <Stat label="Report ID" value={w.ttp.reportId} />
                  </div>
                  <p style={{ fontSize: 13, color: "rgba(255,255,255,0.75)" }}>{w.ttp.summary}</p>
                  <h5 style={{ ...h4, fontSize: 12 }}>Exposure breakdown</h5>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                    {Object.entries(w.ttp.exposureBreakdown).map(([k, v]) => (
                      <span
                        key={k}
                        style={{
                          fontSize: 11,
                          padding: "3px 8px",
                          background: "rgba(255,255,255,0.06)",
                          border: "1px solid rgba(255,255,255,0.1)",
                          borderRadius: 4,
                          color: "rgba(255,255,255,0.85)",
                        }}
                      >
                        {k.replace(/_/g, " ")}: {v.toFixed(1)}%
                      </span>
                    ))}
                  </div>
                  {w.ttp.flaggedAddresses.length > 0 && (
                    <>
                      <h5 style={{ ...h4, fontSize: 12, marginTop: 12 }}>Flagged counterparties</h5>
                      <ul style={{ paddingLeft: 20, fontSize: 12, color: "rgba(255,255,255,0.75)" }}>
                        {w.ttp.flaggedAddresses.map((f, i) => (
                          <li key={i}>
                            <code>{f.address.slice(0, 10)}…{f.address.slice(-6)}</code> —{" "}
                            {f.category} ({f.riskLevel}): {f.note}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 24 }}>
        <button style={primaryBtn} onClick={onNext} disabled={!canProceed && redWallets.length > 0}>
          Proceed to report →
        </button>
        {redPending.length > 0 && (
          <span style={{ marginLeft: 12, color: "rgba(255,255,255,0.55)", fontSize: 12 }}>
            {redPending.length} RED wallet{redPending.length === 1 ? "" : "s"} still awaiting TTP result
          </span>
        )}
      </div>
    </div>
  );
}

/* ── Step 6: report ── */
function StepReport({
  caseFile,
  onUpdated,
}: {
  caseFile: CaseFile;
  onUpdated: (ref: string) => void;
}) {
  const [signOff, setSignOff] = useState(caseFile.signOffName || "");
  const [determination, setDetermination] = useState(caseFile.determination || "");
  const [signoffStatus, setSignoffStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [signoffError, setSignoffError] = useState<string>("");

  const saveSignoff = useCallback(async () => {
    if (!signOff.trim() && !determination.trim()) {
      setSignoffStatus("error");
      setSignoffError("Enter at least a name or a determination before saving.");
      return false;
    }
    setSignoffStatus("saving");
    setSignoffError("");
    try {
      const res = await fetch(`/api/uc7/case/${caseFile.caseReference}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          signOffName: signOff,
          determination,
          signOffDate: new Date().toISOString().slice(0, 10),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSignoffStatus("error");
        setSignoffError(body.error || `Save failed (HTTP ${res.status})`);
        return false;
      }
      await onUpdated(caseFile.caseReference);
      setSignoffStatus("saved");
      return true;
    } catch (err) {
      setSignoffStatus("error");
      setSignoffError(err instanceof Error ? err.message : "Save failed");
      return false;
    }
  }, [caseFile.caseReference, signOff, determination, onUpdated]);

  const reportUrl = `/api/uc7/report/${caseFile.caseReference}`;

  return (
    <div>
      <h3 style={h3}>Compliance report</h3>
      <p style={para}>
        Generate the PDF compliance file. The report opens in a new tab with a "Save as PDF" action,
        and is structured for client file and FINMA audit.
      </p>

      <div style={walletCardStyle}>
        <h4 style={h4}>Sign-off</h4>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <label style={labelStyle}>Compliance officer name</label>
            <input
              value={signOff}
              onChange={(e) => {
                setSignOff(e.target.value);
                if (signoffStatus !== "idle") setSignoffStatus("idle");
              }}
              placeholder="Name"
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <label style={labelStyle}>Determination</label>
            <input
              value={determination}
              onChange={(e) => {
                setDetermination(e.target.value);
                if (signoffStatus !== "idle") setSignoffStatus("idle");
              }}
              placeholder="e.g. Onboard with enhanced monitoring"
              style={inputStyle}
            />
          </div>
        </div>
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button
            style={{ ...secondaryBtn, opacity: signoffStatus === "saving" ? 0.6 : 1, cursor: signoffStatus === "saving" ? "wait" : "pointer" }}
            onClick={() => { void saveSignoff(); }}
            disabled={signoffStatus === "saving"}
          >
            {signoffStatus === "saving" ? "Saving…" : "Save sign-off"}
          </button>
          {signoffStatus === "saved" && (
            <span style={{ color: "#6ee7b7", fontSize: 12, fontWeight: 600 }}>✓ Saved</span>
          )}
          {signoffStatus === "error" && (
            <span style={{ color: "#fca5a5", fontSize: 12 }}>{signoffError}</span>
          )}
        </div>
      </div>

      <div style={{ marginTop: 24, display: "flex", gap: 12 }}>
        <a
          href={`${reportUrl}?t=${Date.now()}`}
          target="_blank"
          rel="noreferrer"
          style={{ ...primaryBtn, textDecoration: "none", display: "inline-block" }}
        >
          Open report
        </a>
        <button
          style={secondaryBtn}
          onClick={async () => {
            // Always persist the latest sign-off values before generating the
            // PDF — otherwise the report would reflect whatever was last on
            // the server, not what the officer just typed.
            if (signOff.trim() || determination.trim()) {
              const ok = await saveSignoff();
              if (!ok) return;
            }
            await fetch(`/api/uc7/report/${caseFile.caseReference}`, { method: "POST" });
            await onUpdated(caseFile.caseReference);
            // Cache-buster suffix forces the browser to re-fetch the freshly
            // generated HTML instead of replaying an earlier "Open report"
            // response from disk cache.
            window.open(`${reportUrl}?t=${Date.now()}`, "_blank");
          }}
        >
          Finalize & download
        </button>
      </div>
      {caseFile.reportGenerated && (
        <div style={{ marginTop: 12, color: "rgba(255,255,255,0.6)", fontSize: 12 }}>
          Last generated: {caseFile.reportGeneratedAt}
        </div>
      )}
    </div>
  );
}

/* ── Utility components ── */
function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", letterSpacing: "0.05em", textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: color || "#fff", marginTop: 2 }}>{value}</div>
    </div>
  );
}

function RiskPill({ tier }: { tier: RiskTier }) {
  const c =
    tier === "GREEN"
      ? { bg: "rgba(16,185,129,0.15)", fg: "#6ee7b7", border: "rgba(16,185,129,0.45)" }
      : tier === "AMBER"
      ? { bg: "rgba(245,158,11,0.15)", fg: "#fbbf24", border: "rgba(245,158,11,0.45)" }
      : { bg: "rgba(239,68,68,0.15)", fg: "#fca5a5", border: "rgba(239,68,68,0.45)" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: "0.05em",
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.border}`,
      }}
    >
      {tier}
    </span>
  );
}

/* ── Styles ── */
const pageRoot: CSSProperties = {
  minHeight: "calc(100vh - 48px)",
  background: "linear-gradient(180deg, #0b1220 0%, #07080f 100%)",
  color: "#fff",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
};

const headerWrap: CSSProperties = {
  maxWidth: 1040,
  margin: "0 auto",
  padding: "48px 20px 16px",
};

const eyebrow: CSSProperties = {
  display: "inline-block",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: UC7_ACCENT,
  fontWeight: 700,
  background: `${UC7_ACCENT}1a`,
  padding: "4px 10px",
  borderRadius: 20,
  marginBottom: 12,
};

const h1: CSSProperties = {
  fontSize: "clamp(28px, 4vw, 38px)",
  fontWeight: 900,
  letterSpacing: "-0.02em",
  lineHeight: 1.1,
  margin: 0,
};

const subtitle: CSSProperties = {
  color: "rgba(255,255,255,0.65)",
  fontSize: 15,
  maxWidth: 700,
  marginTop: 8,
};

const contentWrap: CSSProperties = {
  maxWidth: 1040,
  margin: "0 auto",
  padding: "16px 20px 80px",
};

const cardStyle: CSSProperties = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: 14,
  padding: 24,
};

const caseHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
  paddingBottom: 16,
  borderBottom: "1px solid rgba(255,255,255,0.07)",
  marginBottom: 20,
};

const stepperStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  flexWrap: "wrap",
  marginBottom: 24,
};

const stepBtn: CSSProperties = {
  padding: "8px 14px",
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(255,255,255,0.03)",
  color: "rgba(255,255,255,0.6)",
  cursor: "pointer",
};
const stepBtnActive: CSSProperties = {
  background: `${UC7_ACCENT}22`,
  borderColor: `${UC7_ACCENT}66`,
  color: "#fff",
};
const stepBtnDone: CSSProperties = {
  color: "rgba(255,255,255,0.85)",
};

const h2: CSSProperties = { fontSize: 20, fontWeight: 800, margin: 0 };
const h3: CSSProperties = { fontSize: 16, fontWeight: 700, marginTop: 0, marginBottom: 6 };
const h4: CSSProperties = { fontSize: 13, fontWeight: 700, marginTop: 16, marginBottom: 6, color: "rgba(255,255,255,0.85)" };
const para: CSSProperties = { color: "rgba(255,255,255,0.65)", fontSize: 14, marginTop: 4 };

const inputStyle: CSSProperties = {
  flex: 1,
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(255,255,255,0.04)",
  color: "#fff",
  fontSize: 14,
  outline: "none",
  width: "100%",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "rgba(255,255,255,0.55)",
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  marginBottom: 6,
};

const primaryBtn: CSSProperties = {
  padding: "10px 16px",
  borderRadius: 8,
  border: `1px solid ${UC7_ACCENT}66`,
  background: `${UC7_ACCENT}1c`,
  color: "#fff",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
};

const secondaryBtn: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.15)",
  background: "rgba(255,255,255,0.04)",
  color: "rgba(255,255,255,0.85)",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
};

const dangerBtn: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid rgba(239,68,68,0.4)",
  background: "rgba(239,68,68,0.1)",
  color: "#fca5a5",
  fontSize: 12,
  cursor: "pointer",
};

const linkBtn: CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(255,255,255,0.04)",
  color: "#fff",
  fontSize: 12,
  cursor: "pointer",
};

const walletCardStyle: CSSProperties = {
  border: "1px solid rgba(255,255,255,0.07)",
  background: "rgba(255,255,255,0.02)",
  borderRadius: 10,
  padding: 16,
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  marginTop: 8,
};

const thStyle: CSSProperties = {
  textAlign: "left",
  fontSize: 11,
  color: "rgba(255,255,255,0.55)",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  padding: "8px 10px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
};

const trStyle: CSSProperties = {};

const tdStyle: CSSProperties = {
  fontSize: 13,
  color: "rgba(255,255,255,0.85)",
  padding: "8px 10px",
  borderBottom: "1px solid rgba(255,255,255,0.04)",
};

const mutedBlock: CSSProperties = {
  padding: 20,
  textAlign: "center",
  color: "rgba(255,255,255,0.45)",
  fontSize: 13,
  background: "rgba(255,255,255,0.02)",
  borderRadius: 8,
  marginTop: 10,
};

const errorBox: CSSProperties = {
  marginTop: 10,
  padding: "8px 12px",
  borderRadius: 8,
  background: "rgba(239,68,68,0.1)",
  border: "1px solid rgba(239,68,68,0.3)",
  color: "#fca5a5",
  fontSize: 13,
};

const preBlock: CSSProperties = {
  background: "rgba(0,0,0,0.25)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 6,
  padding: 10,
  fontSize: 12,
  color: "#fff",
  whiteSpace: "pre-wrap",
  fontFamily: "monospace",
  margin: 0,
};

const codeInline: CSSProperties = {
  display: "inline-block",
  padding: "6px 10px",
  background: "rgba(0,0,0,0.25)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 6,
  fontSize: 11,
  color: "#fff",
};
