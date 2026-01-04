// pages/kyc-badge.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { BrowserProvider, Interface } from "ethers";
import NavBar from "../components/NavBar";
import { publicClient } from "../lib/aa";

const BADGE = (process.env.NEXT_PUBLIC_KYC_BADGE_ADDRESS || "") as `0x${string}`;

// Arbitrum Sepolia: 421614 = 0x66eee
const ARB_SEPOLIA_HEX = "0x66eee";

const arbTx = (h: string) => `https://sepolia.arbiscan.io/tx/${h}`;
const arbAddr = (a: string) => `https://sepolia.arbiscan.io/address/${a}`;
const isAddr = (a?: string) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));
const fmtDate = (unixSec?: number) => {
  if (!unixSec) return "—";
  try {
    return new Date(unixSec * 1000).toLocaleString();
  } catch {
    return "—";
  }
};

// Claims bitmask for the MVP trio
const CLAIM_KYC_STRONG = 1; // bit0
const CLAIM_CH = 2; // bit1
const CLAIM_OVER18 = 4; // bit2

const BADGE_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "operator", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },

  { type: "function", name: "claimOperatorRole", stateMutability: "nonpayable", inputs: [], outputs: [] },

  {
    type: "function",
    name: "issue",
    stateMutability: "nonpayable",
    inputs: [
      { name: "wallet", type: "address" },
      { name: "validUntil", type: "uint64" },
      { name: "claims", type: "uint8" },
    ],
    outputs: [],
  },
  { type: "function", name: "revoke", stateMutability: "nonpayable", inputs: [{ name: "wallet", type: "address" }], outputs: [] },

  {
    type: "function",
    name: "isValid",
    stateMutability: "view",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [
      { name: "valid", type: "bool" },
      { name: "validUntil", type: "uint64" },
      { name: "revoked", type: "bool" },
      { name: "issuer", type: "address" },
      { name: "operatorAddr", type: "address" },
      { name: "claims", type: "uint8" },
    ],
  },
] as const;

const BADGE_IFACE = new Interface(BADGE_ABI as any);

