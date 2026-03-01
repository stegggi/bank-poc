# UC5 VM Checklist

## Preconditions

- Node 18+ is installed on the VM:
  - `node -v`
- UC5 bot env has the current defaults:
  - `UC5_DB_MAX_GB=15`
  - `UC5_DB_TARGET_GB=14`
  - `UC5_INGEST_INTERVAL_SEC=0.5`
  - optional: `UC5_NODE_BIN=node`

## Deploy

```bash
cd ~/bank-poc
git pull --ff-only
```

If `git pull` fails on local VM edits:

```bash
git status --short
git stash push -u -m "uc5-vm-local"
git pull --ff-only
```

## Restart

```bash
sudo systemctl restart uc5-bot
sleep 10
sudo systemctl status uc5-bot --no-pager -l
```

## Verify Telemetry

```bash
curl -s http://127.0.0.1:8787/status | python3 -m json.tool
curl -s http://127.0.0.1:8787/ingestion | python3 -m json.tool
curl -s http://127.0.0.1:8787/trading | python3 -m json.tool
```

Expected:

- `bot.alive = true`
- `runtime.regimeLookbackSeconds`, `runtime.regimeBarSeconds`, `runtime.regimeSampleEverySec`, `runtime.trendEntryStrength`, `runtime.flipCooldownSec` present
- `execution.makerOnlyEntry = true`
- `execution.makerFirstExitWithMarketSafety = true`
- `execution.quoteSource = "ws_bookdepth"` once WS is healthy

## Verify Regime Output

```bash
python3 - <<'PY'
import json, urllib.request
j = json.load(urllib.request.urlopen("http://127.0.0.1:8787/status", timeout=20))
print(json.dumps({
  "desired": (j.get("agent") or {}).get("desired"),
  "regimeState": (j.get("agent") or {}).get("regimeState"),
  "regimeDirection": (j.get("agent") or {}).get("regimeDirection"),
  "regimeStrength": (j.get("agent") or {}).get("regimeStrength"),
  "reason": (j.get("agent") or {}).get("reasonRaw"),
}, indent=2))
PY
```

## Verify Chart / Cross-Day Data

```bash
python3 - <<'PY'
import json, urllib.request
j = json.load(urllib.request.urlopen("http://127.0.0.1:8787/uc5/chart?range=24h&resolution=1m", timeout=20))
print(json.dumps({
  "candles": len(j.get("candles") or []),
  "markers": len(j.get("markers") or []),
  "regimeStrength": len(j.get("regimeStrength") or []),
  "partial24h": j.get("partial24h"),
  "missingDays": j.get("missingDays"),
}, indent=2))
PY
```

Expected:

- up to `1440` candles
- trade markers present when trades exist
- `regimeStrength` populated after decisions are written
- `partial24h = false` under normal conditions

## Verify Maker Audit

```bash
python3 - <<'PY'
import json, urllib.request
j = json.load(urllib.request.urlopen("http://127.0.0.1:8787/status", timeout=20))
e = j.get("execution") or {}
print(json.dumps({
  "lastEntryFill": e.get("lastEntryFill"),
  "lastExitMethod": e.get("lastExitMethod"),
  "fillsAuditLast20": (e.get("fillsAuditLast20") or {}).get("summary"),
}, indent=2))
PY
```

Watch for:

- entry fills with `isMaker = true`
- any taker entry should log `MAKER ENTRY VIOLATION`

## Logs

```bash
sudo journalctl -u uc5-bot -n 120 --no-pager
tail -n 200 /home/stefan_geisler/uc5-bot.log
```

Useful patterns:

- `REGIME_NODE`
- `EXEC_CHASE`
- `MAKER_AUDIT`
- `MAKER ENTRY VIOLATION`

## Recovery

If the bot looks stale:

```bash
sudo systemctl restart uc5-bot
sleep 10
curl -s http://127.0.0.1:8787/status | python3 -m json.tool
```
