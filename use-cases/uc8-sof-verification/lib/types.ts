// Shared types for UC8 Source of Funds verification

export type ChainFamily =
  | "evm"
  | "bitcoin"
  | "solana"
  | "tron"
  | "cosmos"
  | "cardano"
  | "xrp"
  | "unknown";

export type ChainDetection = {
  chainFamily: ChainFamily;
  subtype?: string;
  address: string;
};

export type ChainActivity = {
  chain: string;
  chainId?: number;
  nativeBalance: string;
  nativeBalanceUsd: number;
  txCount: number;
  hasActivity: boolean;
};

export type WalletScanResult = {
  address: string;
  chainFamily: ChainFamily;
  chains: ChainActivity[];
  totalValueUsd: number;
  scannedAt: string;
};

export type EntityType =
  | "exchange"
  | "dex"
  | "bridge"
  | "mixer"
  | "mining_pool"
  | "staking"
  | "contract"
  | "unknown";

export type ExchangeTier = "A" | "B" | "C";

export type AddressLabel = {
  address: string;
  name: string | null;
  entityType: EntityType;
  exchangeTier?: ExchangeTier;
  sanctioned: boolean;
  source: "etherscan" | "eth-labels" | "ofac" | "manual" | "heuristic";
};

export type Challenge = {
  challengeId: string;
  caseReference: string;
  nonce: string;
  timestamp: string;
  message: string;
  address: string;
  chainFamily: ChainFamily;
  status: "pending" | "verified" | "failed";
  signature?: string;
  verifiedAt?: string;
  failReason?: string;
};

export type SanctionsHit = {
  address: string;
  listName: string;
  reason: string;
};

export type FundFlowNode = {
  id: string;
  address: string;
  label: AddressLabel | null;
  valueUsd: number;
  hopDepth: number;
  kind: "wallet" | "source" | "intermediate";
};

export type FundFlowEdge = {
  from: string;
  to: string;
  valueUsd: number;
  token?: string;
};

export type TracedSource = {
  address: string;
  valueUsd: number;
  percentage: number;
  label: AddressLabel | null;
  hopDepth: number;
  path: string[];
};

export type TraceResult = {
  walletAddress: string;
  chain: string;
  totalIncomingValueUsd: number;
  attributedValueUsd: number;
  attributedPercentage: number;
  sources: TracedSource[];
  hopsUsed: number;
  maxHopsConfigured: number;
  sanctionsHits: SanctionsHit[];
  nodes: FundFlowNode[];
  edges: FundFlowEdge[];
  tracedAt: string;
};

export type RiskTier = "GREEN" | "AMBER" | "RED";

export type RiskClassification = {
  tier: RiskTier;
  reasons: string[];
  thresholds: { green: number; amber: number };
  requiresTTP: boolean;
  requiresDocs: boolean;
};

export type FlaggedAddress = {
  address: string;
  category: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  note: string;
};

export type TTPReport = {
  provider: string;
  address: string;
  chain: string;
  riskScore: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  exposureBreakdown: Record<string, number>;
  flaggedAddresses: FlaggedAddress[];
  summary: string;
  reportDate: string;
  reportId: string;
};

export type WalletRecord = {
  address: string;
  chainFamily: ChainFamily;
  primaryChain?: string;
  scan?: WalletScanResult;
  challenge?: Challenge;
  trace?: TraceResult;
  classification?: RiskClassification;
  ttp?: TTPReport;
};

export type CaseSettings = {
  maxHopDepth: number;
  greenThreshold: number;
  amberThreshold: number;
  ttpProvider: "mock" | "chainalysis" | "elliptic";
};

export type CaseFile = {
  caseReference: string;
  clientName: string;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "ownership" | "scanning" | "classified" | "escalated" | "completed";
  wallets: WalletRecord[];
  settings: CaseSettings;
  overallRisk?: RiskTier;
  reportGenerated?: boolean;
  reportGeneratedAt?: string;
  signOffName?: string;
  signOffDate?: string;
  determination?: string;
};

export type CaseSummary = {
  caseReference: string;
  clientName: string;
  createdAt: string;
  updatedAt: string;
  status: CaseFile["status"];
  walletCount: number;
  overallRisk?: RiskTier;
};
