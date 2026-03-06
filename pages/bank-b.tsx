// pages/bank-b.tsx
import { useEffect, useRef, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { BrowserProvider, Interface } from "ethers";
import { encodePacked, keccak256 } from "viem";
import { publicClient } from "../shared/lib/aa";
import NavBar from "../shared/components/NavBar";

const HUB = (process.env.NEXT_PUBLIC_PAYMENT_HUB_ADDRESS || "") as `0x${string}`;
const DIR = (process.env.NEXT_PUBLIC_DIRECTORY_ADDRESS || "") as `0x${string}`;
const BANK_A_ID = Number(process.env.NEXT_PUBLIC_BANK_A_ID || 1);
const BANK_B_ID = Number((process.env.NEXT_PUBLIC_BANK_B_ID || process.env.NXT_PUBLIC_BANK_B_ID || 2) as any);
const XBANK = (process.env.NEXT_PUBLIC_XBANK_ADDRESS || "") as `0x${string}`;
const DEMO_RECIPIENT = (process.env.NEXT_PUBLIC_DEMO_RECIPIENT || "") as `0x${string}`;


const MAX_BLOCK_LOOKBACK_REQUESTS = 120;
const MAX_BLOCK_LOOKBACK_LOGS = 120;

const STORAGE_KEY_REQS = "hub:bankB:reqs:v3";
const STORAGE_KEY_LOGS = "hub:logs:v1";
const ACK_STORAGE_KEY = "hub:acks:v1";
const REJECT_STORAGE_KEY = "hub:rejects:v1";

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


const HUB_EVENTS_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: true, internalType: "uint256", name: "toBankId", type: "uint256" },
      { indexed: false, internalType: "bool", name: "requireAck", type: "bool" },
      { indexed: false, internalType: "bytes32", name: "payloadHash", type: "bytes32" },
      { indexed: true, internalType: "bytes32", name: "txRef", type: "bytes32" },
    ],
    name: "OutboundPayment",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "operator", type: "address" },
      { indexed: true, internalType: "uint256", name: "bankId", type: "uint256" },
      { indexed: true, internalType: "bytes32", name: "txRef", type: "bytes32" },
    ],
    name: "InboundAck",
    type: "event",
  },
] as const;

const HUB_EVENT_IFACE = new Interface(HUB_EVENTS_ABI as any);
const outboundEvent = HUB_EVENT_IFACE.getEvent("OutboundPayment");
if (!outboundEvent) {
  throw new Error("OutboundPayment event not found in HUB_EVENTS_ABI");
}
const OUTBOUND_TOPIC0 = outboundEvent.topicHash as `0x${string}`;

const uint256Topic = (n: bigint): `0x${string}` => {
  const hex = n.toString(16);
  const padded = hex.length >= 64 ? hex.slice(-64) : ("0".repeat(64 - hex.length) + hex);
  return ("0x" + padded) as `0x${string}`;
};


