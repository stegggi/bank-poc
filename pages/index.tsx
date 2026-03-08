// pages/index.tsx
import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import NavBar from "../shared/components/NavBar";

/* ── Env vars (unchanged) ── */
const HUB = (process.env.NEXT_PUBLIC_PAYMENT_HUB_ADDRESS || "") as `0x${string}` | "";
const DIR = (process.env.NEXT_PUBLIC_DIRECTORY_ADDRESS || "") as `0x${string}` | "";
const XBANK = (process.env.NEXT_PUBLIC_XBANK_ADDRESS || "") as `0x${string}` | "";
const DEMO_RECIPIENT = (process.env.NEXT_PUBLIC_DEMO_RECIPIENT || "") as `0x${string}` | "";

const HERO_WORDS = ["blockchain", "EVM", "crypto"] as const;

/* ── Use-case data ── */
type UcLink = { href: string; label: string; hint?: string; secondary?: boolean };
type UcDef = {
  n: string;
  tag: string;
  title: string;
  desc: string;
  accent: string;
  highlights: string[];
  links: UcLink[];
};

const USE_CASES: UcDef[] = [
  {
    n: "01",
    tag: "UC1 · eBanking",
    title: "Issue Crypto Wallet",
    desc: "A bank creates a seedless embedded wallet inside the banking app. No seed phrases, no browser extensions. Just a wallet that feels like a bank account.",
    accent: "#3b82f6",
    highlights: [
      "Seedless Privy embedded wallet",
      "Bank sponsored gas on first use",
      "xBank stablecoin on Arbitrum Sepolia",
    ],
    links: [{ href: "/ebanking", label: "Open eBanking", hint: "Password: finalix" }],
  },
  {
    n: "02",
    tag: "UC2 · Interbank Payment",
    title: "Travel Rule Payment",
    desc: "Bank A encrypts compliance data into a travel rule envelope and posts it on chain. Bank B decrypts, ACKs, and the token transfer executes with an immutable audit trail.",
    accent: "#10b981",
    highlights: [
      "HPKE encrypted travel rule envelope",
      "On chain ACK compliance gate",
      "ERC-20 transfer with full audit trail",
    ],
    links: [{ href: "/bank-a", label: "Open Interbank Payment" }],
  },
  {
    n: "03",
    tag: "UC3 · Trust Credential",
    title: "KYC Badge for Wallets",
    desc: "Banks issue expiring, revocable trust badges to wallet addresses. Institutions and individuals can verify compliance status instantly without needing a wallet.",
    accent: "#8b5cf6",
    highlights: [
      "Expiry + instant revocation by issuer",
      "Verifiable by anyone without a wallet",
      "No PII stored on chain",
    ],
    links: [{ href: "/kyc-badge", label: "Open KYC Badge" }],
  },
  {
    n: "04",
    tag: "UC4 · Context Passport",
    title: "AI-Ready Banking Data",
    desc: "Customers create encrypted KYC context modules and grant banks' AI agents time bound access. Data portability with cryptographic consent. Plaintext never leaves the device.",
    accent: "#f59e0b",
    highlights: [
      "Client side AES-GCM encryption",
      "On chain time bound access grants",
      "Portable across multiple bank AI agents",
    ],
    links: [{ href: "/context-vault", label: "Open Context Vault" }],
  },
  {
    n: "05",
    tag: "UC5 · AI Trading Agent",
    title: "Perp Trading Bot",
    desc: "An autonomous AI agent trades BTCUSD perpetual futures on Ethereal mainnet. It classifies market regimes, sizes positions by confidence, and manages risk around the clock.",
    accent: "#ef4444",
    highlights: [
      "TREND / RANGE / UNKNOWN regime engine",
      "Linked signer on chain authorization",
      "Live P&L chart and portfolio dashboard",
    ],
    links: [{ href: "/uc5", label: "Open Trading Bot" }],
  },
  {
    n: "06",
    tag: "UC6 · LP Automation",
    title: "Liquidity Provider Bot",
    desc: "A bot that autonomously manages concentrated liquidity positions on Base. It rebalances bands, harvests fees, and selects the best pool 24/7 without human intervention.",
    accent: "#06b6d4",
    highlights: [
      "Uniswap V3 & Aerodrome Slipstream",
      "Regime aware band rebalancing",
      "Automated fee compounding",
    ],
    links: [{ href: "/uc6", label: "Open LP Bot" }],
  },
];

