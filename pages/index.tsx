// pages/index.tsx
import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import NavBar from "../components/NavBar";

const HUB = (process.env.NEXT_PUBLIC_PAYMENT_HUB_ADDRESS || "") as `0x${string}` | "";
const DIR = (process.env.NEXT_PUBLIC_DIRECTORY_ADDRESS || "") as `0x${string}` | "";
const XBANK = (process.env.NEXT_PUBLIC_XBANK_ADDRESS || "") as `0x${string}` | "";
const DEMO_RECIPIENT = (process.env.NEXT_PUBLIC_DEMO_RECIPIENT || "") as `0x${string}` | "";

const BANK_A_ID = Number(process.env.NEXT_PUBLIC_BANK_A_ID || 1);
const BANK_B_ID = Number(process.env.NEXT_PUBLIC_BANK_B_ID || 2);

const CHECKLIST_KEY = "home:checklist:v4";

// NEW: rotating hero words
const HERO_WORDS = ["finalix", "blockchain", "EVM", "crypto"] as const;

type ChecklistItem = {
  id: string;
  title: string;
  hint: string;
  href?: string;
};

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

  const checklist: ChecklistItem[] = useMemo(
    () => [
      {
        id: "bank-login",
        title: "1) Log into eBanking",
        hint: "Password is “finalix”. Then open your crypto wallet.",
        href: "/ebanking",
      },
      {
        id: "wallet-open",
        title: "2) Create / open your embedded wallet (Privy)",
        hint: "No seed phrase. The bank sponsors a tiny gas top-up for new users.",
        href: "/ebanking",
      },
      {
        id: "buy-xbank",
        title: "3) Buy 100 xBank demo tokens",
        hint: "This mints demo tokens to your wallet so you can transfer later.",
        href: "/ebanking",
      },
      {
        id: "post-envelope",
        title: "4) Encrypt & post the travel-rule request",
        hint: "This writes an encrypted envelope to the Payment Hub (no PII in plaintext).",
        href: "/bank-a",
      },
      {
        id: "bankb-ack",
        title: "5) Review inbound request and ACK (or reject)",
        hint: "Open Bank B in a second window and click ACK to unlock the transfer.",
        href: "/bank-b",
      },
      {
        id: "send-transfer",
        title: "6) Send the xBank transfer to the receiver wallet",
        hint: "After ACK, send the ERC-20 transfer to the fixed recipient address.",
        href: "/bank-a",
      },
    ],
    []
  );

  const [done, setDone] = useState<Record<string, boolean>>({});

  // NEW: rotating header word
  const [heroWordIndex, setHeroWordIndex] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      setHeroWordIndex((i) => (i + 1) % HERO_WORDS.length);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(CHECKLIST_KEY);
      if (raw) setDone(JSON.parse(raw));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(CHECKLIST_KEY, JSON.stringify(done));
    } catch {
      // ignore
    }
  }, [done]);

  const completed = useMemo(() => {
    let c = 0;
    for (let i = 0; i < checklist.length; i += 1) {
      if (done[checklist[i].id]) c += 1;
    }
    return c;
  }, [done, checklist]);

  const pct = Math.round((completed / checklist.length) * 100);

  const resetChecklist = () => setDone({});

  return (
    <>
      <NavBar active="home" />
      <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
        {/* HERO */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <h1 style={{ margin: 0 }}>
              Welcome to the <span style={rotatingWord}>{HERO_WORDS[heroWordIndex]}</span> concept bank
            </h1>
          </div>

          <p style={{ color: "#555", marginTop: 10, marginBottom: 0, maxWidth: 980 }}>
            A hands-on demo of a “bank-grade” crypto flow: seedless embedded wallets, sponsored gas,
            and a travel-rule compliant interbank transfer.
          </p>

          {!envStatus.ok && (
            <div style={{ ...callout, background: "#fff6f6", borderColor: "#ffd5d5", marginTop: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Setup note</div>
              <div style={{ fontSize: 12, color: "#7a1f1f" }}>
                Some environment variables are missing, so parts of the demo may not work yet:
                <div style={{ marginTop: 6, fontFamily: "monospace" }}>{envStatus.missing.join(", ")}</div>
              </div>
            </div>
          )}
        </div>

        {/* MAIN OVERVIEW GRID (3 cards) */}
        <div style={grid3}>
          <Card
            title="eBanking: instant wallet + crypto assets"
            subtitle="The “bank UX” layer that makes crypto feel normal."
            body={
              <>
                <ul style={ul}>
                  <li>
                    Log in with demo password <code style={code}>finalix</code>.
                  </li>
                  <li>
                    Create/open an <strong>embedded wallet</strong> (seedless).
                  </li>
                  <li>
                    Get a small sponsored gas top-up if you are a first time user (“welcome ETH”).
                  </li>
                  <li>
                    Mint <strong>100 xBank</strong> demo tokens to your wallet (to simulate a crypto purchase and to
                    transfer later).
                  </li>
                </ul>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                  <Link href="/ebanking" style={btn}>
                    Go to eBanking →
                  </Link>
                  <span style={miniHint}>Tip: after “Buy 100 xBank”, your xBank balance updates in the UI.</span>
                </div>
              </>
            }
          />

          <Card
            title="Interbank payment (send): build an encrypted travel-rule request"
            subtitle="Creates a reference (txRef), encrypts the payload, posts to the Payment Hub."
            body={
              <>
                <ul style={ul}>
                  <li>Fill the travel-rule “minimum” fields (sender identity + beneficiary).</li>
                  <li>
                    Click <strong>Encrypt &amp; post request</strong> to submit to the on-chain hub.
                  </li>
                  <li>
                    Toggle whether Bank B’s <strong>ACK is required</strong> before tokens move.
                  </li>
                  <li>
                    After ACK, click <strong>Send payment</strong> to transfer xBank to the fixed recipient wallet.
                  </li>
                </ul>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                  <Link href="/bank-a" style={btnSecondary}>
                    Try sending a payment →
                  </Link>
                  <span style={miniHint}>
                    Best demo flow: open Bank B in a second window so you can ACK while Bank A waits.
                  </span>
                </div>
              </>
            }
          />

          <Card
            title="Interbank payment (receive): decrypt, review, ACK / reject"
            subtitle="Simulates the receiving bank workflow."
            body={
              <>
                <ul style={ul}>
                  <li>
                    See the <strong>receiver wallet</strong> + its xBank balance at the top.
                  </li>
                  <li>
                    Incoming requests are found by scanning recent hub events, then the payload is decrypted.
                  </li>
                  <li>
                    Click <strong>ACK</strong> to approve (or <strong>Reject</strong> for the demo).
                  </li>
                  <li>
                    Verify routing and keys via the <strong>Directory Registry</strong>.
                  </li>
                </ul>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                  <Link href="/bank-b" style={btnTertiary}>
                    Discover the payment mechanics →
                  </Link>
                  <span style={miniHint}>
                    If nothing shows: hit “Refresh requests” and ensure Bank B has an HPKE public key in Directory.
                  </span>
                </div>
              </>
            }
          />
        </div>

        {/* FULL-WIDTH CHECKLIST */}
        <div style={{ marginTop: 16 }}>
          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <h3 style={{ margin: 0 }}>Guided demo checklist</h3>
                <div style={{ color: "#666", fontSize: 13, marginTop: 6 }}>
                  Progress: {completed}/{checklist.length} ({pct}%)
                </div>
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <div style={progressWrap}>
                <div style={{ ...progressBar, width: `${pct}%` }} />
              </div>

              <div
                style={{
                  marginTop: 12,
                  display: "grid",
                  gap: 10,
                  gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
                }}
              >
                {checklist.map((it) => {
                  const checked = Boolean(done[it.id]);
                  return (
                    <div key={it.id} style={checkRow}>
                      <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => setDone((d) => ({ ...d, [it.id]: e.target.checked }))}
                          style={{ marginTop: 2 }}
                        />
                        <div>
                          <div style={{ fontWeight: 800, lineHeight: 1.2 }}>
                            {it.href ? (
                              <Link href={it.href} style={{ color: "#111", textDecoration: "underline" }}>
                                {it.title}
                              </Link>
                            ) : (
                              it.title
                            )}
                          </div>
                          <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>{it.hint}</div>
                        </div>
                      </label>
                    </div>
                  );
                })}
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
                <button onClick={resetChecklist} style={btnGhost}>
                  Reset checklist
                </button>
                <span style={miniHint}>Saved locally in your browser (localStorage).</span>
              </div>
            </div>
          </div>
        </div>

        {/* UNDER THE HOOD */}
        <section style={{ marginTop: 28 }}>
          <h2 style={{ marginBottom: 8 }}></h2>
          <p style={{ color: "#555", marginTop: 0, maxWidth: 980 }}>
      
          </p>

          {/* CHANGED: full-width flows (no right column, no "what you can demo") */}
          <div style={panel}>
            <div style={{ fontWeight: 2000, marginBottom: 10, fontSize: 20 }}>Under the hood (grandma-friendly)</div>

            {/* Both flows render full-width here */}
            <UnderTheHoodDiagram />

            
          </div>

          {/* CHANGED: two-window tip moved below flows as a full-width banner */}
          <div style={twoWindowBanner}>
            <div style={{ fontWeight: 900, marginBottom: 4 }}>Two-window tip</div>
            <div style={{ fontSize: 14, lineHeight: 1.4 }}>
              For the best “interbank” feel: keep <strong>Bank A</strong> open, then open <strong>Bank B</strong> in
              a separate window to ACK while Bank A waits.
            </div>
          </div>
        </section>

        <p style={{ color: "#777", marginTop: 24, fontSize: 12 }}>
          Prototype for discussion. Use testnet only. Don’t send real funds.
        </p>
      </main>
    </>
  );
}

/* ---------- Components ---------- */

function Card({
  title,
  subtitle,
  body,
}: {
  title: string;
  subtitle?: string;
  body: ReactNode;
}) {
  return (
    <div style={card}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        {subtitle ? <div style={{ color: "#666", fontSize: 13 }}>{subtitle}</div> : null}
      </div>
      <div style={{ marginTop: 10 }}>{body}</div>
    </div>
  );
}

function UnderTheHoodDiagram() {
  // Rewritten: tighter + accurate to the implemented demo mechanics.
  const flow1Steps: FlowStep[] = [
    {
      whatYouDo: (
        <>
          Log in to <strong>eBanking</strong> and open/create your embedded wallet.
        </>
      ),
      onChain: <>No transaction yet — you’re just accessing your wallet address.</>,
    },
    {
      whatYouDo: (
        <>
          Use the <strong>bank-sponsored ETH</strong> for your first on-chain actions.
        </>
      ),
      onChain: <>A tiny amount of test ETH is sent to your wallet so your first transactions can succeed.</>,
    },
    {
      whatYouDo: (
        <>
          Click <strong>Buy 100 xBank</strong> (demo purchase).
        </>
      ),
      onChain: (
        <>
          The xBank ERC-20 contract credits your wallet (mint/transfer), so your token balance becomes visible on-chain.
        </>
      ),
    },
  ];

  const flow2Steps: FlowStep[] = [
    {
      whatYouDo: (
        <>
          In <strong>Bank A</strong>, enter the travel-rule minimum fields (sender + beneficiary + purpose).
        </>
      ),
      onChain: <>Bank A looks up <strong>Bank B’s Directory entry</strong> (like a phonebook) to get Bank B’s public encryption key.</>,
    },
    {
      whatYouDo: (
        <>
          Click <strong>Encrypt &amp; post request</strong>.
        </>
      ),
      onChain: (
        <>
          The Payment Hub emits an event with a <strong>txRef</strong> plus an <strong>encrypted envelope</strong> (contents are unreadable to outsiders).
        </>
      ),
    },
    {
      whatYouDo: (
        <>
          In <strong>Bank B</strong>, refresh incoming requests and review the decrypted payload.
        </>
      ),
      onChain: <>Bank B is reading public events; decryption happens off-chain using Bank B’s key.</>,
    },
    {
      whatYouDo: (
        <>
          If required, Bank B clicks <strong>ACK</strong> (or reject).
        </>
      ),
      onChain: <>An ACK/reject is recorded on the Payment Hub and can be used as a gate for releasing the payment.</>,
    },
    {
      whatYouDo: (
        <>
          Back in <strong>Bank A</strong>, click <strong>Send payment</strong>.
        </>
      ),
      onChain: (
        <>
          The xBank ERC-20 transfer executes to the receiver wallet address (after ACK, if the toggle is enabled).
        </>
      ),
    },
  ];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <FlowBlock
        title={
          <>
            Flow 1 — eBanking: wallet + xBank purchase 
          </>
        }
        steps={flow1Steps}
        footerTags={[{ kind: "public", text: "Wallet address + token balances are public (ERC-20). That’s normal for blockchains." }]}
      />

      <FlowBlock
        title={
          <>
            Flow 2 — Interbank payment: encrypt → ACK → transfer 
          </>
        }
        steps={flow2Steps}
        footerTags={[
          { kind: "public", text: "The chain can see that an envelope was posted and its txRef." },
          { kind: "private", text: "The travel-rule details inside the envelope are encrypted." },
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
              <span style={t.kind === "public" ? tagPublic : tagPrivate}>{t.kind === "public" ? "Public" : "Private"}</span>
              <span style={legendText}>{t.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Styles ---------- */

const grid3: CSSProperties = {
  display: "grid",
  gap: 16,
  gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
  marginTop: 16,
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
  borderRadius: 10,
  textDecoration: "none",
  fontWeight: 800,
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
  borderRadius: 10,
  border: "1px solid #e6e8eb",
  background: "#fff",
  cursor: "pointer",
  fontWeight: 800,
};

const ul: CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  color: "#333",
  lineHeight: 1.5,
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
  fontSize: 12,
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
  fontWeight: 900,
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
  fontWeight: 900,
  color: "#444",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
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
  fontWeight: 900,
  color: "#666",
};

const stepText: CSSProperties = {
  fontSize: 14,
  color: "#111",
  lineHeight: 1.4,
};

const legendRow: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  flexWrap: "wrap",
};

const legendText: CSSProperties = {
  fontSize: 12,
  color: "#666",
};

const tagBase: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  border: "1px solid #e6e8eb",
  fontSize: 11,
  fontWeight: 800,
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

const tagSoft: CSSProperties = {
  ...tagBase,
  background: "#eef6ff",
  color: "#1f3a8a",
};

// NEW: rotating word styling
const rotatingWord: CSSProperties = {
  display: "inline-block",
  padding: "2px 10px",
  borderRadius: 999,
  background: "#111",
  color: "#fff",
  fontWeight: 900,
  letterSpacing: "0.01em",
};

// NEW: banner styling for the two-window tip
const twoWindowBanner: CSSProperties = {
  marginTop: 12,
  border: "1px solid #e6e8eb",
  borderRadius: 14,
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
