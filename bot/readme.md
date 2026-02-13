# UC5 Bot (Ethereal mainnet)

This bot trades BTCUSD perps on Ethereal using a **linked signer** (recommended).
It:
- fetches config + commands from your Next.js dashboard
- stores data + online model in SQLite
- posts status back to the dashboard

## ENV VARS (on your Google Cloud VM)
- UC5_DASHBOARD_BASE_URL=https://concept-bank.vercel.app
- UC5_BOT_TOKEN=<same token you set on Vercel>
- UC5_BOT_SIGNER_PRIVATE_KEY=0x....
- UC5_SQLITE_PATH=/home/<user>/uc5/uc5.sqlite   (optional)

## Install
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

## Run
python uc5-bot.py