/* ── Page ── */
export default function Home() {
  const envStatus = useMemo(() => {
    const missing: string[] = [];
    if (!HUB) missing.push("NEXT_PUBLIC_PAYMENT_HUB_ADDRESS");
    if (!DIR) missing.push("NEXT_PUBLIC_DIRECTORY_ADDRESS");
    if (!XBANK) missing.push("NEXT_PUBLIC_XBANK_ADDRESS");
    if (!DEMO_RECIPIENT) missing.push("NEXT_PUBLIC_DEMO_RECIPIENT");
    return { ok: missing.length === 0, missing };
  }, []);

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

      <div style={pageRoot}>
        {/* ── HERO ── */}
        <section className="hero-bg" style={heroSection}>
          <div style={heroInner}>
            {/* Eyebrow */}
            <div style={eyebrowRow}>
              <span style={eyebrowPill}>Blockchain Concept Bank</span>
              <span style={eyebrowSep} />
              <span style={eyebrowMeta}>6 use cases · Arbitrum &amp; Base</span>
            </div>

            {/* Headline */}
            <h1 style={heroH1}>
              <span style={{ whiteSpace: "nowrap" }}>
                Welcome to the{" "}
                <span
                  key={heroWordIndex}
                  className="heroFlip"
                  style={heroAccentWord}
                >
                  {HERO_WORDS[heroWordIndex]}
                </span>
              </span>
              <br />
              concept bank
            </h1>

            {/* Subtext */}
            <p style={heroSubtext}>
              A hands on, bank grade exploration of blockchain based payment
              infrastructure. Make the customer relationship, operating model,
              and economics tangible in a real on chain environment.
            </p>

            {/* Env warning */}
            {!envStatus.ok && (
              <div style={envWarning}>
                <span style={envIcon}>⚠</span>
                <div>
                  <div style={envTitle}>Setup incomplete</div>
                  <div style={envBody}>
                    Missing env vars:{" "}
                    <code style={envCode}>{envStatus.missing.join(", ")}</code>
                  </div>
                </div>
              </div>
            )}

            {/* Journey prompt */}
            <div style={scrollNudge}>Explore all 6 use cases below ↓</div>
          </div>
        </section>

        {/* ── USE CASES ── */}
        <div style={gridOuter}>
          {/* Section divider */}
          <div style={dividerRow}>
            <div style={dividerLine} />
            <span style={dividerLabel}>Use Cases</span>
            <div style={dividerLine} />
          </div>

          {/* Cards */}
          <div style={ucGrid}>
            {USE_CASES.map((uc) => (
              <UcCard key={uc.n} uc={uc} />
            ))}
          </div>
        </div>

        {/* ── FOOTER ── */}
        <footer style={footer}>
          Prototype for discussion · Testnet only · No real funds
        </footer>
      </div>

      {/* ── Global styles + animations ── */}
      <style jsx global>{`
        html,
        body {
          background: #07080f;
          margin: 0;
          padding: 0;
          -webkit-font-smoothing: antialiased;
        }

        /* Hero ambient gradient */
        .hero-bg {
          background:
            radial-gradient(ellipse 70% 55% at 15% 45%, rgba(59, 130, 246, 0.13) 0%, transparent 60%),
            radial-gradient(ellipse 55% 50% at 82% 18%, rgba(139, 92, 246, 0.11) 0%, transparent 55%),
            radial-gradient(ellipse 65% 55% at 55% 85%, rgba(16, 185, 129, 0.09) 0%, transparent 55%),
            #07080f;
        }

        /* Rotating hero word */
        .heroFlip {
          animation: heroFlip 380ms ease;
          transform-origin: 50% 55%;
          display: inline-block;
        }
        @keyframes heroFlip {
          0% {
            opacity: 0;
            transform: translateY(10px) scale(0.96);
          }
          100% {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        /* Card hover */
        .uc-card {
          transition: transform 160ms ease, background 160ms ease,
            box-shadow 160ms ease;
        }
        .uc-card:hover {
          transform: translateY(-4px);
          background: rgba(255, 255, 255, 0.055) !important;
          box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55),
            0 0 0 1px rgba(255, 255, 255, 0.11);
        }

        /* Link buttons */
        .uc-btn {
          transition: opacity 140ms ease, filter 140ms ease;
        }
        .uc-btn:hover {
          opacity: 0.88;
          filter: brightness(1.08);
        }

        @media (prefers-reduced-motion: reduce) {
          .heroFlip,
          .uc-card,
          .uc-btn {
            animation: none !important;
            transition: none !important;
          }
        }
      `}</style>
    </>
  );
}

