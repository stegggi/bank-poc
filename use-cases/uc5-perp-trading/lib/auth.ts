// lib/uc5/auth.ts
import { getAddress, verifyMessage, verifyTypedData } from "ethers";

export function normAddr(a: string) {
  return getAddress(a);
}

export function isOwner(address: string, owner: string) {
  try {
    return normAddr(address) === normAddr(owner);
  } catch {
    return false;
  }
}

export function buildAdminMessage(params: {
  action: string;
  nonce: string;
  issuedAt: number;
  payload: any;
}) {
  return [
    "UC5_ADMIN_ACTION",
    `action=${params.action}`,
    `nonce=${params.nonce}`,
    `issuedAt=${params.issuedAt}`,
    `payload=${JSON.stringify(params.payload)}`,
  ].join("\n");
}

export function verifyAdminSignature(params: {
  owner: string;
  address: string;
  signature: string;
  action: string;
  nonce: string;
  issuedAt: number;
  payload: any;
  maxSkewSeconds?: number;
}) {
  const skew = params.maxSkewSeconds ?? 300; // 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - params.issuedAt) > skew) return { ok: false, error: "Signature expired" };

  const msg = buildAdminMessage({
    action: params.action,
    nonce: params.nonce,
    issuedAt: params.issuedAt,
    payload: params.payload,
  });

  let recovered = "";
  try {
    recovered = verifyMessage(msg, params.signature);
  } catch {
    return { ok: false, error: "Bad signature" };
  }

  if (!isOwner(recovered, params.owner) || !isOwner(params.address, params.owner)) {
    return { ok: false, error: "Not owner" };
  }
  return { ok: true };
}

export function verifyLinkSignerSenderSig(params: {
  owner: string;
  domain: any;
  values: {
    sender: string;
    signer: string;
    subaccount: string;
    nonce: string;
    signedAt: number;
  };
  signature: string;
}) {
  const types = {
    LinkSigner: [
      { name: "sender", type: "address" },
      { name: "signer", type: "address" },
      { name: "subaccount", type: "bytes32" },
      { name: "nonce", type: "uint64" },
      { name: "signedAt", type: "uint64" },
    ],
  };

  let recovered = "";
  try {
    recovered = verifyTypedData(params.domain, types, params.values, params.signature);
  } catch {
    return { ok: false, error: "Bad EIP-712 signature" };
  }

  if (!isOwner(recovered, params.owner) || !isOwner(params.values.sender, params.owner)) {
    return { ok: false, error: "Sender is not owner" };
  }
  return { ok: true };
}
