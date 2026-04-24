import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import NavBar from "../shared/components/NavBar";
import FundFlowDiagram from "../use-cases/uc8-sof-verification/components/FundFlowDiagram";
import ExchangeTierBadge from "../use-cases/uc8-sof-verification/components/ExchangeTierBadge";
import { detectChain, chainFamilyLabel } from "../use-cases/uc8-sof-verification/lib/chainDetect";
import type {
  CaseFile,
  CaseSummary,
  RiskTier,
  WalletRecord,
} from "../use-cases/uc8-sof-verification/lib/types";

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

const UC8_ACCENT = "#ec4899";

export default function Uc8Page() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [activeCase, setActiveCase] = useState<CaseFile | null>(null);
  const [step, setStep] = useState<Step>("setup");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadCases = useCallback(async () => {
    try {
      const res = await fetch("/api/uc8/case");
      const json = await res.json();
      setCases(json.cases ?? []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadCases();
  }, [loadCases]);

  const refreshCase = useCallback(async (ref: string) => {
    const res = await fetch(`/api/uc8/case/${ref}`);
    if (!res.ok) return;
    const json = await res.json();
    setActiveCase(json.case);
  }, []);

  return (
    <>
      <NavBar active="uc8" />
      <main style={pageRoot}>
        <header style={headerWrap}>
          <div style={eyebrow}>UC8 · Source of Funds Verification</div>
          <h1 style={h1}>Crypto Onboarding · Source of Funds</h1>
          <p style={subtitle}>
            Verify wallet ownership, trace incoming funds to regulated sources, classify risk, and produce
            a FINMA-ready compliance report per client.
          </p>
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
                    const res = await fetch("/api/uc8/case", {
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
                  await refreshCase(ref);
                  setStep("setup");
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
                    onUpdated={refreshCase}
                    onNext={() => setStep("ownership")}
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

/* ── Step: Case list ── */
function CaseListView({
  cases,
  onCreate,
  onOpen,
  loading,
  error,
}: {
  cases: CaseSummary[];
  onCreate: (name: string) => void;
  onOpen: (ref: string) => void;
  loading: boolean;
  error: string;
}) {
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
          Create case
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
                  <button style={linkBtn} onClick={() => onOpen(c.caseReference)}>
                    Open
                  </button>
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
        const isTtp = s === "ttp";
        const hasRed = caseFile.wallets.some((w) => w.classification?.requiresTTP);
        const disabled = isTtp && !hasRed && step !== "ttp";
        return (
          <button
            key={s}
            onClick={() => !disabled && onChange(s)}
            disabled={disabled}
            style={{
              ...stepBtn,
              ...(isActive ? stepBtnActive : {}),
              ...(isDone ? stepBtnDone : {}),
              ...(disabled ? { opacity: 0.4, cursor: "not-allowed" } : {}),
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
  onUpdated,
  onNext,
}: {
  caseFile: CaseFile;
  onUpdated: (ref: string) => void;
  onNext: () => void;
}) {
  const [addr, setAddr] = useState("");
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");

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
    try {
      const scanRes = await fetch("/api/uc8/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: trimmed }),
      });
      const scanJson = await scanRes.json();

      const newWallet: WalletRecord = {
        address: trimmed,
        chainFamily: detection.chainFamily,
        scan: scanJson.scan ?? undefined,
        primaryChain:
          scanJson.scan?.chains.find((c: { hasActivity: boolean }) => c.hasActivity)?.chain ||
          (detection.chainFamily === "bitcoin"
            ? "bitcoin"
            : detection.chainFamily === "solana"
            ? "solana"
            : undefined),
      };
      const updated: CaseFile = {
        ...caseFile,
        wallets: [...caseFile.wallets, newWallet],
      };
      await fetch(`/api/uc8/case/${caseFile.caseReference}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallets: updated.wallets }),
      });
      onUpdated(caseFile.caseReference);
      setAddr("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add wallet");
    } finally {
      setScanning(false);
    }
  }, [addr, caseFile, onUpdated]);

  const removeWallet = useCallback(
    async (address: string) => {
      const wallets = caseFile.wallets.filter((w) => w.address !== address);
      await fetch(`/api/uc8/case/${caseFile.caseReference}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallets }),
      });
      onUpdated(caseFile.caseReference);
    },
    [caseFile, onUpdated]
  );

  return (
    <div>
      <h3 style={h3}>Wallet intake</h3>
      <p style={para}>
        Enter each wallet address the client controls. The system detects the chain family and scans for
        activity across supported networks.
      </p>
      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
        <input
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          placeholder="0x… / bc1… / Solana pubkey"
          style={{ ...inputStyle, fontFamily: "monospace" }}
        />
        <button
          style={primaryBtn}
          onClick={addWallet}
          disabled={scanning || !addr.trim()}
        >
          {scanning ? "Scanning…" : "Add wallet"}
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
            return (
              <div key={w.address} style={walletCardStyle}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <code style={{ fontSize: 13, color: "#fff" }}>{w.address}</code>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginTop: 4 }}>
                      {chainFamilyLabel(detection.chainFamily)}
                      {detection.subtype && ` · ${detection.subtype}`}
                      {w.scan && ` · $${w.scan.totalValueUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                    </div>
                  </div>
                  <button style={dangerBtn} onClick={() => removeWallet(w.address)}>
                    Remove
                  </button>
                </div>
                {w.scan && w.scan.chains.length > 0 && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                    {w.scan.chains.map((c) => (
                      <span
                        key={c.chain}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: 11,
                          padding: "4px 8px",
                          background: "rgba(255,255,255,0.06)",
                          border: "1px solid rgba(255,255,255,0.1)",
                          borderRadius: 4,
                          color: "rgba(255,255,255,0.85)",
                        }}
                      >
                        {c.chain}: {Number(c.nativeBalance).toFixed(4)} (${c.nativeBalanceUsd.toFixed(0)})
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <button
          style={primaryBtn}
          onClick={onNext}
          disabled={caseFile.wallets.length === 0}
        >
          Proceed to ownership verification →
        </button>
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
        await fetch("/api/uc8/challenge", {
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

  // Poll for verification updates
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
}: {
  wallet: WalletRecord;
  loading: boolean;
  onGenerate: () => void;
}) {
  const challenge = wallet.challenge;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const signUrl = challenge ? `${origin}/uc8-sign/${challenge.challengeId}` : "";

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
            {challenge?.status === "pending" && (
              <span style={{ marginLeft: 10, color: "#fbbf24" }}>⏳ Waiting for signature</span>
            )}
          </div>
        </div>
        {!challenge || challenge.status === "failed" ? (
          <button style={primaryBtn} onClick={onGenerate} disabled={loading}>
            {loading ? "Generating…" : "Generate challenge"}
          </button>
        ) : null}
      </div>

      {challenge && challenge.status !== "verified" && (
        <div style={{ marginTop: 14, display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", marginBottom: 6 }}>
              QR code — scan on client's phone
            </div>
            <img
              alt="Sign challenge"
              src={`/api/uc8/qr?data=${encodeURIComponent(signUrl)}`}
              style={{ width: 180, height: 180, background: "#fff", borderRadius: 8, padding: 6 }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", marginBottom: 4 }}>Challenge message</div>
            <pre style={preBlock}>{challenge.message}</pre>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", marginTop: 10, marginBottom: 4 }}>
              Shareable link
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
    </div>
  );
}

/* ── Step 3: source scan (backward trace) ── */
function StepScan({
  caseFile,
  onUpdated,
  onNext,
}: {
  caseFile: CaseFile;
  onUpdated: (ref: string) => void;
  onNext: () => void;
}) {
  const [running, setRunning] = useState<string | null>(null);

  const runTrace = useCallback(
    async (address: string) => {
      setRunning(address);
      try {
        await fetch("/api/uc8/trace", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ caseReference: caseFile.caseReference, address }),
        });
        onUpdated(caseFile.caseReference);
      } finally {
        setRunning(null);
      }
    },
    [caseFile, onUpdated]
  );

  const runAll = useCallback(async () => {
    for (const w of caseFile.wallets) {
      if (!w.trace) await runTrace(w.address);
    }
  }, [caseFile.wallets, runTrace]);

  const allTraced = caseFile.wallets.every((w) => w.trace);

  return (
    <div>
      <h3 style={h3}>Backward source trace</h3>
      <p style={para}>
        Pull incoming transactions, identify counterparties via Etherscan labels, eth-labels, and OFAC screening,
        and build a hop-by-hop picture of where the funds came from. Maximum depth: {caseFile.settings.maxHopDepth} hops.
      </p>
      <div style={{ marginBottom: 16 }}>
        <button style={primaryBtn} onClick={runAll} disabled={running !== null}>
          Run trace on all wallets
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {caseFile.wallets.map((w) => (
          <TraceRow
            key={w.address}
            wallet={w}
            running={running === w.address}
            onRun={() => runTrace(w.address)}
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
}: {
  wallet: WalletRecord;
  running: boolean;
  onRun: () => void;
}) {
  const trace = wallet.trace;
  return (
    <div style={walletCardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <code style={{ fontSize: 13, color: "#fff" }}>{wallet.address}</code>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginTop: 4 }}>
            {chainFamilyLabel(wallet.chainFamily)}
            {wallet.primaryChain && ` · ${wallet.primaryChain}`}
          </div>
        </div>
        <button style={primaryBtn} onClick={onRun} disabled={running}>
          {running ? "Tracing…" : trace ? "Re-run trace" : "Run trace"}
        </button>
      </div>

      {trace && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 14 }}>
            <Stat
              label="Coverage"
              value={`${(trace.attributedPercentage * 100).toFixed(1)}%`}
              color={
                trace.attributedPercentage >= 0.9
                  ? "#10b981"
                  : trace.attributedPercentage >= 0.6
                  ? "#f59e0b"
                  : "#ef4444"
              }
            />
            <Stat
              label="Attributed"
              value={`$${trace.attributedValueUsd.toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}`}
            />
            <Stat
              label="Total inflow"
              value={`$${trace.totalIncomingValueUsd.toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}`}
            />
            <Stat label="Hops used" value={`${trace.hopsUsed} / ${trace.maxHopsConfigured}`} />
            <Stat
              label="Sanctions"
              value={trace.sanctionsHits.length > 0 ? `${trace.sanctionsHits.length} hit` : "Clean"}
              color={trace.sanctionsHits.length > 0 ? "#ef4444" : "#10b981"}
            />
          </div>

          {trace.sanctionsHits.length > 0 && (
            <div style={{ ...errorBox, marginBottom: 12 }}>
              <strong>OFAC SDN match:</strong>{" "}
              {trace.sanctionsHits.map((h) => h.reason).join(", ")}
            </div>
          )}

          <h5 style={{ ...h4, fontSize: 12 }}>Fund flow</h5>
          <FundFlowDiagram trace={trace} height={360} />

          {trace.sources.length > 0 && (
            <>
              <h5 style={{ ...h4, fontSize: 12, marginTop: 16 }}>Top sources</h5>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Address</th>
                    <th style={thStyle}>Entity</th>
                    <th style={thStyle}>Type</th>
                    <th style={thStyle}>Share</th>
                    <th style={thStyle}>Value</th>
                    <th style={thStyle}>Hop</th>
                  </tr>
                </thead>
                <tbody>
                  {trace.sources.map((s) => (
                    <tr key={s.address} style={trStyle}>
                      <td style={tdStyle}>
                        <code style={{ fontSize: 11 }}>
                          {s.address.slice(0, 10)}…{s.address.slice(-6)}
                        </code>
                      </td>
                      <td style={tdStyle}>
                        {s.label?.name || <span style={{ color: "rgba(255,255,255,0.5)" }}>Unknown</span>}
                        {s.label?.exchangeTier && (
                          <span style={{ marginLeft: 6 }}>
                            <ExchangeTierBadge tier={s.label.exchangeTier} size="sm" />
                          </span>
                        )}
                      </td>
                      <td style={tdStyle}>{s.label?.entityType || "unknown"}</td>
                      <td style={tdStyle}>{(s.percentage * 100).toFixed(1)}%</td>
                      <td style={tdStyle}>
                        ${s.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </td>
                      <td style={tdStyle}>{s.hopDepth}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
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
      await fetch("/api/uc8/classify", {
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
        Apply deterministic rules to each wallet's trace results.
        Thresholds: GREEN ≥ {(caseFile.settings.greenThreshold * 100).toFixed(0)}%, AMBER ≥ {(caseFile.settings.amberThreshold * 100).toFixed(0)}%.
      </p>
      <div style={{ marginBottom: 16 }}>
        <button style={primaryBtn} onClick={classify} disabled={running}>
          {running ? "Classifying…" : "Run classification"}
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

/* ── Step 5: TTP escalation ── */
function StepTtp({
  caseFile,
  onUpdated,
  onNext,
}: {
  caseFile: CaseFile;
  onUpdated: (ref: string) => void;
  onNext: () => void;
}) {
  const redWallets = caseFile.wallets.filter((w) => w.classification?.requiresTTP);
  const [running, setRunning] = useState<string | null>(null);

  const escalate = useCallback(
    async (address: string) => {
      setRunning(address);
      try {
        await fetch("/api/uc8/escalate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ caseReference: caseFile.caseReference, address }),
        });
        onUpdated(caseFile.caseReference);
      } finally {
        setRunning(null);
      }
    },
    [caseFile, onUpdated]
  );

  return (
    <div>
      <h3 style={h3}>Third-party forensic escalation</h3>
      <p style={para}>
        RED-classified wallets are escalated to a third-party analytics provider for forensic screening.
        Provider: <code>{caseFile.settings.ttpProvider}</code>.
      </p>
      {redWallets.length === 0 ? (
        <div style={mutedBlock}>No RED wallets to escalate.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {redWallets.map((w) => (
            <div key={w.address} style={walletCardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <code style={{ fontSize: 13, color: "#fff" }}>{w.address}</code>
                <button style={primaryBtn} onClick={() => escalate(w.address)} disabled={running === w.address}>
                  {running === w.address ? "Escalating…" : w.ttp ? "Re-run screening" : "Send to TTP"}
                </button>
              </div>
              {w.ttp && (
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
                            <code>{f.address.slice(0, 10)}…{f.address.slice(-6)}</code> — {f.category} ({f.riskLevel}): {f.note}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 24 }}>
        <button
          style={primaryBtn}
          onClick={onNext}
          disabled={redWallets.some((w) => !w.ttp)}
        >
          Proceed to report →
        </button>
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

  const saveSignoff = useCallback(async () => {
    await fetch(`/api/uc8/case/${caseFile.caseReference}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        signOffName: signOff,
        determination,
        signOffDate: new Date().toISOString().slice(0, 10),
      }),
    });
    onUpdated(caseFile.caseReference);
  }, [caseFile.caseReference, signOff, determination, onUpdated]);

  const reportUrl = `/api/uc8/report/${caseFile.caseReference}`;

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
              onChange={(e) => setSignOff(e.target.value)}
              placeholder="Name"
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <label style={labelStyle}>Determination</label>
            <input
              value={determination}
              onChange={(e) => setDetermination(e.target.value)}
              placeholder="e.g. Onboard with enhanced monitoring"
              style={inputStyle}
            />
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <button style={secondaryBtn} onClick={saveSignoff}>
            Save sign-off
          </button>
        </div>
      </div>

      <div style={{ marginTop: 24, display: "flex", gap: 12 }}>
        <a href={reportUrl} target="_blank" rel="noreferrer" style={{ ...primaryBtn, textDecoration: "none", display: "inline-block" }}>
          Open report
        </a>
        <button
          style={secondaryBtn}
          onClick={async () => {
            await fetch(`/api/uc8/report/${caseFile.caseReference}`, { method: "POST" });
            onUpdated(caseFile.caseReference);
            window.open(reportUrl, "_blank");
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
  color: UC8_ACCENT,
  fontWeight: 700,
  background: `${UC8_ACCENT}1a`,
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
  background: `${UC8_ACCENT}22`,
  borderColor: `${UC8_ACCENT}66`,
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
  border: `1px solid ${UC8_ACCENT}66`,
  background: `${UC8_ACCENT}1c`,
  color: "#fff",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
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
