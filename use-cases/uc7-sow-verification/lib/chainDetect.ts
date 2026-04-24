import type { ChainDetection, ChainFamily } from "./types";

const BASE58_CHARS = /^[1-9A-HJ-NP-Za-km-z]+$/;

function isBase58(input: string): boolean {
  return BASE58_CHARS.test(input);
}

export function detectChain(raw: string): ChainDetection {
  const address = raw.trim();

  if (!address) {
    return { chainFamily: "unknown", address };
  }

  // Bitcoin native SegWit / Taproot
  if (/^bc1q[a-z0-9]{6,}$/i.test(address)) {
    return { chainFamily: "bitcoin", subtype: "segwit", address };
  }
  if (/^bc1p[a-z0-9]{6,}$/i.test(address)) {
    return { chainFamily: "bitcoin", subtype: "taproot", address };
  }

  // EVM
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return { chainFamily: "evm", address };
  }

  // Cosmos
  if (/^cosmos1[a-z0-9]{20,}$/i.test(address)) {
    return { chainFamily: "cosmos", address };
  }

  // Cardano
  if (/^addr1[a-z0-9]{20,}$/i.test(address)) {
    return { chainFamily: "cardano", address };
  }

  // Tron (starts with T, 34 chars, Base58)
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address) && address.length === 34) {
    return { chainFamily: "tron", address };
  }

  // XRP Ledger
  if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address)) {
    return { chainFamily: "xrp", address };
  }

  // Bitcoin P2PKH
  if (/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address) && address.length >= 26 && address.length <= 35) {
    return { chainFamily: "bitcoin", subtype: "p2pkh", address };
  }
  // Bitcoin P2SH
  if (/^3[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address) && address.length >= 26 && address.length <= 35) {
    return { chainFamily: "bitcoin", subtype: "p2sh", address };
  }

  // Solana (Base58 32-44 chars, no chain-specific prefix)
  if (isBase58(address) && address.length >= 32 && address.length <= 44) {
    return { chainFamily: "solana", address };
  }

  return { chainFamily: "unknown", address };
}

export function chainFamilyLabel(family: ChainFamily): string {
  switch (family) {
    case "evm": return "EVM";
    case "bitcoin": return "Bitcoin";
    case "solana": return "Solana";
    case "tron": return "Tron";
    case "cosmos": return "Cosmos";
    case "cardano": return "Cardano";
    case "xrp": return "XRP Ledger";
    default: return "Unknown";
  }
}
