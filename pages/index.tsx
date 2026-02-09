// pages/index.tsx
import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import NavBar from "../components/NavBar";

const HUB = (process.env.NEXT_PUBLIC_PAYMENT_HUB_ADDRESS || "") as
  | `0x${string}`
  | "";
const DIR = (process.env.NEXT_PUBLIC_DIRECTORY_ADDRESS || "") as
  | `0x${string}`
  | "";
const XBANK = (process.env.NEXT_PUBLIC_XBANK_ADDRESS || "") as
  | `0x${string}`
  | "";
const DEMO_RECIPIENT = (process.env.NEXT_PUBLIC_DEMO_RECIPIENT || "") as
  | `0x${string}`
  | "";

const BANK_A_ID = Number(process.env.NEXT_PUBLIC_BANK_A_ID || 1);
const BANK_B_ID = Number(process.env.NEXT_PUBLIC_BANK_B_ID || 2);

const HERO_WORDS = ["blockchain", "EVM", "crypto"] as const;

type FlowStep = {
  whatYouDo: ReactNode;
  onChain: ReactNode;
};

export default function Home() {
  const envStatus = useMemo(() => {
    const missing: string[] = [];
    if (!HUB) missing.push("NEXT_PUBLIC_PAYMENT_HUB_ADDRESS");
    if (!DIR) missing.push("NEXT_PUBLIC_DIRECTORY_ADDRESS");
    if (!XBANK) missing.push("NEXT_PUBLIC_XBANK_ADDRESS");
    if (!DEMO_RECIPIENT) missing.push("NEXT_PUBLIC_DEMO_RECIPIENT");
    return { ok: missing.length === 0, missing };
  }, []);

  // Rotating header word (every 4 seconds)
  const [heroWordIndex, setHeroWordIndex] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      setHeroWordIndex((i) => (i + 1) % HERO_WORDS.length);
    }, 4000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <NavBar active="home" />
      <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
        {/* HERO */}
        <section style={heroWrap}>
          <div style={heroTopRow}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <h1 style={{ margin: 0, lineHeight: 1.05 }}>
                Welcome to the{" "}
                <span key={heroWordIndex} style={rotatingWord} className="heroFlip">
                  {HERO_WORDS[heroWordIndex]}
                </span>{" "}
                concept bank
              </h1>

              <p style={heroSub}>
                A bank-grade, hands-on exploration of blockchain-based payment infrastructure solutions. <br />Make the customer relationship, operating model, and economics tangible in a real on-chain environment.
              </p>

              {!envStatus.ok && (
                <div
                  style={{
                    ...callout,
                    background: "#fff6f6",
                    borderColor: "#ffd5d5",
                    marginTop: 14,
                  }}
                >
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>Setup note</div>
                  <div style={{ fontSize: 14, color: "#7a1f1f" }}>
                    Some environment variables are missing, so parts of the demo may not work yet:
                    <div style={{ marginTop: 6, fontFamily: "monospace" }}>{envStatus.missing.join(", ")}</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* USE CASE 1 (FULL WIDTH) */}
        <section style={{ marginTop: 16 }}>
          <div style={useCaseCard}>
            <div style={useCaseHeader}>
              <div>
                <div style={useCaseEyebrow}>Use case 1</div>
                <h2 style={{ margin: 0 }}>Issue crypto wallet</h2>
                <div style={useCaseSub}>
                  eBanking creates a seedless embedded wallet and allows the user to acquire demo crypto assets.
                </div>
              </div>
              <div style={useCaseActions}>
                <Link href="/ebanking" style={btn}>
                  Open eBanking →
                </Link>
                <span style={miniHint}>
                  Password: <code style={code}>finalix</code>
                </span>
              </div>
            </div>

            <div style={twoPane}>
              <div style={pane}>
                <div style={paneTitle}>Flow (what you do)</div>
                <StepList
                  steps={[
                    <>
                      Log in to <strong>eBanking</strong> with the demo password (finalix).
                    </>,
                    <>
                      Click <strong>Log-in or create wallet</strong> to open your <strong>embedded wallet</strong>.
                    </>,
                    <>
                      Receive a small <strong>sponsored ETH top-up</strong> upon first wallet creation.
                    </>,
                    <>
                      Click <strong>Buy 100 xBank stablecoin</strong> to add demo tokens to your wallet.
                    </>,
                  ]}
                />
              </div>

              <div style={pane}>
                <div style={paneTitle}>What you’ll notice</div>
                <div style={insightBox}>
                  <div style={insightTitle}>Feels like normal banking</div>
                  <div style={insightText}>
                    The wallet is created inside eBanking, the balance updates instantly, and the user never sees a seed
                    phrase.
                  </div>
                </div>
                <div style={insightBox}>
                  <div style={insightTitle}>Crypto actions “just work”</div>
                  <div style={insightText}>
                    The bank can sponsor gas so first-time users don’t get stuck on “insufficient ETH”.
                  </div>
                </div>
                <div style={insightBox}>
                  <div style={insightTitle}>Your assets are real on-chain</div>
                  <div style={insightText}>
                    The wallet address and ERC-20 balances are public (that’s how blockchains work).
                  </div>
                </div>
              </div>
            </div>

          </div>
        </section>

        {/* USE CASE 2 (ONE UNIT: BANK A + BANK B) */}
        <section style={{ marginTop: 16 }}>
          <div style={useCaseCard}>
            <div style={useCaseHeader}>
              <div>
                <div style={useCaseEyebrow}>Use case 2</div>
                <h2 style={{ margin: 0 }}>Interbank travel-rule payment</h2>
                <div style={useCaseSub}>
                  Bank A posts an encrypted “travel-rule envelope” to the on-chain hub. Bank B reviews and ACKs. Then
                  the token transfer executes.
                </div>
              </div>
              <div style={useCaseActions}>
                <Link href="/bank-a" style={btnSecondary}>
                  Try it now →
                </Link>
              </div>
            </div>

            <div style={splitUseCase}>
              {/* Bank A */}
              <div style={splitPane}>
                <div style={splitHead}>
                  <div style={splitTitle}>Bank A</div>
                  <div style={splitTag}>Sender workflow</div>
                </div>

                <StepList
                  steps={[
                    <>
                      Enter the travel-rule minimum fields (originator + beneficiary + purpose).
                    </>,
                    <>
                      Click <strong>Encrypt &amp; post request</strong> to submit an encrypted envelope to the Payment
                      Hub (with a <strong>txRef</strong>).
                    </>,
                    <>
                      Wait for Bank B’s <strong>ACK</strong> (if the toggle is enabled).
                    </>,
                    <>
                      Click <strong>Send payment</strong> to execute the ERC-20 <strong>xBank transfer</strong> to the
                      fixed recipient wallet.
                    </>,
                  ]}
                />

                <div style={{ marginTop: 12 }}>
                  <div style={paneTitle}>What you’ll notice</div>

                  <div style={insightBox}>
                    <div style={insightTitle}>tx links = your on-chain tracking proof</div>
                    <div style={insightText}>
                      Once you post the request or send the payment, you receive unique <strong>tx links</strong> to the
                      Arbitrum Sepolia blockchain you can use to trace the flow across Bank A and Bank B.
                    </div>
                  </div>

                  <div style={insightBox}>
                    <div style={insightTitle}>Privacy by default</div>
                    <div style={insightText}>
                      The public sees that a payload was posted, but the travel-rule fields are inside an{" "}
                      <strong>encrypted field</strong>.
                    </div>
                  </div>

                  <div style={insightBox}>
                    <div style={insightTitle}>Interbank gate (ACK)</div>
                    <div style={insightText}>
                      If “Require ACK” is enabled, the transfer won’t proceed until Bank B confirms it — like a
                      bank-to-bank compliance handshake.
                    </div>
                  </div>
                </div>
              </div>

              {/* Bank B */}
              <div style={splitPane}>
                <div style={splitHead}>
                  <div style={splitTitle}>Bank B</div>
                  <div style={splitTagAlt}>Receiver workflow</div>
                </div>

                <StepList
                  steps={[
                    <>
                      Refresh inbound requests (Bank B scans recent hub events).
                    </>,
                    <>
                      Review the decrypted envelope (decryption happens off-chain via Bank B’s key).
                    </>,
                    <>
                      Click <strong>ACK</strong> to approve (or Reject for the demo).
                    </>,
                    <>
                      Explore the <strong>Directory Registry</strong> section to learn about bank routing and HPKE keys.
                    </>,
                  ]}
                />

                <div style={{ marginTop: 12 }}>
                  <div style={paneTitle}>What you’ll notice</div>

                  <div style={insightBox}>
                    <div style={insightTitle}>Requests appear from payment hub events</div>
                    <div style={insightText}>
                      Bank B watches the on-chain hub and pulls new requests by scanning recent activity. It then
                      records the ACK decision on-chain.
                    </div>
                  </div>

                  <div style={insightBox}>
                    <div style={insightTitle}>Decryption stays off-chain</div>
                    <div style={insightText}>
                      Bank B can open the payload using its private key, but observers on the blockchain can’t. That’s
                      why you can show details in the UI without publishing them.
                    </div>
                  </div>

                  <div style={insightBox}>
                    <div style={insightTitle}>ACK is the visible approval</div>
                    <div style={insightText}>
                      When Bank B clicks ACK, it writes a small approval signal that Bank A can verify before moving
                      tokens.
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div style={twoWindowBanner}>
              <div style={{ fontWeight: 900, marginBottom: 4 }}>Two-window tip</div>
              <div style={{ fontSize: 14, lineHeight: 1.45 }}>
                For the best “interbank” feel: keep <strong>Bank A</strong> open, then open <strong>Bank B</strong> in
                a separate window to ACK while Bank A waits.
              </div>
            </div>
          </div>
        </section>

        {/* USE CASE 3 */}
        <section style={{ marginTop: 16 }}>
          <div style={useCaseCard}>
            <div style={useCaseHeader}>
              <div>
                <div style={useCaseEyebrow}>Use case 3</div>
                <h2 style={{ margin: 0 }}>KYC badge for wallets</h2>
                <div style={useCaseSub}>
                  A bank issues an expiring &amp; revocable badge to a wallet. Anyone can verify it instantly — without
                  holding a wallet themselves.
                </div>
              </div>
              <div style={useCaseActions}>
                <Link href="/kyc-badge" style={btnTertiary}>
                  Open KYC badge →
                </Link>
              </div>
            </div>

            <div style={twoPane}>
              <div style={pane}>
                <div style={paneTitle}>Flow (what you do)</div>
                <StepList
                  steps={[
                    <>
                      As the “bank”, connect your embedded wallet (Privy) in the issuer panel.
                    </>,
                    <>
                      Enter a target wallet address, choose validity + claims, then click <strong>Issue / renew</strong>.
                    </>,
                    <>
                      Copy the share link or paste any wallet address into the verifier section.
                    </>,
                    <>
                      To simulate risk changes, click <strong>Revoke</strong> and re-verify.
                    </>,
                  ]}
                />
              </div>

              <div style={pane}>
                <div style={paneTitle}>What you’ll notice</div>

                <div style={insightBox}>
                  <div style={insightTitle}>Verifiable by anyone</div>
                  <div style={insightText}>
                    A verifier doesn’t need a wallet — they can read the badge status like checking a public registry.
                  </div>
                </div>

                <div style={insightBox}>
                  <div style={insightTitle}>Expiry + revocation = bank control</div>
                  <div style={insightText}>
                    The badge isn’t forever. It expires automatically, and the bank can revoke instantly if risk changes.
                  </div>
                </div>

                <div style={insightBox}>
                  <div style={insightTitle}>No PII on-chain</div>
                  <div style={insightText}>
                    Only a minimal status record is public (validity + a small claims mask). Identity evidence stays in
                    bank systems.
                  </div>
                </div>
              </div>
            </div>

          </div>
        </section>

        {/* USE CASE 4 */}
        <section style={{ marginTop: 16 }}>
          <div style={useCaseCard}>
            <div style={useCaseHeader}>
              <div>
                <div style={useCaseEyebrow}>Use case 4</div>
                <h2 style={{ margin: 0 }}>Context passport for banking AI agents</h2>
                <div style={useCaseSub}>
                  Customers create KYC context modules and grant banks AI agents time‑bound access. Allowing the bank to serve the client better while keeping the customer in control of their data.
                </div>
              </div>
              <div style={useCaseActions}>
                <Link href="/context-vault" style={btnSecondary}>
                  Open context vault →
                </Link>
              </div>
            </div>

            <div style={twoPane}>
              <div style={pane}>
                <div style={paneTitle}>Flow (what you do)</div>
                <StepList
                  steps={[
                    <>
                      Log in as the customer and select a module (Suitability, Sustainability, Service Scope).
                    </>,
                    <>
                      Fill in preferences and click <strong>Save module</strong> to encrypt locally.
                    </>,
                    <>
                      As a bank, request access for a purpose via MetaMask.
                    </>,
                    <>
                      Back as the customer, click <strong>Grant</strong> — the bank can now load &amp; decrypt.
                    </>,
                  ]}
                />
              </div>

              <div style={pane}>
                <div style={paneTitle}>What you’ll notice</div>

                <div style={insightBox}>
                  <div style={insightTitle}>Customer‑owned portability</div>
                  <div style={insightText}>
                    Modules can be exported and reused across bank's AI agents without re‑entering data.
                  </div>
                </div>

                <div style={insightBox}>
                  <div style={insightTitle}>Consent is enforceable</div>
                  <div style={insightText}>
                    Grants are on‑chain, time‑bound, and revocable — banks can’t decrypt without explicit consent.
                  </div>
                </div>

                <div style={insightBox}>
                  <div style={insightTitle}>No plaintext in bank storage</div>
                  <div style={insightText}>
                    Banks store ciphertext + wrapped keys; the plaintext never leaves the customer’s device.
                  </div>
                </div>
              </div>
            </div>

          </div>
        </section>

        <p style={{ color: "#777", marginTop: 24, fontSize: 14 }}>
          Prototype for discussion. Use testnet only. Don’t send real funds.
        </p>

        {/* Animations / micro-interactions (kept lightweight + respects reduced motion) */}
        <style jsx global>{`
          .heroFlip {
            animation: heroFlip 400ms ease;
            transform-origin: 50% 60%;
            display: inline-block;
          }

          @keyframes heroFlip {
            0% {
              opacity: 0;
              transform: translateY(8px) scale(0.98);
            }
            100% {
              opacity: 1;
              transform: translateY(0px) scale(1);
            }
          }

          @media (prefers-reduced-motion: reduce) {
            .heroFlip {
              animation: none !important;
            }
          }
        `}</style>
      </main>
    </>
  );
}

