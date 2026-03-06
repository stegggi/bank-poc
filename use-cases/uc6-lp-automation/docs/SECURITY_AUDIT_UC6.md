# UC6 Security Audit

## Scope
UC6 is a real-money LP bot on Base plus a Next.js dashboard on Vercel. This audit covers:

- `uc6-lp-bot/*`
- `pages/api/uc6/*`
- `lib/uc6OwnerAuth.ts`
- `scripts/uc6-lp-bot.service`
- VM deployment and operating assumptions

## Threat Model
### Assets
- Hot-wallet private key on the VM
- Admin bearer token between Next.js and bot
- Owner authority bound to a MetaMask address
- Bot settings, state, lifecycle records, and event history
- Live trading capital in wallet and LP NFTs

### Attacker Capabilities
- Internet access to public UC6 HTTP endpoints
- Ability to replay signed requests if nonce or expiry handling is weak
- Ability to send malformed or oversized requests
- Ability to abuse public polling endpoints for DoS
- Ability to influence one RPC provider or feed inconsistent reads
- Ability to observe and front-run public transactions on Base
- Local VM access after another compromise or bad permissions

### Security Goals
- Prevent unauthorized owner actions
- Prevent replay of signed owner requests
- Avoid leaking bearer tokens, private keys, or sensitive env values
- Keep the bot fail-safe under malformed input, provider errors, and rate-limit abuse
- Reduce blast radius if the VM or one RPC provider misbehaves

## Attack Surface Map
```text
Browser (MetaMask)
  -> Next.js /api/uc6/challenge
  -> Next.js /api/uc6/owner/*
      -> Bot /owner/* with Bearer + signed payload
      -> Bot verifies signature, nonce, owner, payload hash

Dashboard polling
  -> Next.js /api/uc6/status
  -> Next.js /api/uc6/positions
      -> Bot /status, /positions

Bot runtime
  -> RPC providers (Infura / Ankr / Base public)
  -> Base contracts (router, quoter, NPM, pools, ERC20s)
  -> Filesystem (/opt/uc6-bot/.env, settings.json, state.json, positions.json, events.jsonl)
  -> systemd / journald / Linux network exposure
```

## What I Would Try As An Attacker
- Replay an old valid owner signature after a network timeout.
  Mitigation: single-use challenge store in Next.js plus single-use nonce cache in bot; both now burn nonces on use. Evidence: `lib/uc6OwnerAuth.ts:297`, `pages/api/uc6/owner/settings.ts:102`, `uc6-lp-bot/uc6-bot.mjs:8786`.
- Brute-force or timing-probe the bearer token on bot `/owner/*`.
  Mitigation: bot now uses constant-time bearer comparison and still requires a valid signature. Evidence: `uc6-lp-bot/lib/security.mjs:24`, `uc6-lp-bot/uc6-bot.mjs:8770`.
- Send huge JSON bodies to exhaust memory or tie up the bot.
  Mitigation: 64 KB body limits in Next.js owner routes and bot-side JSON reader. Evidence: `pages/api/uc6/owner/settings.ts:22`, `pages/api/uc6/challenge.ts:23`, `uc6-lp-bot/uc6-bot.mjs:1286`.
- Abuse `/status` or `/positions` from the public internet.
  Mitigation: per-IP rate limits in Next.js and bot. Evidence: `pages/api/uc6/status.ts:29`, `uc6-lp-bot/uc6-bot.mjs:9043`.
- Mine logs for secrets or admin headers after an upstream error.
  Mitigation: error/log redaction of bearer tokens, env keys, and Infura project URLs. Evidence: `uc6-lp-bot/lib/security.mjs:3`, `uc6-lp-bot/uc6-bot.mjs:2075`.
- Exploit an overly permissive systemd service to read or modify host files.
  Mitigation: hardened unit sandbox with `ProtectSystem=strict`, `PrivateDevices`, `RestrictAddressFamilies`, `LockPersonality`, and `UMask=0077`. Evidence: `scripts/uc6-lp-bot.service:15`.

