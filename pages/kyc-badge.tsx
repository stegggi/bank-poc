// pages/kyc-badge.tsx
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/router";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { BrowserProvider, Interface } from "ethers";
import NavBar from "../shared/components/NavBar";
import { publicClient } from "../shared/lib/aa";
import { useBreakpoint } from "../shared/hooks/useBreakpoint";
import { formatTxError, withChunkRetry } from "../shared/lib/txError";

const BADGE = (process.env.NEXT_PUBLIC_KYC_BADGE_ADDRESS || "") as `0x${string}`;

const ARB_SEPOLIA_HEX = "0x66eee";

const arbTx  = (h: string) => `https://sepolia.arbiscan.io/tx/${h}`;
const arbAddr = (a: string) => `https://sepolia.arbiscan.io/address/${a}`;
const isAddr  = (a?: string) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));
const fmtDate = (unixSec?: number) => {
  if (!unixSec) return "—";
  try { return new Date(unixSec * 1000).toLocaleString(); } catch { return "—"; }
};

const CLAIM_KYC_STRONG = 1;
const CLAIM_CH         = 2;
const CLAIM_OVER18     = 4;

const BADGE_ABI = [
  { type: "function", name: "owner",             stateMutability: "view",        inputs: [],                                                                                           outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "operator",          stateMutability: "view",        inputs: [],                                                                                           outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "claimOperatorRole", stateMutability: "nonpayable",  inputs: [],                                                                                           outputs: [] },
  { type: "function", name: "issue",             stateMutability: "nonpayable",  inputs: [{ name: "wallet", type: "address" }, { name: "validUntil", type: "uint64" }, { name: "claims", type: "uint8" }], outputs: [] },
  { type: "function", name: "revoke",            stateMutability: "nonpayable",  inputs: [{ name: "wallet", type: "address" }],                                                        outputs: [] },
  {
    type: "function", name: "isValid", stateMutability: "view",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [
      { name: "valid",        type: "bool"    },
      { name: "validUntil",   type: "uint64"  },
      { name: "revoked",      type: "bool"    },
      { name: "issuer",       type: "address" },
      { name: "operatorAddr", type: "address" },
      { name: "claims",       type: "uint8"   },
    ],
  },
] as const;

const BADGE_IFACE = new Interface(BADGE_ABI as any);

