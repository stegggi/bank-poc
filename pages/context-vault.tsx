import React, { useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { usePrivy, useSendTransaction, useWallets } from "@privy-io/react-auth";
import NavBar from "../shared/components/NavBar";
import { useBreakpoint } from "../shared/hooks/useBreakpoint";
import CONTEXT_PASSPORT_ABI from "../use-cases/uc4-context-passport/lib/ContextPassportABI";
import {
  UserModulePackageV1,
  decryptAesGcm,
  downloadJson,
  b64ToBytes,
  encryptAesGcm,
  sha256Hex,
  toBankStoredBundle,
  utf8ToBytes,
  wrapDekRsaOaepB64,
} from "../use-cases/uc4-context-passport/lib/contextCrypto";

const STORAGE_PREFIX = "xbank_uc4_ctx_";

/**
 * IMPORTANT (Next.js envs on the client):
 * - Next.js ONLY inlines env vars in the browser when you reference them directly like:
 *     process.env.NEXT_PUBLIC_FOO
 * - Dynamic access like (process.env as any)[name] will be undefined in the browser.
 */
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || "421614");
const CONTRACT = process.env.NEXT_PUBLIC_CONTEXT_PASSPORT_ADDRESS || "";
const EXPLORER_TX = process.env.NEXT_PUBLIC_EXPLORER_TX || "https://sepolia.arbiscan.io/tx/";

const BANK_A_ADDR = process.env.NEXT_PUBLIC_BANK_A_ADDRESS || "";
const BANK_B_ADDR = process.env.NEXT_PUBLIC_BANK_B_ADDRESS || "";
const BANK_A_PUB_PEM = (process.env.NEXT_PUBLIC_BANK_A_RSA_PUBLIC_KEY_PEM || "").replace(/\\n/g, "\n");
const BANK_B_PUB_PEM = (process.env.NEXT_PUBLIC_BANK_B_RSA_PUBLIC_KEY_PEM || "").replace(/\\n/g, "\n");