export default function KYCBadge() {
  const router = useRouter();
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();

  // ✅ Hydration fix: compute origin only after mount
  const [origin, setOrigin] = useState<string>("");

  // Verifier section
  const [walletToVerify, setWalletToVerify] = useState("");
  const [verifyStatus, setVerifyStatus] = useState<
    | ""
    | "missing"
    | "invalid_input"
    | "checking"
    | "valid"
    | "expired"
    | "revoked"
    | "not_found"
    | "error"
  >("");
  const [verifyResult, setVerifyResult] = useState<{
    valid: boolean;
    validUntil: number;
    revoked: boolean;
    issuer: string;
    operator: string;
    claims: number;
  } | null>(null);

  // Issuer panel state (Privy EOA as operator)
  const [issuerStatus, setIssuerStatus] = useState("");
      const [contractOperator, setContractOperator] = useState<string>("");

  const [issueTarget, setIssueTarget] = useState<string>("");
  const [issueDays, setIssueDays] = useState<number>(90);

  const [claimStrong, setClaimStrong] = useState(true);
  const [claimCH, setClaimCH] = useState(true);
  const [claimOver18, setClaimOver18] = useState(true);

  const pollingRef = useRef(false);

  // ✅ Hydration fix: set origin client-side only
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  // Prefill verifier from query /kyc-badge?addr=0x...
  useEffect(() => {
    if (!router.isReady) return;
    const q = router.query?.addr;
    if (!q) return;
    const addr = Array.isArray(q) ? q[0] : String(q);
    if (addr && isAddr(addr)) setWalletToVerify(addr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);

  const shareUrl = useMemo(() => {
    // origin is "" on SSR and first client render → renders "—" consistently → no hydration mismatch
    if (!origin) return "";
    if (!isAddr(walletToVerify)) return origin + "/kyc-badge";
    return origin + "/kyc-badge?addr=" + walletToVerify;
  }, [origin, walletToVerify]);

  const getEmbeddedProvider = async () => {
    const list = (wallets as any[]) || [];
    const embedded =
      list.find(
        (w: any) =>
          typeof w?.getEthereumProvider === "function" &&
          (w?.chainId === "eip155:421614" || w?.meta?.chainId === "eip155:421614")
      ) || list.find((w: any) => typeof w?.getEthereumProvider === "function");
    if (!embedded) throw new Error("No embedded Privy wallet found");
    return embedded.getEthereumProvider();
  };

  const ensureChain = async (prov: any) => {
    try {
      await prov.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ARB_SEPOLIA_HEX }],
      });
    } catch (e: any) {
      if (e?.code === 4902) {
        await prov.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: ARB_SEPOLIA_HEX,
              chainName: "Arbitrum Sepolia",
              nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: [process.env.NEXT_PUBLIC_RPC_URL as string],
              blockExplorerUrls: ["https://sepolia.arbiscan.io"],
            },
          ],
        });
      }
    }
  };

  const grantIfLow = async (addr: `0x${string}`) => {
    const bal = await publicClient.getBalance({ address: addr });
    const threshold = BigInt("200000000000000"); // 0.0002 ETH-ish
    if (bal >= threshold) return;

    setIssuerStatus("Bank sponsoring gas…");
    try {
      const r = await fetch("/api/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: addr }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "grant failed");
      setIssuerStatus("Gas sponsored ✅");
    } catch {
      setIssuerStatus("Gas sponsor attempt finished.");
    }
  };

  const refreshContractInfo = async () => {
    if (!BADGE) return;
    try {
      const op = (await publicClient.readContract({ address: BADGE, abi: BADGE_ABI, functionName: "operator" })) as string;
      setContractOperator(op);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    refreshContractInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!BADGE) return;
    if (pollingRef.current) return;
    pollingRef.current = true;

    const t = setInterval(() => {
      refreshContractInfo();
    }, 3500);

    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [BADGE]);

  const decodeClaims = (claims: number) => {
    const hasStrong = (claims & CLAIM_KYC_STRONG) !== 0;
    const hasCH = (claims & CLAIM_CH) !== 0;
    const hasOver18 = (claims & CLAIM_OVER18) !== 0;
    return { hasStrong, hasCH, hasOver18 };
  };

  const verify = async () => {
    try {
      setVerifyResult(null);

      if (!BADGE) {
        setVerifyStatus("missing");
        return;
      }
      if (!isAddr(walletToVerify)) {
        setVerifyStatus("invalid_input");
        return;
      }

      setVerifyStatus("checking");

      const out = (await publicClient.readContract({
        address: BADGE,
        abi: BADGE_ABI,
        functionName: "isValid",
        args: [walletToVerify as `0x${string}`],
      })) as any;

      const valid = Boolean(out?.[0]);
      const validUntilBig = (out?.[1] ?? BigInt("0")) as bigint;
      const revoked = Boolean(out?.[2]);
      const issuer = String(out?.[3] ?? "");
      const operator = String(out?.[4] ?? "");
      const claimsBig = (out?.[5] ?? BigInt("0")) as bigint;

      const validUntil = Number(validUntilBig);
      const claims = Number(claimsBig);

      const now = Math.floor(Date.now() / 1000);
      const expired = validUntil > 0 && validUntil < now;

      const nextStatus = revoked
        ? "revoked"
        : valid
        ? expired
          ? "expired"
          : "valid"
        : "not_found";

      setVerifyResult({ valid, validUntil, revoked, issuer, operator, claims });
      setVerifyStatus(nextStatus as any);
    } catch {
      setVerifyStatus("error");
      setVerifyResult(null);
    }
  };

  const getClaimsMaskFromUI = () => {
    let m = 0;
    if (claimStrong) m |= CLAIM_KYC_STRONG;
    if (claimCH) m |= CLAIM_CH;
    if (claimOver18) m |= CLAIM_OVER18;
    return m;
  };

  const ensureIssuerReady = async () => {
    if (!ready) throw new Error("Privy not ready yet");
    if (!authenticated) {
      await login();
      throw new Error("Please retry after login.");
    }
    if (!BADGE) throw new Error("Missing NEXT_PUBLIC_KYC_BADGE_ADDRESS");

    const eip1193 = await getEmbeddedProvider();
    await ensureChain(eip1193);

    const ethersProvider = new BrowserProvider(eip1193);
    const signer = await ethersProvider.getSigner();
    const addr = (await signer.getAddress()) as `0x${string}`;

    await grantIfLow(addr);

    return { signer, addr };
  };

  const claimOperatorIfNeeded = async (signer: any, addr: `0x${string}`) => {
    const op = (await publicClient.readContract({
      address: BADGE,
      abi: BADGE_ABI,
      functionName: "operator",
    })) as string;

    setContractOperator(op);

    if (op?.toLowerCase() === addr.toLowerCase()) return;

    setIssuerStatus("Claiming operator role (demo)…");
    const data = BADGE_IFACE.encodeFunctionData("claimOperatorRole", []);
    const tx = await signer.sendTransaction({ to: BADGE, data });

    setIssuerStatus(`Operator claim pending… ${arbTx(tx.hash)}`);
    await publicClient.waitForTransactionReceipt({ hash: tx.hash as `0x${string}` });

    setIssuerStatus(`Operator claimed ✅ ${arbTx(tx.hash)}`);
    await refreshContractInfo();
  };

  const doIssueOrRenew = async () => {
    try {
      setIssuerStatus("");

      if (!isAddr(issueTarget)) {
        setIssuerStatus("Please enter a valid target wallet address (0x…).");
        return;
      }

      const { signer, addr } = await ensureIssuerReady();
      await claimOperatorIfNeeded(signer, addr);

      const days = Number.isFinite(issueDays) && issueDays > 0 ? issueDays : 90;
      const now = Math.floor(Date.now() / 1000);
      const validUntil = now + Math.floor(days * 24 * 60 * 60);

      const claims = getClaimsMaskFromUI();

      setIssuerStatus("Issuing / renewing badge…");
      const data = BADGE_IFACE.encodeFunctionData("issue", [
        issueTarget as `0x${string}`,
        BigInt(validUntil),
        claims,
      ]);
      const tx = await signer.sendTransaction({ to: BADGE, data });

      setIssuerStatus(`Issue pending… ${arbTx(tx.hash)}`);
      await publicClient.waitForTransactionReceipt({ hash: tx.hash as `0x${string}` });

      setIssuerStatus(`Issued ✅ ${arbTx(tx.hash)}`);

      setWalletToVerify(issueTarget);
      await verify();
    } catch (e: any) {
      setIssuerStatus(`Issue failed: ${e?.message || e}`);
    }
  };

  const doRevoke = async () => {
    try {
      setIssuerStatus("");

      if (!isAddr(issueTarget)) {
        setIssuerStatus("Please enter a valid target wallet address (0x…).");
        return;
      }

      const { signer, addr } = await ensureIssuerReady();
      await claimOperatorIfNeeded(signer, addr);

      setIssuerStatus("Revoking badge…");
      const data = BADGE_IFACE.encodeFunctionData("revoke", [issueTarget as `0x${string}`]);
      const tx = await signer.sendTransaction({ to: BADGE, data });

      setIssuerStatus(`Revoke pending… ${arbTx(tx.hash)}`);
      await publicClient.waitForTransactionReceipt({ hash: tx.hash as `0x${string}` });

      setIssuerStatus(`Revoked ✅ ${arbTx(tx.hash)}`);

      setWalletToVerify(issueTarget);
      await verify();
    } catch (e: any) {
      setIssuerStatus(`Revoke failed: ${e?.message || e}`);
    }
  };

  const badgePill = (() => {
    const base: React.CSSProperties = {
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      borderRadius: 999,
      padding: "6px 12px",
      fontSize: 12,
      fontWeight: 900,
      border: "1px solid #e6e8eb",
      background: "#fff",
      color: "#111",
    };

    if (verifyStatus === "valid")
      return <span style={{ ...base, background: "#e6f9f0", borderColor: "#bfe9d2" }}>Valid ✅</span>;
    if (verifyStatus === "expired")
      return <span style={{ ...base, background: "#fff3cd", borderColor: "#ffe3a3" }}>Expired ⏳</span>;
    if (verifyStatus === "revoked")
      return <span style={{ ...base, background: "#ffecec", borderColor: "#ffd0d0" }}>Revoked ⛔</span>;
    if (verifyStatus === "not_found")
      return <span style={{ ...base, background: "#f5f5f5" }}>No badge</span>;
    if (verifyStatus === "checking")
      return <span style={{ ...base, background: "#e6f0ff", borderColor: "#c9d8ff" }}>Checking…</span>;
    return <span style={base}>—</span>;
  })();

  const claimsText = useMemo(() => {
    if (!verifyResult) return null;

    const c = decodeClaims(verifyResult.claims || 0);
    const revoked = Boolean(verifyResult.revoked);

    return (
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Pill state={revoked ? "revoked" : c.hasStrong ? "on" : "off"} label="KYC_STRONG" />
        <Pill state={revoked ? "revoked" : c.hasCH ? "on" : "off"} label="CH" />
        <Pill state={revoked ? "revoked" : c.hasOver18 ? "on" : "off"} label="Age > 18" />
      </div>
    );
  }, [verifyResult]);

  return (
    <>
      <NavBar active="kyc-badge" />
      <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
        <h2 style={{ marginTop: 0, marginBottom: 8 }}>KYC badge</h2>
        <p style={{ marginTop: 0, color: "#555", lineHeight: 1.55 }}>
        </p>

        {/* Issuer panel */}
        <div style={card}>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div>
              <h3 style={{ margin: 0 }}>Bank issuer panel</h3>
              <div style={{ marginTop: 6, color: "#666", fontSize: 13, lineHeight: 1.5 }}>
                This panel will <strong>auto-claim operator role</strong> before issuing/revoking.
              </div>
            </div>
            <a
              href={BADGE ? arbAddr(BADGE) : "#"}
              target="_blank"
              rel="noreferrer"
              style={{ ...linkBtn, pointerEvents: BADGE ? "auto" : "none", opacity: BADGE ? 1 : 0.5 }}
            >
              Contract ↗
            </a>
          </div>

          <div style={{ marginTop: 12, display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
            <div style={miniCard}>
              <div style={miniTitle}>Current operator</div>
              <div style={mono}>{contractOperator || "—"}</div>
              <div style={hint}>
                This is the address allowed to issue/revoke. After the demo auto-claim, it updates to the logged-in embedded wallet.
              </div>
            </div>
          </div>

          <div style={{ marginTop: 14, display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
            <div style={miniCard}>
              <div style={miniTitle}>Target wallet</div>
              <input value={issueTarget} onChange={(e) => setIssueTarget(e.target.value.trim())} placeholder="0x…" style={input} />
            </div>

            <div style={miniCard}>
              <div style={miniTitle}>Validity (days)</div>
              <input value={String(issueDays)} onChange={(e) => setIssueDays(Number(e.target.value || 0))} type="number" min={1} style={input} />
            </div>

            <div style={miniCard}>
              <div style={miniTitle}>Claims</div>
              <label style={checkRow}>
                <input type="checkbox" checked={claimStrong} onChange={(e) => setClaimStrong(e.target.checked)} />
                <span>KYC_STRONG</span>
              </label>
              <label style={checkRow}>
                <input type="checkbox" checked={claimCH} onChange={(e) => setClaimCH(e.target.checked)} />
                <span>Jurisdiction: CH</span>
              </label>
              <label style={checkRow}>
                <input type="checkbox" checked={claimOver18} onChange={(e) => setClaimOver18(e.target.checked)} />
                <span>Age &gt; 18</span>
              </label>
            </div>
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={btn} onClick={doIssueOrRenew} disabled={!ready}>
              Issue / renew badge
            </button>
            <button style={btnSecondary} onClick={doRevoke} disabled={!ready}>
              Revoke badge
            </button>
          </div>

          {issuerStatus && <div style={{ ...note, marginTop: 10 }}>{issuerStatus}</div>}
        </div>

        {/* Verifier UI */}
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <h3 style={{ margin: 0 }}>Verifier UI (no wallet required)</h3>
            {badgePill}
          </div>

          <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 360px" }}>
              <div style={label}>Wallet to verify</div>
              <input value={walletToVerify} onChange={(e) => setWalletToVerify(e.target.value.trim())} placeholder="0x…" style={input} />
            </div>
            <button onClick={verify} style={btn}>
              Verify
            </button>
          </div>

          {verifyResult && (
            <>
              <div style={{ marginTop: 12, display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
                <div style={miniCard}>
                  <div style={miniTitle}>Operator</div>
                  <div style={mono}>{verifyResult.operator || "—"}</div>
                </div>
                <div style={miniCard}>
                  <div style={miniTitle}>Valid until</div>
                  <div style={{ color: "#333", fontSize: 13 }}>{verifyResult.validUntil ? fmtDate(verifyResult.validUntil) : "—"}</div>
                </div>
              </div>

              <div style={{ ...miniCard, marginTop: 10 }}>
                <div style={miniTitle}>Claims</div>
                {claimsText}
              </div>
            </>
          )}

          {/* ✅ Hydration-safe now */}
          <div style={{ ...note, marginTop: 12 }}>
            <strong>Share link:</strong>{" "}
            <span style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
              {shareUrl || "—"}
            </span>
          </div>
        </div>


        {/* ✅ Premium sticky accordion: Why this matters */}
        <WhyThisMatters />
      </div>
    </>
  );
}


/* ---------- Premium “Why this matters” (same component style as Bank-B) ---------- */

function WhyThisMatters() {
  const [open, setOpen] = useState(false);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [maxH, setMaxH] = useState(0);

  useEffect(() => {
    const update = () => {
      if (!innerRef.current) return;
      setMaxH(open ? innerRef.current.scrollHeight : 0);
    };
    update();
    if (typeof window !== "undefined") window.addEventListener("resize", update);
    return () => {
      if (typeof window !== "undefined") window.removeEventListener("resize", update);
    };
  }, [open]);

  return (
    <div style={whyStickyWrap}>
      <div style={whyShell}>
        <button type="button" onClick={() => setOpen((v) => !v)} style={whyHeaderBtn} aria-expanded={open}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <div style={whyTitleRow}>
              <span style={whyTitle}>Why this matters</span>
              <span style={whyMiniTag}>KYC badge</span>
            </div>
            <div style={whySubtitle}>
              A simple trust layer: verifiers can check identity status instantly, without holding a wallet. While the bank keeps control via expiry & revocation option.
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={whyHint}>{open ? "Hide" : "Show"}</span>
            <span style={{ display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: 12, border: "1px solid #e6e8eb", background: "#fff" }}>
              <span style={{ display: "inline-block", transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 180ms ease" }}>
                <WhyChevron />
              </span>
            </span>
          </div>
        </button>

        <div style={{ maxHeight: maxH, transition: "max-height 240ms ease", overflow: "hidden" }}>
          <div ref={innerRef} style={whyBody}>
            <WhySection
              k="1"
              title="Trust for real-world counterparties"
              subtitle="Private companies and public authorities need to identify who they deal with — a plain wallet address is not enough."
            >
              <div style={whyGrid2}>
                <div style={whyCard}>
                  <div style={whyCardTitle}>Verifier-friendly</div>
                  <div style={whyCardText}>
                    The verifier can check status via a simple web page (or QR link) — no crypto wallet, no signatures required.
                  </div>
                  <div style={whyPills}>
                    <WhyPill>Works for “everyone”</WhyPill>
                    <WhyPill>No wallet required</WhyPill>
                  </div>
                </div>

                <div style={whyCard}>
                  <div style={whyCardTitle}>Instant decision</div>
                  <div style={whyCardText}>
                    They only need one answer: “Is this wallet currently verified?” The badge gives a fast yes/no with an expiry date.
                  </div>
                  <div style={whyPills}>
                    <WhyPill>Clear yes/no</WhyPill>
                    <WhyPill>Expires</WhyPill>
                  </div>
                </div>
              </div>
            </WhySection>

            <WhySection
              k="2"
              title="Safety: expiry + revocation"
              subtitle="Badges must not be forever. Banks need a kill-switch if risk changes or a key export is requested."
            >
              <div style={whyGrid2}>
                <div style={whyCard}>
                  <div style={whyCardTitle}>Expiry keeps it fresh</div>
                  <div style={whyCardText}>
                    The badge expires (e.g., 90 days). If the user’s KYC or risk status changes, the badge naturally times out unless renewed.
                  </div>
                </div>
                <div style={whyCard}>
                  <div style={whyCardTitle}>Revocation is instant</div>
                  <div style={whyCardText}>
                    If the user requests the private key, closes the account, or triggers risk rules, the bank revokes the badge immediately.
                  </div>
                </div>
              </div>

              <div style={whyNote}>
                Demo interpretation: seedless wallet stays managed (Privy/bank). If a user wants the private key, the bank revokes the badge.
              </div>
            </WhySection>

            <WhySection
              k="3"
              title="No PII on-chain"
              subtitle="The chain is the shared audit rail — but sensitive identity data stays off-chain."
            >
              <div style={whyGrid2}>
                <div style={whyCard}>
                  <div style={whyCardTitle}>On-chain: minimal status</div>
                  <div style={whyCardText}>
                    Only validity date, revoked flag, and a tiny claims section (e.g., KYC_STRONG, CH, Age&gt;18). No names, addresses, or documents.
                  </div>
                </div>
                <div style={whyCard}>
                  <div style={whyCardTitle}>Off-chain: full evidence</div>
                  <div style={whyCardText}>
                    The underlying KYC evidence stays in the bank’s systems. The badge is only a proof-of-status pointer.
                  </div>
                </div>
              </div>
            </WhySection>

            <WhySection
              k="4"
              title="Upgrade path: privacy mode"
              subtitle="Next step: show only what’s needed (selective disclosure / ZK proofs)."
            >
              <div style={whyGrid2}>
                <div style={whyCard}>
                  <div style={whyCardTitle}>Public badge (today)</div>
                  <div style={whyCardText}>
                    Great for demos: anyone can verify instantly. Useful for low-sensitivity cases where “verified wallet” is enough.
                  </div>
                </div>
                <div style={whyCard}>
                  <div style={whyCardTitle}>User-consented proof (next)</div>
                  <div style={whyCardText}>
                    Government-grade version: verifiable credential + selective disclosure, with an on-chain revocation anchor.
                  </div>
                  <div style={whyPills}>
                    <WhyPill>Selective disclosure</WhyPill>
                    <WhyPill>ZK-friendly</WhyPill>
                  </div>
                </div>
              </div>
            </WhySection>
          </div>
        </div>
      </div>
    </div>
  );
}

function WhySection({
  k,
  title,
  subtitle,
  children,
}: {
  k: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div style={secWrap}>
      <div style={secHead}>
        <div style={secK}>{k}</div>
        <div style={{ minWidth: 0 }}>
          <div style={secTitle}>{title}</div>
          <div style={secSub}>{subtitle}</div>
        </div>
      </div>
      <div>{children}</div>
    </div>
  );
}

function WhyPill({ children }: { children: React.ReactNode }) {
  return <span style={whyPill}>{children}</span>;
}

function WhyChevron() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ---------- “Why this matters” styles (copied from Bank-B for consistency) ---------- */

const whyStickyWrap: React.CSSProperties = {
  marginTop: 18,
  position: "sticky",
  bottom: 14,
  zIndex: 20,
};

const whyShell: React.CSSProperties = {
  border: "1px solid #e6e8eb",
  borderRadius: 16,
  overflow: "hidden",
  background: "rgba(255,255,255,0.88)",
  backdropFilter: "blur(10px)",
  boxShadow: "0 10px 24px rgba(0,0,0,0.06)",
};

const whyHeaderBtn: React.CSSProperties = {
  width: "100%",
  display: "flex",
  gap: 14,
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 14px",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
};

const whyTitleRow: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  flexWrap: "wrap",
};

const whyTitle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 950,
  color: "#111",
  lineHeight: 1.2,
};

const whyMiniTag: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 900,
  padding: "4px 8px",
  borderRadius: 999,
  background: "#f6f8fa",
  border: "1px solid #e6e8eb",
  color: "#333",
};

const whySubtitle: React.CSSProperties = {
  fontSize: 12,
  color: "#666",
  lineHeight: 1.45,
  maxWidth: 720,
};

const whyHint: React.CSSProperties = {
  fontSize: 12,
  color: "#666",
  fontWeight: 800,
};

const whyBody: React.CSSProperties = {
  padding: 14,
  borderTop: "1px solid #e6e8eb",
  background: "rgba(250,250,250,0.6)",
};

const secWrap: React.CSSProperties = {
  border: "1px solid #e6e8eb",
  borderRadius: 14,
  background: "#fff",
  padding: 14,
  boxShadow: "0 8px 18px rgba(0,0,0,0.05)",
  marginBottom: 12,
};

const secHead: React.CSSProperties = {
  display: "flex",
  gap: 12,
  alignItems: "flex-start",
  marginBottom: 10,
};

const secK: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 10,
  display: "grid",
  placeItems: "center",
  background: "#111",
  color: "#fff",
  fontWeight: 950,
  fontSize: 12,
  flex: "0 0 auto",
};

const secTitle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 950,
  color: "#111",
  lineHeight: 1.25,
};

const secSub: React.CSSProperties = {
  marginTop: 4,
  fontSize: 12,
  color: "#666",
  lineHeight: 1.45,
};

const whyGrid2: React.CSSProperties = {
  display: "grid",
  gap: 10,
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
};

const whyCard: React.CSSProperties = {
  border: "1px solid #eef0f2",
  borderRadius: 14,
  padding: 12,
  background: "linear-gradient(180deg, #fff 0%, #fbfbfb 100%)",
};

const whyCardTitle: React.CSSProperties = {
  fontWeight: 950,
  color: "#111",
  fontSize: 12,
  letterSpacing: "0.01em",
};

const whyCardText: React.CSSProperties = {
  marginTop: 6,
  fontSize: 12,
  color: "#444",
  lineHeight: 1.5,
};

const whyPills: React.CSSProperties = {
  marginTop: 10,
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
};

const whyPill: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 900,
  padding: "4px 8px",
  borderRadius: 999,
  border: "1px solid #e6e8eb",
  background: "#fff",
  color: "#333",
};

const whyNote: React.CSSProperties = {
  marginTop: 10,
  padding: 12,
  borderRadius: 14,
  border: "1px solid #e6e8eb",
  background: "#f9fafb",
  color: "#333",
  fontSize: 12,
  lineHeight: 1.5,
};

function Pill({ state, label }: { state: "on" | "off" | "revoked"; label: string }) {
  const isOn = state === "on";
  const isRevoked = state === "revoked";

  const bg = isRevoked ? "#ffecec" : isOn ? "#e6f9f0" : "#f5f5f5";
  const bd = isRevoked ? "#ffd0d0" : isOn ? "#bfe9d2" : "#e6e8eb";
  const icon = isRevoked ? "⛔" : isOn ? "✅" : "—";

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        borderRadius: 999,
        padding: "6px 10px",
        fontSize: 12,
        fontWeight: 900,
        border: "1px solid #e6e8eb",
        background: bg,
        borderColor: bd,
        color: "#111",
      }}
    >
      {label} {icon}
    </span>
  );
}