/* ── Card component ── */
function UcCard({ uc }: { uc: UcDef }) {
  return (
    <article
      className="uc-card"
      style={{ ...ucCard, borderTopColor: uc.accent }}
    >
      {/* Number + tag row */}
      <div style={cardTopRow}>
        <span style={{ ...cardNumber, color: uc.accent }}>{uc.n}</span>
        <span style={cardTag}>{uc.tag}</span>
      </div>

      {/* Title */}
      <h2 style={cardTitle}>{uc.title}</h2>

      {/* Description */}
      <p style={cardDesc}>{uc.desc}</p>

      {/* Highlights */}
      <ul style={cardHighlights}>
        {uc.highlights.map((h, i) => (
          <li key={i} style={cardHighlightItem}>
            <span style={{ ...highlightArrow, color: uc.accent }}>▸</span>
            {h}
          </li>
        ))}
      </ul>

      {/* CTA buttons */}
      <div style={cardLinks}>
        {uc.links.map((l, i) => (
          <div key={i} style={ctaRow}>
            <Link
              href={l.href}
              className="uc-btn"
              style={
                l.secondary
                  ? { ...ctaBtn, ...ctaBtnGhost }
                  : { ...ctaBtn, background: uc.accent }
              }
            >
              {l.label} →
            </Link>
            {l.hint && <span style={ctaHint}>{l.hint}</span>}
          </div>
        ))}
      </div>
    </article>
  );
}

/* ── Styles ── */

const pageRoot: CSSProperties = {
  background: "#07080f",
  minHeight: "100vh",
  color: "#e8e8f0",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
};

/* Hero */
const heroSection: CSSProperties = {
  padding: "72px 24px 88px",
};

const heroInner: CSSProperties = {
  maxWidth: 800,
  margin: "0 auto",
};

const eyebrowRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  marginBottom: 32,
  flexWrap: "wrap",
};

const eyebrowPill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "5px 13px",
  borderRadius: 999,
  border: "1px solid rgba(255,255,255,0.13)",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color: "rgba(255,255,255,0.55)",
  background: "rgba(255,255,255,0.045)",
};

const eyebrowSep: CSSProperties = {
  width: 4,
  height: 4,
  borderRadius: "50%",
  background: "rgba(255,255,255,0.18)",
  flexShrink: 0,
};

const eyebrowMeta: CSSProperties = {
  fontSize: 13,
  color: "rgba(255,255,255,0.50)",
  fontWeight: 500,
};

const heroH1: CSSProperties = {
  margin: 0,
  fontSize: "clamp(38px, 6.5vw, 64px)",
  fontWeight: 900,
  lineHeight: 1.06,
  letterSpacing: "-0.025em",
  color: "#ffffff",
};

const heroAccentWord: CSSProperties = {
  display: "inline-block",
  padding: "4px 20px 6px",
  borderRadius: 999,
  background: "linear-gradient(130deg, #3b82f6 0%, #8b5cf6 100%)",
  color: "#fff",
  fontWeight: 900,
  letterSpacing: "-0.015em",
};

