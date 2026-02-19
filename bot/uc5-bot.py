# bot/uc5-bot.py
"""
UC5 Ethereal Autopilot Bot (mainnet)

- Runs a small HTTP control + telemetry server on the VPS:
    GET /status  -> latest status JSON for the dashboard
    GET /health  -> {"ok": true}
- Runtime config + command queue live locally on the VM.
- High-frequency data (prices/decisions/model) lives in SQLite.

IMPORTANT:
This is a demo trading bot. It can lose money. Start tiny (e.g. 100 USDe) and keep leverage low.
"""

import os, time, json, math, sqlite3, requests, asyncio, threading, uuid
from urllib.parse import urlparse, parse_qs
from decimal import Decimal, ROUND_DOWN
from typing import Optional, Dict, Any, List, Tuple
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer

# ethereal-sdk (async) — support both import styles
try:
  from ethereal import AsyncRESTClient
except Exception:
  from ethereal.async_rest_client import AsyncRESTClient


# ---- Env ----
def _clean_secret(v: Optional[str]) -> str:
  return str(v or "").strip().strip('"').strip("'")


BOT_TOKEN = os.environ.get("UC5_BOT_TOKEN", "")
BOT_PRIVKEY = _clean_secret(os.environ.get("UC5_BOT_SIGNER_PRIVATE_KEY", ""))  # linked signer EOA private key (0x...)

DB_PATH = os.environ.get("UC5_SQLITE_PATH", os.path.join(os.path.dirname(__file__), "uc5.sqlite"))
RUNTIME_CONFIG_PATH = os.environ.get("UC5_RUNTIME_CONFIG_PATH", os.path.join(os.path.dirname(__file__), "uc5.runtime.config.json"))

# Telemetry server (VPS)
TELEMETRY_HOST = os.environ.get("UC5_TELEMETRY_HOST", "0.0.0.0")
TELEMETRY_PORT = int(os.environ.get("UC5_TELEMETRY_PORT", "8787"))
BOT_VERSION = "uc5-bot/0.6 (sdk-safe-status + lot+pnl-fixes)"

if not BOT_TOKEN:
  raise SystemExit("Missing env: UC5_BOT_TOKEN")


def signer_address_from_privkey() -> str:
  if not BOT_PRIVKEY:
    return ""
  try:
    from eth_account import Account
    return str(Account.from_key(BOT_PRIVKEY).address or "")
  except Exception:
    return ""


BOT_SIGNER_ADDRESS = signer_address_from_privkey()


# ---- SQLite ----
def db_connect():
  parent = os.path.dirname(os.path.abspath(DB_PATH))
  os.makedirs(parent, exist_ok=True)

  conn = sqlite3.connect(DB_PATH)
  conn.execute("PRAGMA journal_mode=WAL;")
  conn.execute("""
    CREATE TABLE IF NOT EXISTS prices(
      ts_ms INTEGER PRIMARY KEY,
      price REAL NOT NULL,
      oracle REAL,
      bid REAL,
      ask REAL
    );
  """)
  conn.execute("""
    CREATE TABLE IF NOT EXISTS model(
      id INTEGER PRIMARY KEY CHECK (id=1),
      w0 REAL NOT NULL,
      w1 REAL NOT NULL,
      w2 REAL NOT NULL,
      w3 REAL NOT NULL,
      w4 REAL NOT NULL,
      w5 REAL NOT NULL,
      w6 REAL NOT NULL,
      updated_ms INTEGER NOT NULL
    );
  """)
  conn.execute("""
    CREATE TABLE IF NOT EXISTS decisions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms INTEGER NOT NULL,
      horizon_sec INTEGER NOT NULL,
      p_up REAL NOT NULL,
      f1 REAL, f2 REAL, f3 REAL, f4 REAL, f5 REAL, f6 REAL,
      y INTEGER,   -- label, set later
      trained INTEGER DEFAULT 0
    );
  """)
  conn.execute("""
    CREATE TABLE IF NOT EXISTS trades(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms INTEGER NOT NULL,
      event_type TEXT NOT NULL,  -- ENTRY / EXIT / FLATTEN / HOLD
      side TEXT,
      qty REAL,
      price REAL,
      pnl REAL,
      note TEXT
    );
  """)
  conn.execute("CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts_ms);")
  conn.commit()
  return conn


def sigmoid(x: float) -> float:
  if x >= 0:
    z = math.exp(-x)
    return 1.0 / (1.0 + z)
  else:
    z = math.exp(x)
    return z / (1.0 + z)


def clamp(x: float, a: float, b: float) -> float:
  return max(a, min(b, x))


def quantize_qty_to_lot(qty: float, lot_size: Optional[float]) -> float:
  q = Decimal(str(max(0.0, float(qty or 0.0))))
  if lot_size is None or float(lot_size) <= 0:
    return float(q)
  step = Decimal(str(lot_size))
  units = (q / step).to_integral_value(rounding=ROUND_DOWN)
  return float(units * step)


def ensure_model(conn) -> List[float]:
  row = conn.execute("SELECT w0,w1,w2,w3,w4,w5,w6 FROM model WHERE id=1").fetchone()
  if row:
    return list(row)
  w = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
  conn.execute(
    "INSERT INTO model(id,w0,w1,w2,w3,w4,w5,w6,updated_ms) VALUES (1,?,?,?,?,?,?,?,?)",
    (w[0], w[1], w[2], w[3], w[4], w[5], w[6], int(time.time() * 1000))
  )
  conn.commit()
  return w


def set_model(conn, w: List[float]):
  conn.execute(
    "UPDATE model SET w0=?,w1=?,w2=?,w3=?,w4=?,w5=?,w6=?,updated_ms=? WHERE id=1",
    (w[0], w[1], w[2], w[3], w[4], w[5], w[6], int(time.time() * 1000))
  )
  conn.commit()


def last_prices(conn, n: int) -> List[Tuple[int, float]]:
  rows = conn.execute("SELECT ts_ms, price FROM prices ORDER BY ts_ms DESC LIMIT ?", (n,)).fetchall()
  rows.reverse()
  return rows


def compute_features(conn) -> Tuple[List[float], str]:
  rows = last_prices(conn, 400)
  if len(rows) < 80:
    return [1.0, 0, 0, 0, 0, 0, 0], "warming up (need more history)"

  ts = [r[0] for r in rows]
  px = [r[1] for r in rows]

  def ret_over(ms_back: int) -> float:
    t_now = ts[-1]
    target = t_now - ms_back
    i = 0
    while i < len(ts) and ts[i] < target:
      i += 1
    if i >= len(px):
      i = len(px) - 1
    p0 = px[i]
    p1 = px[-1]
    return (p1 / p0) - 1.0 if p0 > 0 else 0.0

  r1m = ret_over(60_000)
  r5m = ret_over(300_000)

  def sma(window: int) -> float:
    if len(px) < window:
      return sum(px) / len(px)
    return sum(px[-window:]) / window

  sma20 = sma(20)
  sma60 = sma(60)
  trend = ((sma20 - sma60) / px[-1]) if (px[-1] and px[-1] > 0) else 0.0

  # RSI(14)
  gains, losses = 0.0, 0.0
  for i in range(max(1, len(px) - 15), len(px)):
    d = px[i] - px[i - 1]
    if d >= 0:
      gains += d
    else:
      losses += -d
  rs = (gains / 14.0) / (losses / 14.0 + 1e-9)
  rsi = 100.0 - (100.0 / (1.0 + rs))
  rsi_n = (rsi - 50.0) / 50.0

  # volatility (~60 returns)
  rets = []
  for i in range(max(1, len(px) - 60), len(px)):
    prev = px[i - 1]
    if prev and prev > 0:
      rets.append((px[i] / prev) - 1.0)
  if rets:
    mu = sum(rets) / len(rets)
    var = sum((x - mu) * (x - mu) for x in rets) / max(1, len(rets) - 1)
    vol = math.sqrt(var)
  else:
    vol = 0.0

  row = conn.execute("SELECT oracle FROM prices ORDER BY ts_ms DESC LIMIT 1").fetchone()
  oracle = row[0] if row else None
  dev = ((px[-1] - oracle) / oracle) if (oracle and oracle > 0) else 0.0

  feats = [1.0, r1m, r5m, trend, rsi_n, vol, dev]
  reason = f"r1m={r1m:.4f}, r5m={r5m:.4f}, trend={trend:.4f}, rsiN={rsi_n:.3f}, vol={vol:.5f}, dev={dev:.5f}"
  return feats, reason


def predict(w: List[float], feats: List[float]) -> float:
  x = sum(w[i] * feats[i] for i in range(len(w)))
  return sigmoid(x)


def train_online(conn, w: List[float], lr: float = 0.5):
  rows = conn.execute("""
    SELECT id, ts_ms, horizon_sec, f1,f2,f3,f4,f5,f6
    FROM decisions
    WHERE y IS NULL
    ORDER BY id ASC
    LIMIT 50
  """).fetchall()

  if not rows:
    return w

  for (did, ts_ms, horizon, f1, f2, f3, f4, f5, f6) in rows:
    future_ts = ts_ms + int(horizon * 1000)
    fut = conn.execute(
      "SELECT price FROM prices WHERE ts_ms >= ? ORDER BY ts_ms ASC LIMIT 1",
      (future_ts,)
    ).fetchone()
    nowp = conn.execute(
      "SELECT price FROM prices WHERE ts_ms = ?",
      (ts_ms,)
    ).fetchone()
    if not fut or not nowp:
      continue
    y = 1 if fut[0] > nowp[0] else 0
    conn.execute("UPDATE decisions SET y=? WHERE id=?", (y, did))
  conn.commit()

  labeled = conn.execute("""
    SELECT id, f1,f2,f3,f4,f5,f6, y
    FROM decisions
    WHERE y IS NOT NULL AND trained=0
    ORDER BY id ASC
    LIMIT 200
  """).fetchall()

  for (did, f1, f2, f3, f4, f5, f6, y) in labeled:
    feats = [1.0, f1, f2, f3, f4, f5, f6]
    p = predict(w, feats)
    err = (p - y)
    for i in range(len(w)):
      w[i] = w[i] - lr * err * feats[i]
    conn.execute("UPDATE decisions SET trained=1 WHERE id=?", (did,))
  conn.commit()
  return w


