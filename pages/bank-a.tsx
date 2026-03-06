// pages/bank-a.tsx
import { useEffect, useRef, useState } from "react";
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
        <div style={bankAccentWrap}>
          <div style={{ padding: 24 }}>Loading…</div>
        </div>
      </>
    );
  }

  return (
    <>
      <NavBar active="bankA" />
      <div style={bankAccentWrap}>
        <div style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
        <h2>Travel-rule complaint payment (Bank A)</h2>

        {/* Wallet summary */}
        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: 12,
            padding: 16,
            marginTop: 12,
            marginBottom: 24,
            background: "#fafafa",
          }}
        >
          <h3 style={{ marginTop: 0, marginBottom: 8 }}>Your wallet</h3>
          {!authenticated || !eoa ? (
            <>
              <p style={{ marginBottom: 8 }}>
                Connect your embedded Privy wallet to start the demo.
              </p>
              <button onClick={login}>Connect with wallet</button>
            </>
          ) : (
            <>
              <p style={{ marginBottom: 4 }}>
                <strong>Address:</strong>{" "}
                <span style={{ fontFamily: "monospace" }}>{eoa}</span> ·{" "}
                <a href={arbAddr(eoa)} target="_blank" rel="noreferrer">
                  Arbiscan
                </a>
              </p>
              {userEmail && (
                <p style={{ marginBottom: 4 }}>
                  <strong>eBanking login:</strong> <span>{userEmail}</span>
                </p>
              )}
              <p style={{ marginBottom: 4 }}>
                <strong>xBank balance:</strong>{" "}
                <span style={{ fontFamily: "monospace" }}>{human(xbBal)}</span>
              </p>
              <p style={{ marginBottom: 0, fontSize: 12, color: "#666" }}>
                Network: Arbitrum Sepolia (demo) · Bank A ID: {BANK_A_ID}
              </p>
            </>
          )}
        </div>

        {/* Payment + travel-rule block */}
        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: 12,
            padding: 16,
          }}
        >
          <h3 style={{ marginTop: 0 }}>Payment &amp; travel-rule details</h3>
          <p style={{ fontSize: 12, color: "#666", marginBottom: 12 }}>
            The fields below make up the travel-rule envelope sent to Bank B via the Payment Hub. For
            Switzerland (FINMA Art. 10 AMLO-FINMA), the originator’s name, account and at least one of
            address, date/place of birth, client number or ID number must accompany the transfer.
          </p>

          {/* Sender row */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 12 }}>
            <div style={{ flex: "1 1 260px" }}>
              <label style={{ display: "block", fontSize: 12 }}>Sender name</label>
              <input
                value={originatorName}
                onChange={(e) => setOriginatorName(e.target.value)}
                style={{ width: "100%", padding: 4, marginTop: 4 }}
              />
            </div>
            <div style={{ flex: "1 1 260px" }}>
              <label style={{ display: "block", fontSize: 12 }}>Sender wallet (read only)</label>
              <input
                value={eoa || "Connect your wallet above to populate the sender address"}
                readOnly
                style={{
                  width: "100%",
                  padding: 4,
                  marginTop: 4,
                  fontFamily: "monospace",
                  background: "#f5f5f5",
                }}
              />
            </div>
            <div style={{ flex: "0 0 140px" }}>
              <label style={{ display: "block", fontSize: 12 }}>Sender bank ID</label>
              <input
                value={BANK_A_ID}
                readOnly
                style={{ width: "100%", padding: 4, marginTop: 4, background: "#f5f5f5" }}
              />
            </div>
          </div>

          {/* Sender KYC */}
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: "block", fontSize: 12 }}>Sender address</label>
            <input
              value={originatorAddress}
              onChange={(e) => setOriginatorAddress(e.target.value)}
              style={{ width: "100%", padding: 4, marginTop: 4 }}
            />
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 16 }}>
            <div style={{ flex: "0 0 160px" }}>
              <label style={{ display: "block", fontSize: 12 }}>Date of birth</label>
              <input
                type="date"
                value={originatorDob}
                onChange={(e) => setOriginatorDob(e.target.value)}
                style={{ width: "100%", padding: 4, marginTop: 4 }}
              />
            </div>
            <div style={{ flex: "1 1 180px" }}>
              <label style={{ display: "block", fontSize: 12 }}>Place of birth</label>
              <input
                value={originatorPlaceOfBirth}
                onChange={(e) => setOriginatorPlaceOfBirth(e.target.value)}
                style={{ width: "100%", padding: 4, marginTop: 4 }}
              />
            </div>
            <div style={{ flex: "1 1 200px" }}>
              <label style={{ display: "block", fontSize: 12 }}>Client / ID number</label>
              <input
                value={originatorIdNumber}
                onChange={(e) => setOriginatorIdNumber(e.target.value)}
                style={{ width: "100%", padding: 4, marginTop: 4 }}
              />
            </div>
          </div>

          {/* Recipient row */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 12 }}>
            <div style={{ flex: "1 1 260px" }}>
              <label style={{ display: "block", fontSize: 12 }}>Recipient name</label>
              <input
                value={beneficiaryName}
                onChange={(e) => setBeneficiaryName(e.target.value)}
                style={{ width: "100%", padding: 4, marginTop: 4 }}
              />
            </div>
            <div style={{ flex: "1 1 260px" }}>
              <label style={{ display: "block", fontSize: 12 }}>Recipient wallet (fixed)</label>
              <input
                value={DEMO_RECIPIENT}
                readOnly
                style={{
                  width: "100%",
                  padding: 4,
                  marginTop: 4,
                  fontFamily: "monospace",
                  background: "#f5f5f5",
                }}
              />
            </div>
            <div style={{ flex: "0 0 140px" }}>
              <label style={{ display: "block", fontSize: 12 }}>Recipient bank ID</label>
              <input
                value={BANK_B_ID}
                readOnly
                style={{ width: "100%", padding: 4, marginTop: 4, background: "#f5f5f5" }}
              />
            </div>
          </div>

          {/* Amount + purpose */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 12 }}>
            <div style={{ flex: "0 0 180px" }}>
              <label style={{ display: "block", fontSize: 12 }}>Amount (xBank)</label>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                style={{ width: "100%", padding: 4, marginTop: 4 }}
              />
            </div>
            <div style={{ flex: "1 1 260px" }}>
              <label style={{ display: "block", fontSize: 12 }}>Purpose / reference</label>
              <input
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                style={{ width: "100%", padding: 4, marginTop: 4 }}
              />
            </div>
          </div>

          {/* ACK toggle */}
          <label style={{ display: "block", marginTop: 4 }}>
            <input
              type="checkbox"
              checked={requireAck}
              onChange={(e) => setRequireAck(e.target.checked)}
            />{" "}
            Require receiving bank ACK before sending tokens
          </label>

          {/* Actions */}
          <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={postRequest}>Encrypt &amp; post request</button>
            <button
              disabled={!canSend}
              onClick={sendPayment}
              style={
                highlightSendButton
                  ? {
                      backgroundColor: "#e6f9f0",
                      borderColor: "#2e7d32",
                      color: "#1b5e20",
                      fontWeight: 600,
                    }
                  : undefined
              }
            >
              {requireAck && !ackSeen ? "Send payment (waiting ACK)" : "Send payment"}
            </button>
          </div>

          {/* Prompt to open Bank B */}
          {showOpenBankBPrompt && (
            <div
              style={{
                marginTop: 12,
                padding: 12,
                borderRadius: 8,
                background: "#f0f4ff",
                fontSize: 12,
              }}
            >
              <p style={{ margin: 0, marginBottom: 8 }}>
                Your request has been posted to the Payment Hub. To simulate the receiving bank reviewing and
                acknowledging the request, open the Bank B tab in a separate browser window.
              </p>
              <button onClick={handleOpenBankBTab}>Open Bank B in new window</button>
            </div>
          )}

          <div style={{ marginTop: 12, fontSize: 12 }}>
            {txRef && (
              <div>
                <strong>Payment reference (txRef):</strong>{" "}
                <span style={{ fontFamily: "monospace" }}>{txRef}</span>
              </div>
            )}
            {submitTxHash && (
              <div>
                <strong>Envelope tx (hub):</strong>{" "}
                <a href={arbTx(submitTxHash)} target="_blank" rel="noreferrer">
                  {short(submitTxHash)}
                </a>
              </div>
            )}
            {paymentTxHash && (
              <div>
                <strong>Token transfer tx (xBank):</strong>{" "}
                <a href={arbTx(paymentTxHash)} target="_blank" rel="noreferrer">
                  {short(paymentTxHash)}
                </a>
              </div>
            )}
          </div>

          {status && (
            <p
              style={{
                marginTop: 8,
                ...(isSentSuccess
                  ? { background: "#e6f9f0", borderRadius: 6, padding: "8px 10px" }
                  : {}),
                ...(isRejectedStatus
                  ? {
                      background: "#ffecec",
                      borderRadius: 6,
                      padding: "8px 10px",
                      color: "#b00020",
                    }
                  : {}),
              }}
            >
              {status}
            </p>
          )}
        </div>

        {/* ✅ Premium sticky accordion: Why this matters */}
        <WhyThisMatters requireAck={requireAck} ackSeen={ackSeen} />
        </div>
      </div>
    </>
  );
}