export default function KYCBadge() {
  const { isMobile } = useBreakpoint();
  const router = useRouter();
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();

  const [origin, setOrigin]                 = useState<string>("");
  const [walletToVerify, setWalletToVerify] = useState("");
  const [verifyStatus, setVerifyStatus]     = useState<"" | "missing" | "invalid_input" | "checking" | "valid" | "expired" | "revoked" | "not_found" | "error">("");
  const [verifyResult, setVerifyResult]     = useState<{ valid: boolean; validUntil: number; revoked: boolean; issuer: string; operator: string; claims: number } | null>(null);

  const [issuerStatus, setIssuerStatus]         = useState("");
  const [contractOperator, setContractOperator] = useState<string>("");
  const [issueTarget, setIssueTarget]           = useState<string>("");
  const [issueDays, setIssueDays]               = useState<number>(90);
  const [claimStrong, setClaimStrong]           = useState(true);
  const [claimCH, setClaimCH]                   = useState(true);
  const [claimOver18, setClaimOver18]           = useState(true);

  const [wtmTab, setWtmTab] = useState(0);

  const pollingRef = useRef(false);

  useEffect(() => { setOrigin(window.location.origin); }, []);

  useEffect(() => {
    if (!router.isReady) return;
    const q = router.query?.addr;
    if (!q) return;
    const addr = Array.isArray(q) ? q[0] : String(q);
    if (addr && isAddr(addr)) setWalletToVerify(addr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);

  const shareUrl = useMemo(() => {
    if (!origin) return "";
    if (!isAddr(walletToVerify)) return origin + "/kyc-badge";
    return origin + "/kyc-badge?addr=" + walletToVerify;
  }, [origin, walletToVerify]);

  const getEmbeddedProvider = async () => {
    const list = (wallets as any[]) || [];
    const embedded =
      list.find((w: any) => typeof w?.getEthereumProvider === "function" && (w?.chainId === "eip155:421614" || w?.meta?.chainId === "eip155:421614")) ||
      list.find((w: any) => typeof w?.getEthereumProvider === "function");
    if (!embedded) throw new Error("No embedded Privy wallet found");
    return embedded.getEthereumProvider();
  };

  const ensureChain = async (prov: any) => {
    try {
      await prov.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARB_SEPOLIA_HEX }] });
    } catch (e: any) {
      if (e?.code === 4902) {
        await prov.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: ARB_SEPOLIA_HEX, chainName: "Arbitrum Sepolia", nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [process.env.NEXT_PUBLIC_RPC_URL as string], blockExplorerUrls: ["https://sepolia.arbiscan.io"] }],
        });
      }
    }
  };

  const grantIfLow = async (addr: `0x${string}`) => {
    const bal = await publicClient.getBalance({ address: addr });
    if (bal >= BigInt("200000000000000")) return;
    setIssuerStatus("Bank sponsoring gas…");
    try {
      const r = await fetch("/api/grant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: addr }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "grant failed");
      setIssuerStatus("Gas sponsored ✅");
    } catch { setIssuerStatus("Gas sponsor attempt finished."); }
  };

  const refreshContractInfo = async () => {
    if (!BADGE) return;
    try {
      const op = (await publicClient.readContract({ address: BADGE, abi: BADGE_ABI, functionName: "operator" })) as string;
      setContractOperator(op);
    } catch { /* ignore */ }
  };

  useEffect(() => { refreshContractInfo(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  useEffect(() => {
    if (!BADGE || pollingRef.current) return;
    pollingRef.current = true;
    const t = setInterval(refreshContractInfo, 3500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [BADGE]);

  const decodeClaims = (claims: number) => ({
    hasStrong: (claims & CLAIM_KYC_STRONG) !== 0,
    hasCH:     (claims & CLAIM_CH)         !== 0,
    hasOver18: (claims & CLAIM_OVER18)     !== 0,
  });

  const verify = async () => {
    try {
      setVerifyResult(null);
      if (!BADGE)               { setVerifyStatus("missing");       return; }
      if (!isAddr(walletToVerify)) { setVerifyStatus("invalid_input"); return; }
      setVerifyStatus("checking");

      const out = (await publicClient.readContract({ address: BADGE, abi: BADGE_ABI, functionName: "isValid", args: [walletToVerify as `0x${string}`] })) as any;

      const valid      = Boolean(out?.[0]);
      const validUntil = Number((out?.[1] ?? BigInt("0")) as bigint);
      const revoked    = Boolean(out?.[2]);
      const issuer     = String(out?.[3] ?? "");
      const operator   = String(out?.[4] ?? "");
      const claims     = Number((out?.[5] ?? BigInt("0")) as bigint);

      const expired    = validUntil > 0 && validUntil < Math.floor(Date.now() / 1000);
      const nextStatus = revoked ? "revoked" : valid ? (expired ? "expired" : "valid") : "not_found";

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
    if (claimCH)     m |= CLAIM_CH;
    if (claimOver18) m |= CLAIM_OVER18;
    return m;
  };

  const ensureIssuerReady = async () => {
    if (!ready) throw new Error("Privy not ready yet");
    if (!authenticated) { await login(); throw new Error("Please retry after login."); }
    if (!BADGE) throw new Error("Missing NEXT_PUBLIC_KYC_BADGE_ADDRESS");
    const eip1193 = await getEmbeddedProvider();
    await ensureChain(eip1193);
    const signer = await new BrowserProvider(eip1193).getSigner();
    const addr   = (await signer.getAddress()) as `0x${string}`;
    await grantIfLow(addr);
    return { signer, addr };
  };

  const claimOperatorIfNeeded = async (signer: any, addr: `0x${string}`) => {
    const op = (await publicClient.readContract({ address: BADGE, abi: BADGE_ABI, functionName: "operator" })) as string;
    setContractOperator(op);
    if (op?.toLowerCase() === addr.toLowerCase()) return;
    setIssuerStatus("Claiming operator role (demo)…");
    const data = BADGE_IFACE.encodeFunctionData("claimOperatorRole", []);
    const tx   = await signer.sendTransaction({ to: BADGE, data });
    setIssuerStatus(`Operator claim pending… ${arbTx(tx.hash)}`);
    await publicClient.waitForTransactionReceipt({ hash: tx.hash as `0x${string}` });
    setIssuerStatus(`Operator claimed ✅ ${arbTx(tx.hash)}`);
    await refreshContractInfo();
  };

  const doIssueOrRenew = async () => {
    try {
      setIssuerStatus("");
      if (!isAddr(issueTarget)) { setIssuerStatus("Please enter a valid target wallet address (0x…)."); return; }
      await withChunkRetry(async () => {
        const { signer, addr } = await ensureIssuerReady();
        await claimOperatorIfNeeded(signer, addr);
        const days       = Number.isFinite(issueDays) && issueDays > 0 ? issueDays : 90;
        const validUntil = Math.floor(Date.now() / 1000) + Math.floor(days * 86400);
        const claims     = getClaimsMaskFromUI();
        setIssuerStatus("Issuing / renewing badge…");
        const data = BADGE_IFACE.encodeFunctionData("issue", [issueTarget as `0x${string}`, BigInt(validUntil), claims]);
        const tx   = await signer.sendTransaction({ to: BADGE, data });
        setIssuerStatus(`Issue pending… ${arbTx(tx.hash)}`);
        await publicClient.waitForTransactionReceipt({ hash: tx.hash as `0x${string}` });
        setIssuerStatus(`Issued ✅ ${arbTx(tx.hash)}`);
      });
      setWalletToVerify(issueTarget);
      await verify();
    } catch (e: any) { setIssuerStatus(`Issue failed: ${formatTxError(e)}`); }
  };

  const doRevoke = async () => {
    try {
      setIssuerStatus("");
      if (!isAddr(issueTarget)) { setIssuerStatus("Please enter a valid target wallet address (0x…)."); return; }
      await withChunkRetry(async () => {
        const { signer, addr } = await ensureIssuerReady();
        await claimOperatorIfNeeded(signer, addr);
        setIssuerStatus("Revoking badge…");
        const data = BADGE_IFACE.encodeFunctionData("revoke", [issueTarget as `0x${string}`]);
        const tx   = await signer.sendTransaction({ to: BADGE, data });
        setIssuerStatus(`Revoke pending… ${arbTx(tx.hash)}`);
        await publicClient.waitForTransactionReceipt({ hash: tx.hash as `0x${string}` });
        setIssuerStatus(`Revoked ✅ ${arbTx(tx.hash)}`);
      });
      setWalletToVerify(issueTarget);
      await verify();
    } catch (e: any) { setIssuerStatus(`Revoke failed: ${formatTxError(e)}`); }
  };

  // --- Badge status pill (dark theme) ---
  const badgePill = (() => {
    const base: CSSProperties = {
      display: "inline-flex", alignItems: "center", gap: 6,
      borderRadius: 999, padding: "5px 12px", fontSize: 12, fontWeight: 700,
      border: "1px solid rgba(var(--ink),0.1)", background: "rgba(var(--ink),0.06)", color: "rgba(var(--ink),0.55)",
    };
    if (verifyStatus === "valid")     return <span style={{ ...base, background: "rgba(16,185,129,0.15)",  borderColor: "rgba(16,185,129,0.35)",  color: "var(--a-34d399)" }}>Valid ✅</span>;
    if (verifyStatus === "expired")   return <span style={{ ...base, background: "rgba(245,158,11,0.15)", borderColor: "rgba(245,158,11,0.35)", color: "var(--a-fbbf24)" }}>Expired ⏳</span>;
    if (verifyStatus === "revoked")   return <span style={{ ...base, background: "rgba(239,68,68,0.15)",  borderColor: "rgba(239,68,68,0.35)",  color: "var(--a-f87171)" }}>Revoked ⛔</span>;
    if (verifyStatus === "not_found") return <span style={{ ...base }}>No badge found</span>;
    if (verifyStatus === "checking")  return <span style={{ ...base, background: "rgba(139,92,246,0.15)", borderColor: "rgba(139,92,246,0.35)", color: "var(--a-a78bfa)" }}>Checking…</span>;
    return null;
  })();

  const claimsText = useMemo(() => {
    if (!verifyResult) return null;
    const c = decodeClaims(verifyResult.claims || 0);
    const rev = Boolean(verifyResult.revoked);
    return (
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Pill state={rev ? "revoked" : c.hasStrong ? "on" : "off"} label="KYC_STRONG" />
        <Pill state={rev ? "revoked" : c.hasCH     ? "on" : "off"} label="CH" />
        <Pill state={rev ? "revoked" : c.hasOver18 ? "on" : "off"} label="Age > 18" />
      </div>
    );
  }, [verifyResult]);

  // --- Style objects ---
  const page:      CSSProperties = { minHeight: "100vh", background: "var(--bg)", color: "var(--heading)", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" };
  const wrap:      CSSProperties = { maxWidth: 780, margin: "0 auto", padding: isMobile ? "20px 16px 48px" : "24px 20px 64px" };
  const glassCard: CSSProperties = { background: "rgba(var(--ink),0.032)", border: "1px solid rgba(var(--ink),0.08)", borderRadius: 16, padding: isMobile ? 14 : 20, marginTop: 16 };
  const miniGlass: CSSProperties = { background: "rgba(var(--ink),0.04)",  border: "1px solid rgba(var(--ink),0.07)", borderRadius: 12, padding: 14 };

  const stepChip:    CSSProperties = { display: "inline-flex", alignItems: "center", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--a-8b5cf6)", background: "rgba(139,92,246,0.12)", border: "1px solid rgba(139,92,246,0.25)", borderRadius: 999, padding: "3px 10px", marginBottom: 10 };
  const sectionTitle: CSSProperties = { fontSize: 16, fontWeight: 700, color: "var(--heading)", margin: 0 };
  const sectionSub:   CSSProperties = { fontSize: 14, color: "rgba(var(--ink),0.60)", marginTop: 4, lineHeight: 1.6 };

  const fieldLabel: CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: "rgba(var(--ink),0.60)", marginBottom: 6, textTransform: "uppercase" as const };
  const miniLabel:  CSSProperties = { fontSize: 11, fontWeight: 700, color: "rgba(var(--ink),0.52)", letterSpacing: "0.05em", textTransform: "uppercase" as const, marginBottom: 6 };
  const monoVal:    CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 13, color: "rgba(var(--ink),0.88)", wordBreak: "break-all", lineHeight: 1.55 };
  const hintText:   CSSProperties = { marginTop: 6, fontSize: 12, color: "rgba(var(--ink),0.52)", lineHeight: 1.55 };

  const statusBox: CSSProperties = { marginTop: 12, padding: "10px 14px", borderRadius: 10, background: "rgba(var(--ink),0.04)", border: "1px solid rgba(var(--ink),0.08)", fontSize: 13, color: "rgba(var(--ink),0.75)", lineHeight: 1.5, wordBreak: "break-all" };
  const divider:   CSSProperties = { border: "none", borderTop: "1px solid rgba(var(--ink),0.06)", margin: "18px 0" };

  const contractLink: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600, color: "rgba(var(--ink),0.45)", textDecoration: "none", border: "1px solid rgba(var(--ink),0.08)", borderRadius: 8, padding: "4px 10px" };

  // WTM
  const wtmOuter:     CSSProperties = { marginTop: 32 };
  const wtmTitle:     CSSProperties = { fontSize: isMobile ? 16 : 18, fontWeight: 700, color: "var(--heading)", margin: "0 0 6px" };
  const wtmIntro:     CSSProperties = { fontSize: 13, color: "rgba(var(--ink),0.65)", lineHeight: 1.55, margin: "0 0 16px" };
  const wtmTabBar:    CSSProperties = { display: "flex", gap: 6, flexWrap: "wrap" as const, marginBottom: 16 };
  const wtmPanel:     CSSProperties = { background: "rgba(var(--ink),0.032)", border: "1px solid rgba(var(--ink),0.08)", borderRadius: 16, padding: isMobile ? 14 : 20 };
  const wtmPanelTitle: CSSProperties = { fontSize: 15, fontWeight: 700, color: "var(--heading)", marginBottom: 4 };
  const wtmPanelSub:  CSSProperties = { fontSize: 13, color: "rgba(var(--ink),0.60)", lineHeight: 1.55, marginBottom: 14 };
  const wtmGrid2:     CSSProperties = { display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 };
  const wtmCard:      CSSProperties = { background: "rgba(var(--ink),0.04)", border: "1px solid rgba(var(--ink),0.07)", borderRadius: 12, padding: 14 };
  const wtmCardTitle: CSSProperties = { fontSize: 13, fontWeight: 700, color: "var(--heading)", marginBottom: 6 };
  const wtmCardText:  CSSProperties = { fontSize: 13, color: "rgba(var(--ink),0.68)", lineHeight: 1.5 };
  const wtmNote:      CSSProperties = { marginTop: 12, padding: "10px 14px", borderRadius: 10, background: "rgba(var(--ink),0.04)", border: "1px solid rgba(var(--ink),0.08)", fontSize: 13, color: "rgba(var(--ink),0.65)", lineHeight: 1.6 };

  const WTM_TABS = ["Trust & Verifiers", "Safety", "No PII on-chain", "Upgrade path"];

  const wtmContent = [
    /* 0: Trust & Verifiers */
    <div key="trust" style={{ animation: "wtmIn 220ms ease both" }}>
      <div style={wtmPanelTitle}>Trust for real-world counterparties</div>
      <div style={wtmPanelSub}>A plain wallet address is not enough. Banks must attach verifiable identity status so other parties can act on it.</div>
      <div style={wtmGrid2}>
        <div style={wtmCard}>
          <div style={wtmCardTitle}>Verifier-friendly</div>
          <div style={wtmCardText}>Anyone can check status via a web page or QR link — no crypto wallet, no signatures needed.</div>
        </div>
        <div style={wtmCard}>
          <div style={wtmCardTitle}>Instant yes/no</div>
          <div style={wtmCardText}>The badge answers "Is this wallet currently KYC-verified?" with an expiry date — fast, deterministic, on-chain.</div>
        </div>
      </div>
    </div>,

    /* 1: Safety */
    <div key="safety" style={{ animation: "wtmIn 220ms ease both" }}>
      <div style={wtmPanelTitle}>Safety: expiry + revocation</div>
      <div style={wtmPanelSub}>Badges are not permanent. Banks retain a kill-switch if risk changes or the user exits managed custody.</div>
      <div style={wtmGrid2}>
        <div style={wtmCard}>
          <div style={wtmCardTitle}>Expiry keeps it fresh</div>
          <div style={wtmCardText}>Badges expire (e.g., 90 days). If the user's risk status changes, the badge times out unless renewed — reducing stale-trust risk.</div>
        </div>
        <div style={wtmCard}>
          <div style={wtmCardTitle}>Revocation is instant</div>
          <div style={wtmCardText}>Account closed, private key exported, or risk triggered? The bank revokes immediately — one transaction, effective globally.</div>
        </div>
      </div>
      <div style={wtmNote}>Demo: seedless wallet stays managed (Privy/bank). If a user requests the private key, the bank revokes the badge first.</div>
    </div>,

    /* 2: No PII */
    <div key="pii" style={{ animation: "wtmIn 220ms ease both" }}>
      <div style={wtmPanelTitle}>No personal data on-chain</div>
      <div style={wtmPanelSub}>The chain is a shared audit rail — sensitive identity evidence stays off-chain in the bank's systems.</div>
      <div style={wtmGrid2}>
        <div style={wtmCard}>
          <div style={wtmCardTitle}>On-chain: minimal status</div>
          <div style={wtmCardText}>Only validity date, revoked flag, and a tiny claims bitmask (KYC_STRONG, CH, Age&gt;18). No names, documents, or addresses.</div>
        </div>
        <div style={wtmCard}>
          <div style={wtmCardTitle}>Off-chain: full evidence</div>
          <div style={wtmCardText}>The underlying KYC evidence stays in the bank's systems. The badge is a proof-of-status pointer, not a data dump.</div>
        </div>
      </div>
    </div>,

    /* 3: Upgrade path */
    <div key="upgrade" style={{ animation: "wtmIn 220ms ease both" }}>
      <div style={wtmPanelTitle}>Upgrade path: privacy mode</div>
      <div style={wtmPanelSub}>Today's public badge is great for demos. The next step adds selective disclosure and ZK proofs for government-grade privacy.</div>
      <div style={wtmGrid2}>
        <div style={wtmCard}>
          <div style={wtmCardTitle}>Public badge (today)</div>
          <div style={wtmCardText}>Anyone can verify instantly. Useful for low-sensitivity cases where "verified wallet" is sufficient signal.</div>
        </div>
        <div style={wtmCard}>
          <div style={wtmCardTitle}>User-consented proof (next)</div>
          <div style={wtmCardText}>Verifiable credential + selective disclosure with an on-chain revocation anchor. Share only what's required — nothing more.</div>
        </div>
      </div>
    </div>,
  ];

  return (
    <>
      <NavBar active="kyc-badge" />
      <div style={page}>
        <div style={wrap}>

          {/* Page header */}
          <div style={{ marginBottom: 28 }}>
            <div style={{ display: "inline-flex", alignItems: "center", fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "var(--a-8b5cf6)", background: "rgba(139,92,246,0.12)", border: "1px solid rgba(139,92,246,0.25)", borderRadius: 999, padding: "3px 10px", marginBottom: 12 }}>
              UC 03
            </div>
            <h1 style={{ fontSize: isMobile ? 22 : 28, fontWeight: 800, color: "var(--heading)", margin: "0 0 8px" }}>KYC Badge</h1>
            <p style={{ fontSize: 14, color: "rgba(var(--ink),0.55)", margin: 0, lineHeight: 1.6, maxWidth: 560 }}>
              Issue and verify on-chain identity credentials. Banks mint time-limited badges with embedded claims; any counterparty can verify instantly — no wallet required.
            </p>
          </div>

          {/* ── Step 1: Bank Issuer Panel ── */}
          <div style={glassCard}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap", flexDirection: isMobile ? "column" : "row" }}>
              <div>
                <div style={stepChip}>STEP 1 · BANK ISSUER</div>
                <h2 style={sectionTitle}>Issue or revoke a badge</h2>
                <p style={sectionSub}>Log in as the bank operator to mint or revoke a KYC badge for a customer wallet.</p>
              </div>
              {BADGE && (
                <a href={arbAddr(BADGE)} target="_blank" rel="noreferrer" style={contractLink}>Contract ↗</a>
              )}
            </div>

            <hr style={divider} />

            {/* Current operator */}
            <div style={miniGlass}>
              <div style={miniLabel}>Current operator</div>
              <div style={monoVal}>{contractOperator || "—"}</div>
              <div style={hintText}>The address allowed to issue and revoke badges. Automatically claimed to your embedded wallet on first action (demo).</div>
            </div>

            {/* Form grid */}
            <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(210px, 1fr))", gap: 14 }}>
              <div>
                <div style={fieldLabel}>Target wallet</div>
                <input value={issueTarget} onChange={(e) => setIssueTarget(e.target.value.trim())} placeholder="0x…" className="kc-input" />
              </div>
              <div>
                <div style={fieldLabel}>Validity (days)</div>
                <input value={String(issueDays)} onChange={(e) => setIssueDays(Number(e.target.value || 0))} type="number" min={1} className="kc-input" />
              </div>
              <div>
                <div style={fieldLabel}>Claims to embed</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 2 }}>
                  <label className="kc-check"><input type="checkbox" checked={claimStrong} onChange={(e) => setClaimStrong(e.target.checked)} /><span>KYC_STRONG</span></label>
                  <label className="kc-check"><input type="checkbox" checked={claimCH}     onChange={(e) => setClaimCH(e.target.checked)}     /><span>Jurisdiction: CH</span></label>
                  <label className="kc-check"><input type="checkbox" checked={claimOver18} onChange={(e) => setClaimOver18(e.target.checked)}  /><span>Age &gt; 18</span></label>
                </div>
              </div>
            </div>

            <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap", flexDirection: isMobile ? "column" : "row" }}>
              <button className="kc-btn kc-btn-primary" style={isMobile ? { width: "100%" } : undefined} onClick={doIssueOrRenew} disabled={!ready}>Issue / renew badge</button>
              <button className="kc-btn kc-btn-danger"  style={isMobile ? { width: "100%" } : undefined} onClick={doRevoke}       disabled={!ready}>Revoke badge</button>
            </div>

            {issuerStatus && <div style={statusBox}>{issuerStatus}</div>}
          </div>

          {/* ── Step 2: Verifier Panel ── */}
          <div style={glassCard}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap", flexDirection: isMobile ? "column" : "row" }}>
              <div>
                <div style={stepChip}>STEP 2 · ANYONE CAN VERIFY</div>
                <h2 style={sectionTitle}>Verify a badge</h2>
                <p style={sectionSub}>No wallet needed. Enter any address to check its current KYC status directly on-chain.</p>
              </div>
              {badgePill}
            </div>

            <hr style={divider} />

            <div style={{ display: "flex", gap: 12, alignItems: isMobile ? "stretch" : "flex-end", flexWrap: "wrap", flexDirection: isMobile ? "column" : "row" }}>
              <div style={{ flex: "1 1 300px" }}>
                <div style={fieldLabel}>Wallet address to verify</div>
                <input value={walletToVerify} onChange={(e) => setWalletToVerify(e.target.value.trim())} placeholder="0x…" className="kc-input" />
              </div>
              <button className="kc-btn kc-btn-primary" style={isMobile ? { width: "100%" } : undefined} onClick={verify}>Verify</button>
            </div>

            {verifyStatus === "invalid_input" && <div style={{ ...statusBox, borderColor: "rgba(239,68,68,0.25)", color: "rgba(var(--ink),0.62)" }}>Please enter a valid wallet address (0x…).</div>}
            {verifyStatus === "missing"       && <div style={{ ...statusBox, color: "rgba(var(--ink),0.50)" }}>KYC badge contract address not configured.</div>}
            {verifyStatus === "error"         && <div style={{ ...statusBox, borderColor: "rgba(239,68,68,0.25)", color: "var(--a-f87171)" }}>Verification failed. Check the address and try again.</div>}

            {verifyResult && (
              <>
                <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 }}>
                  <div style={miniGlass}>
                    <div style={miniLabel}>Operator</div>
                    <div style={monoVal}>{verifyResult.operator || "—"}</div>
                  </div>
                  <div style={miniGlass}>
                    <div style={miniLabel}>Valid until</div>
                    <div style={{ fontSize: 13, color: "rgba(var(--ink),0.82)" }}>{verifyResult.validUntil ? fmtDate(verifyResult.validUntil) : "—"}</div>
                  </div>
                </div>
                <div style={{ ...miniGlass, marginTop: 12 }}>
                  <div style={miniLabel}>Embedded claims</div>
                  {claimsText}
                </div>
              </>
            )}

            <hr style={divider} />
            <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(var(--ink),0.35)", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 6 }}>Share link</div>
            <div style={{ ...monoVal, fontSize: 12, color: "rgba(var(--ink),0.50)" }}>{shareUrl || "—"}</div>
          </div>

          {/* ── Why This Matters ── */}
          <div style={wtmOuter}>
            <h3 style={wtmTitle}>Why this matters</h3>
            <p style={wtmIntro}>
              A simple trust layer for regulated blockchain use cases: verifiers get instant yes/no on identity status, while banks retain full control via expiry and revocation.
            </p>

            <div style={wtmTabBar}>
              {WTM_TABS.map((tab, i) => (
                <button
                  key={tab}
                  className={`wtm-tab${wtmTab === i ? " wtm-tab-active" : ""}`}
                  onClick={() => setWtmTab(i)}
                >
                  {tab}
                </button>
              ))}
            </div>

            <div style={wtmPanel}>
              {wtmContent[wtmTab]}
            </div>
          </div>

        </div>
      </div>

      <style jsx global>{`
        .kc-input {
          width: 100%;
          padding: 9px 12px;
          border-radius: 10px;
          border: 1px solid rgba(var(--ink),0.10);
          background: rgba(var(--ink),0.05);
          color: var(--heading);
          font-size: 13px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          outline: none;
          box-sizing: border-box;
          transition: border-color 150ms;
        }
        .kc-input::placeholder { color: rgba(var(--ink),0.22); }
        .kc-input:focus { border-color: rgba(139,92,246,0.50); }

        .kc-check {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          color: rgba(var(--ink),0.70);
          cursor: pointer;
        }
        .kc-check input[type="checkbox"] {
          accent-color: var(--a-8b5cf6);
          width: 15px;
          height: 15px;
          cursor: pointer;
        }

        .kc-btn {
          padding: 9px 16px;
          border-radius: 10px;
          border: 1px solid rgba(var(--ink),0.10);
          background: rgba(var(--ink),0.06);
          color: rgba(var(--ink),0.78);
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
          transition: background 150ms, border-color 150ms, opacity 150ms;
        }
        .kc-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .kc-btn-primary {
          background: var(--a-8b5cf6);
          border-color: var(--a-8b5cf6);
          color: #fff;
        }
        .kc-btn-primary:hover:not(:disabled) { background: var(--a-7c3aed); border-color: var(--a-7c3aed); }
        .kc-btn-danger {
          background: rgba(239,68,68,0.10);
          border-color: rgba(239,68,68,0.22);
          color: var(--a-f87171);
        }
        .kc-btn-danger:hover:not(:disabled) { background: rgba(239,68,68,0.18); }

        .wtm-tab {
          padding: 6px 14px;
          border-radius: 8px;
          border: 1px solid rgba(var(--ink),0.08);
          background: transparent;
          color: rgba(var(--ink),0.42);
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 150ms;
          font-family: inherit;
        }
        .wtm-tab:hover { color: rgba(var(--ink),0.68); border-color: rgba(var(--ink),0.14); }
        .wtm-tab-active {
          background: rgba(139,92,246,0.14);
          border-color: rgba(139,92,246,0.35);
          color: var(--a-a78bfa);
        }
        @keyframes wtmIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0);   }
        }
      `}</style>
    </>
  );
}

function Pill({ state, label }: { state: "on" | "off" | "revoked"; label: string }) {
  const isOn      = state === "on";
  const isRevoked = state === "revoked";

  const bg    = isRevoked ? "rgba(239,68,68,0.15)"   : isOn ? "rgba(16,185,129,0.15)" : "rgba(var(--ink),0.05)";
  const bd    = isRevoked ? "rgba(239,68,68,0.30)"   : isOn ? "rgba(16,185,129,0.30)" : "rgba(var(--ink),0.08)";
  const color = isRevoked ? "var(--a-f87171)"                : isOn ? "var(--a-34d399)"               : "rgba(var(--ink),0.38)";
  const icon  = isRevoked ? "⛔" : isOn ? "✅" : "—";

  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      borderRadius: 999, padding: "5px 10px",
      fontSize: 12, fontWeight: 700,
      border: `1px solid ${bd}`, background: bg, color,
    }}>
      {label} {icon}
    </span>
  );
}
