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
```

3. Create default `/opt/uc6-bot/settings.json`
```json
{
  "version": 1,
  "tradingEnabled": true,
  "venue": "slipstream",
  "bandHalfBps": 100,
  "edgeRebalancePct": 0.85,
  "minRebalanceIntervalSec": 300,
  "maxRebalancesPerDay": 20,
  "slippageBps": 30,
  "pollIntervalMs": 2000,
  "maxDeployUsdc": 50000,
  "keepUsdcReserve": 25
}
```

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

## Local check

```bash
cd uc6-lp-bot
npm install --package-lock-only
npm ci
npm run check
```