## Findings
| ID | Severity | Component | Attack scenario | Preconditions | Impact | Evidence (file/line) | Fix now (patch) | Fix later (manual/infra) |
|---|---|---|---|---|---|---|---|---|
| UC6-001 | Critical | Hot wallet on VM | Attacker gains shell or reads `.env`, then signs arbitrary txs | VM compromise or bad file perms | Full fund loss | `uc6-lp-bot/uc6-bot.mjs:62`, `scripts/deploy-uc6.sh:18` | Redacted logs and stronger unit defaults reduce accidental leakage | Move key to KMS/HSM or isolated signer; tighten VM access |
| UC6-002 | Critical | Owner replay protection | Reuse a previously valid signed owner request | Captured signed payload before expiry | Unauthorized settings or action replay | `lib/uc6OwnerAuth.ts:297`, `pages/api/uc6/owner/settings.ts:102`, `uc6-lp-bot/uc6-bot.mjs:8786` | Enforced single-use challenge burn in Next.js and single-use nonce burn in bot | Persist replay cache across restarts if threat model requires it |
| UC6-003 | High | Bot owner auth | Probe bearer token via timing side-channel or header comparison quirks | Network access to `/owner/*` | Owner action bypass attempt | `uc6-lp-bot/uc6-bot.mjs:8770`, `uc6-lp-bot/lib/security.mjs:24` | Constant-time bearer comparison | Prefer binding bot to loopback or tunnel-only admin path |
| UC6-004 | High | Settings validation | Submit unknown keys or malformed nested settings to confuse normalization | Owner route access or compromised dashboard flow | Unexpected behavior, silent coercion | `lib/uc6OwnerAuth.ts:527` | Added explicit whitelist and sane range checks for owner-editable settings | Consider generating schemas from one source of truth |
| UC6-005 | High | HTTP DoS | Oversized request bodies or overly frequent owner/public calls exhaust memory or workers | Public endpoint access | Bot/API degradation | `uc6-lp-bot/uc6-bot.mjs:1286`, `pages/api/uc6/challenge.ts:30`, `pages/api/uc6/status.ts:29` | Added 64 KB body caps and tighter rate limits | Put bot behind reverse proxy / tunnel with additional limits |
| UC6-006 | High | Error handling / logs | Upstream errors leak tokens, Infura project IDs, or internal request details into status/logs | Error path triggered | Secret exposure, intel leak | `uc6-lp-bot/uc6-bot.mjs:2075`, `uc6-lp-bot/lib/security.mjs:3` | Redacted sensitive strings before storing/logging errors | Add central structured logger and secret scanning in CI |
| UC6-007 | High | Bot HTTP server | Slowloris / hung connection keeps sockets open too long | Network access to bot port | Resource exhaustion | `uc6-lp-bot/uc6-bot.mjs:9081` | Added request/header/keepalive timeouts and max header count | Terminate TLS/proxy at Nginx or tunnel with lower timeouts |
| UC6-008 | High | systemd sandbox | Service can access more kernel/FS surface than necessary | Local code execution in service context | Lateral movement / persistence | `scripts/uc6-lp-bot.service:15` | Added `PrivateDevices`, `ProtectKernel*`, `RestrictAddressFamilies`, `LockPersonality`, `UMask=0077` | Apply and verify on VM; add firewall and SSH hardening |
| UC6-009 | High | Public bot exposure | Direct public access to bot endpoints enables scanning and abuse | Port 8797 exposed | Higher DoS and auth attack surface | `uc6-lp-bot/uc6-bot.mjs:9051`, `scripts/uc6-lp-bot.service:10` | Bot now rate-limits public routes too | Bind to `127.0.0.1` plus reverse proxy/tunnel; or firewall allowlist |
| UC6-010 | High | Transaction safety | Runaway loop sends too many txs or too much notional during a bug or provider glitch | Logic bug or malicious/inconsistent read | Excess gas spend or forced bad trades | `uc6-lp-bot/uc6-bot.mjs:534`, `uc6-lp-bot/uc6-bot.mjs:735`, `uc6-lp-bot/uc6-bot.mjs:6605` | Existing rebalance/day and execution caps remain in place | Add `maxTxPerHour` and `maxSwapNotionalUsdPerHour` circuit breakers |
| UC6-011 | Medium/High | RPC trust | Single provider lies or drifts on a critical read before a trade | Provider fault or targeted manipulation | Bad rebalance / bad escape decision | `uc6-lp-bot/uc6-bot.mjs:1711`, `uc6-lp-bot/uc6-bot.mjs:9043` | Existing provider failover remains | Add two-provider confirmation for critical pre-trade reads |
| UC6-012 | Medium | MEV / sandwich | Public swap/mint tx is observed and traded against | Public mempool visibility | Worse execution, alpha leakage | `uc6-lp-bot/uc6-bot.mjs:5038`, `uc6-lp-bot/uc6-bot.mjs:5829` | Existing slippage and amount minimums remain | Private relay / protected RPC where available on Base |
| UC6-013 | Medium | Secrets at rest | `.env` or state files readable by wrong users | Bad perms or backup leakage | Key or token disclosure | `scripts/deploy-uc6.sh:18` | Added hardening docs and snapshot checks | Enforce `600` perms, encrypted backups, restricted admin access |
| UC6-014 | Low/Medium | Vercel API abuse | Repeated polling of `/api/uc6/status` or `/api/uc6/positions` | Public dashboard URL | Higher bot load and cost | `pages/api/uc6/status.ts:29`, `pages/api/uc6/positions.ts:29` | Tightened per-IP budgets | Consider CDN caching for non-owner endpoints if freshness allows |