/* ---------- Components ---------- */

function Kpi({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div style={kpiCard}>
      <div style={{ fontSize: 14, color: "#666", fontWeight: 800 }}>
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 950, marginTop: 4 }}>{value}</div>
      <div
        style={{ fontSize: 14, color: "#666", marginTop: 4, lineHeight: 1.35 }}
      >
        {sub}
      </div>
    </div>
  );
}

function Chip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      style={{
        ...chipBase,
        background: ok ? "#e6f9f0" : "#fff6f6",
        borderColor: ok ? "#b7f0d3" : "#ffd5d5",
        color: ok ? "#0b6b3a" : "#7a1f1f",
      }}
      title={ok ? "Configured" : "Missing env var"}
    >
      {ok ? "✓" : "!"} {label}
    </span>
  );
}

function StepList({ steps }: { steps: ReactNode[] }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {steps.map((s, i) => (
        <div key={i} style={stepRow}>
          <div style={stepBadge}>{i + 1}</div>
          <div style={stepBody}>{s}</div>
        </div>
      ))}
    </div>
  );
}

function UnderTheHoodDiagram() {
  // Accurate to the implemented demo mechanics.
  const flow1Steps: FlowStep[] = [
    {
      whatYouDo: (
        <>
          Log in to <strong>eBanking</strong> and open/create your embedded
          wallet.
        </>
      ),
      onChain: <>No transaction yet — you’re just accessing your wallet address.</>,
    },
    {
      whatYouDo: (
        <>
          Use the <strong>bank-sponsored ETH</strong> for your first on-chain
          actions.
        </>
      ),
      onChain: (
        <>
          A tiny amount of test ETH is sent to your wallet so your first
          transactions can succeed.
        </>
      ),
    },
    {
      whatYouDo: (
        <>
          Click <strong>Buy 100 xBank</strong> (demo purchase).
        </>
      ),
      onChain: (
        <>
          The xBank ERC-20 contract credits your wallet (mint/transfer), so your
          token balance becomes visible on-chain.
        </>
      ),
    },
  ];

  const flow2Steps: FlowStep[] = [
    {
      whatYouDo: (
        <>
          In <strong>Bank A</strong>, enter travel-rule minimum fields (sender +
          beneficiary + purpose).
        </>
      ),
      onChain: (
        <>
          Bank A reads <strong>Bank B’s public encryption key</strong> from the
          on-chain Directory (like a phonebook).
        </>
      ),
    },
    {
      whatYouDo: (
        <>
          Click <strong>Encrypt &amp; post request</strong>.
        </>
      ),
      onChain: (
        <>
          The Payment Hub records an on-chain submission keyed by{" "}
          <strong>txRef</strong> plus an <strong>encrypted envelope</strong>.
        </>
      ),
    },
    {
      whatYouDo: (
        <>
          In <strong>Bank B</strong>, refresh incoming requests and review the
          decrypted payload.
        </>
      ),
      onChain: (
        <>
          Bank B reads public hub events; decryption happens off-chain using Bank
          B’s key (the chain still cannot read the contents).
        </>
      ),
    },
    {
      whatYouDo: (
        <>
          If required, Bank B clicks <strong>ACK</strong> (or reject).
        </>
      ),
      onChain: (
        <>
          An ACK transaction is written to the hub (in this demo, reject is
          local-only, used to simulate a denial).
        </>
      ),
    },
    {
      whatYouDo: (
        <>
          Back in <strong>Bank A</strong>, click <strong>Send payment</strong>.
        </>
      ),
      onChain: (
        <>
          The xBank ERC-20 transfer executes to the receiver wallet address
          (after ACK, if the toggle is enabled).
        </>
      ),
    },
  ];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <FlowBlock
        title={<>Flow 1 — Wallet issuance + xBank purchase</>}
        steps={flow1Steps}
        footerTags={[
          {
            kind: "public",
            text: "Wallet address + ERC-20 balances are public (normal for blockchains).",
          },
        ]}
      />

      <FlowBlock
        title={<>Flow 2 — Interbank payment: encrypt → ACK → transfer</>}
        steps={flow2Steps}
        footerTags={[
          {
            kind: "public",
            text: "The chain can see an envelope was posted and its txRef.",
          },
          {
            kind: "private",
            text: "The travel-rule details inside the envelope are encrypted.",
          },
        ]}
      />
    </div>
  );
}

