// use-cases/uc8-tempo/lib/corridor.ts
//
// UC8 · Act 1 corridor engine — the single source of truth for the rule cards.
//
// Pure function, NO chain dependency: getCorridorRules(from, to, amountCHF) returns a
// five-row compliance result that rewrites itself per corridor. Each row is written for a
// non-expert: a shared plain-language `headline` (what the rule is really about), then the
// per-corridor `meaning` (the so-what here), `setupOnce` (what Limmat does the first time it
// opens the corridor) and `perPayment` (what runs on each transfer), plus a `source` footnote.
//
// Headlines are CONSTANT across corridors; only meaning/setupOnce/perPayment/source vary.
// Every unconfirmed figure carries a `// VERIFY` comment next to it (kept out of the UI text).

export type Jurisdiction = "CH" | "US" | "EU" | "NG";

// Status vocabulary (drives the Act-1 card colours):
//   green = cleared | applies      amber = below_threshold | unverified
//   red   = manual_review          info  = restricted
export type RuleStatus =
  | "applies"
  | "below_threshold"
  | "unverified"
  | "manual_review"
  | "cleared"
  | "restricted";

export type RuleKey =
  | "travel_rule"
  | "counterparty"
  | "sanctions"
  | "recipient_licence"
  | "data_secrecy";

export type CorridorRow = {
  key: RuleKey;
  label: string; // rule name (collapsed-chip label)
  status: RuleStatus;
  headline: string; // plain-language, SAME for all corridors — the only line you must read
  meaning: string; // the so-what for THIS corridor
  setupOnce: string; // what Limmat does the first time it opens this corridor
  perPayment: string; // what runs on each individual transfer
  source: string; // small grey footnote: the regulation name
};

export type CorridorResult = {
  from: Jurisdiction;
  to: Jurisdiction;
  amountCHF: number;
  tag: string; // e.g. "CH→NG"
  rows: CorridorRow[];
};

// ── Thresholds ──
export const CH_TRAVEL_RULE_CHF = 1000; // VERIFY  AMLO-FINMA Art. 10 (Switzerland)
export const US_FINCEN_USD = 3000; // VERIFY  FinCEN BSA travel rule: USD 3,000 "or more"
// EU TFR: ZERO de-minimis threshold between CASPs (in force 30 Dec 2024) — no constant needed.

// Rule names for the collapsed chip.
const LABEL: Record<RuleKey, string> = {
  travel_rule: "Travel rule",
  counterparty: "Counterparty",
  sanctions: "Sanctions",
  recipient_licence: "Recipient licence",
  data_secrecy: "Data / privacy",
};

// Headlines — constant across every corridor (the so-what of the rule itself).
const HEADLINE: Record<RuleKey, string> = {
  travel_rule:
    "Money can't travel anonymously — the sender's identity rides along with the payment.",
  counterparty:
    "Limmat must know who's catching the money on the other side, not just who receives it.",
  sanctions:
    "Check that neither sender nor recipient is on a blocked-persons list before money moves.",
  recipient_licence:
    "Is the receiving business actually allowed to handle this money where it operates?",
  data_secrecy:
    "The payment carries personal data, and privacy rules limit who may see it.",
};

// Shared content (identical wherever it appears, so it lives once).
const TRAVEL_SETUP =
  "Build the secure channel that carries sender and recipient details with each transfer.";
const TRAVEL_PER =
  "Attach Amara's verified identity and the recipient's details to this transfer.";
const TRAVEL_SRC = "Swiss AMLO-FINMA Art. 10 · from CHF 1,000"; // VERIFY figure
const SANCTIONS_SETUP =
  "Connect Limmat's screening to the official watchlists and set the matching rules.";
const SANCTIONS_PER =
  "Screen both names live; a hit would freeze this transfer for review.";
const DATA_PER =
  "Keep identity details off-chain and encrypted; only a reference goes on-chain.";
const DATA_SETUP =
  "Set up encryption and agree what data may cross the border and how it's stored.";

const chf = (n: number) => n.toLocaleString("en-US");

function makeRow(
  key: RuleKey,
  status: RuleStatus,
  c: { meaning: string; setupOnce: string; perPayment: string; source: string },
): CorridorRow {
  return { key, label: LABEL[key], status, headline: HEADLINE[key], ...c };
}

// The Swiss originator-side travel-rule duty is identical across corridors (from = CH); only
// the `meaning` differs per corridor, so each corridor passes its own line in.
function travelRow(amountCHF: number, meaning: string): CorridorRow {
  const applies = amountCHF >= CH_TRAVEL_RULE_CHF; // VERIFY CHF 1,000
  return makeRow("travel_rule", applies ? "applies" : "below_threshold", {
    meaning,
    setupOnce: TRAVEL_SETUP,
    perPayment: TRAVEL_PER,
    source: TRAVEL_SRC,
  });
}

