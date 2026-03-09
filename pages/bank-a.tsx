// pages/bank-a.tsx
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { BrowserProvider, Interface } from "ethers";
import { encodePacked, keccak256 } from "viem";
import { hpkeSealJsonToEnvelopeHex } from "../use-cases/uc2-interbank-payment/lib/hpke";
import { publicClient } from "../shared/lib/aa";
import NavBar from "../shared/components/NavBar";

const HUB = (process.env.NEXT_PUBLIC_PAYMENT_HUB_ADDRESS || "") as `0x${string}`;
const DIR = (process.env.NEXT_PUBLIC_DIRECTORY_ADDRESS || "") as `0x${string}`;
const BANK_A_ID = Number(process.env.NEXT_PUBLIC_BANK_A_ID || 1);
const BANK_B_ID = Number(process.env.NEXT_PUBLIC_BANK_B_ID || 2);
const XBANK = (process.env.NEXT_PUBLIC_XBANK_ADDRESS || "") as `0x${string}`;
const DEMO_RECIPIENT = (process.env.NEXT_PUBLIC_DEMO_RECIPIENT || "") as `0x${string}`;

const ACK_SCAN_SPAN_BLOCKS = 20;
const ACK_MAX_LOOPS = 60;
const ACK_STORAGE_KEY = "hub:acks:v1";
const REJECT_STORAGE_KEY = "hub:rejects:v1";

type AckRecord = {
  txRef: string;
  ackTxHash: string;
  ts: number;
};

type RejectRecord = {
  txRef: string;
  ts: number;
};

const HUB_ABI = [
  {
    type: "function",
    name: "submitPayment",
    stateMutability: "nonpayable",
    inputs: [
      { name: "toBankId", type: "uint256" },
      { name: "requireAck", type: "bool" },
      { name: "payload", type: "bytes" },
      { name: "txRef", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "acknowledge",
    stateMutability: "nonpayable",
    inputs: [{ name: "txRef", type: "bytes32" }],
    outputs: [],
  },
] as const;

const DIR_ABI = [
  {
    type: "function",
    name: "banks",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "active", type: "bool" },
      { name: "leiHash", type: "bytes32" },
      { name: "domainHash", type: "bytes32" },
      { name: "operator", type: "address" },
    ],
  },
  {
    type: "function",
    name: "bankHpkePubKey",
    stateMutability: "view",
    inputs: [{ name: "bankId", type: "uint256" }],
    outputs: [{ name: "", type: "bytes" }],
  },
] as const;

const ERC20_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const arbTx = (h: string) => `https://sepolia.arbiscan.io/tx/${h}`;
const arbAddr = (a: string) => `https://sepolia.arbiscan.io/address/${a}`;
const short = (x?: string) => (x ? x.slice(0, 8) + "…" + x.slice(-6) : "");

function readLocalAck(ref: `0x${string}`): AckRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACK_STORAGE_KEY);
    if (!raw) return null;
    const list = JSON.parse(raw) as AckRecord[];
    const lowerRef = ref.toLowerCase();
    const found = list.find((r) => String(r.txRef).toLowerCase() === lowerRef);
    return found || null;
  } catch {
    return null;
  }
}

function readLocalReject(ref: `0x${string}`): RejectRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(REJECT_STORAGE_KEY);
    if (!raw) return null;
    const list = JSON.parse(raw) as RejectRecord[];
    const lowerRef = ref.toLowerCase();
    const found = list.find((r) => String(r.txRef).toLowerCase() === lowerRef);
    return found || null;
  } catch {
    return null;
  }
}

