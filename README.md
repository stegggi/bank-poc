
Single-frontend demo with tabs:
- Wallet: Wallet-on-file + activation (gas sponsored)
- Bank A: Build encrypted envelope + send token (require ACK toggle)
- Bank B: Inbox, open (decrypt) envelope, ACK
- Directory: Admin-gated bank registry (add/pause)
- Logs: Stream of events/health


1) Copy .env.local.example to .env.local and fill values.
2) npm run dev
