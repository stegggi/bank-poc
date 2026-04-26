import { useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/router";
import type { Challenge } from "../../use-cases/uc7-sow-verification/lib/types";

/**
 * Public re-verification page.
 *
 * Anyone with the challengeId can open this URL and see exactly which
 * message was signed, by which wallet, and when — with the raw signature
 * bytes for independent verification (e.g. via Etherscan's "Verify
 * Signature" tool, MyEtherWallet, or `ethers.verifyMessage(...)` in code).
 *
 * No private data is exposed: the challenge contains only a case
 * reference, a nonce, and a timestamp.
 */
export default function VerifyPage() {
  const router = useRouter();
  const { challengeId } = router.query;
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!challengeId || typeof challengeId !== "string") return;
    (async () => {
      const res = await fetch(`/api/uc7/challenge/${challengeId}`);
      if (!res.ok) {
        setError("Challenge not found");
        return;
      }
      const json = await res.json();
      setChallenge(json.challenge);
    })();
  }, [challengeId]);

  const wrap: CSSProperties = {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #0b1220 0%, #07080f 100%)",
    color: "#fff",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  };
  const card: CSSProperties = {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 14,
    padding: 28,
    maxWidth: 720,
    width: "100%",
  };
  const fieldLabel: CSSProperties = {
    fontSize: 11,
    color: "rgba(255,255,255,0.55)",
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    fontWeight: 700,
    marginTop: 14,
    marginBottom: 4,
  };
  const valueBox: CSSProperties = {
    background: "rgba(0,0,0,0.25)",
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: 6,
    padding: 10,
    fontSize: 12,
    color: "#fff",
    fontFamily: "monospace",
    wordBreak: "break-all",
    whiteSpace: "pre-wrap",
  };

  if (error) {
    return (
      <div style={wrap}>
        <div style={card}>
          <h1 style={{ margin: 0, fontSize: 22 }}>Signature verification</h1>
          <p style={{ color: "#fca5a5", marginTop: 12 }}>{error}</p>
        </div>
      </div>
    );
  }
  if (!challenge) {
    return (
      <div style={wrap}>
        <div style={card}>Loading…</div>
      </div>
    );
  }

  const verified = challenge.status === "verified";
  const failed = challenge.status === "failed";
  const pending = challenge.status === "pending";

  const statusBadge = verified
    ? { label: "✓ VERIFIED", color: "#6ee7b7", bg: "rgba(16,185,129,0.1)", border: "rgba(16,185,129,0.4)" }
    : failed
      ? { label: "✗ FAILED", color: "#fca5a5", bg: "rgba(239,68,68,0.1)", border: "rgba(239,68,68,0.4)" }
      : { label: "PENDING", color: "#fbbf24", bg: "rgba(245,158,11,0.1)", border: "rgba(245,158,11,0.4)" };

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
          Wallet ownership signature · public proof
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 22 }}>Verification record</h1>
          <span
            style={{
              fontSize: 12,
              fontWeight: 800,
              letterSpacing: "0.05em",
              color: statusBadge.color,
              background: statusBadge.bg,
              border: `1px solid ${statusBadge.border}`,
              padding: "4px 10px",
              borderRadius: 4,
            }}
          >
            {statusBadge.label}
          </span>
        </div>

        <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 13, marginTop: 10, lineHeight: 1.6 }}>
          This is an off-chain cryptographic proof of wallet ownership — no on-chain
          transaction is involved. The wallet shown below produced an EIP-191 / Ed25519
          signature over the challenge message. You can independently verify the result
          using the data on this page (no trust in this server required).
        </p>

        <div style={fieldLabel}>Case reference</div>
        <div style={valueBox}>{challenge.caseReference}</div>

        <div style={fieldLabel}>Wallet address ({challenge.chainFamily})</div>
        <div style={valueBox}>{challenge.address}</div>

        <div style={fieldLabel}>Signed message</div>
        <div style={valueBox}>{challenge.message}</div>

        {challenge.signature ? (
          <>
            <div style={fieldLabel}>Signature</div>
            <div style={valueBox}>{challenge.signature}</div>
          </>
        ) : pending ? (
          <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 12, marginTop: 14 }}>
            Awaiting client signature.
          </p>
        ) : null}

        {challenge.verifiedAt && (
          <>
            <div style={fieldLabel}>Verified at</div>
            <div style={valueBox}>{challenge.verifiedAt}</div>
          </>
        )}

        {challenge.failReason && (
          <>
            <div style={fieldLabel}>Failure reason</div>
            <div style={{ ...valueBox, color: "#fca5a5" }}>{challenge.failReason}</div>
          </>
        )}

        <div style={fieldLabel}>How to verify independently</div>
        <ol
          style={{
            fontSize: 12,
            color: "rgba(255,255,255,0.7)",
            paddingLeft: 18,
            lineHeight: 1.7,
            marginTop: 4,
          }}
        >
          {challenge.chainFamily === "evm" && (
            <>
              <li>
                Use{" "}
                <a href="https://app.mycrypto.com/verify-message" target="_blank" rel="noreferrer" style={linkStyle}>
                  MyCrypto&rsquo;s Verify Message tool
                </a>{" "}
                or any EIP-191 verifier.
              </li>
              <li>
                Paste the message, signature, and signing address shown above. The recovered
                address must match the signing address.
              </li>
              <li>
                In code:{" "}
                <code style={{ background: "rgba(255,255,255,0.05)", padding: "1px 4px", borderRadius: 3 }}>
                  ethers.verifyMessage(message, signature)
                </code>{" "}
                must return the wallet address.
              </li>
            </>
          )}
          {challenge.chainFamily === "solana" && (
            <>
              <li>
                Decode the signature and the public key from base58, then call{" "}
                <code style={{ background: "rgba(255,255,255,0.05)", padding: "1px 4px", borderRadius: 3 }}>
                  nacl.sign.detached.verify(messageBytes, sigBytes, pubKey)
                </code>
                .
              </li>
              <li>The function must return <code>true</code>.</li>
            </>
          )}
          {challenge.chainFamily === "bitcoin" && (
            <li>
              Use any BIP-137 message verification tool (e.g. Electrum &gt; Tools &gt; Sign /
              verify message) with the message, address and signature above.
            </li>
          )}
        </ol>

        <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 11, marginTop: 18, lineHeight: 1.5 }}>
          Stable URL — bookmark this page or include it in the compliance file. The data
          here is sufficient for any auditor to confirm the wallet ownership independently.
        </p>
      </div>
    </div>
  );
}

const linkStyle: CSSProperties = {
  color: "#93c5fd",
  textDecoration: "underline",
};