export default function BankA() {
  const { ready, authenticated, login, user } = usePrivy();
  const { wallets } = useWallets();

  const [status, setStatus] = useState("");
  const [eoa, setEoa] = useState<`0x${string}` | "">("");
  const [amount, setAmount] = useState("25");
  const [purpose, setPurpose] = useState("Demo payment");
  const [requireAck, setRequireAck] = useState(true);
  const [txRef, setTxRef] = useState<`0x${string}` | "">("");

  const [submitTxHash, setSubmitTxHash] = useState<`0x${string}` | "">("");
  const [paymentTxHash, setPaymentTxHash] = useState<`0x${string}` | "">("");

  const [ackSeen, setAckSeen] = useState(false);
  const [canSend, setCanSend] = useState(false);

  const [xbBal, setXbBal] = useState<bigint>(BigInt("0"));
  const [xbRecBal, setXbRecBal] = useState<bigint>(BigInt("0")); // recipient balance not shown in UI

  // Travel-rule fields (originator & beneficiary)
  const [originatorName, setOriginatorName] = useState("Max Mustermann");
  const [originatorAddress, setOriginatorAddress] = useState(
    "Demo Street 1, 8001 Zürich, Switzerland"
  );
  const [originatorDob, setOriginatorDob] = useState("1990-01-01");
  const [originatorPlaceOfBirth, setOriginatorPlaceOfBirth] = useState(
    "Zürich, Switzerland"
  );
  const [originatorIdNumber, setOriginatorIdNumber] = useState("CH-123.456.789");

  const [beneficiaryName, setBeneficiaryName] = useState("Fixed Recipient");

  const [showOpenBankBPrompt, setShowOpenBankBPrompt] = useState(false);

  const watching = useRef(false);
  const iface = new Interface(HUB_ABI);
  const erc20 = new Interface(ERC20_ABI);

  const userEmail =
    (user as any)?.email?.address || (user as any)?.emails?.[0]?.address || "";

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
        params: [{ chainId: "0x66eee" }],
      });
    } catch (e: any) {
      if (e?.code === 4902) {
        await prov.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: "0x66eee",
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
    const threshold = BigInt("200000000000000"); // 0.0002 ETH
    if (bal >= threshold) return;
    setStatus("Bank sponsoring gas…");
    try {
      const r = await fetch("/api/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: addr }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "grant failed");
      setStatus(`Grant tx: ${j.hash}`);
    } catch (e: any) {
      setStatus(`Grant failed: ${e?.message ?? e}`);
    }
  };

  const readDirectoryActive = async () => {
    if (!DIR) return false;
    try {
      const a = (await publicClient.readContract({
        address: DIR,
        abi: DIR_ABI,
        functionName: "banks",
        args: [BigInt(BANK_A_ID)],
      })) as any;
      const b = (await publicClient.readContract({
        address: DIR,
        abi: DIR_ABI,
        functionName: "banks",
        args: [BigInt(BANK_B_ID)],
      })) as any;
      return Boolean(a?.[0]) && Boolean(b?.[0]);
    } catch {
      return false;
    }
  };

  const refreshXBankBalances = async (addr: `0x${string}`) => {
    if (!XBANK) {
      setXbBal(BigInt("0"));
      setXbRecBal(BigInt("0"));
      return;
    }
    try {
      const balSender = (await publicClient.readContract({
        address: XBANK,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [addr],
      })) as bigint;
      setXbBal(balSender);
    } catch {
      setXbBal(BigInt("0"));
    }
    try {
      const balRec = (await publicClient.readContract({
        address: XBANK,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [DEMO_RECIPIENT],
      })) as bigint;
      setXbRecBal(balRec);
    } catch {
      setXbRecBal(BigInt("0"));
    }
  };

  useEffect(() => {
    (async () => {
      if (!ready) return;
      if (!authenticated) return;
      try {
        const eip1193 = await getEmbeddedProvider();
        await ensureChain(eip1193);
        const ethersProvider = new BrowserProvider(eip1193);
        const signer = await ethersProvider.getSigner();
        const addr = (await signer.getAddress()) as `0x${string}`;
        setEoa(addr);
        await grantIfLow(addr);
        await refreshXBankBalances(addr);
      } catch (e: any) {
        setStatus(`Init failed: ${e?.message ?? e}`);
        setEoa("");
        setXbBal(BigInt("0"));
      }
    })();
  }, [ready, authenticated, wallets]);

  const genTxRef = () => {
    const from = eoa || ("0x0000000000000000000000000000000000000000" as `0x${string}`);
    const entropy = encodePacked(["address", "uint256"], [from, BigInt(Date.now())]);
    const ref = keccak256(entropy);
    setTxRef(ref as `0x${string}`);
    return ref as `0x${string}`;
  };

  const buildEnvelopeLegacy = (o: any) => {
    const s = JSON.stringify(o);
    const encoder = typeof window !== "undefined" ? new TextEncoder() : null;
    const bytes = encoder ? encoder.encode(s) : new Uint8Array(0);
    let hex = "0x";
    for (let i = 0; i < bytes.length; i += 1) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex as `0x${string}`;
  };

  const readBankHpkePubKey = async (bankId: number) => {
    if (!DIR) return null;
    try {
      const hpke = (await publicClient.readContract({
        address: DIR,
        abi: DIR_ABI,
        functionName: "bankHpkePubKey",
        args: [BigInt(bankId)],
      }).catch(() => "0x")) as `0x${string}`;
      if (!hpke || hpke === "0x") return null;
      return hpke as `0x${string}`;
    } catch {
      return null;
    }
  };

  const buildEnvelopeHpke = async (o: any, ref: `0x${string}`) => {
    const bankBPubKey = await readBankHpkePubKey(BANK_B_ID);
    if (!bankBPubKey) {
      throw new Error(
        "Bank B HPKE public key is not set in Directory. Go to Bank B → Directory and upsert it."
      );
    }
    return hpkeSealJsonToEnvelopeHex({
      recipientPubKeyHex: bankBPubKey,
      hubAddress: HUB,
      txRefHex: ref,
      obj: o,
    });
  };

  const handleOpenBankBTab = () => {
    if (typeof window !== "undefined") {
      window.open("/bank-b", "_blank", "noopener,noreferrer");
    }
  };

  const postRequest = async () => {
    try {
      setShowOpenBankBPrompt(false);

      if (!authenticated) {
        await login();
        return;
      }
      if (!HUB || !DIR || !XBANK) {
        setStatus("Missing HUB/DIR/XBANK env");
        return;
      }

      const bothActive = await readDirectoryActive();
      if (!bothActive) {
        setStatus("One of the demo banks is paused in Directory.");
        return;
      }

      const eip1193 = await getEmbeddedProvider();
      await ensureChain(eip1193);
      const ethersProvider = new BrowserProvider(eip1193);
      const signer = await ethersProvider.getSigner();
      const from = (await signer.getAddress()) as `0x${string}`;
      setEoa(from);

      await grantIfLow(from);

      const numericAmount = Number(amount || "0");
      const _amount = BigInt(Math.floor(numericAmount * 1e18));

      const ref = txRef || genTxRef();

      const payloadObj = {
        originator: {
          name: originatorName,
          account: from,
          bank: BANK_A_ID,
          address: originatorAddress,
          dateOfBirth: originatorDob,
          placeOfBirth: originatorPlaceOfBirth,
          idNumber: originatorIdNumber,
        },
        beneficiary: {
          name: beneficiaryName,
          account: DEMO_RECIPIENT,
          bank: BANK_B_ID,
        },
        asset: { token: XBANK, amount: _amount.toString() },
        purpose,
        txRef: ref,
        ts: Math.floor(Date.now() / 1000),
      };

      // (kept) legacy builder exists for old txs; new path is HPKE
      const _unusedLegacy = buildEnvelopeLegacy;

      const envelope = await buildEnvelopeHpke(payloadObj, ref);

      const data = iface.encodeFunctionData("submitPayment", [
        BigInt(BANK_B_ID),
        requireAck,
        envelope,
        ref,
      ]);

      setStatus("Posting request…");
      const tx = await signer.sendTransaction({ to: HUB, data });
      setSubmitTxHash(tx.hash as `0x${string}`);
      setPaymentTxHash("");

      setAckSeen(false);
      setCanSend(!requireAck);

      setStatus(`PaymentSubmitted. ${arbTx(tx.hash)}`);
      setShowOpenBankBPrompt(true);

      if (requireAck && !watching.current) {
        watching.current = true;
        pollAck(ref);
      }
    } catch (e: any) {
      setStatus(`Post failed: ${e?.message ?? e}`);
      setShowOpenBankBPrompt(false);
    }
  };

  const pollAck = async (ref: `0x${string}`) => {
    let loops = 0;
    try {
      while (loops < ACK_MAX_LOOPS && requireAck) {
        loops += 1;

        const localReject = readLocalReject(ref);
        if (localReject) {
          const when = new Date(localReject.ts * 1000).toLocaleTimeString();
          setCanSend(false);
          setStatus(`Payment rejected! Bank B rejected this request at ${when}.`);
          watching.current = false;
          return;
        }

        const localAck = readLocalAck(ref);
        if (localAck) {
          setAckSeen(true);
          setCanSend(true);
          const when = new Date(localAck.ts * 1000).toLocaleTimeString();
          setStatus(`ACK recorded (local) at ${when}. You can now send the xBank transfer.`);
          watching.current = false;
          return;
        }

        if (HUB) {
          const head = await publicClient.getBlockNumber();
          const zero = BigInt("0");

          for (let offset = 0; offset <= ACK_SCAN_SPAN_BLOCKS; offset += 1) {
            const offsetBig = BigInt(offset);
            const blockNumber = head > offsetBig ? head - offsetBig : zero;

            const block = await publicClient.getBlock({
              blockNumber,
              includeTransactions: true,
            });

            const txs: any[] = [];
            const txList: any[] = ((block as any).transactions || []) as any[];

            if (txList.length > 0) {
              if (typeof txList[0] === "string") {
                for (let j = 0; j < txList.length; j += 1) {
                  try {
                    const hash = txList[j] as `0x${string}`;
                    const full = await publicClient.getTransaction({ hash });
                    if (full) txs.push(full);
                  } catch {
                    // ignore
                  }
                }
              } else {
                for (let j = 0; j < txList.length; j += 1) {
                  txs.push(txList[j]);
                }
              }
            }

            const bnBig = (block as any).number as bigint;

            for (let t = 0; t < txs.length; t += 1) {
              const tx = txs[t];
              if (!tx || !tx.to) continue;
              if (String(tx.to).toLowerCase() !== String(HUB).toLowerCase()) continue;

              try {
                const parsed = iface.parseTransaction({ data: tx.input });
                if (!parsed || parsed.name !== "acknowledge") continue;

                const arg = (parsed.args as any[])[0] as string;
                if (arg && arg.toLowerCase() === ref.toLowerCase()) {
                  setAckSeen(true);
                  setCanSend(true);
                  setStatus(
                    `ACK seen on-chain in block ${String(bnBig)}. You can now send the xBank transfer.`
                  );
                  watching.current = false;
                  return;
                }
              } catch {
                // ignore
              }
            }
          }
        }

        await new Promise((r) => setTimeout(r, 1500));
      }
    } finally {
      watching.current = false;
    }
  };

  const sendPayment = async () => {
    try {
      if (!canSend) return;
      if (!XBANK) {
        setStatus("Missing XBANK env");
        return;
      }
      const eip1193 = await getEmbeddedProvider();
      await ensureChain(eip1193);
      const ethersProvider = new BrowserProvider(eip1193);
      const signer = await ethersProvider.getSigner();
      const from = (await signer.getAddress()) as `0x${string}`;
      await grantIfLow(from);

      const numericAmount = Number(amount || "0");
      const _amount = BigInt(Math.floor(numericAmount * 1e18));

      const data = erc20.encodeFunctionData("transfer", [DEMO_RECIPIENT, _amount]);

      setStatus("Sending xBank transfer…");
      const tx = await signer.sendTransaction({ to: XBANK, data });
      setPaymentTxHash(tx.hash as `0x${string}`);
      setStatus(`Sent! Interbank payment complete. ${arbTx(tx.hash)}`);
      await refreshXBankBalances(from);
    } catch (e: any) {
      setStatus(`Send failed: ${e?.message ?? e}`);
    }
  };

  const human = (v: bigint) => {
    try {
      return Number(v) / 1e18;
    } catch {
      return 0;
    }
  };

  const highlightSendButton = requireAck && ackSeen;
  const isSentSuccess = status.startsWith("Sent!");
  const isRejectedStatus = status.startsWith("Payment rejected!");

  if (!ready) {
    return (
      <>
        <NavBar active="bankA" />
        <div style={pageWrap}>
          <div style={loadingWrap}>
            <div style={loadingDot} />
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <style jsx global>{`
        * { box-sizing: border-box; }
        body { background: #07080f; color: #f0f0f0; }
        .ba-input {
          width: 100%;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 8px;
          padding: 8px 12px;
          color: #f0f0f0;
          font-family: inherit;
          font-size: 13px;
          outline: none;
          transition: border-color 160ms;
        }
        .ba-input:focus { border-color: #10b981; }
        .ba-input[readonly] { opacity: 0.5; cursor: default; }
        .ba-input::placeholder { color: rgba(255,255,255,0.25); }
        .ba-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 9px 18px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.07);
          color: #f0f0f0;
          font-family: inherit;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: background 150ms, border-color 150ms;
        }
        .ba-btn:hover { background: rgba(255,255,255,0.12); }
        .ba-btn:disabled { opacity: 0.35; cursor: not-allowed; pointer-events: none; }
        .ba-btn-primary {
          background: #10b981;
          border-color: #10b981;
          color: #fff;
        }
        .ba-btn-primary:hover { background: #0ea572; border-color: #0ea572; }
        .ba-btn-send-ready {
          background: #10b981;
          border-color: #10b981;
          color: #fff;
          font-weight: 700;
          box-shadow: 0 0 0 0 rgba(16,185,129,0.5);
          animation: sendPulse 1.8s ease-in-out infinite;
        }
        .ba-btn-send-ready:hover { background: #0ea572 !important; border-color: #0ea572 !important; }
        @keyframes sendPulse {
          0%   { box-shadow: 0 0 0 0 rgba(16,185,129,0.55); }
          60%  { box-shadow: 0 0 0 10px rgba(16,185,129,0); }
          100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); }
        }
        .wtm-tab {
          padding: 7px 14px;
          border-radius: 6px;
          border: 1px solid rgba(255,255,255,0.08);
          background: transparent;
          color: rgba(255,255,255,0.45);
          font-family: inherit;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 150ms;
          white-space: nowrap;
        }
        .wtm-tab:hover { color: rgba(255,255,255,0.8); border-color: rgba(255,255,255,0.2); }
        .wtm-tab-active {
          background: rgba(16,185,129,0.15);
          border-color: #10b981;
          color: #10b981;
        }
        .wtm-panel { animation: wtmIn 220ms ease; }
        @keyframes wtmIn {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      <NavBar active="bankA" />
      <div style={pageWrap}>
        <div style={inner}>

          {/* Page header */}
          <div style={pageHeader}>
            <div style={ucChip}>UC2</div>
            <div>
              <div style={pageTitle}>Travel-Rule Compliant Payment</div>
              <div style={pageSubtitle}>Bank A — Sender perspective · Arbitrum Sepolia</div>
            </div>
          </div>

          {/* Wallet card */}
          <div style={card}>
            <div style={cardLabel}>Sender Wallet</div>
            {!authenticated || !eoa ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={dimText}>Connect your embedded Privy wallet to start the demo.</div>
                <button className="ba-btn ba-btn-primary" onClick={login}>Connect wallet</button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={metaRow}>
                  <span style={metaLabel}>Address</span>
                  <span style={monoVal}>{eoa}</span>
                  <a href={arbAddr(eoa)} target="_blank" rel="noreferrer" style={extLink}>↗</a>
                </div>
                {userEmail && (
                  <div style={metaRow}>
                    <span style={metaLabel}>eBanking login</span>
                    <span style={{ color: "rgba(255,255,255,0.75)", fontSize: 13 }}>{userEmail}</span>
                  </div>
                )}
                <div style={metaRow}>
                  <span style={metaLabel}>xBank balance</span>
                  <span style={{ ...monoVal, color: "#10b981" }}>{human(xbBal)} XB</span>
                </div>
                <div style={{ ...dimText, fontSize: 11 }}>
                  Bank A ID: {BANK_A_ID} · Network: Arbitrum Sepolia
                </div>
              </div>
            )}
          </div>

          {/* Payment form */}
          <div style={card}>
            <div style={cardLabel}>Payment &amp; Travel-Rule Details</div>
            <div style={formNote}>
              Fields below form the encrypted Travel-Rule envelope (Swiss FINMA Art. 10 AMLO-FINMA minimum).
              Originator name, account, and at least one of address / DOB / ID must accompany the transfer.
            </div>

            {/* Originator */}
            <div style={formSection}>
              <div style={formSectionTitle}>Originator</div>
              <div style={formGrid3}>
                <label style={formLabel}>
                  Full name
                  <input className="ba-input" value={originatorName} onChange={e => setOriginatorName(e.target.value)} />
                </label>
                <label style={formLabel}>
                  Wallet address (read-only)
                  <input className="ba-input" value={eoa || "Connect wallet above"} readOnly />
                </label>
                <label style={formLabel}>
                  Bank ID (read-only)
                  <input className="ba-input" value={BANK_A_ID} readOnly />
                </label>
              </div>
              <label style={formLabel}>
                Physical address
                <input className="ba-input" value={originatorAddress} onChange={e => setOriginatorAddress(e.target.value)} />
              </label>
              <div style={formGrid3}>
                <label style={formLabel}>
                  Date of birth
                  <input className="ba-input" type="date" value={originatorDob} onChange={e => setOriginatorDob(e.target.value)} />
                </label>
                <label style={formLabel}>
                  Place of birth
                  <input className="ba-input" value={originatorPlaceOfBirth} onChange={e => setOriginatorPlaceOfBirth(e.target.value)} />
                </label>
                <label style={formLabel}>
                  Client / ID number
                  <input className="ba-input" value={originatorIdNumber} onChange={e => setOriginatorIdNumber(e.target.value)} />
                </label>
              </div>
            </div>

            {/* Beneficiary */}
            <div style={formSection}>
              <div style={formSectionTitle}>Beneficiary</div>
              <div style={formGrid3}>
                <label style={formLabel}>
                  Full name
                  <input className="ba-input" value={beneficiaryName} onChange={e => setBeneficiaryName(e.target.value)} />
                </label>
                <label style={formLabel}>
                  Wallet address (fixed)
                  <input className="ba-input" value={DEMO_RECIPIENT} readOnly />
                </label>
                <label style={formLabel}>
                  Bank ID (read-only)
                  <input className="ba-input" value={BANK_B_ID} readOnly />
                </label>
              </div>
            </div>

            {/* Transfer */}
            <div style={formSection}>
              <div style={formSectionTitle}>Transfer</div>
              <div style={formGrid2}>
                <label style={formLabel}>
                  Amount (xBank)
                  <input className="ba-input" value={amount} onChange={e => setAmount(e.target.value)} />
                </label>
                <label style={formLabel}>
                  Purpose / reference
                  <input className="ba-input" value={purpose} onChange={e => setPurpose(e.target.value)} />
                </label>
              </div>
            </div>

            {/* ACK toggle */}
            <label style={ackToggle}>
              <input
                type="checkbox"
                checked={requireAck}
                onChange={e => setRequireAck(e.target.checked)}
                style={{ accentColor: "#10b981" }}
              />
              <span style={{ color: "rgba(255,255,255,0.75)", fontSize: 13 }}>
                Require receiving bank ACK before sending tokens
              </span>
            </label>

            {/* ACK received callout */}
            {highlightSendButton && (
              <div style={ackReadyBanner}>
                <span style={{ fontSize: 16 }}>✓</span>
                <div>
                  <div style={{ fontWeight: 700, color: "#10b981", marginBottom: 2 }}>ACK received from Bank B</div>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)" }}>The receiving bank approved the request. Click <strong style={{ color: "#fff" }}>Send payment</strong> to complete the token transfer.</div>
                </div>
              </div>
            )}

            {/* Actions */}
            <div style={actionRow}>
              <button className="ba-btn ba-btn-primary" onClick={postRequest}>
                Encrypt &amp; post request
              </button>
              <button
                className={`ba-btn${highlightSendButton ? " ba-btn-send-ready" : ""}`}
                disabled={!canSend}
                onClick={sendPayment}
              >
                {requireAck && !ackSeen ? "Send payment (waiting ACK…)" : "Send payment"}
              </button>
            </div>

            {/* Bank B prompt */}
            {showOpenBankBPrompt && (
              <div style={promptBox}>
                <div style={{ color: "rgba(255,255,255,0.8)", fontSize: 13, marginBottom: 10, lineHeight: 1.5 }}>
                  Request posted to Payment Hub. To simulate Bank B reviewing and acknowledging, open Bank B in a new window.
                </div>
                <button className="ba-btn" onClick={handleOpenBankBTab}>Open Bank B →</button>
              </div>
            )}

            {/* Tx refs */}
            {(txRef || submitTxHash || paymentTxHash) && (
              <div style={txRefBox}>
                {txRef && (
                  <div style={txRefRow}>
                    <span style={txRefLabel}>txRef</span>
                    <span style={monoSmall}>{txRef}</span>
                  </div>
                )}
                {submitTxHash && (
                  <div style={txRefRow}>
                    <span style={txRefLabel}>Hub tx</span>
                    <a href={arbTx(submitTxHash)} target="_blank" rel="noreferrer" style={extLink}>{short(submitTxHash)}</a>
                  </div>
                )}
                {paymentTxHash && (
                  <div style={txRefRow}>
                    <span style={txRefLabel}>xBank tx</span>
                    <a href={arbTx(paymentTxHash)} target="_blank" rel="noreferrer" style={extLink}>{short(paymentTxHash)}</a>
                  </div>
                )}
              </div>
            )}

            {/* Status */}
            {status && (
              <div style={{
                ...statusBox,
                ...(isSentSuccess ? { borderColor: "#10b981", background: "rgba(16,185,129,0.1)", color: "#10b981" } : {}),
                ...(isRejectedStatus ? { borderColor: "#ef4444", background: "rgba(239,68,68,0.1)", color: "#ef4444" } : {}),
              }}>
                {status}
              </div>
            )}
          </div>

          <WhyThisMatters requireAck={requireAck} ackSeen={ackSeen} />
        </div>
      </div>
    </>
  );
}

/* ── WhyThisMatters ──────────────────────────────────────────────────────────── */

function WhyThisMatters({ requireAck, ackSeen }: { requireAck: boolean; ackSeen: boolean }) {
  const [tab, setTab] = useState(0);

  const ackLabel = requireAck
    ? ackSeen ? "ACK received ✓" : "Waiting for ACK…"
    : "No ACK required";

  const tabs = [
    {
      n: "01", label: "What you're doing",
      title: "Sending a compliant bank-to-bank message",
      subtitle: "You're not sending tokens yet — you're sending an encrypted Travel Rule envelope that enables compliant settlement.",
      body: (
        <div style={wtmBody}>
          {[
            "You collect the Swiss Travel Rule minimum: originator identification + beneficiary details.",
            "You create a txRef — a unique reference both banks can use for audit and dispute resolution.",
            "You submit an encrypted payload to the Payment Hub so Bank B can review and ACK before tokens move.",
          ].map((t, i) => (
            <div key={i} style={wtmListItem}>
              <span style={wtmArrow}>▸</span>
              <span style={wtmListText}>{t}</span>
            </div>
          ))}
          <div style={wtmCallout}>
            <strong style={{ color: UC_ACCENT }}>Key idea:</strong> The chain becomes the shared audit rail for message delivery — the sensitive payload stays private.
          </div>
        </div>
      ),
    },
    {
      n: "02", label: "Technical",
      title: "Sealed envelope through a public post office",
      subtitle: "Everyone sees it was sent — nobody sees what's inside.",
      body: (
        <div style={wtmBody}>
          <div style={wtmGrid2}>
            <div style={wtmCard}>
              <div style={wtmCardTitle}>Encryption (HPKE)</div>
              <div style={wtmCardText}>The Travel Rule JSON is encrypted to Bank B's on-chain public key using HPKE (X25519 + AEAD). Bank A fetches that key from the Directory Registry.</div>
              <div style={pillRow}>
                {["HPKE", "Directory key lookup", "No plaintext PII"].map(p => <span key={p} style={pill}>{p}</span>)}
              </div>
            </div>
            <div style={wtmCard}>
              <div style={wtmCardTitle}>Binding to txRef</div>
              <div style={wtmCardText}>The encryption uses the txRef as associated data, preventing ciphertext swapping between references — like writing a tracking number on a tamper-evident sealed envelope.</div>
              <div style={pillRow}>
                {["Tamper-evident", "Audit trail"].map(p => <span key={p} style={pill}>{p}</span>)}
              </div>
            </div>
          </div>
        </div>
      ),
    },
    {
      n: "03", label: "On-Chain",
      title: "What goes on-chain (and what doesn't)",
      subtitle: "The Payment Hub provides shared visibility without leaking sensitive information.",
      body: (
        <div style={wtmBody}>
          <div style={wtmGrid2}>
            <div style={wtmCard}>
              <div style={wtmCardTitle}>On-chain</div>
              {[
                "submitPayment(toBankId, requireAck, payload, txRef) call to the hub",
                "The encrypted ciphertext bytes + txRef",
                "Optional ACK transaction from Bank B",
              ].map((t, i) => (
                <div key={i} style={wtmListItem}>
                  <span style={wtmArrow}>▸</span>
                  <span style={wtmListText}>{t}</span>
                </div>
              ))}
            </div>
            <div style={wtmCard}>
              <div style={wtmCardTitle}>Not on-chain</div>
              {[
                "No names, addresses, DOB, or other Travel Rule PII in plaintext",
                "No bank internal case data — only the encrypted payload travels",
                "Token transfer gated until Bank B confirms receipt via ACK",
              ].map((t, i) => (
                <div key={i} style={wtmListItem}>
                  <span style={wtmArrow}>▸</span>
                  <span style={wtmListText}>{t}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={wtmCallout}>
            <strong style={{ color: UC_ACCENT }}>Two-window tip:</strong> Keep Bank A open, then open Bank B in a second window. Bank A waits; Bank B reviews + ACKs; then Bank A sends the tokens.
          </div>
        </div>
      ),
    },
    {
      n: "04", label: "For Banks",
      title: "Why banks and regulators should care",
      subtitle: "This bridges compliant Travel Rule messaging with on-chain settlement.",
      body: (
        <div style={wtmBody}>
          <div style={wtmGrid2}>
            <div style={wtmCard}>
              <div style={wtmCardTitle}>Regulatory lens</div>
              {[
                "Meets the Travel Rule requirement: originator/beneficiary data must accompany the transfer.",
                "Keeps PII off-chain while providing a verifiable audit trail (txRef + timestamps + ACKs).",
                "Supports the operational workflow: post → review → ACK → release settlement.",
              ].map((t, i) => (
                <div key={i} style={wtmListItem}>
                  <span style={wtmArrow}>▸</span>
                  <span style={wtmListText}>{t}</span>
                </div>
              ))}
            </div>
            <div style={wtmCard}>
              <div style={wtmCardTitle}>Operational lens</div>
              {[
                "Interoperability: two banks coordinate over a shared rail without sharing databases.",
                "Customer UX: crypto payments feel like regular bank transfers.",
                "Controls: ACK gating is a simple but powerful safety switch for regulated flows.",
              ].map((t, i) => (
                <div key={i} style={wtmListItem}>
                  <span style={wtmArrow}>▸</span>
                  <span style={wtmListText}>{t}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ),
    },
  ];

  const active = tabs[tab];

  return (
    <div style={wtmOuter}>
      <div style={wtmDivider}>
        <div style={wtmDividerLine} />
        <span style={wtmDividerLabel}>Why This Matters</span>
        <div style={wtmDividerLine} />
      </div>
      <div style={wtmIntro}>
        Travel-Rule compliant payment messaging — without putting PII on-chain.
        {requireAck && <span style={wtmBadge}>{ackLabel}</span>}
      </div>
      <div style={wtmTabStrip} role="tablist">
        {tabs.map((t, i) => (
          <button
            key={i}
            role="tab"
            aria-selected={i === tab}
            className={`wtm-tab${i === tab ? " wtm-tab-active" : ""}`}
            onClick={() => setTab(i)}
          >
            <span style={{ opacity: 0.5, marginRight: 5 }}>{t.n}</span>{t.label}
          </button>
        ))}
      </div>
      <div key={tab} role="tabpanel" className="wtm-panel" style={wtmPanel}>
        <div style={wtmPanelHead}>
          <div style={wtmPanelTitle}>{active.title}</div>
          <div style={wtmPanelSub}>{active.subtitle}</div>
        </div>
        {active.body}
      </div>
    </div>
  );
}

/* ── Styles ──────────────────────────────────────────────────────────────────── */

const UC_ACCENT = "#10b981";
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

const pageWrap: CSSProperties = {
  minHeight: "100vh",
  background: "#07080f",
  fontFamily: FONT,
  color: "#f0f0f0",
  paddingBottom: 80,
};

const inner: CSSProperties = {
  maxWidth: 900,
  margin: "0 auto",
  padding: "32px 24px",
  display: "flex",
  flexDirection: "column",
  gap: 20,
};

const loadingWrap: CSSProperties = {
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  minHeight: "60vh",
};

const loadingDot: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: "50%",
  border: "3px solid rgba(255,255,255,0.08)",
  borderTopColor: UC_ACCENT,
  animation: "spin 0.8s linear infinite",
};

const pageHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  marginBottom: 4,
};

const ucChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 42,
  height: 42,
  borderRadius: 10,
  background: "rgba(16,185,129,0.15)",
  border: "1px solid rgba(16,185,129,0.3)",
  color: UC_ACCENT,
  fontWeight: 700,
  fontSize: 12,
  flexShrink: 0,
};

const pageTitle: CSSProperties = {
  fontSize: 20,
  fontWeight: 700,
  color: "#fff",
  lineHeight: 1.2,
};

const pageSubtitle: CSSProperties = {
  fontSize: 13,
  color: "rgba(255,255,255,0.4)",
  marginTop: 3,
};

const card: CSSProperties = {
  background: "rgba(255,255,255,0.032)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 16,
  padding: "20px 24px",
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

const cardLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: UC_ACCENT,
};

const metaRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};

const metaLabel: CSSProperties = {
  fontSize: 12,
  color: "rgba(255,255,255,0.52)",
  minWidth: 110,
  flexShrink: 0,
};

const monoVal: CSSProperties = {
  fontFamily: "ui-monospace, 'SFMono-Regular', Menlo, Monaco, Consolas, monospace",
  fontSize: 12,
  color: "rgba(255,255,255,0.85)",
  wordBreak: "break-all",
};

const monoSmall: CSSProperties = {
  fontFamily: "ui-monospace, 'SFMono-Regular', Menlo, Monaco, Consolas, monospace",
  fontSize: 12,
  color: "rgba(255,255,255,0.72)",
  wordBreak: "break-all",
};

const dimText: CSSProperties = {
  color: "rgba(255,255,255,0.6)",
  fontSize: 13,
  lineHeight: 1.5,
};

const extLink: CSSProperties = {
  color: UC_ACCENT,
  fontSize: 12,
  textDecoration: "none",
};

const formNote: CSSProperties = {
  fontSize: 12,
  color: "rgba(255,255,255,0.58)",
  lineHeight: 1.55,
};

const formSection: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  borderTop: "1px solid rgba(255,255,255,0.06)",
  paddingTop: 14,
};

const formSectionTitle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "rgba(255,255,255,0.62)",
  letterSpacing: "0.07em",
  textTransform: "uppercase",
};

const formGrid3: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
  gap: 10,
};

const formGrid2: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 10,
};

const formLabel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  fontSize: 12,
  color: "rgba(255,255,255,0.65)",
};

const ackToggle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  cursor: "pointer",
};

const actionRow: CSSProperties = {
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
};

const promptBox: CSSProperties = {
  background: "rgba(16,185,129,0.07)",
  border: "1px solid rgba(16,185,129,0.2)",
  borderRadius: 10,
  padding: "14px 16px",
};

const txRefBox: CSSProperties = {
  background: "rgba(255,255,255,0.025)",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: 8,
  padding: "10px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const txRefRow: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  flexWrap: "wrap",
};

const txRefLabel: CSSProperties = {
  fontSize: 11,
  color: "rgba(255,255,255,0.45)",
  minWidth: 52,
  paddingTop: 1,
  flexShrink: 0,
};

const statusBox: CSSProperties = {
  padding: "10px 14px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(255,255,255,0.04)",
  fontSize: 12,
  color: "rgba(255,255,255,0.78)",
  wordBreak: "break-all",
  lineHeight: 1.5,
};

const ackReadyBanner: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  background: "rgba(16,185,129,0.1)",
  border: "1px solid rgba(16,185,129,0.35)",
  borderRadius: 10,
  padding: "12px 16px",
};

// ── WhyThisMatters styles ─────────────────────────────────────────────────────

const wtmOuter: CSSProperties = { marginTop: 32 };

const wtmDivider: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  marginBottom: 20,
};

const wtmDividerLine: CSSProperties = {
  flex: 1,
  height: 1,
  background: "rgba(255,255,255,0.06)",
};

const wtmDividerLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "rgba(255,255,255,0.28)",
  whiteSpace: "nowrap",
};

const wtmIntro: CSSProperties = {
  fontSize: 14,
  color: "rgba(255,255,255,0.68)",
  marginBottom: 16,
  lineHeight: 1.5,
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
};

const wtmBadge: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "3px 10px",
  borderRadius: 999,
  background: "rgba(16,185,129,0.15)",
  border: "1px solid rgba(16,185,129,0.3)",
  color: UC_ACCENT,
  fontSize: 11,
  fontWeight: 700,
};

const wtmTabStrip: CSSProperties = {
  display: "flex",
  gap: 6,
  flexWrap: "wrap",
  marginBottom: 14,
};

const wtmPanel: CSSProperties = {
  background: "rgba(255,255,255,0.025)",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: 14,
  padding: "20px 22px",
};

const wtmPanelHead: CSSProperties = { marginBottom: 16 };

const wtmPanelTitle: CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: "#fff",
  marginBottom: 5,
};

const wtmPanelSub: CSSProperties = {
  fontSize: 13,
  color: "rgba(255,255,255,0.60)",
  lineHeight: 1.5,
};

const wtmBody: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const wtmGrid2: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: 12,
};

const wtmCard: CSSProperties = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: 12,
  padding: "14px 16px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const wtmCardTitle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#fff",
};

const wtmCardText: CSSProperties = {
  fontSize: 13,
  color: "rgba(255,255,255,0.70)",
  lineHeight: 1.55,
};

const wtmListItem: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "flex-start",
};

const wtmArrow: CSSProperties = {
  color: UC_ACCENT,
  fontSize: 12,
  flexShrink: 0,
  marginTop: 2,
};

const wtmListText: CSSProperties = {
  fontSize: 13,
  color: "rgba(255,255,255,0.72)",
  lineHeight: 1.55,
};

const wtmCallout: CSSProperties = {
  background: "rgba(16,185,129,0.06)",
  border: "1px solid rgba(16,185,129,0.18)",
  borderRadius: 10,
  padding: "12px 14px",
  fontSize: 13,
  color: "rgba(255,255,255,0.72)",
  lineHeight: 1.5,
};

const pillRow: CSSProperties = {
  display: "flex",
  gap: 6,
  flexWrap: "wrap",
};

const pill: CSSProperties = {
  display: "inline-flex",
  padding: "3px 9px",
  borderRadius: 999,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(255,255,255,0.04)",
  fontSize: 11,
  fontWeight: 600,
  color: "rgba(255,255,255,0.48)",
};