/* ---------- Styles ---------- */

const card: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 12,
  padding: 16,
  background: "#fafafa",
  marginTop: 14,
};

const miniCard: React.CSSProperties = {
  border: "1px solid #eef0f2",
  borderRadius: 12,
  padding: 12,
  background: "#fff",
};

const miniTitle: React.CSSProperties = { fontWeight: 900, marginBottom: 6 };

const mono: React.CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  fontSize: 12,
  wordBreak: "break-all",
};

const hint: React.CSSProperties = { marginTop: 6, fontSize: 12, color: "#666", lineHeight: 1.4 };

const note: React.CSSProperties = {
  marginTop: 10,
  padding: 12,
  borderRadius: 12,
  border: "1px solid #e6e8eb",
  background: "#fff",
  color: "#333",
  lineHeight: 1.55,
};

const label: React.CSSProperties = { fontSize: 12, color: "#555", fontWeight: 800 };

const input: React.CSSProperties = {
  width: "100%",
  padding: 8,
  marginTop: 6,
  borderRadius: 10,
  border: "1px solid #e6e8eb",
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
};

const btn: React.CSSProperties = {
  padding: "9px 12px",
  borderRadius: 10,
  border: "1px solid #e6e8eb",
  background: "#111",
  color: "#fff",
  fontWeight: 900,
  cursor: "pointer",
};

const btnSecondary: React.CSSProperties = {
  padding: "9px 12px",
  borderRadius: 10,
  border: "1px solid #e6e8eb",
  background: "#fff",
  color: "#111",
  fontWeight: 900,
  cursor: "pointer",
};

const linkBtn: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 10,
  border: "1px solid #e6e8eb",
  background: "#fff",
  color: "#111",
  fontWeight: 900,
  textDecoration: "none",
  fontSize: 12,
};

const checkRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  color: "#333",
  marginTop: 6,
};