function FlowBlock({
  title,
  steps,
  footerTags,
}: {
  title: ReactNode;
  steps: FlowStep[];
  footerTags?: Array<{ kind: "public" | "private"; text: string }>;
}) {
  return (
    <div style={flowBox}>
      <div style={flowTitle}>{title}</div>

      <div style={twoColWrap}>
        <div style={twoColHeader}>
          <div style={twoColHeadCell}>What you do</div>
          <div style={twoColHeadCell}>What happens on-chain</div>
        </div>

        <div style={{ display: "grid", gap: 8 }}>
          {steps.map((s, idx) => (
            <div key={idx} style={twoColRow}>
              <div style={twoColCellLeft}>
                <div style={stepNum}>Step {idx + 1}</div>
                <div style={stepText}>{s.whatYouDo}</div>
              </div>
              <div style={twoColCellRight}>
                <div style={stepText}>{s.onChain}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {footerTags?.length ? (
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          {footerTags.map((t, i) => (
            <div key={i} style={legendRow}>
              <span style={t.kind === "public" ? tagPublic : tagPrivate}>
                {t.kind === "public" ? "Public" : "Private"}
              </span>
              <span style={legendText}>{t.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Styles ---------- */

const heroWrap: CSSProperties = {
  border: "1px solid #e6e8eb",
  borderRadius: 18,
  padding: 16,
  background:
    "linear-gradient(135deg, rgba(47,92,243,0.10), rgba(15,123,108,0.08), rgba(17,17,17,0.03))",
};

const heroTopRow: CSSProperties = {
  display: "flex",
  gap: 16,
  alignItems: "stretch",
  flexWrap: "wrap",
};

const heroSub: CSSProperties = {
  color: "#555",
  marginTop: 12,
  marginBottom: 0,
  maxWidth: 980,
  fontSize: 14,
  lineHeight: 1.5,
};

const heroCtas: CSSProperties = {
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
  marginTop: 14,
};

const heroRight: CSSProperties = {
  minWidth: 280,
  flex: "0 0 360px",
  border: "1px solid rgba(230,232,235,0.9)",
  borderRadius: 16,
  padding: 14,
  background: "rgba(255,255,255,0.75)",
  backdropFilter: "blur(8px)",
};

const heroRightTitle: CSSProperties = {
  fontWeight: 950,
  marginBottom: 10,
  color: "#111",
};

const kpiGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 10,
};

const kpiCard: CSSProperties = {
  border: "1px solid #eef0f2",
  borderRadius: 14,
  padding: 10,
  background: "#fff",
};

const chipRow: CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  marginTop: 10,
};

const chipBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 10px",
  borderRadius: 999,
  border: "1px solid #e6e8eb",
  fontSize: 14,
  fontWeight: 900,
};

const useCaseCard: CSSProperties = {
  border: "1px solid #e6e8eb",
  borderRadius: 18,
  padding: 16,
  background: "#fff",
  boxShadow: "0 1px 0 rgba(17,17,17,0.02)",
};

const useCaseHeader: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
  alignItems: "flex-end",
};

const useCaseEyebrow: CSSProperties = {
  display: "inline-block",
  fontSize: 14,
  fontWeight: 950,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "#2f5cf3",
  marginBottom: 6,
};

const useCaseSub: CSSProperties = {
  fontSize: 14,
  color: "#666",
  marginTop: 6,
  maxWidth: 820,
  lineHeight: 1.5,
};

const useCaseActions: CSSProperties = {
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
  alignItems: "center",
};

const twoPane: CSSProperties = {
  marginTop: 14,
  display: "grid",
  gap: 12,
  gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
};

const pane: CSSProperties = {
  border: "1px solid #eef0f2",
  borderRadius: 16,
  padding: 14,
  background: "#fafafa",
};

const paneTitle: CSSProperties = {
  fontWeight: 950,
  marginBottom: 10,
  color: "#111",
};

const stepRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "34px 1fr",
  gap: 10,
  alignItems: "start",
  padding: 10,
  borderRadius: 14,
  border: "1px solid #eef0f2",
  background: "#fff",
};

const stepBadge: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 12,
  display: "grid",
  placeItems: "center",
  fontWeight: 950,
  background: "#111",
  color: "#fff",
  fontSize: 14,
};

const stepBody: CSSProperties = {
  color: "#111",
  fontSize: 14,
  lineHeight: 1.45,
};

const insightBox: CSSProperties = {
  border: "1px solid #eef0f2",
  borderRadius: 14,
  padding: 12,
  background: "#fff",
  marginBottom: 10,
};

const insightTitle: CSSProperties = {
  fontWeight: 950,
  marginBottom: 6,
};

const insightText: CSSProperties = {
  color: "#555",
  fontSize: 14,
  lineHeight: 1.5,
};

const splitUseCase: CSSProperties = {
  marginTop: 14,
  display: "grid",
  gap: 12,
  gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
};

const splitPane: CSSProperties = {
  border: "1px solid #eef0f2",
  borderRadius: 16,
  padding: 14,
  background: "#fafafa",
};

const splitHead: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 10,
  alignItems: "center",
  marginBottom: 10,
};

const splitTitle: CSSProperties = {
  fontWeight: 950,
  fontSize: 16,
};

const splitTag: CSSProperties = {
  fontSize: 14,
  fontWeight: 900,
  padding: "4px 10px",
  borderRadius: 999,
  background: "#e6f0ff",
  border: "1px solid #d6e4ff",
  color: "#1f3a8a",
};

const splitTagAlt: CSSProperties = {
  ...splitTag,
  background: "#e6f9f0",
  borderColor: "#b7f0d3",
  color: "#0b6b3a",
};

const splitCtas: CSSProperties = {
  marginTop: 12,
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
  alignItems: "center",
};

const checklistHeader: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
  alignItems: "flex-end",
};

const checklistRight: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
};

const progressPill: CSSProperties = {
  border: "1px solid #e6e8eb",
  borderRadius: 14,
  padding: "8px 12px",
  background: "#fafafa",
  display: "grid",
  gap: 2,
  textAlign: "right",
};

const checklistGrid: CSSProperties = {
  marginTop: 12,
  display: "grid",
  gap: 10,
  gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
};

const card: CSSProperties = {
  border: "1px solid #e6e8eb",
  borderRadius: 14,
  padding: 16,
  background: "#fff",
};

const panel: CSSProperties = {
  border: "1px solid #e6e8eb",
  borderRadius: 14,
  padding: 16,
  background: "#fff",
};

const btn: CSSProperties = {
  display: "inline-block",
  padding: "10px 14px",
  background: "#2f5cf3",
  color: "#fff",
  borderRadius: 12,
  textDecoration: "none",
  fontWeight: 900,
};

const btnSecondary: CSSProperties = {
  ...btn,
  background: "#0f7b6c",
};

const btnTertiary: CSSProperties = {
  ...btn,
  background: "#111",
};

const btnGhost: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 12,
  border: "1px solid #e6e8eb",
  background: "#fff",
  cursor: "pointer",
  fontWeight: 900,
};

const btnGhostLink: CSSProperties = {
  ...btnGhost,
  textDecoration: "none",
  display: "inline-block",
  color: "#111",
};

const code: CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  fontSize: 14,
  background: "#f6f8fa",
  border: "1px solid #e6e8eb",
  padding: "1px 6px",
  borderRadius: 8,
};