const travelBelow = (amountCHF: number) =>
  `At CHF ${chf(amountCHF)} this is under the CHF 1,000 reporting line, so the Swiss travel-rule duty isn't triggered this time.`;

// ── CH → Nigeria (Lagos, family) ──
function corridorNG(amountCHF: number): CorridorRow[] {
  const applies = amountCHF >= CH_TRAVEL_RULE_CHF;
  return [
    travelRow(
      amountCHF,
      applies
        ? `At CHF ${chf(amountCHF)} this is over the line, so Limmat must attach who Amara is before the money leaves.`
        : travelBelow(amountCHF),
    ),
    makeRow("counterparty", "unverified", {
      meaning:
        "Nigeria's licensing regime is new, so Limmat can't assume the receiving institution is properly supervised — it checks rather than trusts.",
      setupOnce:
        "Vet the Lagos partner, confirm its licence, and agree how both sides exchange data.",
      perPayment:
        "Confirm this transfer goes to that vetted partner and nowhere unchecked.",
      source: "Nigeria ISA 2025 · SEC VASP licensing", // VERIFY
    }),
    makeRow("sanctions", "cleared", {
      meaning:
        "Amara and her family screened clean against the Swiss and US lists, so this payment can proceed.",
      setupOnce: SANCTIONS_SETUP,
      perPayment: SANCTIONS_PER,
      source: "SECO (CH), OFAC (USD settlement leg)",
    }),
    makeRow("recipient_licence", "manual_review", {
      meaning:
        "A Nigerian licence exists on paper but the regime is young, so a person signs off this corridor rather than letting it run fully automatically.",
      setupOnce:
        "Record the partner's licence and set the risk rules for what auto-approves vs reviews.",
      perPayment:
        "A compliance officer reviews transfers on this corridor until confidence is high enough to automate.",
      source: "Nigeria ISA 2025 · risk-based reliance (FATF)", // VERIFY
    }),
    makeRow("data_secrecy", "restricted", {
      meaning:
        "Swiss banking secrecy and Nigeria's data rules both apply, so sensitive details stay protected and only a reference travels on-chain.",
      setupOnce: DATA_SETUP,
      perPayment: DATA_PER,
      source: "Swiss bank-client confidentiality; Nigerian data-protection law",
    }),
  ];
}

// ── CH → United States (New York, son) ──
function corridorUS(amountCHF: number): CorridorRow[] {
  // VERIFY: FinCEN is denominated in USD; this demo compares CHF directly against 3,000 (CHF ≈ USD ~1:1).
  const travelApplies = amountCHF >= CH_TRAVEL_RULE_CHF;
  const counterApplies = amountCHF >= US_FINCEN_USD; // VERIFY USD 3,000
  return [
    travelRow(
      amountCHF,
      !travelApplies
        ? travelBelow(amountCHF)
        : counterApplies
          ? "Switzerland reports above CHF 1,000, and above USD 3,000 the US side requires it too, so identity data travels in both directions on this payment."
          : "Switzerland reports above CHF 1,000 wherever the money goes, so Amara's identity travels with this payment — even though, as Counterparty shows, the US side wouldn't require it at this size.",
    ),
    makeRow("counterparty", counterApplies ? "applies" : "below_threshold", {
      meaning: counterApplies
        ? `At ~CHF ${chf(amountCHF)} this is over the USD 3,000 line, so both the US side and Limmat exchange full sender and recipient details on this transfer.`
        : `The US only obliges the receiving side to exchange sender info above USD 3,000. At ~CHF ${chf(amountCHF)} this sits just under, so the US side isn't required to match Limmat's data here — though Limmat still sends it.`,
      setupOnce:
        "Confirm the US receiving institution is a registered, supervised money transmitter or bank.",
      perPayment:
        "Check the amount against the USD 3,000 line; above it, both sides must exchange full details.",
      source: "US FinCEN BSA · threshold USD 3,000", // VERIFY
    }),
    makeRow("sanctions", "cleared", {
      meaning:
        "Amara and her son screened clean against the Swiss and US lists, so this payment can proceed.",
      setupOnce: SANCTIONS_SETUP,
      perPayment: SANCTIONS_PER,
      source: "SECO (CH), OFAC (US)",
    }),
    makeRow("recipient_licence", "cleared", {
      meaning:
        "The US recipient is a licensed, supervised money transmitter or bank, so this corridor can run automatically.",
      setupOnce: "Record the recipient institution's licence or registration.",
      perPayment: "Auto-check the recipient is still the licensed institution on file.",
      source: "US FinCEN MSB / bank charter",
    }),
    makeRow("data_secrecy", "restricted", {
      meaning:
        "Swiss secrecy is strict; the US has no single federal privacy law but a patchwork of state rules, so Limmat protects the data to the stricter Swiss standard.",
      setupOnce: DATA_SETUP,
      perPayment: DATA_PER,
      source: "Swiss bank-client confidentiality; US state privacy laws", // VERIFY
    }),
  ];
}