/* ---------- Premium “Why this matters” (same component as eBanking, page-specific content) ---------- */

function WhyThisMatters({ requireAck, ackSeen }: { requireAck: boolean; ackSeen: boolean }) {
  const [open, setOpen] = useState(false);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [maxH, setMaxH] = useState(0);

  useEffect(() => {
    const update = () => {
      if (!innerRef.current) return;
      setMaxH(open ? innerRef.current.scrollHeight : 0);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open]);

  const ackModeLabel = requireAck ? (ackSeen ? "ACK received ✅" : "") : "ACK disabled";

  return (
    <div style={whyStickyWrap}>
      <div style={whyShell}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={whyHeaderBtn}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <span style={whyBadge}>Why this matters</span>
            <span style={whyTitle}>
              Travel Rule-compliant payment messaging — without putting PII on-chain
            </span>
          </span>

          <span style={whyRight}>
            <span style={whyHint}>{ackModeLabel}</span>
            <span style={{ ...chevWrap, transform: open ? "rotate(180deg)" : "rotate(0deg)" }}>
              <Chevron />
            </span>
          </span>
        </button>

        <div
          style={{
            ...whyBodyOuter,
            maxHeight: open ? maxH : 0,
            opacity: open ? 1 : 0,
            transform: open ? "translateY(0px)" : "translateY(-4px)",
          }}
        >
          <div ref={innerRef} style={whyBodyInner}>
            <Section
              k="1"
              title="What you’re doing on this page"
              subtitle="You’re not sending tokens yet — you’re sending a bank-to-bank “message” that enables a compliant transfer."
            >
              <ul style={whyList}>
                <li>
                  You collect the <strong>Swiss Travel Rule minimum</strong> (originator identification + beneficiary details).
                </li>
                <li>
                  You create a <strong>txRef</strong> — a unique reference both banks can point to.
                </li>
                <li>
                  You submit an <strong>encrypted payload</strong> to the on-chain Payment Hub, so Bank B can review and ACK.
                </li>
              </ul>

              <div style={bannerNote}>
                <strong>Key idea:</strong> The chain becomes the shared “rail” for message delivery and auditability,
                while the sensitive Travel Rule payload stays private.
              </div>
            </Section>

            <Section
              k="2"
              title="What happens technically"
              subtitle="Think: sealed envelope travels through a public post office. Everyone sees it was sent — nobody sees what’s inside."
            >
              <div style={whyGrid2}>
                <div style={whyCard}>
                  <div style={whyCardTitle}>Encryption (HPKE)</div>
                  <div style={whyText}>
                    The Travel Rule JSON is encrypted to <strong>Bank B’s public key</strong> using HPKE (X25519 + AEAD).
                    That public key is stored on-chain in the Directory so Bank A can always fetch the latest key.
                  </div>
                  <div style={pillRow}>
                    <span style={pill}>HPKE</span>
                    <span style={pill}>Directory key lookup</span>
                    <span style={pill}>No plaintext PII</span>
                  </div>
                </div>

                <div style={whyCard}>
                  <div style={whyCardTitle}>Binding to txRef</div>
                  <div style={whyText}>
                    The encryption uses the <strong>txRef</strong> as associated data. That prevents swapping ciphertexts between references.
                    It’s like writing the tracking number onto the sealed envelope in a tamper-evident way.
                  </div>
                  <div style={pillRow}>
                    <span style={pill}>Audit trail</span>
                  </div>
                </div>
              </div>
            </Section>

            <Section
              k="3"
              title="What goes on-chain (and what doesn’t)"
              subtitle="This is why the Payment Hub is useful: shared visibility without leaking sensitive information."
            >
              <div style={whyGrid2}>
                <div style={whyCard}>
                  <div style={whyCardTitle}>On-chain</div>
                  <ul style={whyList}>
                    <li>
                      A transaction to the <strong>Payment Hub</strong>: <code style={whyCode}>submitPayment(toBankId, requireAck, payload, txRef)</code>
                    </li>
                    <li>
                      The <strong>ciphertext payload</strong> (bytes) + the <strong>txRef</strong>
                    </li>
                    <li>
                      Optional: an <strong>ACK</strong> transaction from Bank B to the hub
                    </li>
                  </ul>
                </div>

                <div style={whyCard}>
                  <div style={whyCardTitle}>Not on-chain</div>
                  <ul style={whyList}>
                    <li>
                      No names, addresses, DOB, or other Travel Rule PII in plaintext
                    </li>
                    <li>
                      No bank internal case data — only the encrypted payload travels on-chain
                    </li>
                    <li>
                      The actual token transfer can be <strong>gated</strong> until Bank B confirms receipt (ACK)
                    </li>
                  </ul>
                </div>
              </div>

              <div style={nextStep}>
                <div style={{ fontWeight: 950, marginBottom: 4 }}>Two-window tip</div>
                <div style={{ color: "#333", lineHeight: 1.5 }}>
                  For a real “interbank” feel: keep <strong>Bank A</strong> open, then open <strong>Bank B</strong> in a second window.
                  Bank A waits; Bank B reviews + ACKs; then Bank A sends the tokens.
                </div>
              </div>
            </Section>

            <Section
              k="4"
              title="Why banks (and regulators) should care"
              subtitle="This is the bridge between compliant messaging and on-chain settlement."
            >
              <div style={whyGrid2}>
                <div style={whyCard}>
                  <div style={whyCardTitle}>Regulatory lens (what you’re simulating)</div>
                  <ul style={whyList}>
                    <li>
                      Meeting the Travel Rule requirement: originator/beneficiary data must accompany the transfer.
                    </li>
                    <li>
                      Keeping PII off-chain while still providing a verifiable audit trail (txRef, timestamps, acknowledgements).
                    </li>
                    <li>
                      Supporting an operational workflow: “post → review → ACK → release settlement.”
                    </li>
                  </ul>
                </div>

                <div style={whyCard}>
                  <div style={whyCardTitle}>Operational lens (what this unlocks)</div>
                  <ul style={whyList}>
                    <li>
                      <strong>Interoperability:</strong> two banks can coordinate over a shared rail without sharing databases.
                    </li>
                    <li>
                      <strong>Customer UX:</strong> crypto payments feel like regular bank transfers.
                    </li>
                    <li>
                      <strong>Controls:</strong> ACK gating is a simple but powerful safety switch for regulated flows.
                    </li>
                  </ul>
                </div>
              </div>
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({
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
      <div style={{ marginTop: 10 }}>{children}</div>
    </div>
  );
}

function Chevron() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ---------- Component Styles (same as eBanking) ---------- */

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
  border: "none",
  background: "transparent",
  padding: 14,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

const whyBadge: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "4px 10px",
  borderRadius: 999,
  background: "#111",
  color: "#fff",
  fontWeight: 900,
  fontSize: 12,
  flex: "0 0 auto",
};

const whyTitle: React.CSSProperties = {
  fontWeight: 900,
  color: "#111",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const whyRight: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flex: "0 0 auto",
};

const whyHint: React.CSSProperties = {
  fontSize: 12,
  color: "#666",
  fontWeight: 800,
};

const chevWrap: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 12,
  border: "1px solid #e6e8eb",
  display: "grid",
  placeItems: "center",
  color: "#111",
  background: "#fff",
  transition: "transform 180ms ease",
};

const whyBodyOuter: React.CSSProperties = {
  borderTop: "1px solid #e6e8eb",
  overflow: "hidden",
  transition: "max-height 260ms ease, opacity 200ms ease, transform 200ms ease",
  willChange: "max-height, opacity, transform",
};

const whyBodyInner: React.CSSProperties = {
  padding: 14,
  background: "#eee",
};

const secWrap: React.CSSProperties = {
  padding: 12,
  borderRadius: 14,
  border: "1px solid #eef0f2",
  background: "#fafafa",
  marginBottom: 10,
};

const secHead: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "flex-start",
};

