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
  WalletRecord,
  WalletScanResult,
} from "../use-cases/uc7-sow-verification/lib/types";

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

    try {
      const scanRes = await fetch("/api/uc7/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: trimmed }),
      });
      const scanJson = await scanRes.json();

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

      await fetch(`/api/uc7/case/${caseFile.caseReference}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallets: updated.wallets }),
      });
      onUpdated(caseFile.caseReference);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add wallet");
      // Rollback on failure
      setActiveCase(caseFile);
    } finally {
      setScanning(false);
    }
  }, [addr, caseFile, onUpdated, setActiveCase]);

  const removeWallet = useCallback(
    async (address: string) => {
      const wallets = caseFile.wallets.filter((w) => w.address !== address);
      const updated = { ...caseFile, wallets };
      setActiveCase(updated);
      await fetch(`/api/uc7/case/${caseFile.caseReference}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallets }),
      });
      onUpdated(caseFile.caseReference);
    },
    [caseFile, onUpdated, setActiveCase]
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
        await fetch(`/api/uc7/case/${caseFile.caseReference}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ wallets }),
        });
        onUpdated(caseFile.caseReference);
      } finally {
        setRescanning(null);
      }
    },
    [caseFile, onUpdated, setActiveCase]
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
  const signUrl = challenge ? `${origin}/uc7-sign/${challenge.challengeId}` : "";

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
            {loading ? <><Spinner /> &nbsp;Generating…</> : "Generate challenge"}
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
              src={`/api/uc7/qr?data=${encodeURIComponent(signUrl)}`}
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
}: {
  caseFile: CaseFile;
  onUpdated: (ref: string) => void;
  onNext: () => void;
}) {
  const [runningSet, setRunningSet] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const runTrace = useCallback(
    async (address: string) => {
      setRunningSet((prev) => new Set(prev).add(address));
      try {
        await fetch("/api/uc7/trace", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ caseReference: caseFile.caseReference, address }),
        });
        onUpdated(caseFile.caseReference);
      } finally {
        setRunningSet((prev) => {
          const next = new Set(prev);
          next.delete(address);
          return next;
        });
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

  const allTraced = caseFile.wallets.every((w) => w.trace);
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
          {running ? (
            <>
              <Spinner /> &nbsp;Tracing…
            </>
          ) : trace ? (
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

      {trace && !running && (
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
            <Stat label="Attributed" value={formatChf(trace.attributedValueChf)} />
            <Stat label="Total inflow" value={formatChf(trace.totalIncomingValueChf)} />
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

          {trace.sources.length > 0 ? (
            <>
              <h5 style={{ ...h4, fontSize: 12 }}>Fund flow</h5>
              <FundFlowDiagram trace={trace} height={360} />

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
                        {s.label?.name || (
                          <span style={{ color: "rgba(255,255,255,0.5)" }}>Unknown</span>
                        )}
                        {s.label?.exchangeTier && (
                          <span style={{ marginLeft: 6 }}>
                            <ExchangeTierBadge tier={s.label.exchangeTier} size="sm" />
                          </span>
                        )}
                        {s.unpriced && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 10,
                              color: "#fbbf24",
                              border: "1px solid rgba(245,158,11,0.3)",
                              padding: "1px 4px",
                              borderRadius: 3,
                            }}
                          >
                            UNPRICED
                          </span>
                        )}
                      </td>
                      <td style={tdStyle}>{s.label?.entityType || "unknown"}</td>
                      <td style={tdStyle}>{(s.percentage * 100).toFixed(1)}%</td>
                      <td style={tdStyle}>{formatChf(s.valueChf)}</td>
                      <td style={tdStyle}>{s.hopDepth}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div style={mutedBlock}>
              No incoming value detected. The wallet has no priced inflows on this chain — try re-running the
              trace after setting <code>ETHERSCAN_API_KEY</code>, or confirm the wallet has activity on the expected chain.
            </div>
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

  const saveSignoff = useCallback(async () => {
    await fetch(`/api/uc7/case/${caseFile.caseReference}`, {
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
            await fetch(`/api/uc7/report/${caseFile.caseReference}`, { method: "POST" });
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