const callout: CSSProperties = {
  border: "1px solid #e6e8eb",
  borderRadius: 12,
  padding: 12,
  background: "#fafafa",
};

const miniHint: CSSProperties = {
  fontSize: 14,
  color: "#666",
  alignSelf: "center",
};

const progressWrap: CSSProperties = {
  width: "100%",
  height: 10,
  background: "#f2f3f5",
  borderRadius: 999,
  overflow: "hidden",
  border: "1px solid #e6e8eb",
};

const progressBar: CSSProperties = {
  height: "100%",
  background: "#2f5cf3",
};

const checkRow: CSSProperties = {
  border: "1px solid #eef0f2",
  borderRadius: 12,
  padding: 12,
  background: "#fff",
};

/* under-the-hood flow styles */
const flowBox: CSSProperties = {
  border: "1px solid #eef0f2",
  borderRadius: 12,
  padding: 12,
  background: "#fff",
};

const flowTitle: CSSProperties = {
  fontWeight: 950,
  fontSize: 14,
  color: "#111",
  marginBottom: 10,
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};

const twoColWrap: CSSProperties = {
  border: "1px solid #eef0f2",
  borderRadius: 12,
  padding: 10,
  background: "#fafafa",
};

const twoColHeader: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 10,
  marginBottom: 10,
};