const DIR_ABI = [
  {
    type: "function",
    name: "bankHpkePubKey",
    stateMutability: "view",
    inputs: [{ name: "bankId", type: "uint256" }],
    outputs: [{ name: "", type: "bytes" }],
  },
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
    name: "claimOperatorRole",
    stateMutability: "nonpayable",
    inputs: [{ name: "bankId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "pauseBank",
    stateMutability: "nonpayable",
    inputs: [
      { name: "bankId", type: "uint256" },
      { name: "active", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "upsertBank",
    stateMutability: "nonpayable",
    inputs: [
      { name: "bankId", type: "uint256" },
      { name: "active", type: "bool" },
      { name: "leiHash", type: "bytes32" },
      { name: "domainHash", type: "bytes32" },
      { name: "operator", type: "address" },
      { name: "hpkePubKey", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;


type AckStatus = "pending" | "acked" | "rejected";

type ReqRow = {
  blockNumber: number;
  txHash: `0x${string}`;
  toBankId: number;
  requireAck: boolean;
  purpose: string;
  txRef: `0x${string}`;
  payload: `0x${string}`;
  parsed?: any;
  createdAt?: number;
  status?: AckStatus;
  ackTxHash?: `0x${string}`;
};

type AckRecord = {
  txRef: string;
  ackTxHash: string;
  ts: number;
};

type RejectRecord = {
  txRef: string;
  ts: number;
};

type LogRow = {
  blockNumber: number;
  txHash: `0x${string}`;
  desc: string;
  details?: any;
  timestamp?: number;
};

type BankRow = {
  id: number;
  active: boolean;
  leiHash: `0x${string}`;
  domainHash: `0x${string}`;
  operator: `0x${string}`;
  hpke?: `0x${string}`;
};

const arbTx = (h: string) => `https://sepolia.arbiscan.io/tx/${h}`;
const arbAddr = (a: string) => `https://sepolia.arbiscan.io/address/${a}`;
const isAddr = (a?: string) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));
const human = (v: bigint) => {
  try {
    return Number(v) / 1e18;
  } catch {
    return 0;
  }
};
const short = (x?: string) => (x ? x.slice(0, 8) + "…" + x.slice(-6) : "");

const formatTs = (ts?: number) => {
  if (!ts) return "";
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return "";
  }
};

const decodeEnvelopeLegacy = (hex: `0x${string}`) => {
  try {
    if (!hex || hex === "0x") return null;
    const clean = hex.slice(2);
    const len = Math.floor(clean.length / 2);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      const byte = clean.slice(i * 2, i * 2 + 2);
      bytes[i] = Number.parseInt(byte, 16);
    }
    const decoder = new TextDecoder();
    const json = decoder.decode(bytes);
    return JSON.parse(json);
  } catch {
    return null;
  }
};

  const decryptEnvelopeHpke = async (
    payloadHex: `0x${string}`,
    txRef: `0x${string}`
  ) => {
    try {
      const r = await fetch("/api/hpke-open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payloadHex, txRef }),
      });
      const j = await r.json();
      if (!r.ok || !j?.ok) return null;
      return j?.obj ?? null;
    } catch {
      return null;
    }
  };

  const decodeAnyEnvelope = async (
    payloadHex: `0x${string}`,
    txRef: `0x${string}`
  ) => {
    // 1) Try HPKE (new path)
    const hpkeObj = await decryptEnvelopeHpke(payloadHex, txRef);
    if (hpkeObj) return { obj: hpkeObj, kind: "hpke" as const };

    // 2) Fall back to legacy plaintext JSON (old demo txs)
    const legacy = decodeEnvelopeLegacy(payloadHex);
    if (legacy) return { obj: legacy, kind: "legacy" as const };

    return { obj: null, kind: "none" as const };
  };


const saveAckToLocal = (txRef: `0x${string}`, ackTxHash: `0x${string}`) => {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(ACK_STORAGE_KEY);
    const list: AckRecord[] = raw ? JSON.parse(raw) : [];
    const now = Math.floor(Date.now() / 1000);
    const lowerRef = txRef.toLowerCase();
    const idx = list.findIndex((r) => String(r.txRef).toLowerCase() === lowerRef);
    const rec: AckRecord = { txRef, ackTxHash, ts: now };
    if (idx >= 0) {
      list[idx] = rec;
    } else {
      list.push(rec);
    }
    window.localStorage.setItem(ACK_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
};

const saveRejectToLocal = (txRef: `0x${string}`) => {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(REJECT_STORAGE_KEY);
    const list: RejectRecord[] = raw ? JSON.parse(raw) : [];
    const now = Math.floor(Date.now() / 1000);
    const lowerRef = txRef.toLowerCase();
    const idx = list.findIndex((r) => String(r.txRef).toLowerCase() === lowerRef);
    const rec: RejectRecord = { txRef, ts: now };
    if (idx >= 0) {
      list[idx] = rec;
    } else {
      list.push(rec);
    }
    window.localStorage.setItem(REJECT_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
};

// Helper: derive human-readable xBank amount from payload
const formatXBankAmount = (parsed: any) => {
  try {
    if (!parsed || !parsed.asset) return null;
    const token = parsed.asset.token;
    const amountRaw = parsed.asset.amount;
    if (!amountRaw) {
      return { token, amountHuman: null as number | null, amountRaw: "" };
    }
    const wei = BigInt(amountRaw.toString());
    const amountHuman = Number(wei) / 1e18;
    return { token, amountHuman, amountRaw };
  } catch {
    return null;
  }
};

export default function BankB() {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();

  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<ReqRow[]>([]);
  const [reqLimit, setReqLimit] = useState(3);
  const [operator, setOperator] = useState<string>("");
  const [walletAddr, setWalletAddr] = useState<string>("");

  const [logEvents, setLogEvents] = useState<LogRow[]>([]);
  const [logStatus, setLogStatus] = useState("");
  const [logLimit, setLogLimit] = useState(3);
  const [showReturnToBankABanner, setShowReturnToBankABanner] =
    useState(false);

  const [directoryRows, setDirectoryRows] = useState<BankRow[]>([]);
  const [dirStatus, setDirStatus] = useState("");
  const [dirIdsCsv, setDirIdsCsv] = useState(`${BANK_A_ID},${BANK_B_ID}`);

  // Directory admin (upsert) UI state
  const [upsertBankId, setUpsertBankId] = useState<number>(BANK_B_ID);
  const [upsertActive, setUpsertActive] = useState<boolean>(true);
  const [upsertLei, setUpsertLei] = useState<string>("");
  const [upsertDomain, setUpsertDomain] = useState<string>("");
  const [upsertOperatorAddr, setUpsertOperatorAddr] = useState<string>("");
  const [upsertHpkePubKeyHex, setUpsertHpkePubKeyHex] = useState<string>("");
  const [upsertStatus, setUpsertStatus] = useState<string>("");

  // Directory admin wallet: allow MetaMask (directory owner) for upserts, without touching Privy flows.
  const [dirOwnerAddr, setDirOwnerAddr] = useState<string>("");
  const [dirWalletAddr, setDirWalletAddr] = useState<string>("");
  const [metaMaskAddr, setMetaMaskAddr] = useState<string>("");
  const [metaMaskStatus, setMetaMaskStatus] = useState<string>("");
  const [useMetaMaskForDir, setUseMetaMaskForDir] = useState<boolean>(false);

  // Fixed receiver wallet (beneficiary) info (not a Privy wallet)
  const [recipientXbBal, setRecipientXbBal] = useState<bigint>(BigInt("0"));


  const iface = new Interface(HUB_ABI);
  const dirIface = new Interface(DIR_ABI);

  const pollingReqs = useRef(false);
  const pollingLogs = useRef(false);

  const getEmbeddedProvider = async () => {
    const list = (wallets as any[]) || [];
    const embedded =
      list.find(
        (w: any) =>
          typeof w?.getEthereumProvider === "function" &&
          (w?.chainId === "eip155:421614" ||
            w?.meta?.chainId === "eip155:421614")
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
              nativeCurrency: {
                name: "Sepolia Ether",
                symbol: "ETH",
                decimals: 18,
              },
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
    const threshold = BigInt("200000000000000");
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

  const refreshRecipientBalance = async () => {
    try {
      if (!XBANK || !isAddr(XBANK) || !isAddr(DEMO_RECIPIENT)) {
        setRecipientXbBal(BigInt("0"));
        return;
      }
      const bal = (await publicClient.readContract({
        address: XBANK,
        abi: ERC20_ABI as any,
        functionName: "balanceOf",
        args: [DEMO_RECIPIENT],
      })) as bigint;
      setRecipientXbBal(bal);
    } catch {
      setRecipientXbBal(BigInt("0"));
    }
  };

  useEffect(() => {
    if (!ready) return;
    refreshRecipientBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const handleOpenBankATab = () => {
    if (typeof window !== "undefined") {
      window.open("/bank-a", "_blank", "noopener,noreferrer");
    }
  };

  const connectMetaMask = async () => {
    try {
      setMetaMaskStatus("");
      if (typeof window === "undefined") return;
      const eth = (window as any).ethereum;
      if (!eth || typeof eth.request !== "function") {
        setMetaMaskStatus("MetaMask not found. Install it or use Remix for Directory changes.");
        return;
      }
      const accts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const addr = (accts && accts[0]) ? accts[0] : "";
      if (!addr) {
        setMetaMaskStatus("No MetaMask accounts returned.");
        return;
      }
      setMetaMaskAddr(addr);
      setUseMetaMaskForDir(true);
    } catch (e: any) {
      setMetaMaskStatus(`MetaMask connect failed: ${e?.message ?? e}`);
    }
  };

  const disconnectMetaMask = () => {
    setMetaMaskAddr("");
    setUseMetaMaskForDir(false);
    setMetaMaskStatus("");
  };

  // ----- load persisted requests / logs from localStorage -----
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY_REQS);
      if (raw) {
        const parsed = JSON.parse(raw) as ReqRow[];
        setRows(parsed);
      }
    } catch {
      // ignore
    }
    try {
      const rawLogs = window.localStorage.getItem(STORAGE_KEY_LOGS);
      if (rawLogs) {
        const parsed = JSON.parse(rawLogs) as LogRow[];
        setLogEvents(parsed);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY_REQS, JSON.stringify(rows));
    } catch {
      // ignore
    }
  }, [rows]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        STORAGE_KEY_LOGS,
        JSON.stringify(logEvents)
      );
    } catch {
      // ignore
    }
  }, [logEvents]);

  // ----- load Directory snapshot (Bank A / Bank B) -----
  const loadDirectory = async () => {
    if (!DIR) {
      setDirStatus("Missing NEXT_PUBLIC_DIRECTORY_ADDRESS env var.");
      return;
    }
    try {
      setDirStatus("Loading…");
      // Directory owner (used for MetaMask upsert demo)
      try {
        const owner = (await publicClient.readContract({
          address: DIR,
          abi: DIR_ABI,
          functionName: "owner",
          args: [],
        })) as any;
        if (owner) setDirOwnerAddr(String(owner));
      } catch {
        // ignore
      }
      const ids = String(dirIdsCsv || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
      if (ids.length === 0) ids.push(BANK_A_ID, BANK_B_ID);
      const out: BankRow[] = [];
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        const info = (await publicClient.readContract({
          address: DIR,
          abi: DIR_ABI,
          functionName: "banks",
          args: [BigInt(id)],
        })) as any;
        const hpke = (await publicClient
          .readContract({
            address: DIR,
            abi: DIR_ABI,
            functionName: "bankHpkePubKey",
            args: [BigInt(id)],
          })
          .catch(() => "0x")) as `0x${string}`;

        out.push({
          id,
          active: Boolean(info?.[0]),
          leiHash: (info?.[1] || "0x") as `0x${string}`,
          domainHash: (info?.[2] || "0x") as `0x${string}`,
          operator:
            (info?.[3] ||
              "0x0000000000000000000000000000000000000000") as `0x${string}`,
          hpke: hpke && hpke !== "0x" ? hpke : undefined,
        });
      }
      setDirectoryRows(out);
      setDirStatus("");
      const bankBRow = out.find((r) => r.id === BANK_B_ID);
      if (bankBRow && bankBRow.operator) setOperator(bankBRow.operator);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (
        msg.includes("HTTP request failed") ||
        msg.includes("Failed to fetch")
      ) {
        setDirStatus(
          "Could not reach RPC / Directory. Check NEXT_PUBLIC_DIRECTORY_ADDRESS and RPC key / connectivity."
        );
      } else {
        setDirStatus(msg);
      }
    }
  };

  const asBytes32Hash = (s: string) => {
    const t = String(s || "").trim();
    const zero = ("0x" + "0".repeat(64)) as `0x${string}`;
    if (!t) return zero;
    if (/^0x[0-9a-fA-F]{64}$/.test(t)) return t as `0x${string}`;
    return keccak256(encodePacked(["string"], [t])) as `0x${string}`;
  };

  const upsertBank = async () => {
    try {
      setUpsertStatus("");
      const hasMetaMask =
        typeof window !== "undefined" &&
        (window as any).ethereum &&
        typeof (window as any).ethereum.request === "function";

      const wantsMetaMask = Boolean(useMetaMaskForDir && hasMetaMask);

      if (useMetaMaskForDir && !hasMetaMask) {
        setUpsertStatus("MetaMask not found. Install it or use Remix for Directory changes.");
        return;
      }

      // If we're not using MetaMask for this admin action, fall back to Privy auth + embedded wallet.
      if (!wantsMetaMask && !authenticated) {
        await login();
        return;
      }
      if (!DIR) {
        setUpsertStatus("Missing NEXT_PUBLIC_DIRECTORY_ADDRESS");
        return;
      }

      const bankId = Number(upsertBankId);
      if (!Number.isFinite(bankId) || bankId <= 0) {
        setUpsertStatus("Invalid bankId");
        return;
      }

      const hpkeHex = String(upsertHpkePubKeyHex || "").trim();
      if (!hpkeHex.startsWith("0x")) {
        setUpsertStatus("HPKE pubkey must be hex (0x...)");
        return;
      }

      const leiHash = asBytes32Hash(upsertLei);
      const domainHash = asBytes32Hash(upsertDomain);
      const operatorAddr = (String(upsertOperatorAddr || "").trim() ||
        "0x0000000000000000000000000000000000000000") as `0x${string}`;

      const eip1193 = wantsMetaMask ? (window as any).ethereum : await getEmbeddedProvider();
      await ensureChain(eip1193);
      const ethersProvider = new BrowserProvider(eip1193);
      const signer = await ethersProvider.getSigner();
      const addr = (await signer.getAddress()) as `0x${string}`;
      setDirWalletAddr(addr);
      if (wantsMetaMask) setMetaMaskAddr(addr);

      await grantIfLow(addr);

      const data = dirIface.encodeFunctionData("upsertBank", [
        BigInt(bankId),
        Boolean(upsertActive),
        leiHash,
        domainHash,
        operatorAddr,
        hpkeHex as `0x${string}`,
      ]);

      setUpsertStatus(
        "Sending Directory upsertBank tx… (requires Directory owner wallet)"
      );
      const tx = await signer.sendTransaction({ to: DIR, data });
      setUpsertStatus(`Upsert sent: ${arbTx(tx.hash as `0x${string}`)}`);

      await loadDirectory();
    } catch (e: any) {
      setUpsertStatus(`Upsert failed: ${e?.message ?? e}`);
    }
  };


  useEffect(() => {
    loadDirectory();
  }, []);

  // ----- scan recent blocks for submitPayment to Bank B (incoming requests) -----
  const scanRequests = async () => {
    if (!HUB) {
      setStatus("Missing NEXT_PUBLIC_PAYMENT_HUB_ADDRESS");
      return;
    }
    try {
      setStatus("Scanning recent blocks for requests…");
      
const head = await publicClient.getBlockNumber();
const zero = BigInt("0");
const found: ReqRow[] = [];

// Faster discovery: use OutboundPayment event logs filtered by indexed toBankId,
// then fetch only those matching transactions to extract the payload bytes from calldata.
const lookback = BigInt(MAX_BLOCK_LOOKBACK_REQUESTS);
const fromBlock = head > lookback ? head - lookback : zero;

const toBankTopic = uint256Topic(BigInt(BANK_B_ID));

const logs = await publicClient.getLogs(
  {
    address: HUB,
    fromBlock,
    toBlock: head,
    topics: [OUTBOUND_TOPIC0, null, toBankTopic],
  } as any
);

const tsCache = new Map<string, number>();

for (let i = 0; i < logs.length; i += 1) {
  const lg: any = logs[i];
  const txHash = lg.transactionHash as `0x${string}`;
  const blockNumberBig = lg.blockNumber as bigint;

  if (!txHash || blockNumberBig === undefined || blockNumberBig === null) continue;

  // Decode event (optional) to get requireAck/txRef quickly
  let requireAck = true;
  let txRef = ("0x" + "0".repeat(64)) as `0x${string}`;
  try {
    const parsedLog: any = HUB_EVENT_IFACE.parseLog({ topics: lg.topics, data: lg.data });
    requireAck = Boolean(parsedLog?.args?.requireAck);
    txRef = parsedLog?.args?.txRef as `0x${string}`;
  } catch {
    // ignore
  }

  // Fetch tx calldata and decode submitPayment to extract payload bytes (required for decryption)
  let payload = "0x" as `0x${string}`;
  try {
    const tx: any = await publicClient.getTransaction({ hash: txHash });
    if (!tx?.to || String(tx.to).toLowerCase() !== String(HUB).toLowerCase()) continue;

    const parsed = iface.parseTransaction({ data: tx.input });
    if (!parsed || parsed.name !== "submitPayment") continue;

    const args = parsed.args as any[];
    const toBankIdBig = BigInt(args[0]);
    const toBankIdNum = Number(toBankIdBig);
    if (toBankIdNum !== BANK_B_ID) continue;

    requireAck = Boolean(args[1]);
    payload = args[2] as `0x${string}`;
    txRef = (args[3] as `0x${string}`) || txRef;
  } catch {
    continue;
  }

  // Block timestamp (cached)
  const bnKey = String(blockNumberBig);
  let ts = tsCache.get(bnKey);
  if (!ts) {
    try {
      const block: any = await publicClient.getBlock({ blockNumber: blockNumberBig });
      ts = Number(block?.timestamp ?? 0);
      if (ts) tsCache.set(bnKey, ts);
    } catch {
      ts = 0;
    }
  }

  found.push({
    blockNumber: Number(blockNumberBig),
    txHash,
    toBankId: BANK_B_ID,
    requireAck,
    purpose: "Decrypting…",
    txRef,
    payload,
    parsed: null,
    createdAt: ts || Math.floor(Date.now() / 1000),
    status: "pending",
  });
}

      // Decrypt (HPKE) any newly found inbound requests so the UI can show the Travel-Rule fields.
      for (let i = 0; i < found.length; i += 1) {
        const r = found[i];
        if (!r?.payload || !r?.txRef) continue;
        const decodedAny = await decodeAnyEnvelope(r.payload, r.txRef);
        if (decodedAny.obj) {
          (r as any).parsed = decodedAny.obj;
          (r as any).purpose = String(
            (decodedAny.obj as any)?.purpose ?? r.purpose ?? "—"
          );
        } else {
          (r as any).parsed = null;
          (r as any).purpose = r.purpose || "—";
        }
      }

      setRows((prev) => {
        const byRef = new Map<string, ReqRow>();
        for (let i = 0; i < prev.length; i += 1) {
          const r = prev[i];
          byRef.set(String(r.txRef), r);
        }
        for (let i = 0; i < found.length; i += 1) {
          const r = found[i];
          const key = String(r.txRef);
          const existing = byRef.get(key);
          if (existing) {
            byRef.set(key, {
              ...existing,
              ...r,
              status: existing.status || "pending",
            });
          } else {
            byRef.set(key, r);
          }
        }
        const merged = Array.from(byRef.values());
        merged.sort((a, b) => b.blockNumber - a.blockNumber);
        return merged;
      });

      if (found.length === 0) {
        setStatus(
          "No new requests in last " +
            String(MAX_BLOCK_LOOKBACK_REQUESTS) +
            " blocks (showing archive below)."
        );
      } else {
        setStatus("");
      }
    } catch (e: any) {
      setStatus(`Load failed: ${e?.message ?? e}`);
    }
  };

  // ----- ACK / reject -----
  const ack = async (row: ReqRow) => {
    try {
      if (!authenticated) {
        await login();
        return;
      }
      if (!HUB || !DIR) {
        setStatus("Missing HUB or DIRECTORY env address");
        return;
      }

      const eip1193 = await getEmbeddedProvider();
      await ensureChain(eip1193);
      const ethersProvider = new BrowserProvider(eip1193);
      const signer = await ethersProvider.getSigner();
      const addr = (await signer.getAddress()) as `0x${string}`;
      setWalletAddr(addr);

      await grantIfLow(addr);

      const claimData = dirIface.encodeFunctionData("claimOperatorRole", [
        BigInt(BANK_B_ID),
      ]);
      setStatus("Claiming Bank B operator role…");
      await signer.sendTransaction({ to: DIR, data: claimData });

      const ackData = iface.encodeFunctionData("acknowledge", [row.txRef]);
      setStatus("Sending ACK…");
      const ackTx = await signer.sendTransaction({ to: HUB, data: ackData });
      setStatus(`ACK sent: ${arbTx(ackTx.hash)}`);

      saveAckToLocal(row.txRef, ackTx.hash as `0x${string}`);
      setOperator(addr);

      setRows((prev) =>
        prev.map((r) =>
          r.txRef === row.txRef
            ? { ...r, status: "acked", ackTxHash: ackTx.hash as `0x${string}` }
            : r
        )
      );
      setShowReturnToBankABanner(true);
    } catch (e: any) {
      setStatus(`ACK failed: ${e?.message ?? e}`);
    }
  };

  const reject = (row: ReqRow) => {
    // Save a local "rejected" marker so Bank A can pick it up
    saveRejectToLocal(row.txRef);
    setRows((prev) =>
      prev.map((r) =>
        r.txRef === row.txRef ? { ...r, status: "rejected" } : r
      )
    );
    setStatus("Rejected (demo only, no on-chain reject).");
  };

  // ----- scan logs (hub transactions) -----
  const scanLogs = async () => {
    if (!HUB) {
      setLogStatus("Missing NEXT_PUBLIC_PAYMENT_HUB_ADDRESS");
      return;
    }

    try {
      setLogStatus("Scanning hub logs…");
      const head = await publicClient.getBlockNumber();
      const zero = BigInt("0");
      const found: LogRow[] = [];

      for (let offset = 0; offset <= MAX_BLOCK_LOOKBACK_LOGS; offset += 1) {
        const offsetBig = BigInt(offset);
        const blockNumberBig =
          head > offsetBig ? head - offsetBig : zero;

        const block = await publicClient.getBlock({
          blockNumber: blockNumberBig,
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
        const ts = Number((block as any).timestamp ?? 0);

        for (let t = 0; t < txs.length; t += 1) {
          const tx = txs[t];
          if (!tx || !tx.to) continue;
          if (String(tx.to).toLowerCase() !== String(HUB).toLowerCase())
            continue;

          try {
            const parsed = iface.parseTransaction({ data: tx.input });
            if (!parsed) continue;

            if (parsed.name === "submitPayment") {
              const [toBankId, requireAck, payload, txRef] =
                parsed.args as any[];

              const payloadHex = payload as `0x${string}`;
              const bytesLen =
                payloadHex && payloadHex !== "0x"
                  ? Math.floor((payloadHex.length - 2) / 2)
                  : 0;

              found.push({
                blockNumber: Number(bnBig),
                txHash: tx.hash as `0x${string}`,
                desc:
                  "PaymentSubmitted toBank=" +
                  String(toBankId) +
                  " requireAck=" +
                  String(requireAck),
                details: {
                  txRef,
                  payloadBytes: bytesLen,
                },
                timestamp: ts || Math.floor(Date.now() / 1000),
              });
            } else if (parsed.name === "acknowledge") {
              const [ref] = parsed.args as any[];
              found.push({
                blockNumber: Number(bnBig),
                txHash: tx.hash as `0x${string}`,
                desc: "PaymentAcknowledged ref=" + String(ref),
                timestamp: ts || Math.floor(Date.now() / 1000),
              });
            }
          } catch {
            // ignore parse errors
          }
        }
      }

      setLogEvents((prev) => {
        const byHash = new Map<string, LogRow>();
        for (let i = 0; i < prev.length; i += 1) {
          const r = prev[i];
          byHash.set(r.txHash, r);
        }
        for (let i = 0; i < found.length; i += 1) {
          const r = found[i];
          const existing = byHash.get(r.txHash);
          if (existing) {
            byHash.set(r.txHash, { ...existing, ...r });
          } else {
            byHash.set(r.txHash, r);
          }
        }
        const merged = Array.from(byHash.values());
        merged.sort((a, b) => b.blockNumber - a.blockNumber);
        return merged;
      });

      if (found.length === 0) {
        setLogStatus(
          "No new hub txs in last " +
            String(MAX_BLOCK_LOOKBACK_LOGS) +
            " blocks (showing archive below)."
        );
      } else {
        setLogStatus("");
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (
        msg.includes("HTTP request failed") ||
        msg.includes("Failed to fetch")
      ) {
        setLogStatus(
          "Could not reach RPC while scanning logs. Try again later or check RPC key / limits."
        );
      } else {
        setLogStatus(`Load failed: ${msg}`);
      }
    }
  };

  // ----- periodic scanning -----
  useEffect(() => {
    if (!ready) return;
    scanRequests();
    if (!pollingReqs.current) {
      pollingReqs.current = true;
      const id = window.setInterval(scanRequests, 7000);
      return () => {
        window.clearInterval(id);
        pollingReqs.current = false;
      };
    }
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    scanLogs();
    if (!pollingLogs.current) {
      pollingLogs.current = true;
      const id = window.setInterval(scanLogs, 15000);
      return () => {
        window.clearInterval(id);
        pollingLogs.current = false;
      };
    }
  }, [ready]);

  // ----- rendering helpers -----
  const visibleReqs = rows.slice(0, reqLimit);
  const visibleLogs = logEvents.slice(0, logLimit);

  const pendingCount = rows.filter((r) => r.requireAck && (r.status ?? "pending") === "pending").length;
  const ackedCount = rows.filter((r) => r.status === "acked").length;

  if (!ready) {
    return (
      <>
        <NavBar active="bankB" />
        <div style={bankAccentWrap}>
          <div style={{ padding: 24 }}>Loading…</div>
        </div>
      </>
    );
  }

  return (
    <>
      <NavBar active="bankB" />
      <div style={bankAccentWrap}>
        <div style={{ padding: 24, maxWidth: 1000, margin: "0 auto" }}>
        <h2 style={{ marginTop: 0, marginBottom: 8 }}>Travel-rule compliant receiving (Bank B)</h2>

        {/* Receiver wallet summary (fixed beneficiary address) */}
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
          <h3 style={{ marginTop: 0, marginBottom: 8 }}>Receiver wallet</h3>
          {!isAddr(DEMO_RECIPIENT) ? (
            <p style={{ marginBottom: 0, fontSize: 12, color: "#666" }}>
              Missing <code>NEXT_PUBLIC_DEMO_RECIPIENT</code> env var.
            </p>
          ) : (
            <>
              <p style={{ marginBottom: 4 }}>
                <strong>Address:</strong>{" "}
                <span style={{ fontFamily: "monospace" }}>{DEMO_RECIPIENT}</span>{" "}
                ·{" "}
                <a href={arbAddr(DEMO_RECIPIENT)} target="_blank" rel="noreferrer">
                  Arbiscan
                </a>
              </p>
              <p style={{ marginBottom: 4 }}>
                <strong>xBank balance:</strong>{" "}
                <span style={{ fontFamily: "monospace" }}>{human(recipientXbBal)}</span>
              </p>
              <p style={{ marginBottom: 0, fontSize: 12, color: "#666" }}>
                Network: Arbitrum Sepolia · Fixed recipient wallet
              </p>
            </>
          )}
        </div>

        {/* Section 1: Incoming requests */}
        <section style={{ marginBottom: 32 }}>
          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: 12,
              padding: 16,
              background: "#fafafa",
            }}
          >
            <h2 style={{ marginTop: 0 }}>Incoming requests (Bank B)</h2>
            <p style={{ fontSize: 12, color: "#777" }}>
              HUB: <code>{HUB || "(missing)"}</code> · Bank ID: {BANK_B_ID}
              {operator && (
                <>
                  {" "}
                  · Bank B operator: <code>{operator}</code>
                </>
              )}
              {walletAddr && (
                <>
                  {" "}
                  · Your wallet: <code>{walletAddr}</code>
                </>
              )}
            </p>

            <div style={{ marginBottom: 8 }}>
              <button onClick={scanRequests}>Refresh requests</button>
            </div>

            {showReturnToBankABanner && (
              <div
                style={{
                  marginBottom: 12,
                  padding: 10,
                  borderRadius: 8,
                  background: "#e6f9f0",
                  fontSize: 24,
                }}
              >
                <p style={{ margin: 0, marginBottom: 4 }}>
                  ACK sent. To complete the demo, switch back to{" "}
                  <strong>Bank A</strong> and send the xBank token transfer.
                </p>
              </div>
            )}

            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                tableLayout: "fixed",
              }}
            >
              <thead>
                <tr>
                  <th
                    style={{
                      textAlign: "left",
                      borderBottom: "1px solid #ddd",
                      padding: 8,
                      width: "18%",
                    }}
                  >
                    txRef / tx
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      borderBottom: "1px solid #ddd",
                      padding: 8,
                      width: "14%",
                    }}
                  >
                    Purpose
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      borderBottom: "1px solid #ddd",
                      padding: 8,
                      width: "14%",
                    }}
                  >
                    Created
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      borderBottom: "1px solid #ddd",
                      padding: 8,
                      width: "36%",
                    }}
                  >
                    Payload (decoded)
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      borderBottom: "1px solid #ddd",
                      padding: 8,
                      width: "18%",
                    }}
                  >
                    Actions / status
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleReqs.map((r, idx) => {
                  const assetInfo = formatXBankAmount(r.parsed as any);
                  return (
                    <tr
                      key={idx}
                      style={{
                        borderBottom: "1px solid #eee",
                      }}
                    >
                      <td
                        style={{
                          padding: 8,
                          wordBreak: "break-word",
                          overflowWrap: "break-word",
                        }}
                      >
                        <div
                          style={{
                            fontFamily: "monospace",
                            fontSize: 12,
                            wordBreak: "break-word",
                            overflowWrap: "break-word",
                          }}
                        >
                          {r.txRef}
                        </div>
                        <a
                          href={arbTx(r.txHash)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          tx
                        </a>
                      </td>
                      <td
                        style={{
                          padding: 8,
                          wordBreak: "break-word",
                          overflowWrap: "break-word",
                        }}
                      >
                        {r.purpose}
                      </td>
                      <td
                        style={{
                          padding: 8,
                          fontSize: 12,
                          wordBreak: "break-word",
                          overflowWrap: "break-word",
                        }}
                      >
                        {formatTs(r.createdAt)}
                      </td>
                      <td
                        style={{
                          padding: 8,
                          wordBreak: "break-word",
                          overflowWrap: "break-word",
                        }}
                      >
                        {r.parsed ? (
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: 4,
                              fontSize: 12,
                            }}
                          >
                            <div style={{ fontSize: 11 }}>
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "2px 6px",
                                  borderRadius: 999,
                                  background: "#e6f9f0",
                                  marginRight: 6,
                                }}
                              >
                                Swiss minimum
                              </span>
                              <span style={{ color: "#555" }}>
                                Originator &amp; beneficiary identification
                              </span>
                            </div>
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns:
                                  "minmax(0,1fr) minmax(0,1fr)",
                                columnGap: 12,
                                rowGap: 2,
                              }}
                            >
                              <div
                                style={{
                                  wordBreak: "break-word",
                                  overflowWrap: "break-word",
                                }}
                              >
                                <div
                                  style={{
                                    fontWeight: 600,
                                    fontSize: 11,
                                  }}
                                >
                                  Originator
                                </div>
                                <div>
                                  Name:{" "}
                                  {(r.parsed as any)?.originator?.name ?? "—"}
                                </div>
                                <div>
                                  Account:{" "}
                                  {(r.parsed as any)?.originator?.account ??
                                    "—"}
                                </div>
                                <div>
                                  Address:{" "}
                                  {(r.parsed as any)?.originator?.address ??
                                    "—"}
                                </div>
                                <div>
                                  DOB:{" "}
                                  {(r.parsed as any)?.originator?.dateOfBirth ??
                                    "—"}
                                </div>
                                <div>
                                  Place of birth:{" "}
                                  {(r.parsed as any)?.originator
                                    ?.placeOfBirth ?? "—"}
                                </div>
                                <div>
                                  Client / ID:{" "}
                                  {(r.parsed as any)?.originator?.idNumber ??
                                    "—"}
                                </div>
                              </div>
                              <div
                                style={{
                                  wordBreak: "break-word",
                                  overflowWrap: "break-word",
                                }}
                              >
                                <div
                                  style={{
                                    fontWeight: 600,
                                    fontSize: 11,
                                  }}
                                >
                                  Beneficiary
                                </div>
                                <div>
                                  Name:{" "}
                                  {(r.parsed as any)?.beneficiary?.name ?? "—"}
                                </div>
                                <div>
                                  Account:{" "}
                                  {(r.parsed as any)?.beneficiary?.account ??
                                    "—"}
                                </div>
                              </div>
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                marginTop: 4,
                                wordBreak: "break-word",
                                overflowWrap: "break-word",
                              }}
                            >
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "2px 6px",
                                  borderRadius: 999,
                                  background: "#e6f0ff",
                                  marginRight: 6,
                                }}
                              >
                                Additional fields
                              </span>
                              <span style={{ color: "#555" }}>
                                Asset, amount, purpose and technical metadata
                              </span>
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                wordBreak: "break-word",
                                overflowWrap: "break-word",
                              }}
                            >
                              <div>
                                Amount (xBank):{" "}
                                {assetInfo
                                  ? assetInfo.amountHuman !== null
                                    ? assetInfo.amountHuman
                                    : assetInfo.amountRaw || "—"
                                  : "—"}
                              </div>
                              <div>
                                Token address:{" "}
                                {assetInfo?.token
                                  ? assetInfo.token
                                  : (r.parsed as any)?.asset?.token ?? "—"}
                              </div>
                              <div>
                                Purpose:{" "}
                                {(r.parsed as any)?.purpose ??
                                  r.purpose ??
                                  "—"}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <span style={{ fontSize: 12, color: "#999" }}>
                            No payload decoded
                          </span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: 8,
                          wordBreak: "break-word",
                          overflowWrap: "break-word",
                        }}
                      >
                        {!r.requireAck ? (
                          <span
                            style={{
                              display: "inline-block",
                              padding: "2px 8px",
                              borderRadius: 999,
                              background: "#f5f5f5",
                              fontSize: 12,
                            }}
                          >
                            Processed w/o ACK
                          </span>
                        ) : r.status === "pending" ? (
                          <>
                            <button
                              onClick={() => ack(r)}
                              style={{ marginRight: 8 }}
                            >
                              ACK
                            </button>
                            <button onClick={() => reject(r)}>Reject</button>
                          </>
                        ) : r.status === "acked" ? (
                          <div style={{ fontSize: 12 }}>
                            <span
                              style={{
                                display: "inline-block",
                                padding: "2px 8px",
                                borderRadius: 999,
                                background: "#e6f9f0",
                              }}
                            >
                              ACKed
                            </span>
                            {r.ackTxHash && (
                              <>
                                {" "}
                                ·{" "}
                                <a
                                  href={arbTx(r.ackTxHash)}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  ack tx
                                </a>
                              </>
                            )}
                          </div>
                        ) : (
                          <span
                            style={{
                              display: "inline-block",
                              padding: "2px 8px",
                              borderRadius: 999,
                              background: "#ffecec",
                              fontSize: 12,
                            }}
                          >
                            Rejected
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ padding: 12, color: "#777" }}>
                      No requests yet…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {rows.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 12 }}>
                Showing {Math.min(reqLimit, rows.length)} of {rows.length}{" "}
                requests.
                {"  "}
                {rows.length > reqLimit && (
                  <button
                    onClick={() => setReqLimit((v) => v + 5)}
                    style={{ marginLeft: 8 }}
                  >
                    Show more
                  </button>
                )}
                {reqLimit > 3 && (
                  <button
                    onClick={() => setReqLimit(3)}
                    style={{ marginLeft: 8 }}
                  >
                    Show less
                  </button>
                )}
              </div>
            )}

            {status && <p style={{ marginTop: 10 }}>{status}</p>}
          </div>
        </section>

        {/* Section 2: Logs */}
        <section style={{ marginBottom: 32 }}>
          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: 12,
              padding: 16,
              background: "#fafafa",
            }}
          >
            <h3 style={{ marginTop: 0 }}>Payment Hub activity</h3>
            <div style={{ marginBottom: 8 }}>
              <button onClick={scanLogs}>Refresh logs</button>
            </div>
            {logStatus && <p style={{ fontSize: 12 }}>{logStatus}</p>}
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {visibleLogs.map((l, i) => {
                const descLower = (l.desc || "").toLowerCase();
                const isAck = descLower.startsWith("paymentacknowledged");
                const isSubmit = descLower.startsWith("paymentsubmitted");
                const badgeLabel = isAck
                  ? "ACK"
                  : isSubmit
                  ? "Payment"
                  : "Hub tx";
                const badgeBg = isAck
                  ? "#e6f9f0"
                  : isSubmit
                  ? "#e6f0ff"
                  : "#f5f5f5";

                return (
                  <li key={i} style={{ marginBottom: 8 }}>
                    <div
                      style={{
                        border: "1px solid #eee",
                        borderRadius: 8,
                        padding: 8,
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          fontSize: 12,
                        }}
                      >
                        <span style={{ fontFamily: "monospace" }}>
                          {formatTs(l.timestamp) || "—"}
                        </span>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            borderRadius: 999,
                            background: badgeBg,
                          }}
                        >
                          {badgeLabel}
                        </span>
                      </div>
                      <div style={{ fontSize: 12 }}>
                        <a
                          href={arbTx(l.txHash)}
                          target="_blank"
                          rel="noreferrer"
                          style={{ fontFamily: "monospace" }}
                        >
                          {short(l.txHash)}
                        </a>
                      </div>
                      <div style={{ fontSize: 12 }}>{l.desc}</div>
                      {l.details && (
                        <pre
                          style={{
                            margin: 0,
                            fontSize: 11,
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {JSON.stringify(l.details, null, 2)}
                        </pre>
                      )}
                    </div>
                  </li>
                );
              })}
              {logEvents.length === 0 && !logStatus && (
                <li
                  style={{
                    fontFamily: "monospace",
                    marginBottom: 8,
                    color: "#777",
                  }}
                >
                  No hub transactions yet…
                </li>
              )}
            </ul>
            {logEvents.length > 0 && (
              <div style={{ marginTop: 4, fontSize: 12 }}>
                Showing {Math.min(logLimit, logEvents.length)} of{" "}
                {logEvents.length} log entries.
                {"  "}
                {logEvents.length > logLimit && (
                  <button
                    onClick={() => setLogLimit((v) => v + 5)}
                    style={{ marginLeft: 8 }}
                  >
                    Show more
                  </button>
                )}
                {logLimit > 3 && (
                  <button
                    onClick={() => setLogLimit(3)}
                    style={{ marginLeft: 8 }}
                  >
                    Show less
                  </button>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Section 3: Directory snapshot */}
        <section>
          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: 12,
              padding: 16,
              background: "#fafafa",
            }}
          >
            <h3 style={{ marginTop: 0 }}>Directory Registry</h3>
            <p style={{ fontSize: 12, color: "#777", marginTop: 6 }}>
              This table reads the on-chain DirectoryRegistry. For HPKE to work,
              the receiving must have a non-empty HPKE public key stored on-chain.
            </p>

            <div style={{ marginBottom: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 12, color: "#555" }}>Show bank IDs (comma-separated)</div>
                <input
                  value={dirIdsCsv}
                  onChange={(e) => setDirIdsCsv(e.target.value)}
                  style={{ width: 220 }}
                  placeholder="1,2,3"
                />
              </div>
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <button onClick={loadDirectory}>Refresh Directory</button>
              </div>
            </div>

            <div
              style={{
                border: "1px dashed #bbb",
                borderRadius: 10,
                padding: 12,
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>
                    Directory admin (upsertBank)
                  </div>
                  <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
                    Works only if your connected wallet is the Directory owner.
                    Use this to set Bank B&apos;s HPKE pubkey (or add Bank C).
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {!metaMaskAddr ? (
                      <button onClick={connectMetaMask}>Connect MetaMask</button>
                    ) : (
                      <button onClick={disconnectMetaMask}>Disconnect MetaMask</button>
                    )}

                    <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={useMetaMaskForDir}
                        onChange={(e) => setUseMetaMaskForDir(e.target.checked)}
                        disabled={!metaMaskAddr}
                      />
                      Use MetaMask for Directory
                    </label>

                    <button onClick={upsertBank}>Upsert bank</button>
                  </div>

                  <div style={{ fontSize: 12, color: "#666", textAlign: "right" }}>
                    <div>
                      Directory owner:{" "}
                      <code>{dirOwnerAddr ? dirOwnerAddr : "—"}</code>
                    </div>
                    <div>
                      MetaMask:{" "}
                      <code>{metaMaskAddr ? metaMaskAddr : "not connected"}</code>
                      {metaMaskAddr && dirOwnerAddr && metaMaskAddr.toLowerCase() === dirOwnerAddr.toLowerCase() ? (
                        <span style={{ marginLeft: 6, color: "#0a7" }}>✓ owner</span>
                      ) : null}
                    </div>
                    {metaMaskStatus ? <div style={{ color: "#b00" }}>{metaMaskStatus}</div> : null}
                  </div>
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: 10,
                }}
              >
                <label style={{ fontSize: 12 }}>
                  Bank ID
                  <input
                    type="number"
                    value={upsertBankId}
                    onChange={(e) => setUpsertBankId(Number(e.target.value))}
                    style={{ width: "100%" }}
                  />
                </label>

                <label style={{ fontSize: 12 }}>
                  Active
                  <select
                    value={upsertActive ? "true" : "false"}
                    onChange={(e) => setUpsertActive(e.target.value === "true")}
                    style={{ width: "100%" }}
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                </label>

                <label style={{ fontSize: 12 }}>
                  LEI (plain text or 0x…bytes32)
                  <input
                    value={upsertLei}
                    onChange={(e) => setUpsertLei(e.target.value)}
                    placeholder="Example LEI"
                    style={{ width: "100%" }}
                  />
                </label>

                <label style={{ fontSize: 12 }}>
                  Domain (plain text or 0x…bytes32)
                  <input
                    value={upsertDomain}
                    onChange={(e) => setUpsertDomain(e.target.value)}
                    placeholder="bank.example"
                    style={{ width: "100%" }}
                  />
                </label>

                <label style={{ fontSize: 12 }}>
                  Operator address
                  <input
                    value={upsertOperatorAddr}
                    onChange={(e) => setUpsertOperatorAddr(e.target.value)}
                    placeholder={dirWalletAddr || metaMaskAddr || walletAddr || "0x…"}
                    style={{ width: "100%" }}
                  />
                </label>

                <label style={{ fontSize: 12 }}>
                  HPKE public key (hex bytes)
                  <input
                    value={upsertHpkePubKeyHex}
                    onChange={(e) => setUpsertHpkePubKeyHex(e.target.value)}
                    placeholder="0x… (32 bytes for X25519)"
                    style={{ width: "100%", fontFamily: "monospace" }}
                  />
                </label>
              </div>

              {upsertStatus && (
                <div style={{ marginTop: 10, fontSize: 12, color: "#444" }}>
                  {upsertStatus}
                </div>
              )}
            </div>

            <p style={{ fontSize: 12, color: "#777" }}>
              Registry entries for Bank A and Bank B used by this demo.
            </p>
            <p style={{ fontSize: 12, color: "#777" }}>
              Directory address: <code>{DIR || "(missing)"}</code>
            </p>

            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                tableLayout: "fixed",
              }}
            >
              <thead>
                <tr>
                  <th
                    style={{
                      textAlign: "left",
                      borderBottom: "1px solid #ddd",
                      padding: 8,
                    }}
                  >
                    Bank ID
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      borderBottom: "1px solid #ddd",
                      padding: 8,
                    }}
                  >
                    Status
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      borderBottom: "1px solid #ddd",
                      padding: 8,
                    }}
                  >
                    LEI Hash
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      borderBottom: "1px solid #ddd",
                      padding: 8,
                    }}
                  >
                    Domain Hash
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      borderBottom: "1px solid #ddd",
                      padding: 8,
                    }}
                  >
                    Operator
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      borderBottom: "1px solid #ddd",
                      padding: 8,
                    }}
                  >
                    HPKE PubKey
                  </th>
                </tr>
              </thead>
              <tbody>
                {directoryRows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ padding: 8 }}>{r.id}</td>
                    <td style={{ padding: 8 }}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          borderRadius: 999,
                          background: r.active ? "#e6f9f0" : "#ffecec",
                          fontSize: 12,
                        }}
                      >
                        {r.active ? "active" : "paused"}
                      </span>
                    </td>
                    <td
                      style={{
                        padding: 8,
                        fontFamily: "monospace",
                        wordBreak: "break-all",
                        maxWidth: 160,
                      }}
                    >
                      {r.leiHash}
                    </td>
                    <td
                      style={{
                        padding: 8,
                        fontFamily: "monospace",
                        wordBreak: "break-all",
                        maxWidth: 160,
                      }}
                    >
                      {r.domainHash}
                    </td>
                    <td
                      style={{
                        padding: 8,
                        fontFamily: "monospace",
                        wordBreak: "break-all",
                        maxWidth: 220,
                      }}
                    >
                      {r.operator}
                    </td>
                    <td
                      style={{
                        padding: 8,
                        fontFamily: "monospace",
                        wordBreak: "break-all",
                        maxWidth: 220,
                      }}
                    >
                      {r.hpke ? r.hpke : "—"}
                    </td>
                  </tr>
                ))}
                {directoryRows.length === 0 && !dirStatus && (
                  <tr>
                    <td colSpan={6} style={{ padding: 12, color: "#777" }}>
                      No banks loaded yet…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {dirStatus && <p style={{ marginTop: 8 }}>{dirStatus}</p>}
            <div style={{ marginTop: 8 }}>
              <button onClick={loadDirectory}>Reload directory</button>
            </div>
          </div>
        </section>

        {/* Reset information at the bottom */}
        <p
          style={{
            marginTop: 24,
            fontSize: 12,
            color: "#999",
            textAlign: "center",
          }}
        >
          Note: this demo keeps incoming requests and hub logs only in your
          browser (local storage). If you reload the page or navigate away, the
          view may reset or need to rescan recent blocks.
        </p>

        {/* ✅ Premium sticky accordion: Why this matters */}
        <WhyThisMatters pendingCount={pendingCount} ackedCount={ackedCount} />

        </div>
      </div>
    </>
  );
}

