import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/router";
import { BrowserProvider, type Eip1193Provider } from "ethers";
import type { Challenge } from "../../use-cases/uc7-sow-verification/lib/types";

const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

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
  const [manualSig, setManualSig] = useState<string>("");
  const [manualPubKey, setManualPubKey] = useState<string>("");

  useEffect(() => {
    if (!challengeId || typeof challengeId !== "string") return;
    (async () => {
      const res = await fetch(`/api/uc7/challenge/${challengeId}`);
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

  const signWithEvmProvider = useCallback(
    async (eip1193: Eip1193Provider) => {
      if (!challenge) return;
      const provider = new BrowserProvider(eip1193);
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
      const res = await fetch("/api/uc7/verify-signature", {
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
    },
    [challenge],
  );

  const signEvm = useCallback(async () => {
    if (!challenge) return;
    setStatus("signing");
    setError("");
    const w = window as EthereumWindow;
    if (!w.ethereum) {
      setError("No browser wallet detected. Use the WalletConnect button below for mobile or hardware wallets, or open this page in a wallet app's built-in browser (MetaMask, Rabby, Coinbase).");
      setStatus("error");
      return;
    }
    try {
      await signWithEvmProvider(w.ethereum as unknown as Eip1193Provider);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signing failed");
      setStatus("error");
    }
  }, [challenge, signWithEvmProvider]);

  const signEvmWalletConnect = useCallback(async () => {
    if (!challenge) return;
    if (!WC_PROJECT_ID) {
      setError("WalletConnect is not configured on this server (missing NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID).");
      setStatus("error");
      return;
    }
    setStatus("signing");
    setError("");
    try {
      const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
      const wc = await EthereumProvider.init({
        projectId: WC_PROJECT_ID,
        chains: [1],
        optionalChains: [10, 56, 137, 8453, 42161, 43114],
        showQrModal: true,
        metadata: {
          name: "Wallet Ownership Verification",
          description: "Sign a challenge to prove ownership of your wallet.",
          url: typeof window !== "undefined" ? window.location.origin : "",
          icons: [],
        },
      });
      await wc.connect();
      await signWithEvmProvider(wc as unknown as Eip1193Provider);
      try {
        await wc.disconnect();
      } catch {
        /* ignore disconnect errors after a successful sign */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "WalletConnect signing failed");
      setStatus("error");
    }
  }, [challenge, signWithEvmProvider]);

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
      const res = await fetch("/api/uc7/verify-signature", {
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

  const submitManual = useCallback(async () => {
    if (!challenge) return;
    const sig = manualSig.trim();
    if (!sig) {
      setError("Paste the signature you produced from your wallet");
      setStatus("error");
      return;
    }
    setStatus("verifying");
    setError("");
    try {
      const res = await fetch("/api/uc7/verify-signature", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          signature: sig,
          ...(challenge.chainFamily === "solana" && manualPubKey.trim()
            ? { publicKey: manualPubKey.trim() }
            : {}),
        }),
      });
      const json = await res.json();
      if (json.result?.ok) {
        setStatus("done");
        setResult("Ownership verified. You can close this page.");
      } else {
        setError(json.result?.error || "Signature did not verify against the expected wallet address.");
        setStatus("error");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed");
      setStatus("error");
    }
  }, [challenge, manualSig, manualPubKey]);

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
          Digital Asset Wallet Verification
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
        ) : (
          <>
            {status === "error" && (
              <div style={{ padding: 14, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.4)", borderRadius: 8, color: "#fca5a5", marginBottom: 14 }}>
                {error}
              </div>
            )}
            {status === "signing" || status === "verifying" ? (
              <div style={{ padding: 14, color: "rgba(255,255,255,0.65)", textAlign: "center" }}>
                {status === "signing" ? "Please sign the message in your wallet…" : "Verifying signature…"}
              </div>
            ) : (
              <SignButtons
                challenge={challenge}
                onEvm={signEvm}
                onEvmWalletConnect={signEvmWalletConnect}
                onSol={signSolana}
                walletConnectAvailable={Boolean(WC_PROJECT_ID)}
              />
            )}

            {/* Manual signature paste — works for any wallet (Ledger Live,
                Rabby, Brave Wallet, Frame, OKX, hardware wallets, etc.) */}
            {(challenge.chainFamily === "evm" || challenge.chainFamily === "solana") && (
              <details style={{ marginTop: 16 }}>
                <summary
                  style={{
                    cursor: "pointer",
                    color: "rgba(255,255,255,0.65)",
                    fontSize: 13,
                    padding: "8px 0",
                  }}
                >
                  Or paste a signature from another wallet
                </summary>
                <div
                  style={{
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 8,
                    padding: 14,
                    marginTop: 6,
                  }}
                >
                  <ol
                    style={{
                      fontSize: 12,
                      color: "rgba(255,255,255,0.7)",
                      paddingLeft: 18,
                      margin: "0 0 10px",
                      lineHeight: 1.7,
                    }}
                  >
                    <li>Copy the challenge message above.</li>
                    <li>
                      Open your wallet (MetaMask, Rabby, Ledger Live, Phantom, Trust, OKX, …)
                      and use its <em>Sign Message</em> / <em>Personal Sign</em> feature.
                    </li>
                    <li>
                      Paste the resulting signature here.
                      {challenge.chainFamily === "solana" &&
                        " For Solana, also paste the public key you signed with."}
                    </li>
                  </ol>
                  <textarea
                    placeholder="0x… (hex signature)"
                    value={manualSig}
                    onChange={(e) => setManualSig(e.target.value)}
                    style={{
                      width: "100%",
                      minHeight: 70,
                      padding: 10,
                      borderRadius: 6,
                      border: "1px solid rgba(255,255,255,0.1)",
                      background: "rgba(0,0,0,0.25)",
                      color: "#fff",
                      fontFamily: "monospace",
                      fontSize: 11,
                      resize: "vertical",
                    }}
                  />
                  {challenge.chainFamily === "solana" && (
                    <input
                      placeholder="Solana public key (base58) — only if signing wallet differs"
                      value={manualPubKey}
                      onChange={(e) => setManualPubKey(e.target.value)}
                      style={{
                        width: "100%",
                        marginTop: 6,
                        padding: 8,
                        borderRadius: 6,
                        border: "1px solid rgba(255,255,255,0.1)",
                        background: "rgba(0,0,0,0.25)",
                        color: "#fff",
                        fontFamily: "monospace",
                        fontSize: 11,
                      }}
                    />
                  )}
                  <button
                    onClick={submitManual}
                    disabled={status === "verifying" || !manualSig.trim()}
                    style={{
                      marginTop: 10,
                      padding: "10px 14px",
                      borderRadius: 8,
                      border: "1px solid rgba(255,255,255,0.15)",
                      background: "rgba(255,255,255,0.06)",
                      color: "#fff",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: status === "verifying" || !manualSig.trim() ? "not-allowed" : "pointer",
                      opacity: status === "verifying" || !manualSig.trim() ? 0.6 : 1,
                    }}
                  >
                    Submit signature
                  </button>
                </div>
              </details>
            )}
          </>
        )}

        <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 11, marginTop: 20, lineHeight: 1.5 }}>
          This challenge contains no personal information. Signing proves you control the wallet
          address without revealing any private keys, without paying gas, and without sending an
          on-chain transaction.
        </p>
      </div>
    </div>
  );
}

function SignButtons({
  challenge,
  onEvm,
  onEvmWalletConnect,
  onSol,
  walletConnectAvailable,
}: {
  challenge: Challenge;
  onEvm: () => void;
  onEvmWalletConnect: () => void;
  onSol: () => void;
  walletConnectAvailable: boolean;
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
  const btnSecondary: CSSProperties = {
    ...btn,
    border: "1px solid rgba(255,255,255,0.15)",
    background: "rgba(255,255,255,0.06)",
  };
  if (challenge.chainFamily === "evm") {
    if (!walletConnectAvailable) {
      // No WalletConnect project id on the server — fall back to the injected
      // browser wallet so the page still functions, with a clear note that
      // the agnostic picker isn't available.
      return (
        <>
          <button style={btn} onClick={onEvm}>
            Connect browser wallet and sign
          </button>
          <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
            WalletConnect is not configured on this server, so this page
            falls back to the wallet your browser injects (MetaMask, Rabby,
            Brave Wallet, Coinbase Wallet, …). On mobile, open this link
            from inside your wallet app&rsquo;s built-in browser.
          </p>
        </>
      );
    }
    return (
      <>
        <button
          style={btn}
          onClick={onEvmWalletConnect}
          title="Pick any wallet — MetaMask, Trust, Rainbow, Argent, Safe, Coinbase, Ledger Live, …"
        >
          Connect any wallet
        </button>
        <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
          Opens a wallet picker that supports 300+ wallets — MetaMask, Trust,
          Rainbow, Argent, Safe, Coinbase, OKX, Zerion, Ledger Live, Rabby, … —
          plus a QR code fallback for any WalletConnect-compatible mobile app.
        </p>
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: "pointer", color: "rgba(255,255,255,0.5)", fontSize: 12 }}>
            Power users: use the wallet already injected in this browser
          </summary>
          <button style={{ ...btnSecondary, marginTop: 8 }} onClick={onEvm}>
            Use injected wallet (window.ethereum)
          </button>
          <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
            Skips the picker and uses whatever extension is bound to{" "}
            <code>window.ethereum</code> right now (whichever wallet your
            browser injected last). On Brave or with the Coinbase extension
            installed, this can lock you into one specific wallet — prefer{" "}
            <em>Connect any wallet</em> above.
          </p>
        </details>
      </>
    );
  }
  if (challenge.chainFamily === "solana") {
    return (
      <>
        <button style={btn} onClick={onSol}>
          Connect Solana wallet and sign
        </button>
        <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
          Detects Phantom / Solflare automatically.
        </p>
      </>
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