// ── CH → European Union (Lisbon, father) ──
function corridorEU(amountCHF: number): CorridorRow[] {
  const applies = amountCHF >= CH_TRAVEL_RULE_CHF;
  return [
    travelRow(
      amountCHF,
      applies
        ? "Switzerland reports above CHF 1,000, and the EU side reports from the very first euro, so identity data must travel in both directions on this payment."
        : `At CHF ${chf(amountCHF)} this is under the CHF 1,000 Swiss reporting line; the EU side still reports from the first euro, but the Swiss originator duty isn't triggered here.`,
    ),
    makeRow("counterparty", "applies", {
      meaning:
        "The EU requires the receiving provider to exchange sender and recipient data on every transfer with no minimum, so the Lisbon side must match Limmat's data even on small amounts.",
      setupOnce:
        "Confirm the EU receiving institution is an authorised CASP and agree the data exchange.",
      perPayment:
        "Exchange full sender and recipient details with the EU provider, regardless of size.",
      source: "EU Transfer of Funds Regulation · zero threshold", // VERIFY
    }),
    makeRow("sanctions", "cleared", {
      meaning:
        "Amara and her father screened clean against the Swiss and EU lists, so this payment can proceed.",
      setupOnce: SANCTIONS_SETUP,
      perPayment: SANCTIONS_PER,
      source: "SECO (CH), EU consolidated list",
    }),
    makeRow("recipient_licence", "cleared", {
      meaning:
        "The Lisbon recipient is an authorised payment or e-money provider under EU rules, so this corridor can run automatically.",
      setupOnce: "Record the CASP / e-money authorisation.",
      perPayment: "Auto-check the recipient remains the authorised provider on file.",
      source: "EU MiCA / e-money authorisation", // VERIFY
    }),
    makeRow("data_secrecy", "restricted", {
      meaning:
        "Both Swiss secrecy and the EU's GDPR protect this data, so there must be a lawful basis to send it and it stays protected end to end.",
      setupOnce: "Establish the GDPR lawful basis and the data-handling agreement.",
      perPayment: DATA_PER,
      source: "Swiss bank-client confidentiality; EU GDPR",
    }),
  ];
}

// Defensive default so the function stays total for any unmodelled corridor.
function corridorGeneric(
  from: Jurisdiction,
  to: Jurisdiction,
  amountCHF: number,
): CorridorRow[] {
  const applies = amountCHF >= CH_TRAVEL_RULE_CHF;
  return [
    travelRow(
      amountCHF,
      applies
        ? `At CHF ${chf(amountCHF)} the Swiss travel-rule duty applies, so identity rides with the payment.`
        : travelBelow(amountCHF),
    ),
    makeRow("counterparty", "unverified", {
      meaning: `Corridor ${from}→${to} isn't modelled in this demo, so the receiving institution must be assessed by hand.`,
      setupOnce: "Vet the receiving institution and agree how both sides exchange data.",
      perPayment: "Confirm this transfer reaches the vetted institution and nowhere unchecked.",
      source: "Manual assessment",
    }),
    makeRow("sanctions", "manual_review", {
      meaning: "Run full sanctions screening for this unmodelled corridor before releasing funds.",
      setupOnce: SANCTIONS_SETUP,
      perPayment: SANCTIONS_PER,
      source: "Applicable national / regional lists",
    }),
    makeRow("recipient_licence", "manual_review", {
      meaning: `Recipient licensing for ${to} isn't modelled, so a person verifies it before this corridor runs.`,
      setupOnce: "Record the recipient's licence and set the risk rules for what auto-approves vs reviews.",
      perPayment: "A compliance officer reviews transfers on this corridor.",
      source: "Local licensing regime",
    }),
    makeRow("data_secrecy", "restricted", {
      meaning: "Apply the strictest data-protection regime for this corridor; only a reference travels on-chain.",
      setupOnce: DATA_SETUP,
      perPayment: DATA_PER,
      source: "Swiss bank-client confidentiality; local data-protection law",
    }),
  ];
}

/**
 * Pure function of (from, to, amountCHF). For the demo `from` is always "CH" and
 * `to` ∈ { NG, US, EU }; other corridors fall back to a defensive generic result.
 */