/* ---------- Premium “Why this matters” (same component style as Bank A) ---------- */

function WhyThisMatters({ pendingCount, ackedCount }: { pendingCount: number; ackedCount: number }) {
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

  const inboxLabel =
    pendingCount > 0 ? `Inbox: ${pendingCount} pending` : ackedCount > 0 ? `ACKs sent: ${ackedCount}` : "";

  return (
    <div style={whyStickyWrap}>
      <div style={whyShell}>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} style={whyHeaderBtn}>
          <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <span style={whyBadge}>Why this matters</span>
            <span style={whyTitle}>Receiving bank controls: decrypt, review, and ACK before settlement</span>
          </span>

          <span style={whyRight}>
            <span style={whyHint}>{inboxLabel}</span>
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
              subtitle="You’re acting as the receiving bank: you verify the incoming request, then ACK it so settlement can proceed."
            >
              <ul style={whyList}>
                <li>
                  You monitor the Payment Hub for <strong>outbound payment messages</strong> addressed to Bank B.
                </li>
                <li>
                  You open the <strong>encrypted Travel Rule envelope</strong> and review the originator + beneficiary data.
                </li>
                <li>
                  If everything checks out, you send an on-chain <strong>ACK</strong> — a simple but powerful safety gate.
                </li>
              </ul>

              <div style={bannerNote}>
                <strong>Key idea:</strong> Bank B can “see and verify” compliance data without exposing it publicly —
                and without having to trust Bank A’s database.
              </div>
            </Section>

            <Section
              k="2"
              title="How you find and open the envelope (grandma-friendly)"
              subtitle="Think: you receive a sealed envelope with a tracking number. You can verify it arrived, then open it privately."
            >
              <div style={whyGrid2}>
                <div style={whyCard}>
                  <div style={whyCardTitle}>Finding the message</div>
                  <div style={whyText}>
                    The Payment Hub emits an <strong>OutboundPayment</strong> event with a <strong>txRef</strong> (reference) and a{" "}
                    <strong>payloadHash</strong>. Your UI scans recent blocks and filters messages where{" "}
                    <strong>toBankId = Bank B</strong>.
                  </div>
                  <div style={pillRow}>
                    <span style={pill}>Event logs</span>
                    <span style={pill}>txRef</span>
                    <span style={pill}>Routing by bankId</span>
                  </div>
                </div>

                <div style={whyCard}>
                  <div style={whyCardTitle}>Opening it safely</div>
                  <div style={whyText}>
                    The encrypted payload is created with <strong>HPKE</strong> to Bank B’s on-chain public key (read from Directory).{" "}
                    Bank B holds the matching private key. In this demo, decryption happens via{" "}
                    <code style={whyCode}>/api/hpke-open</code> so the browser never exposes the private key.
                  </div>
                  <div style={pillRow}>
                    <span style={pill}>HPKE</span>
                    <span style={pill}>Private key</span>
                    <span style={pill}>No plaintext PII on-chain</span>
                  </div>
                </div>
              </div>
            </Section>

            <Section
              k="3"
              title="What goes on-chain (and what doesn’t)"
              subtitle="The chain is the shared audit rail — but the sensitive content stays sealed."
            >
              <div style={whyGrid2}>
                <div style={whyCard}>
                  <div style={whyCardTitle}>On-chain</div>
                  <ul style={whyList}>
                    <li>
                      Bank A calls the Payment Hub:{" "}
                      <code style={whyCode}>submitPayment(toBankId, requireAck, payload, txRef)</code>
                    </li>
                    <li>
                      You send: <code style={whyCode}>acknowledge(txRef)</code> (as Bank B operator)
                    </li>
                    <li>
                      Both actions are timestamped and discoverable via events — useful for audit and dispute resolution.
                    </li>
                  </ul>
                </div>

                <div style={whyCard}>
                  <div style={whyCardTitle}>Not on-chain</div>
                  <ul style={whyList}>
                    <li>No plaintext names, addresses, DOB, or other Travel Rule PII</li>
                    <li>No internal bank case notes or screening results</li>
                    <li>
                      The envelope is bound to <strong>txRef</strong> (AAD) to prevent swapping messages between references
                    </li>
                  </ul>
                </div>
              </div>

              <div style={nextStep}>
                <div style={{ fontWeight: 950, marginBottom: 4 }}>Two-window tip</div>
                <div style={{ color: "#333", lineHeight: 1.5 }}>
                  For the best “interbank” feel: keep <strong>Bank A</strong> open in one window, then open{" "}
                  <strong>Bank B</strong> in a second window. Bank A submits; Bank B reviews + ACKs; then settlement proceeds.
                </div>
              </div>
            </Section>

            <Section
              k="4"
              title="Why banks (and regulators) should care"
              subtitle="This is a compact model of Travel Rule messaging & controlled settlement."
            >
              <div style={whyGrid2}>
                <div style={whyCard}>
                  <div style={whyCardTitle}>Regulatory lens</div>
                  <ul style={whyList}>
                    <li>
                      Travel Rule requires originator/beneficiary information to accompany certain crypto transfers (Swiss minimum fields).
                    </li>
                    <li>
                      Data minimization: prove a message was delivered (txRef + events) without publishing PII on a public chain.
                    </li>
                    <li>
                      A receiving bank can enforce an operational control: “review → ACK → release”.
                    </li>
                  </ul>
                </div>

                <div style={whyCard}>
                  <div style={whyCardTitle}>Technical & operational lens</div>
                  <ul style={whyList}>
                    <li>
                      <strong>Directory registry:</strong> bank keys and operator roles are discoverable on-chain (governance via MetaMask in this demo).
                    </li>
                    <li>
                      <strong>Separation of concerns:</strong> settlement (token transfer) can be decoupled from messaging and gated by ACK.
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

/* ---------- Component Styles (same as Bank A / eBanking) ---------- */

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
  background: "#fff",
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

const bankAccentWrap: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(46, 170, 110, 0.10) 0%, rgba(255,255,255,0) 220px)",
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
