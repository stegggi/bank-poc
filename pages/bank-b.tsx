// pages/bank-b.tsx
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { BrowserProvider, Interface } from "ethers";
import { encodePacked, keccak256 } from "viem";
import { publicClient } from "../shared/lib/aa";
import NavBar from "../shared/components/NavBar";
import { useBreakpoint } from "../shared/hooks/useBreakpoint";

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
  const { isMobile, isMobileOrTablet } = useBreakpoint();
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
        <div style={pageWrap}>
          <div style={loadingWrap}>
            <div style={loadingDot} />
          </div>
        </div>
      </>
    );
  }

  // Responsive helpers (derived from hook, safe to use below)
  const innerPadding = isMobile ? "20px 16px" : "32px 24px";
  const cardPad = isMobile ? "16px" : "20px 24px";

  return (
    <>
      <style jsx global>{`
        * { box-sizing: border-box; }
        body { background: #07080f; color: #f0f0f0; }
        .bb-input {
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
        .bb-input:focus { border-color: #10b981; }
        .bb-input::placeholder { color: rgba(255,255,255,0.25); }
        .bb-select {
          width: 100%;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 8px;
          padding: 8px 12px;
          color: #f0f0f0;
          font-family: inherit;
          font-size: 13px;
          outline: none;
        }
        .bb-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 7px 14px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.07);
          color: #f0f0f0;
          font-family: inherit;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: background 150ms;
          white-space: nowrap;
        }
        .bb-btn:hover { background: rgba(255,255,255,0.12); }
        .bb-btn-ack {
          background: rgba(16,185,129,0.15);
          border-color: rgba(16,185,129,0.4);
          color: #10b981;
        }
        .bb-btn-ack:hover { background: rgba(16,185,129,0.25); }
        .bb-btn-reject {
          background: rgba(239,68,68,0.1);
          border-color: rgba(239,68,68,0.3);
          color: #ef4444;
        }
        .bb-btn-reject:hover { background: rgba(239,68,68,0.18); }
        .bb-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        .bb-table th {
          text-align: left;
          padding: 8px 10px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: rgba(255,255,255,0.35);
          border-bottom: 1px solid rgba(255,255,255,0.07);
        }
        .bb-table td {
          padding: 10px;
          font-size: 12px;
          color: rgba(255,255,255,0.7);
          border-bottom: 1px solid rgba(255,255,255,0.05);
          vertical-align: top;
          word-break: break-word;
          overflow-wrap: break-word;
        }
        .bb-table tr:last-child td { border-bottom: none; }
        .bb-checkbox { accent-color: #10b981; }
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

      <NavBar active="bankB" />
      <div style={pageWrap}>
        <div style={{ ...inner, padding: innerPadding }}>

          {/* Page header */}
          <div style={{ ...pageHeader, flexWrap: "wrap" as const }}>
            <div style={ucChip}>UC2</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ ...pageTitle, fontSize: isMobile ? 16 : 20 }}>Travel-Rule Compliant Receiving</div>
              <div style={pageSubtitle}>Bank B — Receiver perspective · Arbitrum Sepolia</div>
            </div>
          </div>

          {/* Receiver wallet card */}
          <div style={{ ...card, padding: cardPad }}>
            <div style={cardLabel}>Receiver Wallet</div>
            {!isAddr(DEMO_RECIPIENT) ? (
              <div style={dimText}>
                Missing <code style={inlineCode}>NEXT_PUBLIC_DEMO_RECIPIENT</code> env var.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={metaRow}>
                  <span style={metaLabel}>Address</span>
                  <span style={monoVal}>{DEMO_RECIPIENT}</span>
                  <a href={arbAddr(DEMO_RECIPIENT)} target="_blank" rel="noreferrer" style={extLink}>↗</a>
                </div>
                <div style={metaRow}>
                  <span style={metaLabel}>xBank balance</span>
                  <span style={{ ...monoVal, color: UC_ACCENT }}>{human(recipientXbBal)} XB</span>
                </div>
                <div style={{ ...dimText, fontSize: 11 }}>
                  Bank B ID: {BANK_B_ID} · Network: Arbitrum Sepolia · Fixed recipient wallet
                  {operator && <> · Operator: <span style={monoVal}>{short(operator)}</span></>}
                  {walletAddr && <> · Your wallet: <span style={monoVal}>{short(walletAddr)}</span></>}
                </div>
              </div>
            )}
          </div>

          {/* Section 1: Incoming requests */}
          <div style={{ ...card, padding: cardPad }}>
            <div style={cardLabel}>Incoming Requests</div>

            {showReturnToBankABanner && (
              <div style={successBanner}>
                ACK sent. Switch back to <strong style={{ color: "#10b981" }}>Bank A</strong> and send the xBank token transfer to complete the demo.
                <button className="bb-btn" style={{ marginLeft: 12 }} onClick={handleOpenBankATab}>Open Bank A →</button>
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <button className="bb-btn" onClick={scanRequests}>Refresh requests</button>
              {status && <span style={statusText}>{status}</span>}
            </div>

            <div style={tableWrap}>
              <table className="bb-table">
                <thead>
                  <tr>
                    <th style={{ width: "20%" }}>txRef / tx</th>
                    <th style={{ width: "14%" }}>Purpose</th>
                    <th style={{ width: "14%" }}>Created</th>
                    <th style={{ width: "34%" }}>Payload (decoded)</th>
                    <th style={{ width: "18%" }}>Actions / status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleReqs.map((r, idx) => {
                    const assetInfo = formatXBankAmount(r.parsed as any);
                    return (
                      <tr key={idx}>
                        <td>
                          <div style={monoSmall}>{r.txRef}</div>
                          <a href={arbTx(r.txHash)} target="_blank" rel="noreferrer" style={extLink}>tx ↗</a>
                        </td>
                        <td>{r.purpose}</td>
                        <td style={{ color: "rgba(255,255,255,0.45)", fontSize: 11 }}>{formatTs(r.createdAt)}</td>
                        <td>
                          {r.parsed ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                <span style={tagGreen}>Swiss minimum</span>
                                <span style={tagBlue}>HPKE decrypted</span>
                              </div>
                              <div style={{ ...payloadGrid, gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr" }}>
                                <div>
                                  <div style={payloadSectionTitle}>Originator</div>
                                  <div style={payloadLine}>Name: {(r.parsed as any)?.originator?.name ?? "—"}</div>
                                  <div style={payloadLine}>Account: {(r.parsed as any)?.originator?.account ?? "—"}</div>
                                  <div style={payloadLine}>Address: {(r.parsed as any)?.originator?.address ?? "—"}</div>
                                  <div style={payloadLine}>DOB: {(r.parsed as any)?.originator?.dateOfBirth ?? "—"}</div>
                                  <div style={payloadLine}>Place: {(r.parsed as any)?.originator?.placeOfBirth ?? "—"}</div>
                                  <div style={payloadLine}>ID: {(r.parsed as any)?.originator?.idNumber ?? "—"}</div>
                                </div>
                                <div>
                                  <div style={payloadSectionTitle}>Beneficiary</div>
                                  <div style={payloadLine}>Name: {(r.parsed as any)?.beneficiary?.name ?? "—"}</div>
                                  <div style={payloadLine}>Account: {(r.parsed as any)?.beneficiary?.account ?? "—"}</div>
                                </div>
                              </div>
                              <div>
                                <div style={payloadLine}>
                                  Amount: {assetInfo ? (assetInfo.amountHuman !== null ? assetInfo.amountHuman : assetInfo.amountRaw || "—") : "—"} XB
                                </div>
                                <div style={payloadLine}>Purpose: {(r.parsed as any)?.purpose ?? r.purpose ?? "—"}</div>
                              </div>
                            </div>
                          ) : (
                            <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 12 }}>No payload decoded</span>
                          )}
                        </td>
                        <td>
                          {!r.requireAck ? (
                            <span style={tagNeutral}>No ACK required</span>
                          ) : r.status === "pending" ? (
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                              <button className="bb-btn bb-btn-ack" onClick={() => ack(r)}>ACK</button>
                              <button className="bb-btn bb-btn-reject" onClick={() => reject(r)}>Reject</button>
                            </div>
                          ) : r.status === "acked" ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                              <span style={tagGreen}>ACKed</span>
                              {r.ackTxHash && (
                                <a href={arbTx(r.ackTxHash)} target="_blank" rel="noreferrer" style={extLink}>ack tx ↗</a>
                              )}
                            </div>
                          ) : (
                            <span style={tagRed}>Rejected</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ color: "rgba(255,255,255,0.3)", textAlign: "center", padding: 20 }}>
                        No requests yet…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {rows.length > 0 && (
              <div style={showMoreRow}>
                <span style={dimText}>Showing {Math.min(reqLimit, rows.length)} of {rows.length}</span>
                {rows.length > reqLimit && (
                  <button className="bb-btn" onClick={() => setReqLimit(v => v + 5)}>Show more</button>
                )}
                {reqLimit > 3 && (
                  <button className="bb-btn" onClick={() => setReqLimit(3)}>Show less</button>
                )}
              </div>
            )}
          </div>

          {/* Section 2: Hub activity log */}
          <div style={{ ...card, padding: cardPad }}>
            <div style={cardLabel}>Payment Hub Activity</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <button className="bb-btn" onClick={scanLogs}>Refresh logs</button>
              {logStatus && <span style={statusText}>{logStatus}</span>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {visibleLogs.map((l, i) => {
                const descLower = (l.desc || "").toLowerCase();
                const isAck = descLower.startsWith("paymentacknowledged");
                const isSubmit = descLower.startsWith("paymentsubmitted");
                const badgeLabel = isAck ? "ACK" : isSubmit ? "Payment" : "Hub tx";
                const badgeStyle = isAck ? tagGreen : isSubmit ? tagBlue : tagNeutral;
                return (
                  <div key={i} style={logCard}>
                    <div style={logCardTop}>
                      <span style={{ fontFamily: "monospace", fontSize: 11, color: "rgba(255,255,255,0.38)" }}>
                        {formatTs(l.timestamp) || "—"}
                      </span>
                      <span style={badgeStyle}>{badgeLabel}</span>
                    </div>
                    <a href={arbTx(l.txHash)} target="_blank" rel="noreferrer" style={extLink}>
                      {short(l.txHash)}
                    </a>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>{l.desc}</div>
                    {l.details && (
                      <pre style={preStyle}>{JSON.stringify(l.details, null, 2)}</pre>
                    )}
                  </div>
                );
              })}
              {logEvents.length === 0 && !logStatus && (
                <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 13 }}>No hub transactions yet…</div>
              )}
            </div>
            {logEvents.length > 0 && (
              <div style={showMoreRow}>
                <span style={dimText}>Showing {Math.min(logLimit, logEvents.length)} of {logEvents.length}</span>
                {logEvents.length > logLimit && (
                  <button className="bb-btn" onClick={() => setLogLimit(v => v + 5)}>Show more</button>
                )}
                {logLimit > 3 && (
                  <button className="bb-btn" onClick={() => setLogLimit(3)}>Show less</button>
                )}
              </div>
            )}
          </div>

          {/* Section 3: Directory Registry */}
          <div style={{ ...card, padding: cardPad }}>
            <div style={cardLabel}>Directory Registry</div>
            <div style={formNote}>
              This reads the on-chain DirectoryRegistry. For HPKE to work, the receiving bank must have a non-empty HPKE public key stored on-chain.
            </div>

            {/* Controls */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label style={formLabel}>
                Bank IDs (comma-separated)
                <input
                  className="bb-input"
                  value={dirIdsCsv}
                  onChange={e => setDirIdsCsv(e.target.value)}
                  placeholder="1,2,3"
                  style={{ width: 200 }}
                />
              </label>
              <button className="bb-btn" onClick={loadDirectory}>Refresh Directory</button>
            </div>

            {/* Directory table */}
            <div style={tableWrap}>
              <table className="bb-table">
                <thead>
                  <tr>
                    <th>Bank ID</th>
                    <th>Status</th>
                    <th>LEI Hash</th>
                    <th>Domain Hash</th>
                    <th>Operator</th>
                    <th>HPKE PubKey</th>
                  </tr>
                </thead>
                <tbody>
                  {directoryRows.map(r => (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 600 }}>{r.id}</td>
                      <td>
                        <span style={r.active ? tagGreen : tagRed}>
                          {r.active ? "active" : "paused"}
                        </span>
                      </td>
                      <td style={{ ...monoSmall, maxWidth: 160 }}>{r.leiHash}</td>
                      <td style={{ ...monoSmall, maxWidth: 160 }}>{r.domainHash}</td>
                      <td style={{ ...monoSmall, maxWidth: 180 }}>{r.operator}</td>
                      <td style={{ ...monoSmall, maxWidth: 180 }}>{r.hpke ? r.hpke : "—"}</td>
                    </tr>
                  ))}
                  {directoryRows.length === 0 && !dirStatus && (
                    <tr>
                      <td colSpan={6} style={{ color: "rgba(255,255,255,0.3)", textAlign: "center", padding: 16 }}>
                        No banks loaded yet…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {dirStatus && <div style={statusText}>{dirStatus}</div>}

            {/* Admin upsert */}
            <div style={adminPanel}>
              <div style={{ ...adminPanelHeader, flexDirection: isMobileOrTablet ? "column" as const : "row" as const }}>
                <div>
                  <div style={{ fontWeight: 700, color: "#fff", fontSize: 13, marginBottom: 3 }}>
                    Directory Admin — upsertBank
                  </div>
                  <div style={formNote}>
                    Works only if your connected wallet is the Directory owner. Use this to set Bank B&apos;s HPKE pubkey.
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column" as const, gap: 6, alignItems: isMobileOrTablet ? "flex-start" as const : "flex-end" as const }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const, justifyContent: isMobileOrTablet ? "flex-start" as const : "flex-end" as const }}>
                    {!metaMaskAddr ? (
                      <button className="bb-btn" onClick={connectMetaMask}>Connect MetaMask</button>
                    ) : (
                      <button className="bb-btn" onClick={disconnectMetaMask}>Disconnect MetaMask</button>
                    )}
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "rgba(255,255,255,0.6)", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        className="bb-checkbox"
                        checked={useMetaMaskForDir}
                        onChange={e => setUseMetaMaskForDir(e.target.checked)}
                        disabled={!metaMaskAddr}
                      />
                      Use MetaMask for Directory
                    </label>
                    <button className="bb-btn" onClick={upsertBank}>Upsert bank</button>
                  </div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", textAlign: "right" }}>
                    <div>Owner: <span style={monoSmall}>{dirOwnerAddr || "—"}</span></div>
                    <div>
                      MetaMask: <span style={monoSmall}>{metaMaskAddr || "not connected"}</span>
                      {metaMaskAddr && dirOwnerAddr && metaMaskAddr.toLowerCase() === dirOwnerAddr.toLowerCase() && (
                        <span style={{ marginLeft: 6, color: UC_ACCENT }}>✓ owner</span>
                      )}
                    </div>
                    {metaMaskStatus && <div style={{ color: "#ef4444" }}>{metaMaskStatus}</div>}
                  </div>
                </div>
              </div>

              <div style={upsertGrid}>
                <label style={formLabel}>
                  Bank ID
                  <input type="number" className="bb-input" value={upsertBankId} onChange={e => setUpsertBankId(Number(e.target.value))} />
                </label>
                <label style={formLabel}>
                  Active
                  <select className="bb-select" value={upsertActive ? "true" : "false"} onChange={e => setUpsertActive(e.target.value === "true")}>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                </label>
                <label style={formLabel}>
                  LEI (plain or 0x…bytes32)
                  <input className="bb-input" value={upsertLei} onChange={e => setUpsertLei(e.target.value)} placeholder="Example LEI" />
                </label>
                <label style={formLabel}>
                  Domain (plain or 0x…bytes32)
                  <input className="bb-input" value={upsertDomain} onChange={e => setUpsertDomain(e.target.value)} placeholder="bank.example" />
                </label>
                <label style={formLabel}>
                  Operator address
                  <input className="bb-input" value={upsertOperatorAddr} onChange={e => setUpsertOperatorAddr(e.target.value)} placeholder={dirWalletAddr || metaMaskAddr || walletAddr || "0x…"} />
                </label>
                <label style={formLabel}>
                  HPKE public key (hex)
                  <input className="bb-input" value={upsertHpkePubKeyHex} onChange={e => setUpsertHpkePubKeyHex(e.target.value)} placeholder="0x… (32 bytes for X25519)" style={{ fontFamily: "monospace" }} />
                </label>
              </div>
              {upsertStatus && <div style={statusText}>{upsertStatus}</div>}
            </div>

            <div style={{ ...dimText, fontSize: 11 }}>
              Directory address: <span style={monoSmall}>{DIR || "(missing)"}</span> · Data persists only in your browser (local storage).
            </div>
          </div>

          <WhyThisMatters pendingCount={pendingCount} ackedCount={ackedCount} />
        </div>
      </div>
    </>
  );
}

/* ── WhyThisMatters ──────────────────────────────────────────────────────────── */

function WhyThisMatters({ pendingCount, ackedCount }: { pendingCount: number; ackedCount: number }) {
  const [tab, setTab] = useState(0);

  const inboxLabel = pendingCount > 0
    ? `Inbox: ${pendingCount} pending`
    : ackedCount > 0 ? `ACKs sent: ${ackedCount}` : "";

  const tabs = [
    {
      n: "01", label: "What you're doing",
      title: "Receiving bank controls: verify, decrypt, ACK",
      subtitle: "You're acting as the receiving bank — you verify the incoming request, then ACK it so settlement can proceed.",
      body: (
        <div style={wtmBody}>
          {[
            "You monitor the Payment Hub for outbound payment messages addressed to Bank B.",
            "You open the encrypted Travel Rule envelope and review the originator + beneficiary data.",
            "If everything checks out, you send an on-chain ACK — a simple but powerful safety gate.",
          ].map((t, i) => (
            <div key={i} style={wtmListItem}>
              <span style={wtmArrow}>▸</span>
              <span style={wtmListText}>{t}</span>
            </div>
          ))}
          <div style={wtmCallout}>
            <strong style={{ color: UC_ACCENT }}>Key idea:</strong> Bank B can verify compliance data without exposing it publicly — and without trusting Bank A&apos;s database.
          </div>
        </div>
      ),
    },
    {
      n: "02", label: "Finding & opening",
      title: "Sealed envelope with a tracking number",
      subtitle: "You can verify it arrived, then open it privately — nobody else can read it.",
      body: (
        <div style={wtmBody}>
          <div style={wtmGrid2}>
            <div style={wtmCard}>
              <div style={wtmCardTitle}>Finding the message</div>
              <div style={wtmCardText}>The Payment Hub emits an OutboundPayment event with a txRef and payloadHash. Your UI scans recent blocks and filters messages where toBankId = Bank B.</div>
              <div style={pillRow}>
                {["Event logs", "txRef", "Routing by bankId"].map(p => <span key={p} style={pill}>{p}</span>)}
              </div>
            </div>
            <div style={wtmCard}>
              <div style={wtmCardTitle}>Opening it safely</div>
              <div style={wtmCardText}>The payload is HPKE-encrypted to Bank B&apos;s on-chain public key (from Directory). Decryption happens via /api/hpke-open so the browser never exposes the private key.</div>
              <div style={pillRow}>
                {["HPKE", "Private key", "No plaintext PII on-chain"].map(p => <span key={p} style={pill}>{p}</span>)}
              </div>
            </div>
          </div>
        </div>
      ),
    },
    {
      n: "03", label: "On-Chain",
      title: "The chain is the shared audit rail",
      subtitle: "Sensitive content stays sealed — only metadata and ACKs go on-chain.",
      body: (
        <div style={wtmBody}>
          <div style={wtmGrid2}>
            <div style={wtmCard}>
              <div style={wtmCardTitle}>On-chain</div>
              {[
                "Bank A calls submitPayment(toBankId, requireAck, payload, txRef)",
                "You send acknowledge(txRef) as Bank B operator",
                "Both actions are timestamped and discoverable — useful for audit and disputes",
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
                "No plaintext names, addresses, DOB, or other Travel Rule PII",
                "No internal bank case notes or screening results",
                "Envelope is bound to txRef (AAD) to prevent swapping messages between references",
              ].map((t, i) => (
                <div key={i} style={wtmListItem}>
                  <span style={wtmArrow}>▸</span>
                  <span style={wtmListText}>{t}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={wtmCallout}>
            <strong style={{ color: UC_ACCENT }}>Two-window tip:</strong> Keep Bank A open in one window, then open Bank B in a second. Bank A submits; Bank B reviews + ACKs; then settlement proceeds.
          </div>
        </div>
      ),
    },
    {
      n: "04", label: "For Banks",
      title: "Why banks and regulators should care",
      subtitle: "A compact model for Travel Rule messaging and controlled settlement.",
      body: (
        <div style={wtmBody}>
          <div style={wtmGrid2}>
            <div style={wtmCard}>
              <div style={wtmCardTitle}>Regulatory lens</div>
              {[
                "Travel Rule requires originator/beneficiary info to accompany crypto transfers (Swiss minimum fields).",
                "Data minimization: prove delivery via txRef + events without publishing PII on a public chain.",
                "Receiving bank enforces the control: review → ACK → release settlement.",
              ].map((t, i) => (
                <div key={i} style={wtmListItem}>
                  <span style={wtmArrow}>▸</span>
                  <span style={wtmListText}>{t}</span>
                </div>
              ))}
            </div>
            <div style={wtmCard}>
              <div style={wtmCardTitle}>Technical &amp; operational lens</div>
              {[
                "Directory registry: bank keys and operator roles are discoverable on-chain.",
                "Separation of concerns: settlement (token transfer) is decoupled from messaging, gated by ACK.",
                "Interoperability: two banks coordinate over a shared rail without sharing databases.",
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
        Receiving bank controls: decrypt, review, and ACK before settlement.
        {inboxLabel && <span style={wtmBadge}>{inboxLabel}</span>}
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
  maxWidth: 1040,
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
  fontSize: 11,
  color: "rgba(255,255,255,0.70)",
  wordBreak: "break-all",
};

const dimText: CSSProperties = {
  color: "rgba(255,255,255,0.60)",
  fontSize: 13,
  lineHeight: 1.5,
};

const extLink: CSSProperties = {
  color: UC_ACCENT,
  fontSize: 12,
  textDecoration: "none",
};

const inlineCode: CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  fontSize: 12,
  background: "rgba(255,255,255,0.07)",
  padding: "1px 6px",
  borderRadius: 4,
};

const formNote: CSSProperties = {
  fontSize: 12,
  color: "rgba(255,255,255,0.58)",
  lineHeight: 1.55,
};

const formLabel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  fontSize: 12,
  color: "rgba(255,255,255,0.65)",
};

const tableWrap: CSSProperties = {
  overflowX: "auto",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.06)",
};

const showMoreRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
};

const statusText: CSSProperties = {
  fontSize: 12,
  color: "rgba(255,255,255,0.68)",
  lineHeight: 1.5,
  wordBreak: "break-all",
};

const successBanner: CSSProperties = {
  background: "rgba(16,185,129,0.1)",
  border: "1px solid rgba(16,185,129,0.25)",
  borderRadius: 10,
  padding: "12px 16px",
  fontSize: 13,
  color: "rgba(255,255,255,0.8)",
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  lineHeight: 1.5,
};

const tagGreen: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: 999,
  background: "rgba(16,185,129,0.15)",
  border: "1px solid rgba(16,185,129,0.3)",
  color: "#10b981",
  fontSize: 11,
  fontWeight: 600,
};

const tagBlue: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: 999,
  background: "rgba(59,130,246,0.12)",
  border: "1px solid rgba(59,130,246,0.25)",
  color: "#60a5fa",
  fontSize: 11,
  fontWeight: 600,
};

const tagRed: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: 999,
  background: "rgba(239,68,68,0.12)",
  border: "1px solid rgba(239,68,68,0.25)",
  color: "#f87171",
  fontSize: 11,
  fontWeight: 600,
};

const tagNeutral: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: 999,
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.1)",
  color: "rgba(255,255,255,0.45)",
  fontSize: 11,
  fontWeight: 600,
};

const payloadGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 8,
};

const payloadSectionTitle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "rgba(255,255,255,0.35)",
  marginBottom: 3,
};

const payloadLine: CSSProperties = {
  fontSize: 11,
  color: "rgba(255,255,255,0.72)",
  lineHeight: 1.6,
  wordBreak: "break-all",
};

const logCard: CSSProperties = {
  background: "rgba(255,255,255,0.025)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 10,
  padding: "10px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 5,
};

const logCardTop: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const preStyle: CSSProperties = {
  margin: 0,
  fontSize: 10,
  whiteSpace: "pre-wrap",
  color: "rgba(255,255,255,0.4)",
  fontFamily: "ui-monospace, monospace",
};

const adminPanel: CSSProperties = {
  background: "rgba(255,255,255,0.025)",
  border: "1px dashed rgba(255,255,255,0.1)",
  borderRadius: 12,
  padding: "16px 18px",
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const adminPanelHeader: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
};

const upsertGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 10,
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
