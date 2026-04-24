# UC8 — Crypto Source of Funds Verification

A compliance tool for onboarding clients who hold crypto assets. Verifies wallet ownership,
traces incoming funds to regulated exchanges, classifies risk into GREEN / AMBER / RED tiers,
and produces a FINMA-ready compliance report per client.

## Flow

1. **Case setup** — compliance officer creates a case for a client and adds wallet addresses.
   Chain family is auto-detected (EVM, Bitcoin, Solana, Tron, Cosmos, Cardano, XRP). Each EVM
   address is scanned across Ethereum, Base, Arbitrum, Polygon, BSC, and Optimism.

2. **Ownership verification** — a PII-free challenge message is generated per wallet. A QR code
   encodes a link to a signing page; the client signs the challenge from their wallet app
   (`/uc8-sign/[challengeId]`). EVM and Solana signatures are verified cryptographically; Bitcoin
   is out-of-band for this prototype.

3. **Source trace** — backward trace through incoming transactions, identifying counterparties
   via OFAC SDN screening, exchange tier database, and DEX/bridge/contract labels. Hop depth is
   configurable per case (default: 3).

4. **Risk classification** — deterministic rules map trace coverage, exchange tiers, and
   sanctions hits to GREEN / AMBER / RED.

5. **TTP escalation** (RED only) — mock third-party analytics provider returns a forensic report
   (risk score, exposure breakdown, flagged counterparties). Swap in Chainalysis / Elliptic by
   implementing the `TTPProvider` interface in `lib/ttpEscalation.ts`.

6. **PDF report** — a print-to-PDF HTML page per case, structured for the client file and FINMA
   audit, with embedded fund flow SVG.

## Key files

- `lib/chainDetect.ts` — regex-based chain detection
- `lib/multiChainScan.ts` — Etherscan V2 + Blockstream + Solana RPC
- `lib/ownershipChallenge.ts` — EVM + Solana signature verification
- `lib/labelDatabase.ts` — OFAC + eth-labels + exchange tier lookup
- `lib/backwardTrace.ts` — BFS source tracing
- `lib/riskClassifier.ts` — classification rules
- `lib/ttpEscalation.ts` — pluggable TTP provider (Mock included)
- `lib/fundFlowGraph.ts` — SVG layout + React component
- `pdf/generateReport.ts` — HTML report (print-to-PDF)

## Environment

```
BLOB_READ_WRITE_TOKEN=   # Required in prod — case/challenge storage via Vercel Blob
ETHERSCAN_API_KEY=       # Required for EVM scan + trace
HELIUS_API_KEY=          # Optional, falls back to public RPC
COINGECKO_API_KEY=       # Optional for price conversion
TTP_PROVIDER=mock        # mock | chainalysis | elliptic
TTP_API_KEY=             # For real TTP providers
MAX_HOP_DEPTH=3
```

## Data

- `data/exchange-tiers.json` — exchange classification DB (Tier A/B/C + known hot wallets)
- `data/ofac-sdn-addresses.json` — OFAC SDN seed set
- `data/known-dex-labels.json` — DEX routers, bridges, staking, tokens

Cases and challenges are stored in Vercel Blob (`cases/{ref}.json`, `challenges/{id}.json`).
Without `BLOB_READ_WRITE_TOKEN` set, the stores transparently fall back to local disk under
`data/cases/` and `data/challenges/` for development.

## API routes

```
POST /api/uc8/case              create case
GET  /api/uc8/case              list cases
GET  /api/uc8/case/[id]         get case
PUT  /api/uc8/case/[id]         update case

POST /api/uc8/scan              scan wallet address
POST /api/uc8/challenge         generate ownership challenge
GET  /api/uc8/challenge/[id]    get challenge
POST /api/uc8/verify-signature  verify signed challenge
POST /api/uc8/trace             backward trace wallet
POST /api/uc8/classify          classify wallets in case
POST /api/uc8/escalate          send wallet to TTP
GET  /api/uc8/report/[caseId]   view HTML compliance report
POST /api/uc8/report/[caseId]   finalize + view HTML report
GET  /api/uc8/qr?data=...       QR code SVG
```

## Prototype constraints

- JSON file storage (no database)
- Single user (no auth)
- Bitcoin signature verification handled out-of-band
- TTP provider mocked (pluggable interface for real providers)
- Fund flow layout is a custom SVG — no graph library dependency
- PDF via print-to-PDF on the HTML report page (no pdfkit / headless browser needed)