type BankId = "bank-a" | "bank-b";
function bankLabel(bank: BankId) {
  return bank === "bank-a" ? "Bank A" : "Bank B";
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function loadUserPkg(moduleId: string): UserModulePackageV1 | null {
  const raw = localStorage.getItem(STORAGE_PREFIX + moduleId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserModulePackageV1;
  } catch {
    return null;
  }
}
function saveUserPkg(pkg: UserModulePackageV1) {
  localStorage.setItem(STORAGE_PREFIX + pkg.moduleId, JSON.stringify(pkg));
}

function getStoredBankBlobRefs(moduleId: string, bank: BankId, owner: string) {
  const pkg = loadUserPkg(moduleId);
  const refs = pkg?.bankBlobRefs?.[bank];
  if (!refs) return null;
  if (refs.owner && refs.owner.toLowerCase() !== owner.toLowerCase()) return null;
  if (!refs.bundleUrl && (!refs.contextUrl || !refs.dekUrl)) return null;
  return refs;
}

function saveBankBlobRefs(
  moduleId: string,
  bank: BankId,
  owner: string,
  refs: { bundleUrl?: string; contextUrl?: string; dekUrl?: string }
) {
  const pkg = loadUserPkg(moduleId);
  if (!pkg) return;
  const existing = pkg.bankBlobRefs?.[bank] || {};
  pkg.bankBlobRefs = {
    ...(pkg.bankBlobRefs || {}),
    [bank]: {
      ...existing,
      owner: owner.toLowerCase(),
      bundleUrl: refs.bundleUrl ?? existing.bundleUrl,
      contextUrl: refs.contextUrl ?? existing.contextUrl,
      dekUrl: refs.dekUrl ?? existing.dekUrl,
      updatedAtIso: new Date().toISOString(),
    },
  };
  saveUserPkg(pkg);
}

function expiryFromDays(daysStr: string): number {
  const d = Number(daysStr);
  if (!Number.isFinite(d) || d < 0) throw new Error("Expiry days must be 0 or a positive number.");
  return d === 0 ? 0 : nowSec() + Math.floor(d * 24 * 60 * 60);
}

function isBytes32(v: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(v || "");
}

function fmtShort(v: string, keep = 10) {
  if (!v) return "—";
  if (v.length <= keep * 2) return v;
  return v.slice(0, keep) + "…" + v.slice(-6);
}
function chainIdToHex(chainId: number) {
  return "0x" + chainId.toString(16);
}

/* ---------- UC4 module templates (banking) ---------- */

type ModuleKey = "suitability" | "sustainability" | "service-scope";
type ModuleTypeString = "suitability_profile" | "sustainability_preferences" | "client_service_scope";

const MODULE_DEFS: Array<{ key: ModuleKey; label: string; type: ModuleTypeString; defaultPolicy: string }> = [
  {
    key: "suitability",
    label: "Suitability Profile",
    type: "suitability_profile",
    defaultPolicy: "Personalization only. Use for suitability checks. No resale. Default expiry 30 days. Revoke anytime.",
  },
  {
    key: "sustainability",
    label: "Sustainability Preferences",
    type: "sustainability_preferences",
    defaultPolicy: "Personalization only. Use for ESG preference matching. No resale. Default expiry 30 days. Revoke anytime.",
  },
  {
    key: "service-scope",
    label: "Client Service Scope",
    type: "client_service_scope",
    defaultPolicy:
      "Personalization only. Use to determine service scope & permitted actions. No resale. Default expiry 30 days. Revoke anytime.",
  },
];

function moduleKeyLabel(key: ModuleKey) {
  return MODULE_DEFS.find((d) => d.key === key)?.label ?? key;
}
function moduleKeyType(key: ModuleKey): ModuleTypeString {
  return (MODULE_DEFS.find((d) => d.key === key)?.type ?? "suitability_profile") as ModuleTypeString;
}
function moduleKeyFromType(t: string): ModuleKey | null {
  const hit = MODULE_DEFS.find((d) => d.type === t);
  return hit?.key ?? null;
}

function deriveModuleId(owner: string, key: ModuleKey): string {
  if (!ethers.isAddress(owner)) return "";
  // deterministic => max 3 modules per owner (one per key)
  return ethers.keccak256(utf8ToBytes(`xbank_uc4:${owner.toLowerCase()}:${key}`));
}

/* ---------- Draft types ---------- */

type SuitabilityDraft = {
  riskTolerance: "conservative" | "balanced" | "growth" | "aggressive";
  lossCapacity: "low" | "medium" | "high";
  investmentHorizonYears: number;
  liquidityNeed: "low" | "medium" | "high";
  objectives: { long_term_growth: boolean; income: boolean; capital_preservation: boolean };
  knowledgeExperience: {
    equities: "none" | "basic" | "good";
    bonds: "none" | "basic" | "good";
    fundsETFs: "none" | "basic" | "good";
    derivatives: "none" | "basic" | "good";
    crypto: "none" | "basic" | "good";
  };
  constraints: { leverageAllowed: boolean; derivativesAllowed: boolean };
  lastReviewed: string; // auto
};

type SustainabilityDraft = {
  hasSustainabilityPreferences: boolean;
  minTaxonomyAlignedPercent: number;
  minSustainableInvestmentsPercent: number;
  considerPAIs: boolean;
  exclusions: {
    controversial_weapons: boolean;
    thermal_coal: boolean;
    tobacco: boolean;
  };
  themes: {
    climate_transition: boolean;
    water: boolean;
    social: boolean;
  };
  stewardshipStyle: "engagement_preferred" | "exclusion_preferred" | "neutral";
  lastReviewed: string; // auto
};

type ServiceScopeDraft = {
  clientSegment: "retail" | "professional" | "institutional";
  serviceType: "execution_only" | "investment_advice" | "portfolio_management";
  advisoryScope: "single_transaction" | "portfolio_based";
  productPermissions: {
    crypto: "not_allowed" | "allowed_with_warning" | "allowed";
    derivatives: "not_allowed" | "allowed_with_warning" | "allowed";
    structuredProducts: "not_allowed" | "allowed_with_warning" | "allowed";
  };
  communicationPreferences: {
    language: string;
    tone: "direct" | "neutral" | "friendly";
    detailLevel: "step_by_step" | "summary";
    channel: "in_app_chat" | "email" | "phone";
  };
  aiConsent: {
    allowPersonalization: boolean;
    allowCrossBankPortability: boolean;
  };
  lastReviewed: string; // auto
};

function defaultSuitabilityDraft(): SuitabilityDraft {
  return {
    riskTolerance: "balanced",
    lossCapacity: "medium",
    investmentHorizonYears: 7,
    liquidityNeed: "low",
    objectives: { long_term_growth: true, income: false, capital_preservation: false },
    knowledgeExperience: { equities: "good", bonds: "good", fundsETFs: "good", derivatives: "none", crypto: "basic" },
    constraints: { leverageAllowed: false, derivativesAllowed: false },
    lastReviewed: "",
  };
}
function defaultSustainabilityDraft(): SustainabilityDraft {
  return {
    hasSustainabilityPreferences: true,
    minTaxonomyAlignedPercent: 10,
    minSustainableInvestmentsPercent: 25,
    considerPAIs: true,
    exclusions: { controversial_weapons: true, thermal_coal: true, tobacco: false },
    themes: { climate_transition: true, water: false, social: false },
    stewardshipStyle: "engagement_preferred",
    lastReviewed: "",
  };
}
function defaultServiceScopeDraft(): ServiceScopeDraft {
  return {
    clientSegment: "retail",
    serviceType: "investment_advice",
    advisoryScope: "portfolio_based",
    productPermissions: { crypto: "allowed_with_warning", derivatives: "not_allowed", structuredProducts: "allowed" },
    communicationPreferences: { language: "English", tone: "direct", detailLevel: "step_by_step", channel: "in_app_chat" },
    aiConsent: { allowPersonalization: true, allowCrossBankPortability: true },
    lastReviewed: "",
  };
}

export default function ContextVaultPage() {
  const { isMobile, isMobileOrTablet } = useBreakpoint();

  // Hydration guard
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Customer (Privy embedded)
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();

  // Bank (MetaMask / injected)
  const [bankErr, setBankErr] = useState<string>("");
  const [bankAddress, setBankAddress] = useState<string>("");
  const [bankChainId, setBankChainId] = useState<number | null>(null);
  const [bankBusy, setBankBusy] = useState<boolean>(false);

  const bankProviderRef = useRef<ethers.BrowserProvider | null>(null);
  const bankSignerRef = useRef<ethers.JsonRpcSigner | null>(null);

  // Shared status UI
  const [status, setStatus] = useState<string>("");
  const [err, setErr] = useState<string>("");
  const [lastTx, setLastTx] = useState<string>("");

  // Module selection (max 3)
  const [selectedKey, setSelectedKey] = useState<ModuleKey>("suitability");

  // Per-module policies (hashed onchain)
  const [policyByKey, setPolicyByKey] = useState<Record<ModuleKey, string>>({
    suitability: MODULE_DEFS.find((d) => d.key === "suitability")!.defaultPolicy,
    sustainability: MODULE_DEFS.find((d) => d.key === "sustainability")!.defaultPolicy,
    "service-scope": MODULE_DEFS.find((d) => d.key === "service-scope")!.defaultPolicy,
  });

  // Drafts (form state)
  const [suitabilityDraft, setSuitabilityDraft] = useState<SuitabilityDraft>(defaultSuitabilityDraft());
  const [sustainabilityDraft, setSustainabilityDraft] = useState<SustainabilityDraft>(defaultSustainabilityDraft());
  const [serviceScopeDraft, setServiceScopeDraft] = useState<ServiceScopeDraft>(defaultServiceScopeDraft());

  // Onchain module list (for existence checks)
  const [modules, setModules] = useState<any[]>([]);

  // Consent controls
  const [expiryDays, setExpiryDays] = useState<string>("30");
  const [purpose, setPurpose] = useState<string>("Personalize banking assistant onboarding");

  // Bank assistant demo
  const [bankModuleId, setBankModuleId] = useState<string>("");
  const [bankAPlain, setBankAPlain] = useState<string>("");
  const [bankBPlain, setBankBPlain] = useState<string>("");
  const [bankAErr, setBankAErr] = useState<string>("");
  const [bankBErr, setBankBErr] = useState<string>("");

  const wallet = useMemo(() => {
    if (!wallets || wallets.length === 0) return null;
    const embedded = wallets.find((w: any) => w.walletClientType === "privy");
    return (embedded ?? wallets[0]) as any;
  }, [wallets]);

  const walletAddress = wallet?.address ?? "";
  // Bank assistant demo owner address (derived from currently selected customer wallet)
  const bankOwner = walletAddress;
  // UI-safe strings
  const uiContract = mounted ? (CONTRACT || "⚠️ set NEXT_PUBLIC_CONTEXT_PASSPORT_ADDRESS") : "…";
  const uiChainId = mounted ? String(CHAIN_ID) : "…";
  const uiCustomerWallet = mounted ? (walletAddress || "—") : "…";
  const uiBankAAddr = mounted ? (BANK_A_ADDR || "⚠️ set NEXT_PUBLIC_BANK_A_ADDRESS") : "…";
  const uiBankBAddr = mounted ? (BANK_B_ADDR || "⚠️ set NEXT_PUBLIC_BANK_B_ADDRESS") : "…";

  const canUseCustomer = mounted && ready && authenticated && !!wallet && ethers.isAddress(CONTRACT);
  const bankConnected = !!bankAddress;
  const bankOnRightChain = bankChainId === null ? false : bankChainId === CHAIN_ID;
  const canUseBank = mounted && bankConnected && !!bankSignerRef.current && ethers.isAddress(CONTRACT);
  const isBankAddressSelected = (bank: BankId) => {
    const expected = bank === "bank-a" ? BANK_A_ADDR : BANK_B_ADDR;
    if (!ethers.isAddress(expected)) return false;
    return bankAddress.toLowerCase() === expected.toLowerCase();
  };
  const moduleAccessStatus = (m: any, bank: BankId) => {
    const entry = m?.access?.[bank];
    if (entry?.granted) return "granted";
    if (entry?.requested) return "pending";
    return "no request";
  };
  const accessStatusModules = useMemo(() => {
    const emptyAccess = () => ({
      "bank-a": { requested: false, granted: false },
      "bank-b": { requested: false, granted: false },
    });
    if (!ethers.isAddress(walletAddress)) {
      return MODULE_DEFS.map((d) => ({ key: d.key, label: d.label, moduleId: "", access: emptyAccess() }));
    }
    const byId = new Map(modules.map((m) => [String(m.moduleId || "").toLowerCase(), m]));
    return MODULE_DEFS.map((d) => {
      const id = deriveModuleId(walletAddress, d.key);
      const hit = byId.get(id.toLowerCase());
      return { key: d.key, label: d.label, moduleId: id, access: hit?.access ?? emptyAccess() };
    });
  }, [modules, walletAddress]);

  const customerModuleId = useMemo(() => deriveModuleId(walletAddress, selectedKey), [walletAddress, selectedKey]);
  const onchainIdSet = useMemo(() => new Set(modules.map((m) => String(m.moduleId || "").toLowerCase())), [modules]);
  const customerModuleExistsOnchain = useMemo(
    () => (isBytes32(customerModuleId) ? onchainIdSet.has(customerModuleId.toLowerCase()) : false),
    [customerModuleId, onchainIdSet]
  );

  const localPkgForSelected = useMemo(() => {
    if (!mounted) return null;
    if (!isBytes32(customerModuleId)) return null;
    try {
      return loadUserPkg(customerModuleId);
    } catch {
      return null;
    }
  }, [mounted, customerModuleId]);

  // Derive bank moduleId from current customer wallet + selected template
  const derivedBankModuleId = useMemo(() => deriveModuleId(walletAddress, selectedKey), [walletAddress, selectedKey]);
  useEffect(() => {
    if (!mounted) return;
    if (isBytes32(derivedBankModuleId)) setBankModuleId(derivedBankModuleId);
  }, [mounted, derivedBankModuleId]);

  async function getCustomerSigner() {
    if (!wallet) throw new Error("No customer wallet connected");
    const eip1193 = await wallet.getEthereumProvider();
    const provider = new ethers.BrowserProvider(eip1193);
    const signer = await provider.getSigner();
    return { provider, signer };
  }

  async function ensureCustomerChain() {
    try {
      if (wallet?.switchChain) await wallet.switchChain(CHAIN_ID);
    } catch {
      // best-effort
    }
  }

  async function loadModules() {
    setErr("");
    setLastTx("");
    try {
      if (!ethers.isAddress(CONTRACT)) throw new Error("Missing contract address.");
      if (!ethers.isAddress(walletAddress)) throw new Error("Missing customer wallet address.");

      const { provider } = await getCustomerSigner();
      const contract = new ethers.Contract(CONTRACT, CONTEXT_PASSPORT_ABI as any, provider);
      const ids: string[] = await contract.getOwnerModules(walletAddress);

      const hasBankA = ethers.isAddress(BANK_A_ADDR);
      const hasBankB = ethers.isAddress(BANK_B_ADDR);
      const out: any[] = [];
      for (const id of ids) {
        try {
          const m = await contract.getModule(id);
          const access: any = {
            "bank-a": { requested: false, granted: false },
            "bank-b": { requested: false, granted: false },
          };
          if (hasBankA) {
            const [granted, requested] = await Promise.all([contract.hasAccess(id, BANK_A_ADDR), contract.wasRequested(id, BANK_A_ADDR)]);
            access["bank-a"] = { requested: !!requested, granted: !!granted };
          }
          if (hasBankB) {
            const [granted, requested] = await Promise.all([contract.hasAccess(id, BANK_B_ADDR), contract.wasRequested(id, BANK_B_ADDR)]);
            access["bank-b"] = { requested: !!requested, granted: !!granted };
          }
          out.push({
            moduleId: id,
            label: String(m.label || ""),
            uri: String(m.uri || ""),
            policyHash: String(m.policyHash || ""),
            contentHash: String(m.contentHash || ""),
            updatedAt: Number(m.updatedAt || 0),
            owner: String(m.owner || ""),
            access,
          });
        } catch {
          out.push({
            moduleId: id,
            label: "",
            uri: "",
            owner: walletAddress,
            access: {
              "bank-a": { requested: false, granted: false },
              "bank-b": { requested: false, granted: false },
            },
          });
        }
      }
      setModules(out);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  useEffect(() => {
    if (!canUseCustomer) return;
    void ensureCustomerChain().then(loadModules);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseCustomer, walletAddress]);

  async function txSendCustomer(data: string) {
    const { hash } = await sendTransaction({ to: CONTRACT, data, value: 0 }, { sponsor: true, address: walletAddress });
    return hash;
  }

  // Populate form from local package (if exists)
  useEffect(() => {
    if (!mounted) return;
    if (!isBytes32(customerModuleId)) return;

    const pkg = loadUserPkg(customerModuleId);
    if (!pkg) {
      if (selectedKey === "suitability") setSuitabilityDraft(defaultSuitabilityDraft());
      if (selectedKey === "sustainability") setSustainabilityDraft(defaultSustainabilityDraft());
      if (selectedKey === "service-scope") setServiceScopeDraft(defaultServiceScopeDraft());
      return;
    }

    (async () => {
      try {
        const pt = await decryptAesGcm(pkg.ciphertextB64, pkg.ivB64, pkg.dekB64);
        const obj = JSON.parse(pt);
        const t = String(obj?.type || "");
        const k = moduleKeyFromType(t);
        if (!k || k !== selectedKey) return;

        if (selectedKey === "suitability") {
          const d = defaultSuitabilityDraft();
          setSuitabilityDraft({
            ...d,
            riskTolerance: obj.riskTolerance ?? d.riskTolerance,
            lossCapacity: obj.lossCapacity ?? d.lossCapacity,
            investmentHorizonYears: Number(obj.investmentHorizonYears ?? d.investmentHorizonYears),
            liquidityNeed: obj.liquidityNeed ?? d.liquidityNeed,
            objectives: {
              long_term_growth: !!obj?.objectives?.includes?.("long_term_growth") || !!obj?.objectives?.includes?.("growth"),
              income: !!obj?.objectives?.includes?.("income"),
              capital_preservation: !!obj?.objectives?.includes?.("capital_preservation"),
            },
            knowledgeExperience: {
              equities: obj?.knowledgeExperience?.equities ?? d.knowledgeExperience.equities,
              bonds: obj?.knowledgeExperience?.bonds ?? d.knowledgeExperience.bonds,
              fundsETFs: obj?.knowledgeExperience?.fundsETFs ?? d.knowledgeExperience.fundsETFs,
              derivatives: obj?.knowledgeExperience?.derivatives ?? d.knowledgeExperience.derivatives,
              crypto: obj?.knowledgeExperience?.crypto ?? d.knowledgeExperience.crypto,
            },
            constraints: {
              leverageAllowed: !!obj?.constraints?.leverageAllowed,
              derivativesAllowed: !!obj?.constraints?.derivativesAllowed,
            },
            lastReviewed: String(obj.lastReviewed || ""),
          });
        }

        if (selectedKey === "sustainability") {
          const d = defaultSustainabilityDraft();
          setSustainabilityDraft({
            ...d,
            hasSustainabilityPreferences: !!obj.hasSustainabilityPreferences,
            minTaxonomyAlignedPercent: Number(obj.minTaxonomyAlignedPercent ?? d.minTaxonomyAlignedPercent),
            minSustainableInvestmentsPercent: Number(obj.minSustainableInvestmentsPercent ?? d.minSustainableInvestmentsPercent),
            considerPAIs: !!obj.considerPAIs,
            exclusions: {
              controversial_weapons: !!(obj.exclusions || []).includes?.("controversial_weapons"),
              thermal_coal: !!(obj.exclusions || []).includes?.("thermal_coal"),
              tobacco: !!(obj.exclusions || []).includes?.("tobacco"),
            },
            themes: {
              climate_transition: !!(obj.themes || []).includes?.("climate_transition"),
              water: !!(obj.themes || []).includes?.("water"),
              social: !!(obj.themes || []).includes?.("social"),
            },
            stewardshipStyle: (obj.stewardshipStyle ?? d.stewardshipStyle) as any,
            lastReviewed: String(obj.lastReviewed || ""),
          });
        }

        if (selectedKey === "service-scope") {
          const d = defaultServiceScopeDraft();
          setServiceScopeDraft({
            ...d,
            clientSegment: (obj.clientSegment ?? d.clientSegment) as any,
            serviceType: (obj.serviceType ?? d.serviceType) as any,
            advisoryScope: (obj.advisoryScope ?? d.advisoryScope) as any,
            productPermissions: {
              crypto: (obj?.productPermissions?.crypto ?? d.productPermissions.crypto) as any,
              derivatives: (obj?.productPermissions?.derivatives ?? d.productPermissions.derivatives) as any,
              structuredProducts: (obj?.productPermissions?.structuredProducts ?? d.productPermissions.structuredProducts) as any,
            },
            communicationPreferences: {
              language: String(obj?.communicationPreferences?.language ?? d.communicationPreferences.language),
              tone: (obj?.communicationPreferences?.tone ?? d.communicationPreferences.tone) as any,
              detailLevel: (obj?.communicationPreferences?.detailLevel ?? d.communicationPreferences.detailLevel) as any,
              channel: (obj?.communicationPreferences?.channel ?? d.communicationPreferences.channel) as any,
            },
            aiConsent: {
              allowPersonalization: !!obj?.aiConsent?.allowPersonalization,
              allowCrossBankPortability: !!obj?.aiConsent?.allowCrossBankPortability,
            },
            lastReviewed: String(obj.lastReviewed || ""),
          });
        }
      } catch {
        // ignore
      }
    })();
  }, [mounted, customerModuleId, selectedKey]);

  function buildPlaintextForSelectedModule(): string {
    const iso = new Date().toISOString();

    if (selectedKey === "suitability") {
      const d = suitabilityDraft;
      const objectives: string[] = [];
      if (d.objectives.long_term_growth) objectives.push("long_term_growth");
      if (d.objectives.income) objectives.push("income");
      if (d.objectives.capital_preservation) objectives.push("capital_preservation");

      const obj = {
        version: 1,
        type: moduleKeyType("suitability"),
        riskTolerance: d.riskTolerance,
        lossCapacity: d.lossCapacity,
        investmentHorizonYears: d.investmentHorizonYears,
        liquidityNeed: d.liquidityNeed,
        objectives,
        knowledgeExperience: d.knowledgeExperience,
        constraints: d.constraints,
        lastReviewed: iso,
      };

      setSuitabilityDraft({ ...d, lastReviewed: iso });
      return JSON.stringify(obj, null, 2);
    }

    if (selectedKey === "sustainability") {
      const d = sustainabilityDraft;
      const exclusions: string[] = [];
      if (d.exclusions.controversial_weapons) exclusions.push("controversial_weapons");
      if (d.exclusions.thermal_coal) exclusions.push("thermal_coal");
      if (d.exclusions.tobacco) exclusions.push("tobacco");

      const themes: string[] = [];
      if (d.themes.climate_transition) themes.push("climate_transition");
      if (d.themes.water) themes.push("water");
      if (d.themes.social) themes.push("social");

      const obj = {
        version: 1,
        type: moduleKeyType("sustainability"),
        hasSustainabilityPreferences: d.hasSustainabilityPreferences,
        minTaxonomyAlignedPercent: d.minTaxonomyAlignedPercent,
        minSustainableInvestmentsPercent: d.minSustainableInvestmentsPercent,
        considerPAIs: d.considerPAIs,
        exclusions,
        themes,
        stewardshipStyle: d.stewardshipStyle,
        lastReviewed: iso,
      };

      setSustainabilityDraft({ ...d, lastReviewed: iso });
      return JSON.stringify(obj, null, 2);
    }

    const d = serviceScopeDraft;
    const obj = {
      version: 1,
      type: moduleKeyType("service-scope"),
      clientSegment: d.clientSegment,
      serviceType: d.serviceType,
      advisoryScope: d.advisoryScope,
      productPermissions: d.productPermissions,
      communicationPreferences: d.communicationPreferences,
      aiConsent: d.aiConsent,
      lastReviewed: iso,
    };

    setServiceScopeDraft({ ...d, lastReviewed: iso });
    return JSON.stringify(obj, null, 2);
  }

  async function saveSelectedModule() {
    setErr("");
    setLastTx("");
    setStatus("Saving module…");
    try {
      if (!canUseCustomer) throw new Error("Login with the customer wallet first.");
      if (!isBytes32(customerModuleId)) throw new Error("Customer moduleId not available yet.");
      if (!ethers.isAddress(CONTRACT)) throw new Error("Missing contract address.");

      const label = moduleKeyLabel(selectedKey);
      const policy = policyByKey[selectedKey] || MODULE_DEFS.find((d) => d.key === selectedKey)!.defaultPolicy;
      const uri = `ctx://module/${customerModuleId}`;

      const plaintext = buildPlaintextForSelectedModule();
      const enc = await encryptAesGcm(plaintext);
      const ciphertextBytes = b64ToBytes(enc.ciphertextB64);
      const contentHash = ethers.keccak256(ciphertextBytes);
      const policyHash = ethers.keccak256(utf8ToBytes(policy));

      const existing = loadUserPkg(customerModuleId);
      const pkg: UserModulePackageV1 = {
        version: 1,
        moduleId: customerModuleId,
        label,
        policy,
        uri,
        ciphertextB64: enc.ciphertextB64,
        ivB64: enc.ivB64,
        dekB64: enc.dekB64,
        plaintextSha256: await sha256Hex(utf8ToBytes(plaintext)),
        ciphertextKeccak256: contentHash,
        createdAtIso: existing?.createdAtIso ?? new Date().toISOString(),
        bankBlobRefs: existing?.bankBlobRefs,
      };
      saveUserPkg(pkg);

      const iface = new ethers.Interface(CONTEXT_PASSPORT_ABI as any);
      const fn = customerModuleExistsOnchain ? "updateModule" : "registerModule";
      const args = customerModuleExistsOnchain
        ? [customerModuleId, contentHash, policyHash, uri]
        : [customerModuleId, contentHash, policyHash, label, uri];
      const data = iface.encodeFunctionData(fn, args);
      const hash = await txSendCustomer(data);

      setLastTx(hash);
      setStatus(customerModuleExistsOnchain ? "Module updated ✅" : "Module created ✅");
      await loadModules();
    } catch (e: any) {
      setStatus("");
      setErr(e?.message ?? String(e));
    }
  }

  function exportSelected() {
    setErr("");
    setLastTx("");
    if (!isBytes32(customerModuleId)) return setErr("ModuleId not available yet.");
    const pkg = loadUserPkg(customerModuleId);
    if (!pkg) return setErr("No local user package found for this module (nothing to export).");
    downloadJson(`uc4-context-${pkg.moduleId}.json`, pkg);
    setStatus("Exported user package (includes DEK) ✅");
  }

  async function importUserPackage(file: File) {
    setErr("");
    setLastTx("");
    setStatus("Importing…");
    try {
      const text = await file.text();
      const pkg = JSON.parse(text) as UserModulePackageV1;
      if (!pkg.moduleId || !pkg.dekB64 || !pkg.ciphertextB64) throw new Error("Invalid user package JSON.");
      saveUserPkg(pkg);

      try {
        const pt = await decryptAesGcm(pkg.ciphertextB64, pkg.ivB64, pkg.dekB64);
        const obj = JSON.parse(pt);
        const k = moduleKeyFromType(String(obj?.type || ""));
        if (k) setSelectedKey(k);
      } catch {
        // ignore
      }

      setStatus(`Imported module ${fmtShort(pkg.moduleId)} ✅`);
      await loadModules();
    } catch (e: any) {
      setStatus("");
      setErr(e?.message ?? String(e));
    }
  }

  async function previewDecryptLocal() {
    setErr("");
    setLastTx("");
    try {
      if (!isBytes32(customerModuleId)) throw new Error("ModuleId not available yet.");
      const pkg = loadUserPkg(customerModuleId);
      if (!pkg) throw new Error("No local user package found.");
      const pt = await decryptAesGcm(pkg.ciphertextB64, pkg.ivB64, pkg.dekB64);
      alert(pt);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  async function connectBankWallet() {
    setBankErr("");
    setBankBusy(true);
    try {
      const eth = (window as any).ethereum;
      if (!eth) throw new Error("MetaMask not found. Install MetaMask.");
      const provider = new ethers.BrowserProvider(eth);
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      const addr = await signer.getAddress();
      const net = await provider.getNetwork();

      bankProviderRef.current = provider;
      bankSignerRef.current = signer;
      setBankAddress(addr);
      setBankChainId(Number(net.chainId));
    } catch (e: any) {
      setBankErr(e?.message ?? String(e));
    } finally {
      setBankBusy(false);
    }
  }
  function disconnectBankWallet() {
    bankProviderRef.current = null;
    bankSignerRef.current = null;
    setBankAddress("");
    setBankChainId(null);
  }
  async function switchBankChain() {
    setBankErr("");
    try {
      const eth = (window as any).ethereum;
      if (!eth) throw new Error("MetaMask not found.");
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdToHex(CHAIN_ID) }] });

      const provider = new ethers.BrowserProvider(eth);
      const signer = await provider.getSigner();
      const net = await provider.getNetwork();
      bankProviderRef.current = provider;
      bankSignerRef.current = signer;
      setBankChainId(Number(net.chainId));
      setBankAddress(await signer.getAddress());
    } catch (e: any) {
      setBankErr(e?.message ?? String(e));
    }
  }

  async function requestAccessAsMetaMask(bank: BankId) {
    setErr("");
    setLastTx("");
    setStatus("Submitting access request…");
    try {
      if (!canUseBank) throw new Error("Connect MetaMask first.");
      if (!bankOnRightChain) throw new Error("MetaMask is on the wrong network. Click 'Switch chain'.");
      if (!isBytes32(bankModuleId)) throw new Error("Invalid moduleId (bytes32).");
      if (!purpose) throw new Error("Purpose required.");
      if (!isBankAddressSelected(bank)) {
        const expected = bank === "bank-a" ? BANK_A_ADDR : BANK_B_ADDR;
        throw new Error(`MetaMask is connected to the wrong bank address. Expected ${expected}.`);
      }

      const signer = bankSignerRef.current!;
      const contract = new ethers.Contract(CONTRACT, CONTEXT_PASSPORT_ABI as any, signer);

      const pHash = ethers.keccak256(utf8ToBytes(purpose));
      // MetaMask occasionally underprices maxFeePerGas on low-fee chains; bump fees to clear base fee.
      let overrides: any = {};
      try {
        const feeData = await signer.provider!.getFeeData();
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
          let maxFee = feeData.maxFeePerGas;
          let lastBase: bigint | null = null;
          try {
            // Use latest block's base fee (if available) instead of a FeeData field that may not exist.
            const block = await signer.provider!.getBlock("latest");
            lastBase = block && (block as any).baseFeePerGas ? (block as any).baseFeePerGas : null;
          } catch {
            // ignore
          }
          if (lastBase) {
            const minMax = lastBase * BigInt(2) + feeData.maxPriorityFeePerGas;
            if (maxFee < minMax) maxFee = minMax;
          } else {
            maxFee = maxFee * BigInt(2);
          }
          overrides = { maxFeePerGas: maxFee, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas };
        } else if (feeData.gasPrice) {
          overrides = { gasPrice: feeData.gasPrice * BigInt(2) };
        }
      } catch {
        // Some RPCs don't support eth_maxPriorityFeePerGas; fall back to wallet defaults.
      }

      const tx = await contract.requestAccess(bankModuleId, pHash, overrides);
      setLastTx(tx.hash);
      await tx.wait();

      setStatus(`${bankLabel(bank)} requested access ✅`);
      if (canUseCustomer) await loadModules();
    } catch (e: any) {
      setStatus("");
      setErr(e?.message ?? String(e));
    }
  }

  async function grantToBank(bank: BankId) {
    setErr("");
    setLastTx("");
    setStatus(`Granting to ${bankLabel(bank)}…`);
    try {
      if (!canUseCustomer) throw new Error("Login with customer wallet first.");
      if (!isBytes32(customerModuleId)) throw new Error("Select a module first.");
      const pkg = loadUserPkg(customerModuleId);
      if (!pkg) throw new Error("No local user package found for this module (import it first).");

      const expiry = expiryFromDays(expiryDays);
      const pHash = ethers.keccak256(utf8ToBytes(purpose));
      const bankAddress = bank === "bank-a" ? BANK_A_ADDR : BANK_B_ADDR;
      if (!ethers.isAddress(bankAddress)) throw new Error("Missing bank address env var.");

      const bankPem = bank === "bank-a" ? BANK_A_PUB_PEM : BANK_B_PUB_PEM;
      if (!bankPem) throw new Error("Missing bank public key PEM env var.");

      // 1) Upload merged bundle (ciphertext + wrapped DEK) to bank storage
      const encDekB64 = await wrapDekRsaOaepB64(bankPem, pkg.dekB64);
      const bundlePayload = toBankStoredBundle(pkg, walletAddress, encDekB64);
      const bundleResp = await fetch(`/api/bank/${bank}/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: walletAddress, moduleId: customerModuleId, payload: bundlePayload }),
      });
      const bundleJson = await bundleResp.json();
      if (!bundleResp.ok) throw new Error(bundleJson?.error ?? "Failed to store encrypted bundle at bank.");

      const bundleUrl =
        typeof bundleJson?.bundleUrl === "string" ? bundleJson.bundleUrl : typeof bundleJson?.url === "string" ? bundleJson.url : "";
      if (bundleUrl) {
        saveBankBlobRefs(customerModuleId, bank, walletAddress, {
          bundleUrl,
          contextUrl: bundleUrl,
          dekUrl: bundleUrl,
        });
      }

      // 2) Onchain grant
      const iface = new ethers.Interface(CONTEXT_PASSPORT_ABI as any);
      const data = iface.encodeFunctionData("grantAccess", [customerModuleId, bankAddress, expiry, pHash]);
      const hash = await txSendCustomer(data);

      setLastTx(hash);
      setStatus(`Granted to ${bankLabel(bank)} ✅`);
      await loadModules();
    } catch (e: any) {
      setStatus("");
      setErr(e?.message ?? String(e));
    }
  }

  async function revokeFromBank(bank: BankId) {
    setErr("");
    setLastTx("");
    setStatus(`Revoking from ${bankLabel(bank)}…`);
    try {
      if (!canUseCustomer) throw new Error("Login with customer wallet first.");
      if (!isBytes32(customerModuleId)) throw new Error("Select a module first.");
      const bankAddress = bank === "bank-a" ? BANK_A_ADDR : BANK_B_ADDR;
      if (!ethers.isAddress(bankAddress)) throw new Error("Missing bank address env var.");

      const iface = new ethers.Interface(CONTEXT_PASSPORT_ABI as any);
      const data = iface.encodeFunctionData("revokeAccess", [customerModuleId, bankAddress]);
      const hash = await txSendCustomer(data);

      setLastTx(hash);
      setStatus(`Revoked from ${bankLabel(bank)} ✅`);
      await loadModules();
    } catch (e: any) {
      setStatus("");
      setErr(e?.message ?? String(e));
    }
  }

  async function bankLoadPlain(bank: BankId) {
    setLastTx("");
    if (bank === "bank-a") setBankAErr("");
    else setBankBErr("");
    try {
      if (!ethers.isAddress(bankOwner)) throw new Error("Enter a valid customer owner address.");
      if (!isBytes32(bankModuleId)) throw new Error("Enter a valid moduleId (bytes32).");
      const params = new URLSearchParams({
        owner: bankOwner,
        moduleId: bankModuleId,
      });
      const blobRefs = getStoredBankBlobRefs(bankModuleId, bank, bankOwner);
      if (blobRefs?.bundleUrl) {
        params.set("bundleUrl", blobRefs.bundleUrl);
      } else {
        if (blobRefs?.contextUrl) params.set("ctxUrl", blobRefs.contextUrl);
        if (blobRefs?.dekUrl) params.set("dekUrl", blobRefs.dekUrl);
      }

      const r = await fetch(`/api/bank/${bank}/plain?${params.toString()}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? "Failed to load/decrypt.");

      const pt = String(j.plaintext || "");
      if (bank === "bank-a") setBankAPlain(pt);
      else setBankBPlain(pt);

      setStatus(`${bankLabel(bank)} decrypted module successfully ✅`);
    } catch (e: any) {
      setStatus("");
      const msg = e?.message ?? String(e);
      if (bank === "bank-a") setBankAErr(msg);
      else setBankBErr(msg);
    }
  }

  function renderModuleSelector(disabled: boolean) {
    return (
      <select style={{ ...input, fontFamily: "inherit" }} value={selectedKey} onChange={(e) => setSelectedKey(e.target.value as ModuleKey)} disabled={disabled}>
        {MODULE_DEFS.map((d) => (
          <option key={d.key} value={d.key}>
            {d.label}
          </option>
        ))}
      </select>
    );
  }

  function renderSuitabilityFields() {
    const d = suitabilityDraft;
    const setObj = (patch: Partial<SuitabilityDraft>) => setSuitabilityDraft({ ...d, ...patch });
    const setKE = (k: keyof SuitabilityDraft["knowledgeExperience"], v: any) => setObj({ knowledgeExperience: { ...d.knowledgeExperience, [k]: v } });
    const setObjFlag = (k: keyof SuitabilityDraft["objectives"], v: boolean) => setObj({ objectives: { ...d.objectives, [k]: v } });
    const setConstraint = (k: keyof SuitabilityDraft["constraints"], v: boolean) => setObj({ constraints: { ...d.constraints, [k]: v } });

    return (
      <div style={{ display: "grid", gap: 10 }}>
        <div style={miniCard}>
          <div style={miniTitle}>Risk tolerance</div>
          <select style={input} value={d.riskTolerance} onChange={(e) => setObj({ riskTolerance: e.target.value as any })}>
            <option value="conservative">Conservative</option>
            <option value="balanced">Balanced</option>
            <option value="growth">Growth</option>
            <option value="aggressive">Aggressive</option>
          </select>
        </div>

        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <div style={miniCard}>
            <div style={miniTitle}>Loss capacity</div>
            <select style={input} value={d.lossCapacity} onChange={(e) => setObj({ lossCapacity: e.target.value as any })}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>

          <div style={miniCard}>
            <div style={miniTitle}>Investment horizon (years)</div>
            <input style={input} type="number" min={0} value={d.investmentHorizonYears} onChange={(e) => setObj({ investmentHorizonYears: Number(e.target.value || 0) })} />
          </div>

          <div style={miniCard}>
            <div style={miniTitle}>Liquidity need</div>
            <select style={input} value={d.liquidityNeed} onChange={(e) => setObj({ liquidityNeed: e.target.value as any })}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
        </div>

        <div style={miniCard}>
          <div style={miniTitle}>Objectives</div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <label style={checkWrap}>
              <input type="checkbox" checked={d.objectives.long_term_growth} onChange={(e) => setObjFlag("long_term_growth", e.target.checked)} />
              Long-term growth
            </label>
            <label style={checkWrap}>
              <input type="checkbox" checked={d.objectives.income} onChange={(e) => setObjFlag("income", e.target.checked)} />
              Income
            </label>
            <label style={checkWrap}>
              <input type="checkbox" checked={d.objectives.capital_preservation} onChange={(e) => setObjFlag("capital_preservation", e.target.checked)} />
              Capital preservation
            </label>
          </div>
        </div>

        <div style={miniCard}>
          <div style={miniTitle}>Knowledge & experience</div>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            {(["equities", "bonds", "fundsETFs", "derivatives", "crypto"] as const).map((k) => (
              <div key={k}>
                <div style={labelStyle}>{k}</div>
                <select style={input} value={d.knowledgeExperience[k]} onChange={(e) => setKE(k, e.target.value as any)}>
                  <option value="none">None</option>
                  <option value="basic">Basic</option>
                  <option value="good">Good</option>
                </select>
              </div>
            ))}
          </div>
        </div>

        <div style={miniCard}>
          <div style={miniTitle}>Constraints</div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <label style={checkWrap}>
              <input type="checkbox" checked={d.constraints.leverageAllowed} onChange={(e) => setConstraint("leverageAllowed", e.target.checked)} />
              Leverage allowed
            </label>
            <label style={checkWrap}>
              <input type="checkbox" checked={d.constraints.derivativesAllowed} onChange={(e) => setConstraint("derivativesAllowed", e.target.checked)} />
              Derivatives allowed
            </label>
          </div>
        </div>

        <div style={hint}>
          Last reviewed: <span style={mono}>{d.lastReviewed ? new Date(d.lastReviewed).toLocaleString() : "—"}</span>
        </div>
      </div>
    );
  }

  function renderSustainabilityFields() {
    const d = sustainabilityDraft;
    const setD = (patch: Partial<SustainabilityDraft>) => setSustainabilityDraft({ ...d, ...patch });
    const setExcl = (k: keyof SustainabilityDraft["exclusions"], v: boolean) => setD({ exclusions: { ...d.exclusions, [k]: v } });
    const setTheme = (k: keyof SustainabilityDraft["themes"], v: boolean) => setD({ themes: { ...d.themes, [k]: v } });

    return (
      <div style={{ display: "grid", gap: 10 }}>
        <div style={miniCard}>
          <div style={miniTitle}>Has sustainability preferences</div>
          <label style={checkWrap}>
            <input type="checkbox" checked={d.hasSustainabilityPreferences} onChange={(e) => setD({ hasSustainabilityPreferences: e.target.checked })} />
            Yes
          </label>
        </div>

        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <div style={miniCard}>
            <div style={miniTitle}>Min taxonomy-aligned %</div>
            <input style={input} type="number" min={0} max={100} value={d.minTaxonomyAlignedPercent} onChange={(e) => setD({ minTaxonomyAlignedPercent: Number(e.target.value || 0) })} />
          </div>

          <div style={miniCard}>
            <div style={miniTitle}>Min sustainable investments %</div>
            <input style={input} type="number" min={0} max={100} value={d.minSustainableInvestmentsPercent} onChange={(e) => setD({ minSustainableInvestmentsPercent: Number(e.target.value || 0) })} />
          </div>

          <div style={miniCard}>
            <div style={miniTitle}>Consider PAIs</div>
            <label style={checkWrap}>
              <input type="checkbox" checked={d.considerPAIs} onChange={(e) => setD({ considerPAIs: e.target.checked })} />
              Yes
            </label>
          </div>
        </div>

        <div style={miniCard}>
          <div style={miniTitle}>Exclusions</div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <label style={checkWrap}>
              <input type="checkbox" checked={d.exclusions.controversial_weapons} onChange={(e) => setExcl("controversial_weapons", e.target.checked)} />
              Controversial weapons
            </label>
            <label style={checkWrap}>
              <input type="checkbox" checked={d.exclusions.thermal_coal} onChange={(e) => setExcl("thermal_coal", e.target.checked)} />
              Thermal coal
            </label>
            <label style={checkWrap}>
              <input type="checkbox" checked={d.exclusions.tobacco} onChange={(e) => setExcl("tobacco", e.target.checked)} />
              Tobacco
            </label>
          </div>
        </div>

        <div style={miniCard}>
          <div style={miniTitle}>Themes</div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <label style={checkWrap}>
              <input type="checkbox" checked={d.themes.climate_transition} onChange={(e) => setTheme("climate_transition", e.target.checked)} />
              Climate transition
            </label>
            <label style={checkWrap}>
              <input type="checkbox" checked={d.themes.water} onChange={(e) => setTheme("water", e.target.checked)} />
              Water
            </label>
            <label style={checkWrap}>
              <input type="checkbox" checked={d.themes.social} onChange={(e) => setTheme("social", e.target.checked)} />
              Social
            </label>
          </div>
        </div>

        <div style={miniCard}>
          <div style={miniTitle}>Stewardship style</div>
          <select style={input} value={d.stewardshipStyle} onChange={(e) => setD({ stewardshipStyle: e.target.value as any })}>
            <option value="engagement_preferred">Engagement preferred</option>
            <option value="exclusion_preferred">Exclusion preferred</option>
            <option value="neutral">Neutral</option>
          </select>
        </div>

        <div style={hint}>
          Last reviewed (auto): <span style={mono}>{d.lastReviewed ? new Date(d.lastReviewed).toLocaleString() : "—"}</span>
        </div>
      </div>
    );
  }

  function renderServiceScopeFields() {
    const d = serviceScopeDraft;
    const setD = (patch: Partial<ServiceScopeDraft>) => setServiceScopeDraft({ ...d, ...patch });
    const setPerm = (k: keyof ServiceScopeDraft["productPermissions"], v: any) => setD({ productPermissions: { ...d.productPermissions, [k]: v } });
    const setComm = (k: keyof ServiceScopeDraft["communicationPreferences"], v: any) =>
      setD({ communicationPreferences: { ...d.communicationPreferences, [k]: v } });
    const setConsent = (k: keyof ServiceScopeDraft["aiConsent"], v: boolean) => setD({ aiConsent: { ...d.aiConsent, [k]: v } });

    return (
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <div style={miniCard}>
            <div style={miniTitle}>Client segment</div>
            <select style={input} value={d.clientSegment} onChange={(e) => setD({ clientSegment: e.target.value as any })}>
              <option value="retail">Retail</option>
              <option value="professional">Professional</option>
              <option value="institutional">Institutional</option>
            </select>
          </div>

          <div style={miniCard}>
            <div style={miniTitle}>Service type</div>
            <select style={input} value={d.serviceType} onChange={(e) => setD({ serviceType: e.target.value as any })}>
              <option value="execution_only">Execution only</option>
              <option value="investment_advice">Investment advice</option>
              <option value="portfolio_management">Portfolio management</option>
            </select>
          </div>

          <div style={miniCard}>
            <div style={miniTitle}>Advisory scope</div>
            <select style={input} value={d.advisoryScope} onChange={(e) => setD({ advisoryScope: e.target.value as any })}>
              <option value="single_transaction">Single transaction</option>
              <option value="portfolio_based">Portfolio based</option>
            </select>
          </div>
        </div>

        <div style={miniCard}>
          <div style={miniTitle}>Product permissions</div>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            {(["crypto", "derivatives", "structuredProducts"] as const).map((k) => (
              <div key={k}>
                <div style={labelStyle}>{k}</div>
                <select style={input} value={d.productPermissions[k]} onChange={(e) => setPerm(k, e.target.value as any)}>
                  <option value="not_allowed">Not allowed</option>
                  <option value="allowed_with_warning">Allowed with warning</option>
                  <option value="allowed">Allowed</option>
                </select>
              </div>
            ))}
          </div>
        </div>

        <div style={miniCard}>
          <div style={miniTitle}>Communication preferences</div>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <div>
              <div style={labelStyle}>Language</div>
              <input style={input} value={d.communicationPreferences.language} onChange={(e) => setComm("language", e.target.value)} />
            </div>
            <div>
              <div style={labelStyle}>Tone</div>
              <select style={input} value={d.communicationPreferences.tone} onChange={(e) => setComm("tone", e.target.value as any)}>
                <option value="direct">Direct</option>
                <option value="neutral">Neutral</option>
                <option value="friendly">Friendly</option>
              </select>
            </div>
            <div>
              <div style={labelStyle}>Detail level</div>
              <select style={input} value={d.communicationPreferences.detailLevel} onChange={(e) => setComm("detailLevel", e.target.value as any)}>
                <option value="step_by_step">Step by step</option>
                <option value="summary">Summary</option>
              </select>
            </div>
            <div>
              <div style={labelStyle}>Channel</div>
              <select style={input} value={d.communicationPreferences.channel} onChange={(e) => setComm("channel", e.target.value as any)}>
                <option value="in_app_chat">In-app chat</option>
                <option value="email">Email</option>
                <option value="phone">Phone</option>
              </select>
            </div>
          </div>
        </div>

        <div style={miniCard}>
          <div style={miniTitle}>AI consent</div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <label style={checkWrap}>
              <input type="checkbox" checked={d.aiConsent.allowPersonalization} onChange={(e) => setConsent("allowPersonalization", e.target.checked)} />
              Allow personalization
            </label>
            <label style={checkWrap}>
              <input type="checkbox" checked={d.aiConsent.allowCrossBankPortability} onChange={(e) => setConsent("allowCrossBankPortability", e.target.checked)} />
              Allow cross-bank portability
            </label>
          </div>
        </div>

        <div style={hint}>
          Last reviewed (auto): <span style={mono}>{d.lastReviewed ? new Date(d.lastReviewed).toLocaleString() : "—"}</span>
        </div>
      </div>
    );
  }

  function renderFieldsForSelected() {
    if (selectedKey === "suitability") return renderSuitabilityFields();
    if (selectedKey === "sustainability") return renderSustainabilityFields();
    return renderServiceScopeFields();
  }

  const moduleStatusLine = (
    <div style={{ marginTop: 8, color: "rgba(255,255,255,0.45)", fontSize: 12, lineHeight: 1.5 }}>
      ModuleId: <span style={mono}>{isBytes32(customerModuleId) ? customerModuleId : "—"}</span>
      <br />Onchain: <b style={{ color: customerModuleExistsOnchain ? "#34d399" : "rgba(255,255,255,0.45)" }}>{customerModuleExistsOnchain ? "yes" : "no"}</b>
      {" · "}Local pkg: <b style={{ color: localPkgForSelected ? "#34d399" : "rgba(255,255,255,0.45)" }}>{localPkgForSelected ? "yes" : "no"}</b>
    </div>
  );

  const accent = "#f59e0b";

  const page: React.CSSProperties = {
    minHeight: "100vh",
    background: "#0d0d0d",
    color: "#fff",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  };
  const wrap: React.CSSProperties = { maxWidth: 1000, margin: "0 auto", padding: isMobile ? "20px 16px 64px" : "24px 20px 64px" };
  const sectionHeading: React.CSSProperties = { fontSize: 15, fontWeight: 700, color: "#fff", margin: "0 0 4px" };
  const sectionSub: React.CSSProperties = { fontSize: 14, color: "rgba(255,255,255,0.62)", lineHeight: 1.6, marginBottom: 14 };
  const divider: React.CSSProperties = { border: "none", borderTop: "1px solid rgba(255,255,255,0.06)", margin: "14px 0" };
  const statusTag = (connected: boolean, right?: boolean) => ({
    fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
    color: connected ? (right ? "rgba(52,211,153,0.9)" : "rgba(52,211,153,0.9)") : "rgba(255,255,255,0.40)",
    padding: "2px 8px",
    border: `1px solid ${connected ? (right ? "rgba(52,211,153,0.28)" : "rgba(52,211,153,0.28)") : "rgba(255,255,255,0.08)"}`,
    borderRadius: 999,
  } as React.CSSProperties);

  const connectedBankId: BankId | null = isBankAddressSelected("bank-a") ? "bank-a" : isBankAddressSelected("bank-b") ? "bank-b" : null;
  const custStep1Done = authenticated;
  const custStep2Done = customerModuleExistsOnchain && !!localPkgForSelected;
  const bankStep1Done = bankConnected && bankOnRightChain;

  /* ── step circle helper ── */
  const stepCircle = (n: number, done: boolean, locked: boolean) => (
    <div style={{
      width: 28, height: 28, borderRadius: "50%",
      background: done ? "#34d399" : locked ? "rgba(255,255,255,0.06)" : accent,
      color: done ? "#000" : locked ? "rgba(255,255,255,0.25)" : "#000",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 13, fontWeight: 800, flexShrink: 0,
    }}>
      {done ? "✓" : n}
    </div>
  );

  return (
    <>
      <NavBar active="context-vault" />
      <div style={page}>
        <div style={wrap}>

          {/* ── Page header ── */}
          <div style={{ marginBottom: 36 }}>
            <div style={{ display: "inline-flex", alignItems: "center", fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: accent, background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: 999, padding: "3px 10px", marginBottom: 12 }}>
              UC 04
            </div>
            <h1 style={{ fontSize: isMobile ? 22 : 28, fontWeight: 800, color: "#fff", margin: "0 0 8px" }}>Context Passport</h1>
            <p style={{ fontSize: 14, color: "rgba(255,255,255,0.55)", margin: 0, lineHeight: 1.6, maxWidth: 600 }}>
              Customer-owned encrypted context modules. You control who can decrypt &mdash; with onchain-enforced consent.
            </p>
          </div>

          {/* ── Global status bar ── */}
          {(status || err) && (
            <div style={{ ...note, marginBottom: 20, borderColor: err ? "rgba(239,68,68,0.25)" : "rgba(52,211,153,0.18)" }}>
              {status && <div style={{ fontWeight: 700, color: "#fff" }}>{status}</div>}
              {err && <div style={{ color: "#f87171", marginTop: status ? 6 : 0 }}>{err}</div>}
              {lastTx && (
                <a style={{ ...linkBtn, marginTop: 8, display: "inline-flex" }} href={`${EXPLORER_TX}${lastTx}`} target="_blank" rel="noreferrer">
                  View transaction ↗
                </a>
              )}
            </div>
          )}

          {/* ── Two journeys grid ── */}
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(440px, 1fr))", gap: 28, alignItems: "start" }}>

            {/* ════ CUSTOMER JOURNEY ════ */}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", color: "rgba(255,255,255,0.35)", textTransform: "uppercase" }}>Customer Journey</div>
                <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.06)" }} />
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.28)" }}>Privy embedded wallet</div>
              </div>

              {/* ─ C-Step 1: Connect wallet ─ */}
              <div style={{ display: "flex", gap: 14, marginBottom: 16 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                  {stepCircle(1, custStep1Done, false)}
                  <div style={{ width: 1, flex: 1, background: "rgba(255,255,255,0.07)", marginTop: 6 }} />
                </div>
                <div style={{ flex: 1, paddingBottom: 20 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: custStep1Done ? "#34d399" : "#fff", marginBottom: 12 }}>
                    Connect your wallet
                  </div>
                  {custStep1Done ? (
                    <div style={{ ...miniCard, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.40)", marginBottom: 4 }}>Wallet address</div>
                        <div style={{ ...mono, fontSize: 12 }}>{uiCustomerWallet}</div>
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button style={btnSecondary} disabled={!canUseCustomer} onClick={loadModules}>Refresh</button>
                        <button style={btnSecondary} onClick={logout}>Logout</button>
                      </div>
                    </div>
                  ) : (
                    <div style={card}>
                      <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", marginBottom: 14, lineHeight: 1.5 }}>
                        Sign in with your embedded wallet to create and manage context modules.
                      </div>
                      <button style={btn} disabled={!ready || !mounted} onClick={login}>Login with Privy</button>
                      <div style={{ marginTop: 10 }}>
                        <div style={hint}>Contract: <span style={mono}>{uiContract}</span></div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ─ C-Step 2: Build module ─ */}
              <div style={{ display: "flex", gap: 14, marginBottom: 16 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                  {stepCircle(2, custStep2Done, !custStep1Done)}
                  <div style={{ width: 1, flex: 1, background: "rgba(255,255,255,0.07)", marginTop: 6 }} />
                </div>
                <div style={{ flex: 1, paddingBottom: 20 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: !custStep1Done ? "rgba(255,255,255,0.28)" : custStep2Done ? "#34d399" : "#fff", marginBottom: 12 }}>
                    Build your context module
                  </div>
                  {!custStep1Done ? (
                    <div style={{ ...card, opacity: 0.5 }}>
                      <div style={{ fontSize: 13, color: "rgba(255,255,255,0.35)" }}>Complete Step 1 to unlock.</div>
                    </div>
                  ) : (
                    <div style={card}>
                      <div style={{ display: "grid", gap: 10, gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", marginBottom: 12 }}>
                        <div>
                          <div style={labelStyle}>Module type</div>
                          {renderModuleSelector(!canUseCustomer)}
                        </div>
                        <div>
                          <div style={labelStyle}>Sharing policy (hashed onchain)</div>
                          <input
                            style={input}
                            value={policyByKey[selectedKey]}
                            onChange={(e) => setPolicyByKey({ ...policyByKey, [selectedKey]: e.target.value })}
                          />
                          <div style={hint}>Non-sensitive. Hashed onchain.</div>
                        </div>
                      </div>
                      {moduleStatusLine}
                      <div style={{ ...miniCard, marginTop: 12, marginBottom: 12 }}>
                        <div style={miniTitle}>Module fields</div>
                        {renderFieldsForSelected()}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button style={btn} disabled={!canUseCustomer} onClick={saveSelectedModule}>
                          {customerModuleExistsOnchain ? "Update module" : "Create module"}
                        </button>
                        <button style={btnSecondary} disabled={!localPkgForSelected} onClick={previewDecryptLocal}>Preview</button>
                        <button style={btnSecondary} disabled={!localPkgForSelected} onClick={exportSelected}>Export</button>
                        <label style={{ ...btnSecondary, display: "inline-flex", alignItems: "center", cursor: "pointer" }}>
                          Import
                          <input
                            type="file"
                            accept="application/json"
                            style={{ display: "none" }}
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) void importUserPackage(f); }}
                          />
                        </label>
                      </div>
                      {!localPkgForSelected && customerModuleExistsOnchain && (
                        <div style={{ ...note, marginTop: 10, fontSize: 12 }}>
                          Module exists onchain but no local DEK found on this device. Import the exported JSON to edit or grant.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* ─ C-Step 3: Grant access ─ */}
              <div style={{ display: "flex", gap: 14 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                  {stepCircle(3, false, !custStep1Done)}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: !custStep1Done ? "rgba(255,255,255,0.28)" : "#fff", marginBottom: 12 }}>
                    Share with banks
                  </div>
                  {!custStep1Done ? (
                    <div style={{ ...card, opacity: 0.5 }}>
                      <div style={{ fontSize: 13, color: "rgba(255,255,255,0.35)" }}>Complete Step 1 to unlock.</div>
                    </div>
                  ) : (
                    <div style={card}>
                      <div style={{ display: "grid", gap: 10, gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", marginBottom: 14 }}>
                        <div>
                          <div style={labelStyle}>Expiry (days, 0 = forever)</div>
                          <input style={input} value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} />
                        </div>
                        <div>
                          <div style={labelStyle}>Purpose (hashed onchain)</div>
                          <input style={input} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
                        </div>
                      </div>
                      <div style={{ display: "grid", gap: 10, gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr" }}>
                        {(["bank-a", "bank-b"] as BankId[]).map((bank) => {
                          const uiAddr = bank === "bank-a" ? uiBankAAddr : uiBankBAddr;
                          return (
                            <div key={bank} style={miniCard}>
                              <div style={miniTitle}>{bankLabel(bank)}</div>
                              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.30)", marginBottom: 10, wordBreak: "break-all" }}>{uiAddr}</div>
                              <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                                <button style={btn} disabled={!canUseCustomer || !localPkgForSelected} onClick={() => grantToBank(bank)}>Grant</button>
                                <button style={btnSecondary} disabled={!canUseCustomer} onClick={() => revokeFromBank(bank)}>Revoke</button>
                              </div>
                              <div>
                                {accessStatusModules.map((m) => {
                                  const st = moduleAccessStatus(m, bank);
                                  const col = st === "granted" ? "#34d399" : st === "pending" ? "#fbbf24" : "rgba(255,255,255,0.28)";
                                  return (
                                    <div key={m.key} style={{ fontSize: 11, color: col, marginTop: 3 }}>
                                      {m.label}: {st === "granted" ? "granted ✓" : st === "pending" ? "pending…" : "no grant"}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div style={{ ...note, marginTop: 12, fontSize: 12 }}>
                        <strong style={{ color: "#fff" }}>Grant</strong> uploads ciphertext + wrapped DEK to the bank&apos;s storage and records onchain consent.
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ════ BANK JOURNEY ════ */}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", color: "rgba(255,255,255,0.35)", textTransform: "uppercase" }}>Bank Journey</div>
                <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.06)" }} />
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.28)" }}>MetaMask wallet</div>
              </div>

              {/* ─ B-Step 1: Connect MetaMask ─ */}
              <div style={{ display: "flex", gap: 14, marginBottom: 16 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                  {stepCircle(1, bankStep1Done, false)}
                  <div style={{ width: 1, flex: 1, background: "rgba(255,255,255,0.07)", marginTop: 6 }} />
                </div>
                <div style={{ flex: 1, paddingBottom: 20 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: bankStep1Done ? "#34d399" : "#fff", marginBottom: 12 }}>
                    Connect as bank
                  </div>
                  {bankStep1Done ? (
                    <div style={miniCard}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                        <div>
                          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.40)", marginBottom: 4 }}>MetaMask address</div>
                          <div style={{ ...mono, fontSize: 12 }}>{bankAddress}</div>
                        </div>
                        <button style={btnSecondary} onClick={disconnectBankWallet}>Disconnect</button>
                      </div>
                      {connectedBankId ? (
                        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#34d399", background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.20)", borderRadius: 999, padding: "3px 10px" }}>
                          Signed in as {bankLabel(connectedBankId)}
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: "#fbbf24", lineHeight: 1.5 }}>
                          Not a recognized bank address. Switch MetaMask to Bank A ({uiBankAAddr.slice(0, 10)}…) or Bank B ({uiBankBAddr.slice(0, 10)}…).
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={card}>
                      <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", marginBottom: 14, lineHeight: 1.5 }}>
                        Connect MetaMask with the Bank A or Bank B address to request and decrypt customer context.
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button style={btn} disabled={!mounted || bankBusy} onClick={connectBankWallet}>
                          {bankBusy ? "Connecting…" : "Connect MetaMask"}
                        </button>
                        {bankConnected && !bankOnRightChain && (
                          <button style={btnSecondary} onClick={switchBankChain}>Switch to chain {uiChainId}</button>
                        )}
                      </div>
                      {bankErr && (
                        <div style={{ ...note, marginTop: 10, color: "#f87171", borderColor: "rgba(239,68,68,0.25)" }}>{bankErr}</div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* ─ B-Step 2: Request access ─ */}
              <div style={{ display: "flex", gap: 14, marginBottom: 16 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                  {stepCircle(2, false, !bankStep1Done)}
                  <div style={{ width: 1, flex: 1, background: "rgba(255,255,255,0.07)", marginTop: 6 }} />
                </div>
                <div style={{ flex: 1, paddingBottom: 20 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: !bankStep1Done ? "rgba(255,255,255,0.28)" : "#fff", marginBottom: 12 }}>
                    Request access
                  </div>
                  {!bankStep1Done ? (
                    <div style={{ ...card, opacity: 0.5 }}>
                      <div style={{ fontSize: 13, color: "rgba(255,255,255,0.35)" }}>Complete Step 1 to unlock.</div>
                    </div>
                  ) : (
                    <div style={card}>
                      <div style={{ marginBottom: 12 }}>
                        <div style={labelStyle}>Module to request</div>
                        {renderModuleSelector(false)}
                        <div style={{ ...hint, marginTop: 6 }}>
                          ModuleId: <span style={mono}>{isBytes32(derivedBankModuleId) ? fmtShort(derivedBankModuleId) : "—"}</span>
                        </div>
                      </div>
                      <div style={{ marginBottom: 14 }}>
                        <div style={labelStyle}>Purpose</div>
                        <input style={input} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
                      </div>
                      {connectedBankId ? (
                        <button
                          style={btn}
                          disabled={!canUseBank || !isBankAddressSelected(connectedBankId)}
                          onClick={() => requestAccessAsMetaMask(connectedBankId)}
                        >
                          Request access as {bankLabel(connectedBankId)}
                        </button>
                      ) : (
                        <div style={{ ...note, fontSize: 12 }}>
                          Switch MetaMask to a recognized bank address to request access.
                        </div>
                      )}
                      <div style={{ marginTop: 16 }}>
                        <div style={labelStyle}>Access status</div>
                        {(["bank-a", "bank-b"] as BankId[]).map((bank) => (
                          <div key={bank} style={{ marginTop: 8 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.50)", marginBottom: 3 }}>{bankLabel(bank)}</div>
                            {accessStatusModules.map((m) => {
                              const st = moduleAccessStatus(m, bank);
                              const col = st === "granted" ? "#34d399" : st === "pending" ? "#fbbf24" : "rgba(255,255,255,0.28)";
                              return (
                                <div key={m.key} style={{ fontSize: 11, color: col, marginLeft: 8, marginTop: 2 }}>
                                  {m.label}: {st === "granted" ? "granted ✓" : st === "pending" ? "pending…" : "no grant"}
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ─ B-Step 3: Load & decrypt ─ */}
              <div style={{ display: "flex", gap: 14 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                  {stepCircle(3, false, !bankStep1Done)}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: !bankStep1Done ? "rgba(255,255,255,0.28)" : "#fff", marginBottom: 12 }}>
                    Load &amp; decrypt context
                  </div>
                  {!bankStep1Done ? (
                    <div style={{ ...card, opacity: 0.5 }}>
                      <div style={{ fontSize: 13, color: "rgba(255,255,255,0.35)" }}>Complete Step 1 to unlock.</div>
                    </div>
                  ) : (
                    <div style={card}>
                      <div style={{ ...miniCard, marginBottom: 14 }}>
                        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr" }}>
                          <div>
                            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.40)", marginBottom: 4 }}>Customer address (auto)</div>
                            <div style={{ ...mono, fontSize: 11 }}>{bankOwner || "—"}</div>
                          </div>
                          <div>
                            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.40)", marginBottom: 4 }}>Module ID (auto)</div>
                            <div style={{ ...mono, fontSize: 11 }}>{isBytes32(bankModuleId) ? fmtShort(bankModuleId) : "—"}</div>
                          </div>
                        </div>
                      </div>
                      {(["bank-a", "bank-b"] as BankId[]).map((bank) => {
                        const plain = bank === "bank-a" ? bankAPlain : bankBPlain;
                        const setPlain = bank === "bank-a" ? setBankAPlain : setBankBPlain;
                        const bankErrMsg = bank === "bank-a" ? bankAErr : bankBErr;
                        const isActive = connectedBankId === bank;
                        return (
                          <div key={bank} style={{ ...miniCard, marginBottom: 10, borderColor: isActive ? "rgba(245,158,11,0.28)" : "rgba(255,255,255,0.07)" }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                              <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{bankLabel(bank)}</div>
                              {isActive && (
                                <span style={{ fontSize: 11, color: "#fbbf24", fontWeight: 700 }}>active wallet ✓</span>
                              )}
                            </div>
                            <button
                              style={btn}
                              disabled={!ethers.isAddress(bankOwner) || !isBytes32(bankModuleId)}
                              onClick={() => bankLoadPlain(bank)}
                            >
                              Decrypt as {bankLabel(bank)}
                            </button>
                            {bankErrMsg && (
                              <div style={{ ...note, marginTop: 8, color: "#f87171", borderColor: "rgba(239,68,68,0.25)", fontSize: 12 }}>{bankErrMsg}</div>
                            )}
                            {plain && (
                              <textarea
                                style={{ ...input, height: 140, fontSize: 11, marginTop: 10, resize: "vertical" }}
                                value={plain}
                                onChange={(e) => setPlain(e.target.value)}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <WhyThisMatters />

        </div>
      </div>

      <style jsx global>{`
        input, select, textarea { transition: border-color 150ms; font-family: inherit; }
        input:focus, select:focus, textarea:focus { border-color: rgba(245,158,11,0.50) !important; outline: none; }
        input::placeholder, textarea::placeholder { color: rgba(255,255,255,0.22); }
        select option { background: #1a1a1a; color: #fff; }
        input[type="checkbox"] { accent-color: #f59e0b; cursor: pointer; width: 15px; height: 15px; }
        input:disabled, select:disabled, textarea:disabled { opacity: 0.42; cursor: not-allowed; }
        .wtm-tab {
          padding: 6px 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08);
          background: transparent; color: rgba(255,255,255,0.42); font-size: 12px; font-weight: 600;
          cursor: pointer; transition: all 150ms; font-family: inherit;
        }
        .wtm-tab:hover { color: rgba(255,255,255,0.68); border-color: rgba(255,255,255,0.14); }
        .wtm-tab-active { background: rgba(245,158,11,0.12); border-color: rgba(245,158,11,0.30); color: #fbbf24; }
        @keyframes wtmIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </>
  );
}

/* ---------- "Why this matters" (dark inline tabs) ---------- */

function WhyThisMatters() {
  const [tab, setTab] = useState(0);
  const TABS = ["What you do here", "Encryption", "On-Chain", "For Banks"];

  const outer:      React.CSSProperties = { marginTop: 32 };
  const heading:    React.CSSProperties = { fontSize: 18, fontWeight: 700, color: "#fff", margin: "0 0 6px" };
  const intro:      React.CSSProperties = { fontSize: 13, color: "rgba(255,255,255,0.65)", lineHeight: 1.55, margin: "0 0 16px" };
  const tabBar:     React.CSSProperties = { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 };
  const panel:      React.CSSProperties = { background: "rgba(255,255,255,0.032)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: 20 };
  const pTitle:     React.CSSProperties = { fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 4 };
  const pSub:       React.CSSProperties = { fontSize: 13, color: "rgba(255,255,255,0.60)", lineHeight: 1.55, marginBottom: 14 };
  const g2:         React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 };
  const wCard:      React.CSSProperties = { background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 14 };
  const wCardTitle: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: "#fff", marginBottom: 6 };
  const wCardText:  React.CSSProperties = { fontSize: 13, color: "rgba(255,255,255,0.68)", lineHeight: 1.5 };
  const wNote:      React.CSSProperties = { marginTop: 12, padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", fontSize: 12, color: "rgba(255,255,255,0.55)", lineHeight: 1.5 };
  const wPillRow:   React.CSSProperties = { marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" };
  const wPill:      React.CSSProperties = { display: "inline-flex", padding: "3px 9px", borderRadius: 999, background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.28)", fontSize: 12, fontWeight: 700, color: "#fbbf24" };
  const wList:      React.CSSProperties = { margin: "0 0 0 16px", padding: 0, color: "rgba(255,255,255,0.68)", fontSize: 13, lineHeight: 1.7 };

  const content = [
    /* 0 — What you do here */
    <div key="what" style={{ animation: "wtmIn 220ms ease both" }}>
      <div style={pTitle}>What you do here</div>
      <div style={pSub}>You create portable context modules and control who can decrypt them — with onchain-enforced consent.</div>
      <ul style={wList}>
        <li>Create or update three modules: <strong style={{ color: "#fff" }}>Suitability</strong>, <strong style={{ color: "#fff" }}>Sustainability</strong>, and <strong style={{ color: "#fff" }}>Service Scope</strong>.</li>
        <li>Each module is <strong style={{ color: "#fff" }}>encrypted locally</strong> and stored as a reusable package you can export.</li>
        <li>Grant access per bank with a <strong style={{ color: "#fff" }}>purpose</strong> and <strong style={{ color: "#fff" }}>expiry</strong> — revoke anytime, instantly.</li>
      </ul>
      <div style={wNote}><strong style={{ color: "#fff" }}>Key idea:</strong> the customer controls the data. Each bank only gets access when consent is explicit.</div>
    </div>,

    /* 1 — Encryption */
    <div key="enc" style={{ animation: "wtmIn 220ms ease both" }}>
      <div style={pTitle}>Encryption + key sharing</div>
      <div style={pSub}>Same ciphertext, different keys per bank — the plaintext never leaves the customer&apos;s device.</div>
      <div style={g2}>
        <div style={wCard}>
          <div style={wCardTitle}>Content encryption (AES-GCM)</div>
          <div style={wCardText}>Each module is encrypted using a unique data encryption key (DEK). Only ciphertext and hashes are transmitted.</div>
          <div style={wPillRow}><span style={wPill}>AES-GCM</span><span style={wPill}>Per-module DEK</span></div>
        </div>
        <div style={wCard}>
          <div style={wCardTitle}>Bank-specific access (RSA-OAEP)</div>
          <div style={wCardText}>When you grant access, the DEK is wrapped to that bank&apos;s public key and stored in that bank&apos;s own storage only.</div>
          <div style={wPillRow}><span style={wPill}>RSA-OAEP</span><span style={wPill}>Per-bank keys</span></div>
        </div>
      </div>
    </div>,

    /* 2 — On-Chain */
    <div key="chain" style={{ animation: "wtmIn 220ms ease both" }}>
      <div style={pTitle}>What goes on-chain (and what doesn&apos;t)</div>
      <div style={pSub}>The chain is the shared consent audit rail — not the data store.</div>
      <div style={g2}>
        <div style={wCard}>
          <div style={wCardTitle}>On-chain</div>
          <ul style={wList}>
            <li>Module commitments (content hash + policy hash + URI + label)</li>
            <li>Access requests, grants, and revocations with expiry</li>
          </ul>
        </div>
        <div style={wCard}>
          <div style={wCardTitle}>Off-chain</div>
          <ul style={wList}>
            <li>Encrypted module payload (ciphertext)</li>
            <li>Wrapped DEK stored per bank</li>
            <li>All plaintext preferences and PII</li>
          </ul>
        </div>
      </div>
    </div>,

    /* 3 — For Banks */
    <div key="banks" style={{ animation: "wtmIn 220ms ease both" }}>
      <div style={pTitle}>Why banks should care</div>
      <div style={pSub}>Portable onboarding + enforceable consent without data sprawl.</div>
      <div style={g2}>
        <div style={wCard}>
          <div style={wCardTitle}>Portability with control</div>
          <div style={wCardText}>Customers reuse a trusted context package across banks without re-entering data. Each bank only gets access when explicitly granted.</div>
        </div>
        <div style={wCard}>
          <div style={wCardTitle}>Operationally realistic</div>
          <div style={wCardText}>Banks store ciphertext in their own systems; the chain only carries consent. Revocation immediately blocks future decryptions.</div>
        </div>
      </div>
      <div style={wNote}>Once consent exists, banks can personalize onboarding, advice, and support — without ever storing raw customer data by default.</div>
    </div>,
  ];

  return (
    <div style={outer}>
      <h3 style={heading}>Why this matters</h3>
      <p style={intro}>Customer-owned context that moves between banks — with enforceable onchain consent and zero PII on the ledger.</p>
      <div style={tabBar}>
        {TABS.map((t, i) => (
          <button key={t} className={`wtm-tab${tab === i ? " wtm-tab-active" : ""}`} onClick={() => setTab(i)}>{t}</button>
        ))}
      </div>
      <div style={panel}>{content[tab]}</div>
    </div>
  );
}

/* ---------- Dark theme style constants ---------- */

const card: React.CSSProperties = {
  background: "rgba(255,255,255,0.032)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 16,
  padding: 16,
};

const bankACard: React.CSSProperties = {
  background: "rgba(59,130,246,0.07)",
  border: "1px solid rgba(59,130,246,0.18)",
  borderRadius: 16,
  padding: 16,
};

const bankBCard: React.CSSProperties = {
  background: "rgba(16,185,129,0.07)",
  border: "1px solid rgba(16,185,129,0.18)",
  borderRadius: 16,
  padding: 16,
};

const grid2: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
  gap: 14,
  marginTop: 14,
};

const miniCard: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: 12,
  padding: 12,
};

const miniTitle: React.CSSProperties = {
  fontSize: 11,
  color: "rgba(255,255,255,0.55)",
  fontWeight: 700,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  marginBottom: 8,
};

const btn: React.CSSProperties = {
  padding: "9px 14px",
  borderRadius: 10,
  border: "1px solid #f59e0b",
  background: "#f59e0b",
  color: "#000",
  fontWeight: 700,
  cursor: "pointer",
  fontSize: 13,
};

const btnSecondary: React.CSSProperties = {
  padding: "9px 14px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.10)",
  background: "rgba(255,255,255,0.06)",
  color: "rgba(255,255,255,0.78)",
  fontWeight: 700,
  cursor: "pointer",
  fontSize: 13,
};

const linkBtn: React.CSSProperties = {
  ...btnSecondary,
  textDecoration: "none",
  display: "inline-flex",
  alignItems: "center",
};

const input: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid rgba(255,255,255,0.10)",
  borderRadius: 10,
  padding: "9px 12px",
  outline: "none",
  background: "rgba(255,255,255,0.05)",
  color: "#fff",
  fontSize: 13,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "rgba(255,255,255,0.62)",
  fontWeight: 700,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  marginBottom: 6,
};

const hint: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  color: "rgba(255,255,255,0.55)",
  lineHeight: 1.55,
};

const mono: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  fontSize: 13,
  wordBreak: "break-all",
  color: "rgba(255,255,255,0.80)",
};

const note: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(255,255,255,0.04)",
  padding: 12,
  borderRadius: 12,
  color: "rgba(255,255,255,0.75)",
  lineHeight: 1.6,
  fontSize: 13,
};

const checkWrap: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  color: "rgba(255,255,255,0.70)",
  cursor: "pointer",
};