const twoColHeadCell: CSSProperties = {
  fontSize: 14,
  fontWeight: 950,
  color: "#444",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const twoColRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 10,
  alignItems: "start",
  background: "#fff",
  border: "1px solid #eef0f2",
  borderRadius: 12,
  padding: 10,
};

const twoColCellLeft: CSSProperties = {
  display: "grid",
  gap: 6,
};

const twoColCellRight: CSSProperties = {
  display: "grid",
  gap: 6,
};

const stepNum: CSSProperties = {
  fontSize: 14,
  fontWeight: 950,
  color: "#666",
};

const stepText: CSSProperties = {
  fontSize: 14,
  color: "#111",
  lineHeight: 1.45,
};

const legendRow: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  flexWrap: "wrap",
};

const legendText: CSSProperties = {
  fontSize: 14,
  color: "#666",
};

const tagBase: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  border: "1px solid #e6e8eb",
  fontSize: 12,
  fontWeight: 900,
};

const tagPublic: CSSProperties = {
  ...tagBase,
  background: "#f6f8fa",
  color: "#333",
};

const tagPrivate: CSSProperties = {
  ...tagBase,
  background: "#fff1f1",
  color: "#7a1f1f",
  borderColor: "#ffd5d5",
};

const rotatingWord: CSSProperties = {
  display: "inline-block",
  padding: "3px 12px",
  borderRadius: 999,
  background: "#111",
  color: "#fff",
  fontWeight: 950,
  letterSpacing: "0.01em",
};

const twoWindowBanner: CSSProperties = {
  marginTop: 12,
  border: "1px solid #e6e8eb",
  borderRadius: 16,
  padding: 14,
  background: "#fafafa",
};

function short(x: string) {
  try {
    if (!x) return "";
    if (x.length <= 14) return x;
    return x.slice(0, 8) + "…" + x.slice(-6);
  } catch {
    return x;
  }
}
