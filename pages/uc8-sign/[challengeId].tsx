import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/router";
import { BrowserProvider } from "ethers";
import type { Challenge } from "../../use-cases/uc8-sof-verification/lib/types";

type EthereumWindow = typeof window & {
  ethereum?: {
    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  };
  solana?: {
    isPhantom?: boolean;
    connect: () => Promise<{ publicKey: { toBase58: () => string } }>;
    signMessage: (m: Uint8Array, encoding?: string) => Promise<{ signature: Uint8Array; publicKey: { toBase58: () => string } }>;
  };
};

function b58Encode(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let zeros = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      const x = digits[j] * 256 + carry;
      digits[j] = x % 58;
      carry = Math.floor(x / 58);
    }
    while (carry) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "";
  for (let i = 0; i < zeros; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

export default function SignPage() {
  const router = useRouter();
  const { challengeId } = router.query;
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [status, setStatus] = useState<"idle" | "signing" | "verifying" | "done" | "error">("idle");
  const [error, setError] = useState<string>("");
  const [result, setResult] = useState<string>("");

  useEffect(() => {
    if (!challengeId || typeof challengeId !== "string") return;
    (async () => {
      const res = await fetch(`/api/uc8/challenge/${challengeId}`);
      if (!res.ok) {
        setError("Challenge not found or expired");
        setStatus("error");
        return;
      }
      const json = await res.json();
      setChallenge(json.challenge);
      if (json.challenge.status === "verified") {
        setStatus("done");
        setResult("Ownership already verified. You can close this page.");
      }
    })();
  }, [challengeId]);

  const signEvm = useCallback(async () => {
    if (!challenge) return;
    setStatus("signing");
    setError("");
    const w = window as EthereumWindow;
    if (!w.ethereum) {
      setError("No EVM wallet detected. Open this page in a wallet app (MetaMask, Rabby) or use WalletConnect.");
      setStatus("error");
      return;
    }
    try {
      const provider = new BrowserProvider(w.ethereum as unknown as ConstructorParameters<typeof BrowserProvider>[0]);
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      const connected = (await signer.getAddress()).toLowerCase();
      if (connected !== challenge.address.toLowerCase()) {
        setError(`Your wallet address (${connected}) does not match the challenge address (${challenge.address}). Switch accounts and try again.`);
        setStatus("error");
        return;
      }
      const signature = await signer.signMessage(challenge.message);
      setStatus("verifying");
      const res = await fetch("/api/uc8/verify-signature", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
      });
      const json = await res.json();
      if (json.result?.ok) {
        setStatus("done");
        setResult("Ownership verified. You can close this page.");
      } else {
        setError(json.result?.error || "Signature verification failed");
        setStatus("error");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signing failed");
      setStatus("error");
    }
  }, [challenge]);

  const signSolana = useCallback(async () => {
    if (!challenge) return;
    setStatus("signing");
    setError("");
    const w = window as EthereumWindow;
    if (!w.solana) {
      setError("No Solana wallet detected. Open this page in Phantom or Solflare.");
      setStatus("error");
      return;
    }
    try {
      const conn = await w.solana.connect();
      const pubKey = conn.publicKey.toBase58();
      if (pubKey !== challenge.address) {
        setError(`Your wallet address (${pubKey}) does not match the challenge address (${challenge.address}).`);
        setStatus("error");
        return;
      }
      const encoded = new TextEncoder().encode(challenge.message);
      const signed = await w.solana.signMessage(encoded, "utf8");
      const sig = b58Encode(signed.signature);
      setStatus("verifying");
      const res = await fetch("/api/uc8/verify-signature", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId: challenge.challengeId, signature: sig, publicKey: pubKey }),
      });
      const json = await res.json();
      if (json.result?.ok) {
        setStatus("done");
        setResult("Ownership verified. You can close this page.");
      } else {
        setError(json.result?.error || "Signature verification failed");
        setStatus("error");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signing failed");
      setStatus("error");
    }
  }, [challenge]);

  const pageStyle: CSSProperties = {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #0b1220 0%, #07080f 100%)",
    color: "#fff",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  };
  const cardStyle: CSSProperties = {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 14,
    padding: 28,
    maxWidth: 500,
    width: "100%",
  };

  if (!challenge) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <h1 style={{ margin: 0, fontSize: 20 }}>Digital Asset Ownership Verification</h1>
          <p style={{ color: "rgba(255,255,255,0.6)", marginTop: 12 }}>
            {error || "Loading challenge…"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
          LGT Digital Asset Onboarding
        </div>
        <h1 style={{ margin: "0 0 6px", fontSize: 22 }}>Verify Wallet Ownership</h1>
        <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, marginBottom: 20 }}>
          Reference {challenge.caseReference}
        </div>

        <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 14, marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>Challenge message</div>
          <pre style={{ fontSize: 12, color: "#fff", margin: 0, fontFamily: "monospace", whiteSpace: "pre-wrap" }}>{challenge.message}</pre>
        </div>

        <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 14, marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>Wallet to sign with</div>
          <code style={{ fontSize: 12, color: "#fff", wordBreak: "break-all" }}>{challenge.address}</code>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 4 }}>Chain: {challenge.chainFamily}</div>
        </div>

        {status === "done" ? (
          <div style={{ padding: 14, background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.4)", borderRadius: 8, color: "#6ee7b7" }}>
            {result}
          </div>
        ) : status === "error" ? (
          <>
            <div style={{ padding: 14, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.4)", borderRadius: 8, color: "#fca5a5", marginBottom: 14 }}>
              {error}
            </div>
            <SignButtons challenge={challenge} onEvm={signEvm} onSol={signSolana} />
          </>
        ) : status === "signing" || status === "verifying" ? (
          <div style={{ padding: 14, color: "rgba(255,255,255,0.65)", textAlign: "center" }}>
            {status === "signing" ? "Please sign the message in your wallet…" : "Verifying signature…"}
          </div>
        ) : (
          <SignButtons challenge={challenge} onEvm={signEvm} onSol={signSolana} />
        )}

        <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 11, marginTop: 20, lineHeight: 1.5 }}>
          This challenge contains no personal information. Signing proves you control the wallet address without revealing any private keys.
        </p>
      </div>
    </div>
  );
}

function SignButtons({
  challenge,
  onEvm,
  onSol,
}: {
  challenge: Challenge;
  onEvm: () => void;
  onSol: () => void;
}) {
  const btn: CSSProperties = {
    width: "100%",
    padding: "14px 18px",
    borderRadius: 10,
    border: "1px solid rgba(59,130,246,0.4)",
    background: "rgba(59,130,246,0.15)",
    color: "#fff",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 8,
  };
  if (challenge.chainFamily === "evm") {
    return (
      <button style={btn} onClick={onEvm}>
        Connect wallet and sign
      </button>
    );
  }
  if (challenge.chainFamily === "solana") {
    return (
      <button style={btn} onClick={onSol}>
        Connect Solana wallet and sign
      </button>
    );
  }
  return (
    <div style={{ padding: 14, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.4)", borderRadius: 8, color: "#fbbf24" }}>
      {challenge.chainFamily === "bitcoin"
        ? "Bitcoin signature verification is handled out-of-band in this prototype. Contact your compliance officer for instructions."
        : `Signing for ${challenge.chainFamily} is not supported in this prototype.`}
    </div>
  );
}