const secK: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 12,
  display: "grid",
  placeItems: "center",
  background: "#111",
  color: "#fff",
  fontWeight: 950,
  fontSize: 13,
  flex: "0 0 auto",
};

const secTitle: React.CSSProperties = {
  fontWeight: 950,
  color: "#111",
  lineHeight: 1.2,
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
  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
};

const whyCard: React.CSSProperties = {
  border: "1px solid #eef0f2",
  borderRadius: 14,
  padding: 12,
  background: "#fff",
};

const whyCardTitle: React.CSSProperties = {
  fontWeight: 900,
  marginBottom: 8,
  color: "#111",
};

const whyText: React.CSSProperties = {
  color: "#333",
  lineHeight: 1.55,
  fontSize: 13,
};

const whyList: React.CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  color: "#333",
  lineHeight: 1.55,
};

const whyCode: React.CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  fontSize: 12,
  background: "#f6f8fa",
  border: "1px solid #e6e8eb",
  padding: "1px 6px",
  borderRadius: 8,
};

const pillRow: React.CSSProperties = {
  marginTop: 10,
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
};

const pill: React.CSSProperties = {
  display: "inline-flex",
  padding: "4px 10px",
  borderRadius: 999,
  border: "1px solid #e6e8eb",
  background: "#fafafa",
  fontSize: 12,
  fontWeight: 800,
  color: "#444",
};

const bannerNote: React.CSSProperties = {
  marginTop: 10,
  padding: 12,
  borderRadius: 14,
  border: "1px solid #e6e8eb",
  background: "#fafafa",
  color: "#333",
  lineHeight: 1.5,
};

const nextStep: React.CSSProperties = {
  marginTop: 10,
  padding: 12,
  borderRadius: 14,
  border: "1px solid #e6e8eb",
  background: "#fff",
  color: "#333",
};

const bankAccentWrap: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(64, 118, 255, 0.10) 0%, rgba(255,255,255,0) 220px)",
};
