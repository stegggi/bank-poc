# UC6 LP Bot (Base)

UC6 runs as a separate Node.js service on the Debian VM (`/opt/uc6-bot`) and exposes:
- `GET /health`
- `GET /status`
- `POST /owner/settings` (protected by bearer token + owner wallet signature)

Primary execution venue is Aerodrome Slipstream. Uniswap v3 is wired as fallback/read-only monitoring.

## Security model

`POST /owner/settings` requires **both**:
1. `Authorization: Bearer <UC6_ADMIN_TOKEN>`
2. Valid MetaMask owner signature for the exact payload (hash-locked)

Additional protections:
- owner endpoints are under `/owner/*`
- in-memory rate limit (`20 req/min/IP`) on bot owner endpoints
- one-time nonce replay protection on the bot
- settings are persisted atomically to `/opt/uc6-bot/settings.json`
- hard kill switch (`settings.killSwitch`) blocks all tx paths even if the loop is running

## Files on VM

- App code: `/opt/uc6-bot/app`
- Env file: `/opt/uc6-bot/.env`
- Strategy settings: `/opt/uc6-bot/settings.json`
- Bot state: `/opt/uc6-bot/state.json`

## How to run

1. Install Node dependencies
```bash
cd /opt/uc6-bot/app
npm ci
```

2. Create `/opt/uc6-bot/.env`
```bash
cp /opt/uc6-bot/app/.env.example /opt/uc6-bot/.env
# then edit secrets:
# - UC6_RPC_URL
# - UC6_PRIVATE_KEY
# - UC6_ADMIN_TOKEN
# - UC6_OWNER_ADDRESS
# - optional: UC6_ALLOW_KILL_SWITCH_RESET=false
```

3. Create default `/opt/uc6-bot/settings.json`
```json
{
  "version": 1,
  "tradingEnabled": true,
  "killSwitch": false,
  "failureCooldownSec": 900,
  "venue": "slipstream",
  "bandHalfBps": 100,
  "edgeRebalancePct": 0.85,
  "minRebalanceIntervalSec": 300,
  "maxRebalancesPerDay": 20,
  "slippageBps": 30,
  "pollIntervalMs": 2000,
  "maxDeployUsdc": 50000,
  "reserveMinUsdc": 25,
  "reservePct": 0,
  "reserveMaxUsdc": 0,
  "compoundMode": "on_rebalance",
  "harvestThresholdUsd": 30,
  "churnProtectionEnabled": false,
  "churnMaxCostToFeeRatio": 0.4
}
```

If `killSwitch` is `true`, the bot force-disables trading and rejects tx attempts.

If a rebalance fails, bot enters a failure cooldown (`failureCooldownSec`) and blocks further rebalance attempts until cooldown expires.

Reserve target is computed as `max(reserveMinUsdc, reservePct * portfolioValueUsd)` and capped by `reserveMaxUsdc` when `reserveMaxUsdc > 0`.

4. Install systemd unit and start
```bash
sudo cp ~/bank-poc/scripts/uc6-lp-bot.service /etc/systemd/system/uc6-lp-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now uc6-lp-bot.service
sudo systemctl status uc6-lp-bot.service
```

5. Verify endpoints
```bash
curl http://35.205.209.20:8797/health
curl http://35.205.209.20:8797/status
```

6. Set Vercel env vars and deploy dashboard
- `UC6_BOT_BASE_URL=http://35.205.209.20:8797`
- `UC6_BOT_ADMIN_TOKEN=<same as VM UC6_ADMIN_TOKEN>`
- `UC6_OWNER_ADDRESS=<owner wallet>`
- `NEXT_PUBLIC_UC6_OWNER_ADDRESS=<same owner wallet>`

## Emergency stop

Set kill switch from VM (hot-reloads):

```bash
sudo bash -c '
set -euo pipefail
tmp=$(mktemp /opt/uc6-bot/settings.XXXXXX)
jq ".killSwitch=true | .tradingEnabled=false" /opt/uc6-bot/settings.json > "$tmp"
mv "$tmp" /opt/uc6-bot/settings.json
chown uc6:uc6 /opt/uc6-bot/settings.json
chmod 600 /opt/uc6-bot/settings.json
'
```

To intentionally clear kill switch later, set `UC6_ALLOW_KILL_SWITCH_RESET=true` in `/opt/uc6-bot/.env` and use owner settings update.

## Local check

```bash
cd uc6-lp-bot
npm install --package-lock-only
npm ci
npm run check
```