def db_read_conn():
  c = sqlite3.connect(DB_PATH)
  c.row_factory = sqlite3.Row
  return c


def insert_trade_event(
  conn,
  ts_ms: int,
  event_type: str,
  side: Optional[str],
  qty: Optional[float],
  price: Optional[float],
  pnl: Optional[float] = None,
  note: Optional[str] = None,
):
  conn.execute(
    "INSERT INTO trades(ts_ms, event_type, side, qty, price, pnl, note) VALUES (?,?,?,?,?,?,?)",
    (int(ts_ms), str(event_type), side, qty, price, pnl, note),
  )
  conn.commit()


def query_ingestion_stats() -> Dict[str, Any]:
  now_ms = int(time.time() * 1000)
  five_min_ago = now_ms - 5 * 60 * 1000
  day_ago = now_ms - 24 * 60 * 60 * 1000
  c = db_read_conn()
  try:
    row = c.execute(
      """
      SELECT
        MIN(ts_ms) AS min_ts,
        MAX(ts_ms) AS max_ts,
        COUNT(*) AS total,
        SUM(CASE WHEN ts_ms >= ? THEN 1 ELSE 0 END) AS cnt_24h,
        SUM(CASE WHEN ts_ms >= ? THEN 1 ELSE 0 END) AS cnt_5m
      FROM prices
      """
      ,
      (day_ago, five_min_ago),
    ).fetchone()
    min_ts = int(row["min_ts"]) if row and row["min_ts"] is not None else None
    max_ts = int(row["max_ts"]) if row and row["max_ts"] is not None else None
    total = int(row["total"]) if row and row["total"] is not None else 0
    cnt_24h = int(row["cnt_24h"]) if row and row["cnt_24h"] is not None else 0
    cnt_5m = int(row["cnt_5m"]) if row and row["cnt_5m"] is not None else 0
    db_size = None
    try:
      db_size = os.path.getsize(DB_PATH)
    except Exception:
      db_size = None
    rate_per_min = float(cnt_5m) / 5.0
    return {
      "collectingSince": min_ts,
      "lastTickAt": max_ts,
      "ticksCollected": total,
      "ticks24h": cnt_24h,
      "dbSizeBytes": db_size,
      "ingestionRatePerMin5m": rate_per_min,
      "lastTickAgeSec": (max(0, int((now_ms - max_ts) / 1000)) if max_ts else None),
    }
  finally:
    c.close()