export function getCorridorRules(
  from: Jurisdiction,
  to: Jurisdiction,
  amountCHF: number,
): CorridorResult {
  let rows: CorridorRow[];
  if (from === "CH" && to === "NG") rows = corridorNG(amountCHF);
  else if (from === "CH" && to === "US") rows = corridorUS(amountCHF);
  else if (from === "CH" && to === "EU") rows = corridorEU(amountCHF);
  else rows = corridorGeneric(from, to, amountCHF);
  return { from, to, amountCHF, tag: `${from}→${to}`, rows };
}

// ─────────────────────────────────────────────────────────────────────────────
// Act 1 send sequence — the walk-through Amara sees when she hits Send.
//
// Derived ENTIRELY from a CorridorResult: the steps, their one-line narration and
// their resolution all come from the rule statuses, so the send component hardcodes
// nothing. The framing is the rule cards' two columns made literal — the "Set up once"
// work is assumed done, and the user watches the "Every payment" work execute.
// Compliance steps (1-3) gate the money; settlement (step 4) is the LIVE on-chain
// transfer and only fires when every compliance step cleared (NG stays held).
// ─────────────────────────────────────────────────────────────────────────────

export type SendLane = "compliance" | "settlement";
export type SendOutcome = "done" | "held" | "flagged";
export type SendStepKey = "screen" | "envelope" | "confirm" | "settle";

export type SendStep = {
  key: SendStepKey;
  lane: SendLane;
  label: string;
  narration: string; // one line, from the engine — never hardcoded in the UI
  maps: RuleKey[]; // rule chips to highlight while this step runs
  outcome: SendOutcome; // terminal state; for settle + "done" the component runs the LIVE transfer
  live: boolean; // true only for settlement (the real mUSDC transfer + memo)
};

/** Build the four-step Act-1 send walk-through from a corridor result. Pure; UI-free. */
export function getSendSequence(result: CorridorResult): SendStep[] {
  const statusOf = (k: RuleKey): RuleStatus =>
    result.rows.find((r) => r.key === k)?.status ?? "manual_review";

  const sanctions = statusOf("sanctions");
  const counterparty = statusOf("counterparty");
  const licence = statusOf("recipient_licence");

  const screenOutcome: SendOutcome = sanctions === "manual_review" ? "flagged" : "done";
  // The receiving side needs a human whenever the licence is under manual review or the
  // counterparty is unverified — NG hits both; US and EU clear.
  const confirmHeld = licence === "manual_review" || counterparty === "unverified";
  const confirmOutcome: SendOutcome = confirmHeld ? "held" : "done";

  // Settlement only fires when every compliance step cleared. NG stays held — never auto-settles.
  const blocked = screenOutcome !== "done" || confirmOutcome !== "done";
  const settleOutcome: SendOutcome = blocked ? "held" : "done";

  let confirmNarration: string;
  if (confirmHeld) {
    confirmNarration =
      result.to === "NG"
        ? "Confirming the vetted Lagos partner — this corridor is held for a compliance check."
        : "Confirming the receiving institution — this corridor is held for manual review.";
  } else if (result.to === "US") {
    confirmNarration =
      counterparty === "applies"
        ? "Recipient is a registered institution; above the USD 3,000 line, both sides exchange full details." // VERIFY USD 3,000
        : "Recipient is a registered institution; amount is under the USD 3,000 line."; // VERIFY USD 3,000
  } else if (result.to === "EU") {
    confirmNarration = "Exchanging full details with the authorised EU provider.";
  } else {
    confirmNarration = "Receiving institution confirmed for this corridor.";
  }

  const settleNarration = blocked
    ? "Held for review — settlement won't fire until the corridor is cleared."
    : "Value settles on Tempo."; // settles in ~3s for ~$0.001 — shown live // VERIFY figures

  return [
    {
      key: "screen", lane: "compliance", label: "Screen both parties", maps: ["sanctions"],
      narration: "Checking Amara and the recipient against the watchlists.",
      outcome: screenOutcome, live: false,
    },
    {
      key: "envelope", lane: "compliance", label: "Attach identity envelope", maps: ["travel_rule", "data_secrecy"],
      narration: "Sealing Amara's verified identity to the payment; only a reference goes on-chain.",
      outcome: "done", live: false,
    },
    {
      key: "confirm", lane: "compliance", label: "Confirm the receiving side", maps: ["counterparty", "recipient_licence"],
      narration: confirmNarration, outcome: confirmOutcome, live: false,
    },
    {
      key: "settle", lane: "settlement", label: "Settle on the rail", maps: [],
      narration: settleNarration, outcome: settleOutcome, live: true,
    },
  ];
}
