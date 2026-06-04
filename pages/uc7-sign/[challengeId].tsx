import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/router";
import { BrowserProvider, type Eip1193Provider } from "ethers";
import type { Challenge } from "../../use-cases/uc7-sow-verification/lib/types";

const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

// EIP-6963 — Multi Injected Provider Discovery. Wallets that follow it
// announce themselves via a custom event so the dApp can list every
// installed extension instead of using whichever one happened to win the
// `window.ethereum` slot. MetaMask, Coinbase, Rabby, Brave, Trust, OKX,
// Phantom, Frame, etc. all support it.
type Eip6963ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};
type Eip6963Detail = {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
};

function useDetectedWallets(): Eip6963Detail[] {
  const [wallets, setWallets] = useState<Eip6963Detail[]>([]);
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963Detail>).detail;
      if (!detail?.info?.uuid) return;
      setWallets((prev) =>
        prev.some((w) => w.info.uuid === detail.info.uuid)
          ? prev
          : [...prev, detail],
      );
    };
    window.addEventListener("eip6963:announceProvider", handler);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", handler);
  }, []);
  return wallets;
}

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
  const detectedWallets = useDetectedWallets();

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

  const signEvm = useCallback(
    async (provider?: Eip1193Provider) => {
      if (!challenge) return;
      setStatus("signing");
      setError("");
      // Prefer the provider the user explicitly picked (via EIP-6963). If
      // none was passed, fall back to whatever holds window.ethereum — this
      // keeps the page working for older wallets that don't support 6963.
      const w = window as EthereumWindow;
      const target =
        provider ?? (w.ethereum as unknown as Eip1193Provider | undefined);
      if (!target) {
        setError(
          "No browser wallet detected. Install MetaMask, Rabby, Trust, Coinbase, or any other EIP-1193 wallet — or use the QR option to sign with a mobile wallet.",
        );
        setStatus("error");
        return;
      }
      try {
        await signWithEvmProvider(target);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Signing failed");
        setStatus("error");
      }
    },
    [challenge, signWithEvmProvider],
  );

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
    background: "linear-gradient(180deg, var(--bg) 0%, var(--bg) 100%)",
    color: "var(--heading)",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  };
  const cardStyle: CSSProperties = {
    background: "rgba(var(--ink),0.04)",
    border: "1px solid rgba(var(--ink),0.08)",
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
          <p style={{ color: "rgba(var(--ink),0.6)", marginTop: 12 }}>
            {error || "Loading challenge…"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <div style={{ fontSize: 11, color: "rgba(var(--ink),0.5)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
          Digital Asset Wallet Verification
        </div>
        <h1 style={{ margin: "0 0 6px", fontSize: 22 }}>Verify Wallet Ownership</h1>
        <div style={{ color: "rgba(var(--ink),0.55)", fontSize: 13, marginBottom: 20 }}>
          Reference {challenge.caseReference}
        </div>

        <div style={{ background: "rgba(var(--ink),0.03)", border: "1px solid rgba(var(--ink),0.08)", borderRadius: 8, padding: 14, marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: "rgba(var(--ink),0.5)", marginBottom: 4 }}>Challenge message</div>
          <pre style={{ fontSize: 12, color: "var(--heading)", margin: 0, fontFamily: "monospace", whiteSpace: "pre-wrap" }}>{challenge.message}</pre>
        </div>

        <div style={{ background: "rgba(var(--ink),0.03)", border: "1px solid rgba(var(--ink),0.08)", borderRadius: 8, padding: 14, marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: "rgba(var(--ink),0.5)", marginBottom: 4 }}>Wallet to sign with</div>
          <code style={{ fontSize: 12, color: "var(--heading)", wordBreak: "break-all" }}>{challenge.address}</code>
          <div style={{ fontSize: 11, color: "rgba(var(--ink),0.5)", marginTop: 4 }}>Chain: {challenge.chainFamily}</div>
        </div>

        {status === "done" ? (
          <div style={{ padding: 14, background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.4)", borderRadius: 8, color: "var(--a-6ee7b7)" }}>
            {result}
          </div>
        ) : (
          <>
            {status === "error" && (
              <div style={{ padding: 14, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.4)", borderRadius: 8, color: "var(--a-fca5a5)", marginBottom: 14 }}>
                {error}
              </div>
            )}
            {status === "signing" || status === "verifying" ? (
              <div style={{ padding: 14, color: "rgba(var(--ink),0.65)", textAlign: "center" }}>
                {status === "signing" ? "Please sign the message in your wallet…" : "Verifying signature…"}
              </div>
            ) : (
              <SignButtons
                challenge={challenge}
                onEvm={signEvm}
                onEvmWalletConnect={signEvmWalletConnect}
                onSol={signSolana}
                walletConnectAvailable={Boolean(WC_PROJECT_ID)}
                detectedWallets={detectedWallets}
              />
            )}

            {/* Manual signature paste — works for any wallet (Ledger Live,
                Rabby, Brave Wallet, Frame, OKX, hardware wallets, etc.) */}
            {(challenge.chainFamily === "evm" || challenge.chainFamily === "solana") && (
              <details style={{ marginTop: 16 }}>
                <summary
                  style={{
                    cursor: "pointer",
                    color: "rgba(var(--ink),0.65)",
                    fontSize: 13,
                    padding: "8px 0",
                  }}
                >
                  Or paste a signature from another wallet
                </summary>
                <div
                  style={{
                    background: "rgba(var(--ink),0.03)",
                    border: "1px solid rgba(var(--ink),0.08)",
                    borderRadius: 8,
                    padding: 14,
                    marginTop: 6,
                  }}
                >
                  <ol
                    style={{
                      fontSize: 12,
                      color: "rgba(var(--ink),0.7)",
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
                      border: "1px solid rgba(var(--ink),0.1)",
                      background: "rgba(0,0,0,0.25)",
                      color: "var(--heading)",
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
                        border: "1px solid rgba(var(--ink),0.1)",
                        background: "rgba(0,0,0,0.25)",
                        color: "var(--heading)",
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
                      border: "1px solid rgba(var(--ink),0.15)",
                      background: "rgba(var(--ink),0.06)",
                      color: "var(--heading)",
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

        <p style={{ color: "rgba(var(--ink),0.4)", fontSize: 11, marginTop: 20, lineHeight: 1.5 }}>
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
  detectedWallets,
}: {
  challenge: Challenge;
  onEvm: (provider?: Eip1193Provider) => void;
  onEvmWalletConnect: () => void;
  onSol: () => void;
  walletConnectAvailable: boolean;
  detectedWallets: Eip6963Detail[];
}) {
  const btn: CSSProperties = {
    width: "100%",
    padding: "14px 18px",
    borderRadius: 10,
    border: "1px solid rgba(59,130,246,0.4)",
    background: "rgba(59,130,246,0.15)",
    color: "var(--heading)",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 8,
  };
  const btnSecondary: CSSProperties = {
    ...btn,
    border: "1px solid rgba(var(--ink),0.15)",
    background: "rgba(var(--ink),0.06)",
  };
  if (challenge.chainFamily === "evm") {
    const sectionLabel: CSSProperties = {
      fontSize: 11,
      color: "rgba(var(--ink),0.45)",
      letterSpacing: "0.05em",
      textTransform: "uppercase",
      fontWeight: 700,
      marginTop: 4,
      marginBottom: 6,
    };
    const walletBtn: CSSProperties = {
      ...btn,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      marginTop: 6,
    };
    const hasInjected =
      typeof window !== "undefined" && !!(window as EthereumWindow).ethereum;
    return (
      <>
        <div style={sectionLabel}>Sign on this device</div>

        {detectedWallets.length > 0 ? (
          <>
            {detectedWallets.map((w) => (
              <button
                key={w.info.uuid}
                style={walletBtn}
                onClick={() => onEvm(w.provider)}
                title={`Sign with ${w.info.name}`}
              >
                {w.info.icon && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={w.info.icon}
                    alt=""
                    width={20}
                    height={20}
                    style={{ borderRadius: 4 }}
                  />
                )}
                <span>Sign with {w.info.name}</span>
              </button>
            ))}
            <p style={{ color: "rgba(var(--ink),0.5)", fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
              {detectedWallets.length === 1
                ? "Detected one wallet extension in this browser. Click to sign."
                : `Detected ${detectedWallets.length} wallet extensions in this browser — pick the one that holds the address you registered.`}
            </p>
          </>
        ) : hasInjected ? (
          <>
            <button style={walletBtn} onClick={() => onEvm()}>
              Connect browser wallet
            </button>
            <p style={{ color: "rgba(var(--ink),0.5)", fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
              A wallet is injected in this browser but it doesn&rsquo;t advertise
              itself via EIP-6963 — we&rsquo;ll use whichever one currently holds{" "}
              <code>window.ethereum</code>. If that turns out to be the wrong
              wallet (e.g. a Coinbase extension when you wanted MetaMask),
              disable the unwanted extension or switch to the QR option below.
            </p>
          </>
        ) : (
          <div
            style={{
              padding: 12,
              background: "rgba(245,158,11,0.08)",
              border: "1px solid rgba(245,158,11,0.3)",
              borderRadius: 8,
              color: "var(--a-fbbf24)",
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              No wallet extension detected in this browser.
            </div>
            Install one of these (any will work — pick whichever you already
            use, or trust):
            <ul style={{ paddingLeft: 18, marginTop: 6, marginBottom: 0 }}>
              <li>
                <a href="https://metamask.io/download/" target="_blank" rel="noreferrer" style={{ color: "var(--a-93c5fd)" }}>
                  MetaMask
                </a>
              </li>
              <li>
                <a href="https://rabby.io/" target="_blank" rel="noreferrer" style={{ color: "var(--a-93c5fd)" }}>
                  Rabby
                </a>
              </li>
              <li>
                <a href="https://www.coinbase.com/wallet/downloads" target="_blank" rel="noreferrer" style={{ color: "var(--a-93c5fd)" }}>
                  Coinbase Wallet
                </a>
              </li>
              <li>
                <a href="https://trustwallet.com/download" target="_blank" rel="noreferrer" style={{ color: "var(--a-93c5fd)" }}>
                  Trust Wallet
                </a>
              </li>
              <li>
                <a href="https://www.okx.com/web3" target="_blank" rel="noreferrer" style={{ color: "var(--a-93c5fd)" }}>
                  OKX Wallet
                </a>
              </li>
            </ul>
            <div style={{ marginTop: 8 }}>
              Or use the QR option below to sign with a wallet on your phone
              instead.
            </div>
          </div>
        )}

        <div style={{ ...sectionLabel, marginTop: 18 }}>Sign on a different device</div>
        <button
          style={{
            ...btn,
            opacity: walletConnectAvailable ? 1 : 0.5,
            cursor: walletConnectAvailable ? "pointer" : "not-allowed",
          }}
          onClick={onEvmWalletConnect}
          disabled={!walletConnectAvailable}
          title={
            walletConnectAvailable
              ? "Open a QR you can scan from any WalletConnect-compatible mobile wallet"
              : "WalletConnect project id not configured on this server"
          }
        >
          Scan QR with mobile wallet
        </button>
        <p style={{ color: "rgba(var(--ink),0.55)", fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
          {walletConnectAvailable
            ? "Opens a QR code that any WalletConnect-compatible app can scan — MetaMask Mobile, Trust, Rainbow, Argent, Safe, Coinbase, OKX, Zerion, Ledger Live, Rabby, …"
            : "WalletConnect isn't configured on this server. Install a browser wallet above to sign instead."}
        </p>
      </>
    );
  }
  if (challenge.chainFamily === "solana") {
    return (
      <>
        <button style={btn} onClick={onSol}>
          Connect Solana wallet and sign
        </button>
        <p style={{ color: "rgba(var(--ink),0.45)", fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
          Detects Phantom / Solflare automatically.
        </p>
      </>
    );
  }
  return (
    <div style={{ padding: 14, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.4)", borderRadius: 8, color: "var(--a-fbbf24)" }}>
      {challenge.chainFamily === "bitcoin"
        ? "Bitcoin signature verification is handled out-of-band in this prototype. Contact your compliance officer for instructions."
        : `Signing for ${challenge.chainFamily} is not supported in this prototype.`}
    </div>
  );
}
