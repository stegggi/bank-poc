# UC5 Bot (Ethereal mainnet)

This bot trades BTCUSD perps on Ethereal using a **linked signer** (recommended).
It:
- stores all runtime data in local SQLite
- serves VM control/status endpoints directly
- avoids high-frequency Vercel Blob operations

## ENV VARS (on your Google Cloud VM)
- UC5_BOT_TOKEN=<same token you set on Vercel>
- UC5_BOT_SIGNER_PRIVATE_KEY=0x....
- UC5_SQLITE_PATH=/home/<user>/uc5/uc5.sqlite   (optional)
- UC5_RUNTIME_CONFIG_PATH=/home/<user>/uc5/uc5.runtime.config.json   (optional)
- UC5_TELEMETRY_HOST=0.0.0.0
- UC5_TELEMETRY_PORT=8787

## VM endpoints (served by uc5-bot.py)
- `GET /health` -> `{ok:true}`
- `GET /status` -> live bot status (for dashboard polling)
- `GET /config` -> current runtime config
- `POST /config` -> set config (requires header `x-uc5-bot-token`)
- `POST /command` -> enqueue `FLATTEN` / `LINK_SIGNER` (requires token header)
- `GET /commands` -> list command queue (requires token header)
- `POST /command-updates` -> apply command updates (requires token header; compatibility)

## Install
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

## Run
python uc5-bot.py