def query_chart_data(range_hours: int = 24, resolution_sec: int = 60) -> Dict[str, Any]:
  now_ms = int(time.time() * 1000)
  from_ms = now_ms - range_hours * 60 * 60 * 1000
  bucket_ms = max(1000, int(resolution_sec * 1000))
  c = db_read_conn()
  try:
    rows = c.execute(
      "SELECT ts_ms, price FROM prices WHERE ts_ms >= ? ORDER BY ts_ms ASC",
      (from_ms,),
    ).fetchall()
    candles: List[Dict[str, Any]] = []
    if rows:
      cur_bucket = None
      bucket_rows: List[Tuple[int, float]] = []
      for r in rows:
        ts = int(r["ts_ms"])
        px = float(r["price"])
        b = (ts // bucket_ms) * bucket_ms
        if cur_bucket is None:
          cur_bucket = b
        if b != cur_bucket:
          if bucket_rows:
            open_px = bucket_rows[0][1]
            close_px = bucket_rows[-1][1]
            highs = [x[1] for x in bucket_rows]
            candles.append({
              "t": int(cur_bucket),
              "open": float(open_px),
              "high": float(max(highs)),
              "low": float(min(highs)),
              "close": float(close_px),
            })
          bucket_rows = []
          cur_bucket = b
        bucket_rows.append((ts, px))
      if bucket_rows and cur_bucket is not None:
        open_px = bucket_rows[0][1]
        close_px = bucket_rows[-1][1]
        highs = [x[1] for x in bucket_rows]
        candles.append({
          "t": int(cur_bucket),
          "open": float(open_px),
          "high": float(max(highs)),
          "low": float(min(highs)),
          "close": float(close_px),
        })

    markers = []
    trows = c.execute(
      """
      SELECT ts_ms, event_type, side, price
      FROM trades
      WHERE ts_ms >= ? AND event_type IN ('ENTRY','EXIT','FLATTEN')
      ORDER BY ts_ms ASC
      """,
      (from_ms,),
    ).fetchall()
    for r in trows:
      et = str(r["event_type"] or "")
      markers.append(
        {
          "t": int(r["ts_ms"]),
          "price": float(r["price"]) if r["price"] is not None else None,
          "type": ("ENTRY" if et == "ENTRY" else "EXIT"),
          "side": (r["side"] or None),
          "eventType": et,
        }
      )
    return {"candles": candles[-1440:], "markers": markers[-500:]}
  finally:
    c.close()


def query_trades_summary() -> Dict[str, Any]:
  c = db_read_conn()
  try:
    rows = c.execute(
      """
      SELECT ts_ms, event_type, side, qty, price, pnl
      FROM trades
      WHERE event_type IN ('ENTRY','EXIT','FLATTEN')
      ORDER BY ts_ms ASC
      """
    ).fetchall()

    open_leg: Optional[Dict[str, Any]] = None
    closed: List[Tuple[int, Optional[float]]] = []
    for r in rows:
      et = str(r["event_type"] or "")
      if et == "ENTRY":
        open_leg = {
          "ts_ms": int(r["ts_ms"]),
          "side": str(r["side"] or "").upper(),
          "qty": _f(r["qty"]),
          "price": _f(r["price"]),
        }
        continue
      if et not in ("EXIT", "FLATTEN"):
        continue

      pnl = _f(r["pnl"])
      if (pnl is None or abs(float(pnl)) < 1e-12) and open_leg:
        side = str(open_leg.get("side") or "").upper()
        qty = _f(r["qty"]) or _f(open_leg.get("qty"))
        entry_px = _f(open_leg.get("price"))
        exit_px = _f(r["price"])
        if qty and qty > 0 and entry_px and entry_px > 0 and exit_px and exit_px > 0:
          if side == "LONG":
            pnl = (exit_px - entry_px) * qty
          elif side == "SHORT":
            pnl = (entry_px - exit_px) * qty

      closed.append((int(r["ts_ms"]), pnl))
      open_leg = None

    pnls = [float(x[1]) for x in closed if x[1] is not None]
    wins = [x for x in pnls if x > 0]
    losses = [x for x in pnls if x < 0]
    total = len(closed)
    win_rate = (len(wins) / len(pnls)) if pnls else 0.0
    avg_win = (sum(wins) / len(wins)) if wins else 0.0
    avg_loss = (sum(losses) / len(losses)) if losses else 0.0
    total_realized = sum(pnls) if pnls else 0.0
    day_ago = int(time.time() * 1000) - 24 * 60 * 60 * 1000
    realized_today = sum(float(p) for (ts, p) in closed if p is not None and ts >= day_ago)
    return {
      "totalTrades": total,
      "winRate": win_rate,
      "avgWin": avg_win,
      "avgLoss": avg_loss,
      "realizedPnlTotal": total_realized,
      "realizedPnlToday": realized_today,
    }
  finally:
    c.close()


def query_open_leg_from_trades() -> Optional[Dict[str, Any]]:
  c = db_read_conn()
  try:
    rows = c.execute(
      """
      SELECT ts_ms, event_type, side, qty, price
      FROM trades
      WHERE event_type IN ('ENTRY','EXIT','FLATTEN')
      ORDER BY ts_ms ASC
      """
    ).fetchall()
    open_leg: Optional[Dict[str, Any]] = None
    for r in rows:
      et = str(r["event_type"] or "")
      if et == "ENTRY":
        open_leg = {
          "ts_ms": int(r["ts_ms"]),
          "side": str(r["side"] or "").upper() or None,
          "qty": _f(r["qty"]),
          "price": _f(r["price"]),
        }
      elif et in ("EXIT", "FLATTEN"):
        open_leg = None
    return open_leg
  finally:
    c.close()


def explain_agent_reason(raw_reason: str, desired: str, conf: float) -> Tuple[str, str]:
  """
  Convert compact metrics string into readable explanation.
  """
  vals: Dict[str, float] = {}
  for part in str(raw_reason or "").split(","):
    p = part.strip()
    if "=" not in p:
      continue
    k, v = p.split("=", 1)
    try:
      vals[k.strip()] = float(v.strip())
    except Exception:
      continue
  r1m = vals.get("r1m", 0.0)
  r5m = vals.get("r5m", 0.0)
  rsi = vals.get("rsiN", 0.0)
  vol = vals.get("vol", 0.0)
  trend = vals.get("trend", 0.0)
  conf_pct = int(max(0.0, min(1.0, conf)) * 100)
  band = "High" if conf >= 0.75 else ("Medium" if conf >= 0.6 else "Low")
  direction = {"LONG": "bullish", "SHORT": "bearish", "FLAT": "neutral"}.get(desired, "neutral")
  human = (
    f"{band} confidence ({conf_pct}%). "
    f"Signals are {direction}: 1m={r1m*100:.2f}%, 5m={r5m*100:.2f}%, trend={trend*100:.2f}%, "
    f"RSI={50 + (rsi*50):.1f}, volatility={vol*100:.3f}%."
  )
  return human, raw_reason


def confidence_band(conf: float) -> str:
  if conf >= 0.75:
    return "HIGH"
  if conf >= 0.6:
    return "MEDIUM"
  return "LOW"


def to_countdown_sec(target_ms: Optional[int], now_ms: Optional[int] = None) -> Optional[int]:
  if not target_ms:
    return None
  if now_ms is None:
    now_ms = int(time.time() * 1000)
  return max(0, int((int(target_ms) - int(now_ms) + 999) / 1000))


def parse_range_hours(raw: Optional[str]) -> int:
  if not raw:
    return 24
  s = str(raw).strip().lower()
  try:
    if s.endswith("h"):
      return max(1, min(168, int(s[:-1])))
    if s.endswith("d"):
      return max(1, min(168, int(s[:-1]) * 24))
    return max(1, min(168, int(s)))
  except Exception:
    return 24


def parse_resolution_seconds(raw: Optional[str]) -> int:
  if not raw:
    return 60
  s = str(raw).strip().lower()
  try:
    if s.endswith("ms"):
      return max(1, int(int(s[:-2]) / 1000))
    if s.endswith("s"):
      return max(1, min(3600, int(s[:-1])))
    if s.endswith("m"):
      return max(1, min(3600, int(s[:-1]) * 60))
    return max(1, min(3600, int(s)))
  except Exception:
    return 60


# ---- Runtime config + commands (local, no Blob dependency) ----
def default_runtime_config() -> Dict[str, Any]:
  owner = os.environ.get("UC5_OWNER_ADDRESS", "")
  return {
    "version": 1,
    "ownerAddress": owner,
    "etherealApiBase": os.environ.get("UC5_ETHEREAL_API_BASE", "https://api.ethereal.trade"),
    "etherealArchiveBase": os.environ.get("UC5_ETHEREAL_ARCHIVE_BASE", "https://archive.ethereal.trade"),
    "etherealRpcUrl": os.environ.get("UC5_ETHEREAL_RPC_URL", "https://rpc.ethereal.trade"),
    "ticker": "BTCUSD",
    "productId": "",
    "subaccountId": "",
    "subaccountName": "",
    "botSignerAddress": os.environ.get("UC5_BOT_SIGNER_ADDRESS", ""),
    "botSignerLinked": False,
    "ingestionEnabled": True,
    "tradingEnabled": True,
    "killSwitch": False,  # legacy compat; ignored in UI.
    "pollIntervalSeconds": 2,  # legacy compat.
    "ingestIntervalSec": 2,
    "reassessIntervalSec": 300,
    "predictionHorizonSeconds": 3600,
    "maxLeverage": 2,
    "maxMarginPct": 25.0,
    "maxMarginUsd": 100,
    "confidenceThreshold": 0.6,
    "minHoldSeconds": 3600,
    "maxHoldSeconds": 7200,
    "maxOrdersPerHour": 120,
  }


def sanitize_runtime_config(raw: Any) -> Dict[str, Any]:
  cfg = default_runtime_config()
  if isinstance(raw, dict):
    for k in cfg.keys():
      if k in raw:
        cfg[k] = raw.get(k)

  cfg["ownerAddress"] = str(cfg.get("ownerAddress") or "")
  cfg["etherealApiBase"] = str(cfg.get("etherealApiBase") or "https://api.ethereal.trade")
  cfg["etherealArchiveBase"] = str(cfg.get("etherealArchiveBase") or "https://archive.ethereal.trade")
  cfg["etherealRpcUrl"] = str(cfg.get("etherealRpcUrl") or "https://rpc.ethereal.trade")
  cfg["ticker"] = str(cfg.get("ticker") or "BTCUSD")
  cfg["productId"] = str(cfg.get("productId") or "")
  cfg["subaccountId"] = str(cfg.get("subaccountId") or "")
  cfg["subaccountName"] = str(cfg.get("subaccountName") or "")
  cfg["botSignerAddress"] = str(cfg.get("botSignerAddress") or "")
  cfg["botSignerLinked"] = bool(cfg.get("botSignerLinked", False))
  cfg["ingestionEnabled"] = bool(cfg.get("ingestionEnabled", True))
  cfg["tradingEnabled"] = bool(cfg.get("tradingEnabled", True))
  cfg["killSwitch"] = False

  # Backward-compatible migration from pollIntervalSeconds.
  if "ingestIntervalSec" not in (raw or {}) and "pollIntervalSeconds" in (raw or {}):
    cfg["ingestIntervalSec"] = raw.get("pollIntervalSeconds")
  if "pollIntervalSeconds" not in (raw or {}):
    cfg["pollIntervalSeconds"] = cfg.get("ingestIntervalSec", 2)

  try:
    cfg["pollIntervalSeconds"] = int(cfg.get("pollIntervalSeconds", 2))
  except Exception:
    cfg["pollIntervalSeconds"] = 2
  cfg["pollIntervalSeconds"] = max(2, min(60, cfg["pollIntervalSeconds"]))

  try:
    cfg["ingestIntervalSec"] = int(cfg.get("ingestIntervalSec", 2))
  except Exception:
    cfg["ingestIntervalSec"] = 2
  cfg["ingestIntervalSec"] = max(1, min(60, cfg["ingestIntervalSec"]))

  try:
    cfg["reassessIntervalSec"] = int(cfg.get("reassessIntervalSec", 300))
  except Exception:
    cfg["reassessIntervalSec"] = 300
  cfg["reassessIntervalSec"] = max(5, min(86400, cfg["reassessIntervalSec"]))

  try:
    cfg["predictionHorizonSeconds"] = int(cfg.get("predictionHorizonSeconds", 3600))
  except Exception:
    cfg["predictionHorizonSeconds"] = 3600
  cfg["predictionHorizonSeconds"] = max(5, min(259200, cfg["predictionHorizonSeconds"]))

  try:
    cfg["maxLeverage"] = float(cfg.get("maxLeverage", 2))
  except Exception:
    cfg["maxLeverage"] = 2.0
  cfg["maxLeverage"] = max(1.0, min(20.0, cfg["maxLeverage"]))

  try:
    cfg["maxMarginPct"] = float(cfg.get("maxMarginPct", 25))
  except Exception:
    cfg["maxMarginPct"] = 25.0
  cfg["maxMarginPct"] = max(0.0, min(100.0, cfg["maxMarginPct"]))

  try:
    cfg["maxMarginUsd"] = float(cfg.get("maxMarginUsd", 100))
  except Exception:
    cfg["maxMarginUsd"] = 100.0
  cfg["maxMarginUsd"] = max(1.0, cfg["maxMarginUsd"])

  try:
    cfg["confidenceThreshold"] = float(cfg.get("confidenceThreshold", 0.6))
  except Exception:
    cfg["confidenceThreshold"] = 0.6
  cfg["confidenceThreshold"] = max(0.5, min(0.95, cfg["confidenceThreshold"]))

  try:
    cfg["minHoldSeconds"] = int(cfg.get("minHoldSeconds", 3600))
  except Exception:
    cfg["minHoldSeconds"] = 3600
  cfg["minHoldSeconds"] = max(5, min(259200, cfg["minHoldSeconds"]))

  try:
    cfg["maxHoldSeconds"] = int(cfg.get("maxHoldSeconds", 7200))
  except Exception:
    cfg["maxHoldSeconds"] = 7200
  cfg["maxHoldSeconds"] = max(3600, min(259200, cfg["maxHoldSeconds"]))

  try:
    cfg["maxOrdersPerHour"] = int(cfg.get("maxOrdersPerHour", 120))
  except Exception:
    cfg["maxOrdersPerHour"] = 120
  cfg["maxOrdersPerHour"] = max(1, min(2000, cfg["maxOrdersPerHour"]))

  return cfg


def load_runtime_config_from_disk() -> Dict[str, Any]:
  try:
    if os.path.exists(RUNTIME_CONFIG_PATH):
      with open(RUNTIME_CONFIG_PATH, "r", encoding="utf-8") as f:
        return sanitize_runtime_config(json.load(f))
  except Exception:
    pass
  return sanitize_runtime_config({})


def save_runtime_config_to_disk(cfg: Dict[str, Any]):
  parent = os.path.dirname(os.path.abspath(RUNTIME_CONFIG_PATH))
  os.makedirs(parent, exist_ok=True)
  tmp = f"{RUNTIME_CONFIG_PATH}.tmp"
  with open(tmp, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
  os.replace(tmp, RUNTIME_CONFIG_PATH)


def clone_jsonable(v: Any) -> Any:
  try:
    return json.loads(json.dumps(v))
  except Exception:
    return v


RUNTIME_LOCK = threading.Lock()
RUNTIME_CONFIG: Dict[str, Any] = load_runtime_config_from_disk()

COMMANDS_LOCK = threading.Lock()
COMMANDS: List[Dict[str, Any]] = []
COMMAND_LIMIT = 300


def get_runtime_config() -> Dict[str, Any]:
  with RUNTIME_LOCK:
    return clone_jsonable(RUNTIME_CONFIG)


def set_runtime_config(cfg: Dict[str, Any]) -> Dict[str, Any]:
  global RUNTIME_CONFIG
  next_cfg = sanitize_runtime_config(cfg)
  with RUNTIME_LOCK:
    RUNTIME_CONFIG = next_cfg
  save_runtime_config_to_disk(next_cfg)
  return clone_jsonable(next_cfg)


def list_commands() -> List[Dict[str, Any]]:
  with COMMANDS_LOCK:
    return clone_jsonable(COMMANDS)


def enqueue_command(cmd_type: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
  cmd = {
    "id": str(uuid.uuid4()),
    "type": str(cmd_type),
    "createdAt": int(time.time() * 1000),
    "status": "NEW",
  }
  if payload is not None:
    cmd["payload"] = clone_jsonable(payload)

  with COMMANDS_LOCK:
    COMMANDS.append(cmd)
    if len(COMMANDS) > COMMAND_LIMIT:
      del COMMANDS[: len(COMMANDS) - COMMAND_LIMIT]
  return clone_jsonable(cmd)


def get_new_commands() -> List[Dict[str, Any]]:
  with COMMANDS_LOCK:
    return [clone_jsonable(c) for c in COMMANDS if c.get("status") == "NEW"]


def apply_command_updates(updates: List[Dict[str, Any]]):
  if not updates:
    return
  by_id = {str(u.get("id")): u for u in updates if u.get("id")}
  if not by_id:
    return
  with COMMANDS_LOCK:
    for c in COMMANDS:
      u = by_id.get(str(c.get("id")))
      if not u:
        continue
      c["status"] = u.get("status", c.get("status"))
      if "result" in u:
        c["result"] = clone_jsonable(u.get("result"))


# ---- Telemetry server (in-memory latest status) ----
LATEST_STATUS: Dict[str, Any] = {"bot": {"alive": False, "message": "starting"}}
STATUS_LOCK = threading.Lock()


class TelemetryHandler(BaseHTTPRequestHandler):
  def _authorized(self) -> bool:
    expected = str(BOT_TOKEN or "")
    got = str(self.headers.get("x-uc5-bot-token") or "")
    return bool(expected and got and got == expected)

  def _read_json(self) -> Dict[str, Any]:
    try:
      length = int(self.headers.get("Content-Length", "0") or "0")
      if length <= 0:
        return {}
      raw = self.rfile.read(length).decode("utf-8")
      if not raw.strip():
        return {}
      obj = json.loads(raw)
      return obj if isinstance(obj, dict) else {}
    except Exception:
      return {}

  def _send_json(self, code: int, obj: Any):
    try:
      body = json.dumps(obj).encode("utf-8")
      self.send_response(code)
      self.send_header("Content-Type", "application/json")
      self.send_header("Access-Control-Allow-Origin", "*")
      self.send_header("Access-Control-Allow-Headers", "content-type, x-uc5-bot-token")
      self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
      self.send_header("Cache-Control", "no-store")
      self.end_headers()
      self.wfile.write(body)
    except (BrokenPipeError, ConnectionResetError):
      return

  def do_OPTIONS(self):
    return self._send_json(200, {"ok": True})

  def do_GET(self):
    parsed = urlparse(self.path)
    path = parsed.path
    qs = parse_qs(parsed.query or "")

    if path.startswith("/health"):
      return self._send_json(200, {"ok": True})
    if path.startswith("/status"):
      with STATUS_LOCK:
        data = LATEST_STATUS
      return self._send_json(200, data)
    if path.startswith("/config"):
      return self._send_json(200, get_runtime_config())
    if path.startswith("/commands"):
      if not self._authorized():
        return self._send_json(403, {"error": "forbidden"})
      return self._send_json(200, {"commands": list_commands()})
    if path.startswith("/ingestion"):
      cfg = get_runtime_config()
      stats = query_ingestion_stats()
      with STATUS_LOCK:
        s = clone_jsonable(LATEST_STATUS)
      return self._send_json(
        200,
        {
          "updatedAt": int(time.time() * 1000),
          "enabled": bool(cfg.get("ingestionEnabled", True)),
          "running": bool(s.get("bot", {}).get("alive", False)),
          "ingestIntervalSec": int(cfg.get("ingestIntervalSec", 2)),
          **stats,
        },
      )
    if path.startswith("/trading"):
      cfg = get_runtime_config()
      now_ms = int(time.time() * 1000)
      with STATUS_LOCK:
        s = clone_jsonable(LATEST_STATUS)
      pos = s.get("position") if isinstance(s.get("position"), dict) else {}
      agent = s.get("agent") if isinstance(s.get("agent"), dict) else {}
      pos_open = bool(pos.get("open"))
      entry_at = pos.get("entryAt")
      min_hold_until = agent.get("minHoldUntil")
      next_reassess_at = agent.get("nextReassessAt")
      max_hold_until = agent.get("maxHoldUntil")
      next_entry_eval = None
      if not pos_open:
        last_decision = agent.get("lastDecisionAt")
        decision_interval = int(agent.get("decisionIntervalSeconds") or cfg.get("reassessIntervalSec") or 300)
        if last_decision:
          next_entry_eval = int(last_decision) + decision_interval * 1000
        else:
          next_entry_eval = now_ms
      return self._send_json(
        200,
        {
          "updatedAt": now_ms,
          "enabled": bool(cfg.get("tradingEnabled", True)),
          "running": bool(s.get("bot", {}).get("alive", False)) and bool(cfg.get("tradingEnabled", True)),
          "positionOpen": pos_open,
          "side": pos.get("side"),
          "timeSinceEntrySec": (max(0, int((now_ms - int(entry_at)) / 1000)) if entry_at else None),
          "entryAt": entry_at,
          "initialHoldEndsAt": min_hold_until,
          "nextReassessAt": next_reassess_at,
          "maxHoldEndsAt": max_hold_until,
          "nextDecisionAt": next_entry_eval,
          "countdowns": {
            "initialHoldEndsInSec": to_countdown_sec(min_hold_until, now_ms),
            "nextReassessInSec": to_countdown_sec(next_reassess_at, now_ms),
            "maxHoldEndsInSec": to_countdown_sec(max_hold_until, now_ms),
            "nextDecisionInSec": to_countdown_sec(next_entry_eval, now_ms),
          },
          "lastAction": s.get("lastAction"),
        },
      )
    if path.startswith("/uc5/chart"):
      range_raw = qs.get("range", ["24h"])[0]
      res_raw = qs.get("resolution", ["1m"])[0]
      out = query_chart_data(
        range_hours=parse_range_hours(range_raw),
        resolution_sec=parse_resolution_seconds(res_raw),
      )
      return self._send_json(200, out)
    if path.startswith("/uc5/portfolio"):
      cfg = get_runtime_config()
      with STATUS_LOCK:
        s = clone_jsonable(LATEST_STATUS)
      sub_id = str(cfg.get("subaccountId") or s.get("account", {}).get("subaccountId") or "")
      eth_base = str(cfg.get("etherealApiBase") or "https://api.ethereal.trade")
      snap = fetch_portfolio_snapshot(eth_base, sub_id)
      summary = query_trades_summary()
      used = _f(snap.get("usedMarginUsd")) or 0.0
      pv = _f(snap.get("portfolioValueUsd"))
      used_pct = ((used / pv) * 100.0) if pv and pv > 0 else (0.0 if used == 0 else None)
      unrealized = _f(s.get("position", {}).get("unrealizedPnl"))
      return self._send_json(
        200,
        {
          "updatedAt": int(time.time() * 1000),
          **snap,
          "usedMarginPct": used_pct,
          "unrealizedPnl": 0.0 if unrealized is None else unrealized,
          "realizedPnlToday": float(summary.get("realizedPnlToday") or 0.0),
          "realizedPnlTotal": float(summary.get("realizedPnlTotal") or 0.0),
        },
      )
    if path.startswith("/uc5/trades/summary"):
      return self._send_json(200, query_trades_summary())
    if path.startswith("/uc5/setup"):
      cfg = get_runtime_config()
      with STATUS_LOCK:
        s = clone_jsonable(LATEST_STATUS)
      signer_addr = str(cfg.get("botSignerAddress") or os.environ.get("UC5_BOT_SIGNER_ADDRESS", ""))
      sub_id = str(cfg.get("subaccountId") or s.get("account", {}).get("subaccountId") or "")
      eth_base = str(cfg.get("etherealApiBase") or "https://api.ethereal.trade")
      signer_linked = bool(cfg.get("botSignerLinked", False))
      if signer_addr and sub_id:
        signer_linked = is_linked_signer_active(eth_base, sub_id, signer_addr)
      require_signer_link = str(os.environ.get("UC5_REQUIRE_SIGNER_LINK", "1")).strip().lower() not in ("0", "false", "no", "off")
      missing: List[str] = []
      if not str(cfg.get("ownerAddress") or ""):
        missing.append("ownerAddress")
      if not str(cfg.get("subaccountId") or s.get("account", {}).get("subaccountId") or ""):
        missing.append("subaccountId")
      if not str(cfg.get("subaccountName") or s.get("account", {}).get("subaccountName") or ""):
        missing.append("subaccountName")
      if not str(cfg.get("productId") or ""):
        missing.append("productId")
      if require_signer_link and not signer_linked:
        missing.append("botSignerLink")
      return self._send_json(
        200,
        {
          "updatedAt": int(time.time() * 1000),
          "missing": missing,
          "needsSetup": len(missing) > 0,
          "botSigner": {
            "configuredAddress": signer_addr,
            "linkedDetectable": True,
            "linked": signer_linked,
            "required": require_signer_link,
            "status": ("linked" if signer_linked else ("required" if require_signer_link else "optional_recommended")),
          },
        },
      )
    return self._send_json(404, {"error": "not found"})

  def do_POST(self):
    if self.path.startswith("/config"):
      if not self._authorized():
        return self._send_json(403, {"error": "forbidden"})
      body = self._read_json()
      raw_cfg = body.get("config")
      if not isinstance(raw_cfg, dict):
        return self._send_json(400, {"error": "Missing config object"})
      cfg = set_runtime_config(raw_cfg)
      return self._send_json(200, {"ok": True, "config": cfg})

    if self.path.startswith("/command-updates"):
      if not self._authorized():
        return self._send_json(403, {"error": "forbidden"})
      body = self._read_json()
      updates = body.get("updates")
      if not isinstance(updates, list):
        return self._send_json(400, {"error": "Missing updates array"})
      apply_command_updates([u for u in updates if isinstance(u, dict)])
      return self._send_json(200, {"ok": True})

    if self.path.startswith("/command"):
      if not self._authorized():
        return self._send_json(403, {"error": "forbidden"})
      body = self._read_json()
      cmd_type = str(body.get("type") or "").strip().upper()
      payload = body.get("payload")
      if cmd_type not in ("FLATTEN", "LINK_SIGNER"):
        return self._send_json(400, {"error": f"Unsupported command type: {cmd_type or '(empty)'}"})
      if cmd_type == "LINK_SIGNER" and not isinstance(payload, dict):
        return self._send_json(400, {"error": "Missing payload for LINK_SIGNER"})
      cmd = enqueue_command(cmd_type, payload if isinstance(payload, dict) else None)
      return self._send_json(200, {"ok": True, "id": cmd["id"], "command": cmd})

    return self._send_json(404, {"error": "not found"})

  def log_message(self, format, *args):
    return


def start_telemetry_server():
  class _UC5TelemetryServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

  srv = _UC5TelemetryServer((TELEMETRY_HOST, TELEMETRY_PORT), TelemetryHandler)
  t = threading.Thread(target=srv.serve_forever, daemon=True)
  t.start()
  return srv


# ---- Ethereal REST helpers (public endpoints) ----
def fetch_product_id(eth_base: str, ticker: str) -> str:
  prod = requests.get(f"{eth_base}/v1/product", params={"ticker": ticker}, timeout=20).json()
  if prod.get("data"):
    return prod["data"][0]["id"]
  return ""


def fetch_product_row(eth_base: str, ticker: str, product_id: str) -> Dict[str, Any]:
  try:
    prod = requests.get(f"{eth_base}/v1/product", params={"ticker": ticker}, timeout=20).json()
    data = prod.get("data") if isinstance(prod, dict) else None
    if isinstance(data, list):
      for row in data:
        if not isinstance(row, dict):
          continue
        if product_id and str(row.get("id") or "") == product_id:
          return row
      if data and isinstance(data[0], dict):
        return data[0]
  except Exception:
    return {}
  return {}


def extract_lot_size(product_row: Dict[str, Any], fallback: float = 0.00001) -> float:
  if not isinstance(product_row, dict):
    return fallback
  for k in ("lotSize", "baseLotSize", "qtyIncrement", "quantityIncrement", "stepSize", "sizeStep"):
    v = product_row.get(k)
    try:
      x = float(v)
      if x > 0:
        return x
    except Exception:
      continue
  return fallback


def fetch_market_price(eth_base: str, product_id: str) -> Dict[str, Any]:
  # Endpoint commonly expects `productIds` and returns payload in `data[0]`.
  # Keep a fallback to `productId` for compatibility with older variants.
  r = requests.get(
    f"{eth_base}/v1/product/market-price",
    params={"productIds": product_id},
    timeout=20
  ).json()
  if isinstance(r, dict) and isinstance(r.get("data"), list) and r["data"]:
    row = r["data"][0]
    if isinstance(row, dict):
      return row

  r2 = requests.get(
    f"{eth_base}/v1/product/market-price",
    params={"productId": product_id},
    timeout=20
  ).json()
  if isinstance(r2, dict) and isinstance(r2.get("data"), list) and r2["data"]:
    row = r2["data"][0]
    if isinstance(row, dict):
      return row
  return r2 if isinstance(r2, dict) else {}


def fetch_subaccounts(eth_base: str, sender: str) -> List[Dict[str, Any]]:
  if not sender:
    return []
  try:
    raw = requests.get(
      f"{eth_base}/v1/subaccount",
      params={"sender": sender},
      timeout=20,
    ).json()
    data = raw.get("data") if isinstance(raw, dict) else None
    if isinstance(data, list):
      return [x for x in data if isinstance(x, dict)]
  except Exception:
    return []
  return []


def fetch_linked_signers(eth_base: str, subaccount_id: str, active: Optional[bool] = None) -> List[Dict[str, Any]]:
  if not subaccount_id:
    return []
  params: Dict[str, Any] = {"subaccountId": subaccount_id}
  if active is not None:
    params["active"] = str(bool(active)).lower()
  try:
    r = requests.get(f"{eth_base}/v1/linked-signer", params=params, timeout=20)
    if r.status_code == 400 and active is not None:
      # Some deployments do not accept the "active" query parameter.
      r = requests.get(
        f"{eth_base}/v1/linked-signer",
        params={"subaccountId": subaccount_id},
        timeout=20,
      )
    raw = r.json() if r.content else {}
    data = raw.get("data") if isinstance(raw, dict) else None
    if isinstance(data, list):
      return [x for x in data if isinstance(x, dict)]
  except Exception:
    return []
  return []


def is_linked_signer_active(eth_base: str, subaccount_id: str, signer_addr: str) -> bool:
  signer = str(signer_addr or "").strip().lower()
  if not signer or not subaccount_id:
    return False
  rows = fetch_linked_signers(eth_base, subaccount_id, active=True)
  for r in rows:
    s = str(r.get("signer") or "").strip().lower()
    if s == signer:
      status = str(r.get("status") or "").strip().upper()
      if status:
        return status in ("ACTIVE", "LINKED", "DONE")
      if "isActive" in r:
        return bool(r.get("isActive"))
      if "active" in r:
        return bool(r.get("active"))
      revoked = r.get("revokedAt")
      if revoked:
        return False
      exp = r.get("expiresAt")
      if exp is not None:
        try:
          now_ms = int(time.time() * 1000)
          exp_ms = int(exp)
          return exp_ms > now_ms
        except Exception:
          return True
      return True
  return False


def resolve_subaccount_context(
  eth_base: str,
  sender: str,
  subaccount_id: str,
  subaccount_name: str,
) -> Tuple[str, str]:
  sid = str(subaccount_id or "").strip()
  sname = str(subaccount_name or "").strip()
  if not sender or (sid and sname):
    return sid, sname

  subs = fetch_subaccounts(eth_base, sender)
  if not subs:
    return sid, sname

  if sid:
    for sub in subs:
      if str(sub.get("id") or "") == sid:
        if not sname:
          sname = str(sub.get("name") or "")
        return sid, sname

  if sname:
    for sub in subs:
      if str(sub.get("name") or "").lower() == sname.lower():
        if not sid:
          sid = str(sub.get("id") or "")
        if not sname:
          sname = str(sub.get("name") or "")
        return sid, sname

  if not sid and not sname:
    first = subs[0]
    sid = str(first.get("id") or "")
    sname = str(first.get("name") or "")

  return sid, sname


def fetch_active_position(eth_base: str, sub_id: str, product_id: str) -> Optional[Dict[str, Any]]:
  if not sub_id or not product_id:
    return None
  try:
    raw = requests.get(
      f"{eth_base}/v1/position/active",
      params={"subaccountId": sub_id, "productId": product_id},
      timeout=20
    ).json()
    if isinstance(raw, dict):
      data = raw.get("data")
      if isinstance(data, list):
        return data[0] if data else None
      if isinstance(data, dict):
        return data
      return raw
    return None
  except Exception:
    return None


def fetch_portfolio_snapshot(eth_base: str, sub_id: str) -> Dict[str, Any]:
  out = {
    "portfolioValueUsd": None,
    "availableMarginUsd": None,
    "usedMarginUsd": None,
    "error": None,
  }
  if not sub_id:
    return out
  try:
    def first_num(src: Dict[str, Any], keys: List[str]) -> Optional[float]:
      for k in keys:
        if k in src:
          v = _f(src.get(k))
          if v is not None:
            return v
      return None

    bal = requests.get(
      f"{eth_base}/v1/subaccount/balance",
      params={"subaccountId": sub_id},
      timeout=20,
    ).json()
    rows = bal.get("data") if isinstance(bal, dict) else None
    row: Dict[str, Any] = {}
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
      row = rows[0]
    elif isinstance(rows, dict):
      row = rows
    elif isinstance(bal, dict):
      row = bal

    if row:
      margin = row.get("margin")
      margin_obj = margin if isinstance(margin, dict) else {}
      avail = first_num(
        row,
        ["availableMarginUsd", "availableMargin", "available", "freeCollateral", "availableBalance", "availableUsd"],
      )
      if avail is None:
        avail = first_num(margin_obj, ["availableMarginUsd", "availableMargin", "freeCollateral", "available"])

      used = first_num(
        row,
        ["usedMarginUsd", "usedMargin", "marginUsed", "used", "initialMargin", "lockedMargin"],
      )
      if used is None:
        used = first_num(margin_obj, ["usedMarginUsd", "usedMargin", "marginUsed", "initialMargin"])
      if used is None:
        used = 0.0

      pv = first_num(
        row,
        ["portfolioValueUsd", "portfolioValue", "equityUsd", "equity", "balanceUsd", "balance", "netAssetValue"],
      )
      if pv is None:
        pv = first_num(margin_obj, ["portfolioValueUsd", "equityUsd", "equity"])
      if pv is None and avail is not None:
        pv = avail + used
      if avail is None and pv is not None:
        avail = max(0.0, pv - used)

      out["portfolioValueUsd"] = pv
      out["availableMarginUsd"] = avail
      out["usedMarginUsd"] = used
  except Exception as e:
    out["error"] = str(e)
  return out


def _f(x: Any) -> Optional[float]:
  try:
    if x is None:
      return None
    return float(x)
  except Exception:
    return None


def parse_position(pos: Optional[Dict[str, Any]]) -> Tuple[bool, Optional[str], float, Optional[float], Optional[float], Optional[int]]:
  # returns: (open, side, size, upnl-ish, entry_price, entry_at_ms)
  if not isinstance(pos, dict) or pos.get("size") is None:
    return (False, None, 0.0, None, None, None)

  size = float(pos.get("size") or 0)
  open_ = abs(size) > 0
  side: Optional[str] = None
  side_raw = pos.get("side")
  if isinstance(side_raw, str):
    s = side_raw.strip().upper()
    if s in ("LONG", "BUY", "BID", "0"):
      side = "LONG"
    elif s in ("SHORT", "SELL", "ASK", "1"):
      side = "SHORT"
  elif isinstance(side_raw, (int, float)):
    side = "LONG" if int(side_raw) == 0 else "SHORT"
  if side is None and open_:
    side = "LONG" if size > 0 else "SHORT"
  upnl = None
  for k in ("unrealizedPnl", "uPnl", "unrealized", "markPnl", "pnl", "realizedPnl"):
    if pos.get(k) is not None:
      try:
        upnl = float(pos.get(k) or 0)
        break
      except Exception:
        continue
  entry_price = (
    _f(pos.get("entryPrice"))
    or _f(pos.get("avgEntryPrice"))
    or _f(pos.get("averageEntryPrice"))
  )
  entry_at_ms = None
  for k in ("openedAt", "openTs", "updatedAt", "createdAt"):
    v = pos.get(k)
    if v is None:
      continue
    try:
      x = int(v)
      entry_at_ms = x if x > 10_000_000_000 else x * 1000
      break
    except Exception:
      continue
  return (open_, side, size, upnl, entry_price, entry_at_ms)


# ---- SDK trading helpers ----
async def ensure_client(cfg: Dict[str, Any]) -> AsyncRESTClient:
  """
  Ethereal SDK expects create({...}) with chain_config. :contentReference[oaicite:2]{index=2}
  """
  eth_base = cfg.get("etherealApiBase", "https://api.ethereal.trade")
  eth_rpc = cfg.get("etherealRpcUrl", "https://rpc.ethereal.trade")
  try:
    return await AsyncRESTClient.create({
      "base_url": eth_base,
      "chain_config": {
        "rpc_url": eth_rpc,
        "private_key": BOT_PRIVKEY,  # required for trading
      }
    })
  except TypeError:
    # Backward-compatible path for SDK variants that expose kwargs.
    return await AsyncRESTClient.create(
      private_key=BOT_PRIVKEY,
      api_url=eth_base,
      chain_rpc_url=eth_rpc,
    )


async def place_market(
  client: AsyncRESTClient,
  ticker: str,
  side_int: int,
  qty: float,
  sender: str,
  subaccount: str,
  lot_size: Optional[float] = None,
):
  """
  create_order expects:
    side=0 (buy) / 1 (sell), quantity=Decimal(...). :contentReference[oaicite:3]{index=3}
  """
  q_adj = quantize_qty_to_lot(qty, lot_size)
  if q_adj <= 0:
    raise RuntimeError(f"Quantity {qty} rounds to 0 at lotSize={lot_size}")
  q = Decimal(str(q_adj))
  # Some SDK builds accept price=None for MARKET; others are stricter.
  async def _submit(order_sender: str):
    try:
      await client.create_order(
        order_type="MARKET",
        quantity=q,
        side=side_int,
        price=None,
        ticker=ticker,
        sender=order_sender,
        subaccount=subaccount,
      )
    except TypeError:
      await client.create_order(
        order_type="MARKET",
        quantity=q,
        side=side_int,
        price=Decimal("0"),
        ticker=ticker,
        sender=order_sender,
        subaccount=subaccount,
      )

  try:
    await _submit(sender)
  except Exception as first_error:
    err = str(first_error or "")
    # Some deployments authorize linked signers only when sender == signer EOA.
    if (
      ("401" in err or "Unauthorized" in err)
      and BOT_SIGNER_ADDRESS
      and BOT_SIGNER_ADDRESS.lower() != str(sender or "").lower()
    ):
      await _submit(BOT_SIGNER_ADDRESS)
      return
    raise


async def close_position_if_any(
  client: AsyncRESTClient,
  ticker: str,
  pos_open: bool,
  pos_side: Optional[str],
  pos_size: float,
  sender: str,
  subaccount: str,
  lot_size: Optional[float] = None,
):
  if not pos_open or not pos_side or abs(pos_size) <= 0:
    return
  # If LONG -> SELL to close, if SHORT -> BUY to close
  side_int = 1 if pos_side == "LONG" else 0
  await place_market(client, ticker, side_int, abs(pos_size), sender, subaccount, lot_size)


# ---- LINK_SIGNER helper (kept as-is for your current dashboard flow) ----
async def process_link_signer(cfg: Dict[str, Any], cmd: Dict[str, Any]) -> Dict[str, Any]:
  eth_base = cfg["etherealApiBase"]
  payload = cmd["payload"]

  rpc = requests.get(f"{eth_base}/v1/rpc/config", timeout=20).json()
  domain = rpc.get("domain")
  if not domain:
    raise RuntimeError("Could not fetch /v1/rpc/config domain")

  typed = {
    "types": {
      "EIP712Domain": [
        {"name": "name", "type": "string"},
        {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"},
        {"name": "verifyingContract", "type": "address"},
      ],
      "LinkSigner": [
        {"name": "sender", "type": "address"},
        {"name": "signer", "type": "address"},
        {"name": "subaccount", "type": "bytes32"},
        {"name": "nonce", "type": "uint64"},
        {"name": "signedAt", "type": "uint64"},
      ],
    },
    "primaryType": "LinkSigner",
    "domain": domain,
    "message": {
      "sender": payload["sender"],
      "signer": payload["signer"],
      "subaccount": payload["subaccount"],
      "nonce": int(payload["nonce"]),
      "signedAt": int(payload["signedAt"]),
    },
  }

  # Always sign with the explicit bot private key for deterministic EOA signatures.
  from eth_account import Account
  from eth_account.messages import encode_typed_data
  pk = str(BOT_PRIVKEY or "").strip().strip('"').strip("'")
  acct = Account.from_key(pk)
  expected_signer = str(payload.get("signer") or "").strip().lower()
  actual_signer = str(acct.address or "").strip().lower()
  if expected_signer and expected_signer != actual_signer:
    raise RuntimeError(
      f"BOT_PRIVKEY address mismatch: env key resolves to {acct.address}, payload signer is {payload.get('signer')}"
    )
  msg = encode_typed_data(full_message=typed)
  signer_sig = acct.sign_message(msg).signature.hex()
  if not str(signer_sig).startswith("0x"):
    signer_sig = f"0x{signer_sig}"

  body = {
    "signature": payload["senderSignature"],
    "signerSignature": signer_sig,
    "data": {
      "subaccountId": payload["subaccountId"],
      "sender": payload["sender"],
      "subaccount": payload["subaccount"],
      "signer": payload["signer"],
      "nonce": payload["nonce"],
      "signedAt": payload["signedAt"],
    }
  }

  r = requests.post(f"{eth_base}/v1/linked-signer/link", json=body, timeout=20)
  if r.status_code >= 300:
    raise RuntimeError(f"Link signer failed: {r.status_code} {r.text}")
  return r.json()


async def main():
  global LATEST_STATUS

  # Start telemetry server immediately
  start_telemetry_server()

  conn = db_connect()
  w = ensure_model(conn)

  if not BOT_PRIVKEY:
    raise SystemExit("Missing env UC5_BOT_SIGNER_PRIVATE_KEY (bot signer private key).")

  client: Optional[AsyncRESTClient] = None
  last_order_ts: List[float] = []
  last_position_opened_ms: Optional[int] = None
  next_reassess_ms: Optional[int] = None
  last_decision_at_ms: Optional[int] = None
  last_reason = "warming up (need more history)"
  last_conf = 0.5
  last_desired = "FLAT"
  last_mid: Optional[float] = None
  last_oracle: Optional[float] = None
  last_bid: Optional[float] = None
  last_ask: Optional[float] = None
  last_ingested_ms: Optional[int] = None
  cached_product_id: str = ""
  cached_lot_size: float = 0.00001

  while True:
    loop_started = time.time()
    status_payload: Dict[str, Any] = {}

    try:
      cfg = get_runtime_config()
      eth_base = cfg.get("etherealApiBase", "https://api.ethereal.trade")
      ingest_enabled = bool(cfg.get("ingestionEnabled", True))
      trading_enabled = bool(cfg.get("tradingEnabled", True))

      # Resolve identifiers early (so commands can use them)
      ticker = cfg.get("ticker", "BTCUSD")
      product_id = cfg.get("productId", "") or fetch_product_id(eth_base, ticker)
      if not product_id:
        raise RuntimeError(f"No productId found for ticker={ticker}")
      if product_id != cached_product_id:
        row = fetch_product_row(eth_base, ticker, product_id)
        cached_lot_size = extract_lot_size(row, fallback=0.00001)
        cached_product_id = product_id
      sub_id = str(cfg.get("subaccountId", "") or "")
      owner_addr_raw = str(cfg.get("ownerAddress") or "")
      owner_addr = owner_addr_raw.lower()
      subaccount_name = str(cfg.get("subaccountName") or "")
      configured_signer_addr = str(cfg.get("botSignerAddress") or "")
      sub_id, subaccount_name = resolve_subaccount_context(
        eth_base=eth_base,
        sender=owner_addr,
        subaccount_id=sub_id,
        subaccount_name=subaccount_name,
      )
      signer_active = True
      if configured_signer_addr and sub_id:
        signer_active = is_linked_signer_active(eth_base, sub_id, configured_signer_addr)
        cfg_linked = bool(cfg.get("botSignerLinked", False))
        if signer_active != cfg_linked:
          cfg = set_runtime_config({**cfg, "botSignerLinked": signer_active})
      missing_trade_ctx = []
      if not owner_addr_raw:
        missing_trade_ctx.append("ownerAddress")
      if not subaccount_name:
        missing_trade_ctx.append("subaccountName")
      has_trade_account_ctx = bool(owner_addr_raw and subaccount_name)

      # Fetch active position once per loop (used for FLATTEN and status)
      pos = fetch_active_position(eth_base, sub_id, product_id)
      pos_open, pos_side, pos_size, pos_upnl, pos_entry_price, pos_entry_at_ms = parse_position(pos)
      if pos_open and (pos_entry_price is None or pos_entry_at_ms is None):
        open_leg = query_open_leg_from_trades()
        if open_leg:
          if pos_entry_price is None:
            pos_entry_price = _f(open_leg.get("price"))
          if pos_entry_at_ms is None:
            try:
              pos_entry_at_ms = int(open_leg.get("ts_ms")) if open_leg.get("ts_ms") is not None else None
            except Exception:
              pos_entry_at_ms = pos_entry_at_ms
          if not pos_side:
            leg_side = str(open_leg.get("side") or "").upper()
            if leg_side in ("LONG", "SHORT"):
              pos_side = leg_side

      ts_ms = int(time.time() * 1000)
      horizon_sec = max(5, int(cfg.get("predictionHorizonSeconds", 3600)))
      min_hold_sec = max(5, int(cfg.get("minHoldSeconds", 3600)))
      reassess_sec = max(5, int(cfg.get("reassessIntervalSec", 300)))
      max_hold = max(int(cfg.get("maxHoldSeconds", 7200)), min_hold_sec)
      ingest_interval = max(1, int(cfg.get("ingestIntervalSec", cfg.get("pollIntervalSeconds", 2))))

      # Keep local timers aligned with live exchange position.
      if pos_open:
        inferred_entry_ms = int(pos_entry_at_ms or last_position_opened_ms or ts_ms)
        if last_position_opened_ms is None:
          last_position_opened_ms = inferred_entry_ms
        min_hold_anchor = int(last_position_opened_ms) + min_hold_sec * 1000
        if next_reassess_ms is None or next_reassess_ms < min_hold_anchor:
          next_reassess_ms = min_hold_anchor
      else:
        last_position_opened_ms = None
        next_reassess_ms = None

      # ---- Commands ----
      async def ensure_client_ready(timeout_sec: float = 2.0) -> Optional[str]:
        nonlocal client
        if client is not None:
          return None
        try:
          client = await asyncio.wait_for(ensure_client(cfg), timeout=timeout_sec)
          return None
        except asyncio.TimeoutError:
          return "SDK client init timed out (check ethereal API/RPC reachability)"
        except Exception as ce:
          return f"SDK client init failed: {ce}"

      cmds = get_new_commands()
      updates = []
      for c in cmds:
        if c.get("status") != "NEW":
          continue
        cid = c.get("id")
        try:
          if c.get("type") == "FLATTEN":
            if not has_trade_account_ctx:
              updates.append({
                "id": cid,
                "status": "ERROR",
                "result": {"error": f"Missing {', '.join(missing_trade_ctx)} in config. Discover subaccount and save config first."},
              })
            else:
              cerr = await ensure_client_ready()
              if cerr or client is None:
                updates.append({"id": cid, "status": "ERROR", "result": {"error": cerr or "SDK client unavailable"}})
                continue
              await close_position_if_any(client, ticker, pos_open, pos_side, pos_size, owner_addr, subaccount_name, cached_lot_size)
              if pos_open:
                insert_trade_event(
                  conn,
                  ts_ms,
                  "FLATTEN",
                  pos_side,
                  abs(pos_size) if pos_size else None,
                  last_mid if last_mid is not None else pos_entry_price,
                  pos_upnl,
                  "manual_flatten_command",
                )
              pos_open, pos_side, pos_size, pos_upnl, pos_entry_price = False, None, 0.0, None, None
              last_position_opened_ms = None
              next_reassess_ms = None
              updates.append({"id": cid, "status": "DONE", "result": {"ok": True}})
          elif c.get("type") == "LINK_SIGNER":
            out = await process_link_signer(cfg, c)
            link_status = str((out or {}).get("status") or "").strip().upper()
            linked_now = link_status in ("ACTIVE", "LINKED", "DONE")
            cur = get_runtime_config()
            set_runtime_config(
              {
                **cur,
                "botSignerLinked": linked_now,
                "botSignerAddress": str(c.get("payload", {}).get("signer") or cur.get("botSignerAddress") or ""),
              }
            )
            updates.append({"id": cid, "status": "DONE", "result": out})
          else:
            updates.append({"id": cid, "status": "ERROR", "result": {"error": "Unknown command"}})
        except Exception as ce:
          updates.append({"id": cid, "status": "ERROR", "result": {"error": str(ce)}})

      apply_command_updates(updates)

      # ---- Market price ----
      mp = fetch_market_price(eth_base, product_id)
      best_bid = float(mp.get("bestBidPrice") or mp.get("bestBid") or 0)
      best_ask = float(mp.get("bestAskPrice") or mp.get("bestAsk") or 0)
      oracle = float(mp.get("oraclePrice") or mp.get("oracle") or mp.get("price") or 0)
      mid = (best_bid + best_ask) / 2.0 if best_bid and best_ask else (oracle or best_bid or best_ask)
      if mid <= 0:
        raise RuntimeError(f"Market price unavailable for ticker={ticker}, productId={product_id}")
      last_mid = mid
      last_oracle = oracle
      last_bid = best_bid
      last_ask = best_ask

      if ingest_enabled:
        if last_ingested_ms is None or (ts_ms - last_ingested_ms) >= max(500, ingest_interval * 1000 - 100):
          conn.execute(
            "INSERT OR REPLACE INTO prices(ts_ms, price, oracle, bid, ask) VALUES (?,?,?,?,?)",
            (ts_ms, mid, oracle, best_bid, best_ask),
          )
          conn.commit()
          last_ingested_ms = ts_ms

      # ---- Learning + decision cadence ----
      w = train_online(conn, w, lr=0.25)
      set_model(conn, w)

      horizon_ms = int(horizon_sec * 1000)
      decision_interval_ms = int(reassess_sec * 1000)

      evaluate_now = False
      evaluate_for_entry = False
      evaluate_for_reassess = False
      if (not pos_open) and (last_decision_at_ms is None):
        evaluate_now = True
        evaluate_for_entry = True
      elif (not pos_open) and (last_decision_at_ms is not None) and (ts_ms - last_decision_at_ms >= decision_interval_ms):
        evaluate_now = True
        evaluate_for_entry = True
      elif pos_open and next_reassess_ms and ts_ms >= next_reassess_ms:
        evaluate_now = True
        evaluate_for_reassess = True

      reason = last_reason
      p_up = float(last_conf)
      desired = str(last_desired)
      if evaluate_now:
        feats, reason = compute_features(conn)
        p_up = predict(w, feats)

        conn.execute(
          "INSERT INTO decisions(ts_ms, horizon_sec, p_up, f1,f2,f3,f4,f5,f6) VALUES (?,?,?,?,?,?,?,?,?)",
          (ts_ms, horizon_sec, p_up, feats[1], feats[2], feats[3], feats[4], feats[5], feats[6])
        )
        conn.commit()

        thr = float(cfg.get("confidenceThreshold", 0.6))
        desired = "FLAT"
        if p_up > thr:
          desired = "LONG"
        elif p_up < (1.0 - thr):
          desired = "SHORT"

        last_decision_at_ms = ts_ms
        last_reason = reason
        last_conf = float(p_up)
        last_desired = desired

        if pos_open and evaluate_for_reassess:
          next_reassess_ms = ts_ms + int(reassess_sec * 1000)

      min_hold_until = (last_position_opened_ms + min_hold_sec * 1000) if last_position_opened_ms else None
      max_hold_until = (last_position_opened_ms + max_hold * 1000) if last_position_opened_ms else None
      human_reason, raw_reason = explain_agent_reason(reason, desired, float(p_up))

      action_taken = {"type": "NO_ACTION", "ok": True, "info": None}

      # ---- Trade gate ----
      if not has_trade_account_ctx:
        action_taken = {
          "type": "SKIP_ACCOUNT_CONTEXT_MISSING",
          "ok": False,
          "info": {"missing": missing_trade_ctx},
        }
      elif not signer_active:
        action_taken = {
          "type": "SKIP_SIGNER_NOT_ACTIVE",
          "ok": False,
          "info": {"botSignerAddress": configured_signer_addr},
        }
      elif not trading_enabled:
        if pos_open:
          cerr = await ensure_client_ready()
          if cerr or client is None:
            action_taken = {"type": "SKIP_CLIENT_UNAVAILABLE", "ok": False, "info": {"error": cerr or "SDK client unavailable"}}
          else:
            await close_position_if_any(client, ticker, pos_open, pos_side, pos_size, owner_addr, subaccount_name, cached_lot_size)
            insert_trade_event(
              conn,
              ts_ms,
              "FLATTEN",
              pos_side,
              abs(pos_size) if pos_size else None,
              mid,
              pos_upnl,
              "trading_disabled",
            )
            last_order_ts.append(time.time())
            pos_open, pos_side, pos_size, pos_upnl, pos_entry_price = False, None, 0.0, None, None
            last_position_opened_ms = None
            next_reassess_ms = None
            action_taken = {"type": "AUTO_FLATTEN_TRADING_OFF", "ok": True, "info": None}
        else:
          action_taken = {"type": "TRADING_DISABLED_IDLE", "ok": True, "info": None}
      else:
        max_oph = int(cfg.get("maxOrdersPerHour", 120))
        now = time.time()
        last_order_ts[:] = [t for t in last_order_ts if now - t < 3600]
        can_open = len(last_order_ts) < max_oph

        # Force close if max position age is reached.
        if pos_open and max_hold_until and ts_ms >= max_hold_until:
          cerr = await ensure_client_ready()
          if cerr or client is None:
            action_taken = {"type": "SKIP_CLIENT_UNAVAILABLE", "ok": False, "info": {"error": cerr or "SDK client unavailable"}}
          else:
            await close_position_if_any(client, ticker, pos_open, pos_side, pos_size, owner_addr, subaccount_name, cached_lot_size)
            insert_trade_event(
              conn,
              ts_ms,
              "EXIT",
              pos_side,
              abs(pos_size) if pos_size else None,
              mid,
              pos_upnl,
              "max_hold_reached",
            )
            last_order_ts.append(now)
            pos_open, pos_side, pos_size, pos_upnl, pos_entry_price = False, None, 0.0, None, None
            last_position_opened_ms, next_reassess_ms = None, None
            action_taken = {"type": "CLOSE_MAX_HOLD", "ok": True, "info": {"maxHoldSeconds": max_hold}}

        elif not pos_open:
          # Only evaluate new entries at horizon cadence (>= 60m).
          if not evaluate_for_entry:
            action_taken = {
              "type": "WAIT_ENTRY_REASSESS",
              "ok": True,
              "info": {"nextAt": (last_decision_at_ms + decision_interval_ms) if last_decision_at_ms else ts_ms},
            }
          elif desired in ("LONG", "SHORT"):
            if not can_open:
              action_taken = {"type": "RATE_LIMITED", "ok": False, "info": {"maxOrdersPerHour": max_oph}}
            else:
              conf = clamp(abs(p_up - 0.5) * 2.0, 0.0, 1.0)
              snap = fetch_portfolio_snapshot(eth_base, sub_id)
              avail = _f(snap.get("availableMarginUsd"))
              portfolio_val = _f(snap.get("portfolioValueUsd"))
              max_margin = float(cfg.get("maxMarginUsd", 100))
              max_margin_pct = float(cfg.get("maxMarginPct", 25.0))
              pct_cap = (portfolio_val * max_margin_pct / 100.0) if portfolio_val and portfolio_val > 0 else None
              if pct_cap is not None:
                max_margin = min(max_margin, pct_cap)
              lev = float(cfg.get("maxLeverage", 2))
              margin_use = min(max_margin, (avail if avail is not None else max_margin))
              notional = margin_use * lev * conf
              qty_raw = max(0.0, (notional / mid) if mid > 0 else 0.0)
              qty = quantize_qty_to_lot(qty_raw, cached_lot_size)

              if qty > 0:
                cerr = await ensure_client_ready()
                if cerr or client is None:
                  action_taken = {"type": "SKIP_CLIENT_UNAVAILABLE", "ok": False, "info": {"error": cerr or "SDK client unavailable"}}
                else:
                  side_int = 0 if desired == "LONG" else 1
                  await place_market(client, ticker, side_int, qty, owner_addr, subaccount_name, cached_lot_size)
                  insert_trade_event(conn, ts_ms, "ENTRY", desired, qty, mid, None, "model_entry")
                  last_order_ts.append(now)
                  last_position_opened_ms = ts_ms
                  pos_open, pos_side, pos_size, pos_entry_price = True, desired, qty, mid
                  next_reassess_ms = ts_ms + min_hold_sec * 1000
                  action_taken = {"type": f"OPEN_{desired}", "ok": True, "info": {"qty": qty, "qtyRaw": qty_raw, "lotSize": cached_lot_size, "conf": conf, "lev": lev, "margin": margin_use}}
              else:
                action_taken = {"type": "SKIP_QTY_BELOW_LOT", "ok": False, "info": {"qtyRaw": qty_raw, "lotSize": cached_lot_size}}
          else:
            action_taken = {"type": "SKIP_NO_SIGNAL", "ok": True, "info": {"desired": desired}}

        else:
          # In trade: hold for at least horizon, then reassess periodically.
          if not evaluate_for_reassess:
            action_taken = {"type": "HOLD_UNTIL_REASSESS", "ok": True, "info": {"nextAt": next_reassess_ms}}
          elif desired == pos_side:
            action_taken = {"type": "HOLD_AFTER_REASSESS", "ok": True, "info": {"nextAt": next_reassess_ms}}
          else:
            cerr = await ensure_client_ready()
            if cerr or client is None:
              action_taken = {"type": "SKIP_CLIENT_UNAVAILABLE", "ok": False, "info": {"error": cerr or "SDK client unavailable"}}
            else:
              prev_side = pos_side
              await close_position_if_any(client, ticker, pos_open, pos_side, pos_size, owner_addr, subaccount_name, cached_lot_size)
              insert_trade_event(
                conn,
                ts_ms,
                "EXIT",
                pos_side,
                abs(pos_size) if pos_size else None,
                mid,
                pos_upnl,
                "reassess_exit",
              )
              last_order_ts.append(now)
              pos_open, pos_side, pos_size, pos_upnl, pos_entry_price = False, None, 0.0, None, None
              last_position_opened_ms, next_reassess_ms = None, None
              action_taken = {
                "type": "LIQUIDATE_REASSESS",
                "ok": True,
                "info": {"from": prev_side, "modelDesired": desired},
              }

      # ---- Build status ----
      status_payload = {
        "updatedAt": int(time.time() * 1000),
        "bot": {
          "alive": True,
          "lastLoopAt": int(time.time() * 1000),
          "message": "running",
          "version": BOT_VERSION,
        },
        "runtime": {
          "ingestionEnabled": ingest_enabled,
          "tradingEnabled": trading_enabled,
          "ingestIntervalSec": ingest_interval,
          "reassessIntervalSec": reassess_sec,
          "predictionHorizonSeconds": horizon_sec,
          "minHoldSeconds": min_hold_sec,
          "maxHoldSeconds": max_hold,
          "maxLeverage": float(cfg.get("maxLeverage", 2)),
          "maxMarginUsd": float(cfg.get("maxMarginUsd", 100)),
          "maxMarginPct": float(cfg.get("maxMarginPct", 25.0)),
          "confidenceThreshold": float(cfg.get("confidenceThreshold", 0.6)),
        },
        "market": {
          "ticker": ticker,
          "price": mid,
          "oraclePrice": oracle,
          "bestBid": best_bid,
          "bestAsk": best_ask,
        },
        "account": {
          "owner": owner_addr_raw,
          "subaccountId": sub_id,
          "subaccountName": subaccount_name,
        },
        "position": {
          "open": bool(pos_open),
          "side": pos_side,
          "size": pos_size,
          "entryPrice": pos_entry_price,
          "entryAt": last_position_opened_ms,
          "ageSec": (max(0, int((ts_ms - last_position_opened_ms) / 1000)) if last_position_opened_ms else None),
          "unrealizedPnl": pos_upnl,
          "updatedAt": int(time.time() * 1000),
        },
        "agent": {
          "desired": desired,
          "confidence": float(p_up),
          "confidenceBand": confidence_band(float(p_up)),
          "reason": raw_reason,
          "reasonHuman": human_reason,
          "reasonRaw": raw_reason,
          "lastDecisionAt": last_decision_at_ms,
          "decisionHorizonSeconds": horizon_sec,
          "decisionIntervalSeconds": reassess_sec,
          "nextReassessAt": next_reassess_ms,
          "minHoldUntil": min_hold_until,
          "maxHoldUntil": max_hold_until,
        },
        "trading": {
          "enabled": trading_enabled,
          "running": trading_enabled,
          "positionOpen": bool(pos_open),
          "entryAt": last_position_opened_ms,
          "initialHoldEndsAt": min_hold_until,
          "nextReassessAt": next_reassess_ms,
          "maxHoldEndsAt": max_hold_until,
          "nextDecisionAt": (
            None
            if pos_open
            else ((last_decision_at_ms + decision_interval_ms) if last_decision_at_ms else ts_ms)
          ),
          "countdowns": {
            "initialHoldEndsInSec": to_countdown_sec(min_hold_until, ts_ms),
            "nextReassessInSec": to_countdown_sec(next_reassess_ms, ts_ms),
            "maxHoldEndsInSec": to_countdown_sec(max_hold_until, ts_ms),
            "nextDecisionInSec": to_countdown_sec(
              None if pos_open else ((last_decision_at_ms + decision_interval_ms) if last_decision_at_ms else ts_ms),
              ts_ms,
            ),
          },
        },
        "lastAction": action_taken,
      }

    except Exception as e:
      status_payload = {
        "updatedAt": int(time.time() * 1000),
        "bot": {
          "alive": True,
          "lastLoopAt": int(time.time() * 1000),
          "message": f"error: {str(e)}",
          "version": BOT_VERSION,
        },
        "market": {
          "ticker": get_runtime_config().get("ticker", "BTCUSD"),
          "price": last_mid,
          "oraclePrice": last_oracle,
          "bestBid": last_bid,
          "bestAsk": last_ask,
        },
      }

    # Update telemetry (served from VPS)
    with STATUS_LOCK:
      LATEST_STATUS = status_payload

    # Sleep — use runtime config (2s default)
    try:
      cfg_now = get_runtime_config()
      interval = int(cfg_now.get("ingestIntervalSec", cfg_now.get("pollIntervalSeconds", 2)))
    except Exception:
      interval = 2

    elapsed = time.time() - loop_started
    to_sleep = max(0.2, float(interval) - float(elapsed))
    await asyncio.sleep(to_sleep)


if __name__ == "__main__":
  asyncio.run(main())