## Patch Now (In Code)
- Constant-time bearer comparison on bot `/owner/*`
- Single-use bot nonce burn before action execution
- 64 KB JSON body limit on challenge and owner API routes
- Bot-side JSON body size enforcement
- Tighter owner and public per-IP rate limits
- Sanitized error messages and log redaction
- Generic 500 responses from bot HTTP server
- HTTP server request/header/keepalive timeouts
- Strict owner settings whitelist with sane ranges
- Hardened systemd unit defaults in `scripts/uc6-lp-bot.service`
- Added local self-test script
- Added VM security snapshot script

## Manual Hardening (Ops Changes)
- Restrict bot exposure:
  - preferred: bind UC6 bot to `127.0.0.1` and expose through Nginx, Cloudflare Tunnel, Tailscale, or WireGuard
  - minimum: firewall port `8797` and expose only the intended ingress path
- Enforce SSH key-only auth, disable password auth, and disable root SSH login
- Verify `/opt/uc6-bot/.env` and `settings.json` are `600` and owned by `uc6`
- Rotate `UC6_ADMIN_TOKEN` and wallet key if they were ever logged or shared
- Keep a tested restore path for `/opt/uc6-bot/{settings.json,state.json,positions.json,events.jsonl}`
- Monitor journal for repeated 401/409/429 patterns on owner routes

## Bigger Redesign (Optional)
- Move hot-wallet signing to KMS/HSM or a dedicated signer service
- Add per-hour tx/notional circuit breakers
- Require two-provider agreement before high-stakes trade execution
- Use protected/private transaction submission on Base if operationally feasible
- Replace in-memory replay caches with durable shared storage if multi-instance deployment ever appears

## Immediate Patches Included In This PR
- Constant-time bearer token verification on bot owner routes
- Single-use nonce consumption hardened on both tiers
- Strict owner settings schema and range validation
- 64 KB request body caps on challenge and owner routes
- Stronger owner/public route rate limits
- Bot HTTP timeouts and hardened JSON response headers
- Redaction of sensitive strings from logs and stored last-error text
- Hardened systemd unit file
- Added `scripts/uc6_security_snapshot.sh`
- Added `scripts/uc6_security_selftest.mjs`

## Manual Actions You Must Do On The VM/Vercel/RPC Accounts
- Apply the hardened systemd unit and reload systemd
- Apply firewall and SSH hardening from `docs/UC6_HARDENING_RUNBOOK.md`
- Verify `/opt/uc6-bot/.env` ownership and `600` permissions
- Confirm Vercel env vars never expose `UC6_BOT_ADMIN_TOKEN` to the browser
- Review RPC provider dashboards for 401/429 spikes and rotate provider keys if needed