const heroSubtext: CSSProperties = {
  margin: "26px 0 0",
  fontSize: 17,
  lineHeight: 1.68,
  color: "rgba(255,255,255,0.65)",
  maxWidth: 620,
};

const envWarning: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  marginTop: 28,
  padding: "14px 18px",
  borderRadius: 12,
  border: "1px solid rgba(239,68,68,0.28)",
  background: "rgba(239,68,68,0.07)",
};

const envIcon: CSSProperties = {
  fontSize: 15,
  color: "#ef4444",
  flexShrink: 0,
  marginTop: 1,
};

const envTitle: CSSProperties = {
  fontWeight: 700,
  fontSize: 13,
  color: "#fca5a5",
  marginBottom: 4,
};

const envBody: CSSProperties = {
  fontSize: 13,
  color: "rgba(255,255,255,0.38)",
};

const envCode: CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace",
  fontSize: 12,
  color: "#fca5a5",
};

const scrollNudge: CSSProperties = {
  marginTop: 44,
  fontSize: 13,
  color: "rgba(255,255,255,0.38)",
  fontWeight: 500,
  letterSpacing: "0.02em",
};

/* Grid section */
const gridOuter: CSSProperties = {
  maxWidth: 1160,
  margin: "0 auto",
  padding: "0 24px 80px",
};

const dividerRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 18,
  marginBottom: 36,
};

const dividerLine: CSSProperties = {
  flex: 1,
  height: 1,
  background: "rgba(255,255,255,0.06)",
};

const dividerLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.11em",
  textTransform: "uppercase",
  color: "rgba(255,255,255,0.22)",
  flexShrink: 0,
};

const ucGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))",
  gap: 16,
};

/* Card */
const ucCard: CSSProperties = {
  background: "rgba(255,255,255,0.032)",
  border: "1px solid rgba(255,255,255,0.075)",
  borderTop: "2px solid", /* borderTopColor set per card */
  borderRadius: 16,
  padding: "24px 24px 22px",
  display: "flex",
  flexDirection: "column",
  cursor: "default",
};

const cardTopRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  marginBottom: 18,
};

const cardNumber: CSSProperties = {
  fontSize: 12,
  fontWeight: 900,
  letterSpacing: "0.06em",
  fontVariantNumeric: "tabular-nums",
};

const cardTag: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "rgba(255,255,255,0.42)",
  letterSpacing: "0.03em",
};

const cardTitle: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 22,
  fontWeight: 800,
  color: "#ffffff",
  lineHeight: 1.18,
  letterSpacing: "-0.022em",
};

const cardDesc: CSSProperties = {
  margin: "0 0 20px",
  fontSize: 14,
  color: "rgba(255,255,255,0.62)",
  lineHeight: 1.68,
  flexGrow: 1,
};

const cardHighlights: CSSProperties = {
  margin: "0 0 24px",
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const cardHighlightItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  fontSize: 13,
  color: "rgba(255,255,255,0.70)",
  fontWeight: 500,
  lineHeight: 1.4,
};

const highlightArrow: CSSProperties = {
  fontSize: 9,
  flexShrink: 0,
  marginTop: 1,
};

const cardLinks: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  marginTop: "auto",
};

const ctaRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
};

const ctaBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "9px 16px",
  borderRadius: 10,
  textDecoration: "none",
  fontSize: 13,
  fontWeight: 700,
  color: "#fff",
  letterSpacing: "0.01em",
  border: "1px solid transparent",
};

const ctaBtnGhost: CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.14)",
  color: "rgba(255,255,255,0.55)",
};

const ctaHint: CSSProperties = {
  fontSize: 12,
  color: "rgba(255,255,255,0.42)",
  fontWeight: 500,
};

/* Footer */
const footer: CSSProperties = {
  textAlign: "center",
  padding: "28px 24px",
  fontSize: 13,
  color: "rgba(255,255,255,0.18)",
  borderTop: "1px solid rgba(255,255,255,0.05)",
};
