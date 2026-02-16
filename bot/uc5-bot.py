# bot/uc5-bot.py
"""
UC5 Ethereal Autopilot Bot (mainnet)

- NO high-frequency writes to Vercel Blob anymore (prevents Advanced Ops burn).
- Runs a small HTTP telemetry server on the VPS:
    GET /status  -> latest status JSON for the dashboard
    GET /health  -> {"ok": true}
- Throttles dashboard reads (config/commands) to reduce Vercel ops.

IMPORTANT:
This is a demo trading bot. It can lose money. Start tiny (e.g. 100 USDe) and keep leverage low.
"""

import os, time, json, math, sqlite3, requests, asyncio, threading
from decimal import Decimal
from typing import Optional, Dict, Any, List, Tuple
from http.server import BaseHTTPRequestHandler, HTTPServer

# ethereal-sdk (async) — support both import styles
try:
  from ethereal import AsyncRESTClient
except Exception:
  from ethereal.async_rest_client import AsyncRESTClient


# ---- Env ----
DASH_BASE = os.environ.get("UC5_DASHBOARD_BASE_URL", "").rstrip("/")
BOT_TOKEN = os.environ.get("UC5_BOT_TOKEN", "")
BOT_PRIVKEY = os.environ.get("UC5_BOT_SIGNER_PRIVATE_KEY", "")  # linked signer EOA private key (0x...)

DB_PATH = os.environ.get("UC5_SQLITE_PATH", os.path.join(os.path.dirname(__file__), "uc5.sqlite"))

# Telemetry server (VPS)
TELEMETRY_HOST = os.environ.get("UC5_TELEMETRY_HOST", "0.0.0.0")
TELEMETRY_PORT = int(os.environ.get("UC5_TELEMETRY_PORT", "8787"))

# Reduce dashboard polling
CFG_REFRESH_SECONDS = int(os.environ.get("UC5_CFG_REFRESH_SECONDS", "300"))     # config fetch at most every 5 min
CMDS_REFRESH_SECONDS = int(os.environ.get("UC5_CMDS_REFRESH_SECONDS", "30"))    # commands fetch at most every 30s

if not DASH_BASE or not BOT_TOKEN:
  raise SystemExit("Missing env: UC5_DASHBOARD_BASE_URL and/or UC5_BOT_TOKEN")


def bot_headers() -> Dict[str, str]:
  return {"x-uc5-bot-token": BOT_TOKEN}


def http_get(path: str) -> Any:
  r = requests.get(f"{DASH_BASE}{path}", timeout=20)
  r.raise_for_status()
  return r.json()


def http_post(path: str, payload: Any, headers: Optional[Dict[str, str]] = None) -> Any:
  h = {"Content-Type": "application/json"}
  if headers:
    h.update(headers)
  r = requests.post(f"{DASH_BASE}{path}", data=json.dumps(payload), headers=h, timeout=20)
  r.raise_for_status()
  return r.json()


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
  trend = (sma20 - sma60) / px[-1]

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
    rets.append((px[i] / px[i - 1]) - 1.0)
  mu = sum(rets) / len(rets)
  var = sum((x - mu) * (x - mu) for x in rets) / max(1, len(rets) - 1)
  vol = math.sqrt(var)

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


# ---- Telemetry server (in-memory latest status) ----
LATEST_STATUS: Dict[str, Any] = {"bot": {"alive": False, "message": "starting"}}
STATUS_LOCK = threading.Lock()


class TelemetryHandler(BaseHTTPRequestHandler):
  def _send_json(self, code: int, obj: Any):
    body = json.dumps(obj).encode("utf-8")
    self.send_response(code)
    self.send_header("Content-Type", "application/json")
    self.send_header("Access-Control-Allow-Origin", "*")
    self.send_header("Cache-Control", "no-store")
    self.end_headers()
    self.wfile.write(body)

  def do_GET(self):
    if self.path.startswith("/health"):
      return self._send_json(200, {"ok": True})
    if self.path.startswith("/status"):
      with STATUS_LOCK:
        data = LATEST_STATUS
      return self._send_json(200, data)
    return self._send_json(404, {"error": "not found"})

  def log_message(self, format, *args):
    return


def start_telemetry_server():
  srv = HTTPServer((TELEMETRY_HOST, TELEMETRY_PORT), TelemetryHandler)
  t = threading.Thread(target=srv.serve_forever, daemon=True)
  t.start()
  return srv


# ---- Ethereal REST helpers (public endpoints) ----
def fetch_product_id(eth_base: str, ticker: str) -> str:
  prod = requests.get(f"{eth_base}/v1/product", params={"ticker": ticker}, timeout=20).json()
  if prod.get("data"):
    return prod["data"][0]["id"]
  return ""


def fetch_market_price(eth_base: str, product_id: str) -> Dict[str, Any]:
  return requests.get(
    f"{eth_base}/v1/product/market-price",
    params={"productId": product_id},
    timeout=20
  ).json()


def fetch_active_position(eth_base: str, sub_id: str, product_id: str) -> Optional[Dict[str, Any]]:
  if not sub_id or not product_id:
    return None
  try:
    return requests.get(
      f"{eth_base}/v1/position/active",
      params={"subaccountId": sub_id, "productId": product_id},
      timeout=20
    ).json()
  except Exception:
    return None


def parse_position(pos: Optional[Dict[str, Any]]) -> Tuple[bool, Optional[str], float, Optional[float]]:
  # returns: (open, side, size, upnl-ish)
  if not isinstance(pos, dict) or pos.get("size") is None:
    return (False, None, 0.0, None)

  size = float(pos.get("size") or 0)
  open_ = abs(size) > 0
  side_int = pos.get("side")
  side = "LONG" if side_int == 0 else "SHORT"
  upnl = None
  if pos.get("realizedPnl") is not None:
    upnl = float(pos.get("realizedPnl") or 0)
  return (open_, side, size, upnl)


# ---- SDK trading helpers ----
async def ensure_client(cfg: Dict[str, Any]) -> AsyncRESTClient:
  """
  Ethereal SDK expects create({...}) with chain_config. :contentReference[oaicite:2]{index=2}
  """
  eth_base = cfg.get("etherealApiBase", "https://api.ethereal.trade")
  eth_rpc = cfg.get("etherealRpcUrl", "https://rpc.ethereal.trade")
  return await AsyncRESTClient.create({
    "base_url": eth_base,
    "chain_config": {
      "rpc_url": eth_rpc,
      "private_key": BOT_PRIVKEY,  # required for trading
    }
  })


async def place_market(client: AsyncRESTClient, ticker: str, side_int: int, qty: float):
  """
  create_order expects:
    side=0 (buy) / 1 (sell), quantity=Decimal(...). :contentReference[oaicite:3]{index=3}
  """
  q = Decimal(str(qty))
  # Some SDK builds accept price=None for MARKET; others are stricter.
  try:
    await client.create_order(
      order_type="MARKET",
      quantity=q,
      side=side_int,
      price=None,
      ticker=ticker,
    )
  except TypeError:
    await client.create_order(
      order_type="MARKET",
      quantity=q,
      side=side_int,
      price=Decimal("0"),
      ticker=ticker,
    )


async def close_position_if_any(
  client: AsyncRESTClient,
  ticker: str,
  pos_open: bool,
  pos_side: Optional[str],
  pos_size: float
):
  if not pos_open or not pos_side or abs(pos_size) <= 0:
    return
  # If LONG -> SELL to close, if SHORT -> BUY to close
  side_int = 1 if pos_side == "LONG" else 0
  await place_market(client, ticker, side_int, abs(pos_size))


# ---- LINK_SIGNER helper (kept as-is for your current dashboard flow) ----
async def process_link_signer(cfg: Dict[str, Any], cmd: Dict[str, Any], client: AsyncRESTClient) -> Dict[str, Any]:
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

  signer_sig = None
  try:
    acct = getattr(client, "_account", None) or getattr(client, "account", None)
    if acct is None:
      raise Exception("no account on client")
    from eth_account.messages import encode_typed_data
    msg = encode_typed_data(full_message=typed)
    signer_sig = acct.sign_message(msg).signature.hex()
  except Exception:
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    acct = Account.from_key(BOT_PRIVKEY)
    msg = encode_typed_data(full_message=typed)
    signer_sig = acct.sign_message(msg).signature.hex()

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

  cfg_cache: Optional[Dict[str, Any]] = None
  cfg_last_fetch = 0.0
  cmds_last_fetch = 0.0
  cmds_cache: List[Dict[str, Any]] = []

  def get_cfg() -> Dict[str, Any]:
    nonlocal cfg_cache, cfg_last_fetch
    now = time.time()
    if cfg_cache is None or (now - cfg_last_fetch) >= CFG_REFRESH_SECONDS:
      cfg_cache = http_get("/api/uc5/config")
      cfg_last_fetch = now
    return cfg_cache

  def get_cmds() -> List[Dict[str, Any]]:
    nonlocal cmds_cache, cmds_last_fetch
    now = time.time()
    if (now - cmds_last_fetch) >= CMDS_REFRESH_SECONDS:
      cmds_file = requests.get(f"{DASH_BASE}/api/uc5/bot/commands", headers=bot_headers(), timeout=20).json()
      cmds_cache = cmds_file.get("commands", [])
      cmds_last_fetch = now
    return cmds_cache

  while True:
    loop_started = time.time()
    status_payload: Dict[str, Any] = {}

    try:
      cfg = get_cfg()
      eth_base = cfg.get("etherealApiBase", "https://api.ethereal.trade")

      # Ensure client (SDK)
      if client is None:
        client = await ensure_client(cfg)

      # Resolve identifiers early (so commands can use them)
      ticker = cfg.get("ticker", "BTCUSD")
      product_id = cfg.get("productId", "") or fetch_product_id(eth_base, ticker)
      sub_id = cfg.get("subaccountId", "")

      # Fetch active position once per loop (used for FLATTEN and status)
      pos = fetch_active_position(eth_base, sub_id, product_id)
      pos_open, pos_side, pos_size, pos_upnl = parse_position(pos)

      # ---- Commands ----
      cmds = get_cmds()
      updates = []
      for c in cmds:
        if c.get("status") != "NEW":
          continue
        cid = c.get("id")
        try:
          if c.get("type") == "FLATTEN":
            await close_position_if_any(client, ticker, pos_open, pos_side, pos_size)
            updates.append({"id": cid, "status": "DONE", "result": {"ok": True}})
          elif c.get("type") == "LINK_SIGNER":
            out = await process_link_signer(cfg, c, client)
            updates.append({"id": cid, "status": "DONE", "result": out})
          else:
            updates.append({"id": cid, "status": "ERROR", "result": {"error": "Unknown command"}})
        except Exception as ce:
          updates.append({"id": cid, "status": "ERROR", "result": {"error": str(ce)}})

      if updates:
        http_post("/api/uc5/bot/commands", {"updates": updates}, headers=bot_headers())

      # ---- Market price ----
      mp = fetch_market_price(eth_base, product_id)
      best_bid = float(mp.get("bestBidPrice") or 0)
      best_ask = float(mp.get("bestAskPrice") or 0)
      oracle = float(mp.get("oraclePrice") or 0)
      mid = (best_bid + best_ask) / 2.0 if best_bid and best_ask else (oracle or best_bid or best_ask)

      ts_ms = int(time.time() * 1000)
      conn.execute(
        "INSERT OR REPLACE INTO prices(ts_ms, price, oracle, bid, ask) VALUES (?,?,?,?,?)",
        (ts_ms, mid, oracle, best_bid, best_ask)
      )
      conn.commit()

      # ---- Learning ----
      w = train_online(conn, w, lr=0.25)
      set_model(conn, w)

      feats, reason = compute_features(conn)
      p_up = predict(w, feats)

      conn.execute(
        "INSERT INTO decisions(ts_ms, horizon_sec, p_up, f1,f2,f3,f4,f5,f6) VALUES (?,?,?,?,?,?,?,?,?)",
        (ts_ms, int(cfg.get("predictionHorizonSeconds", 60)),
         p_up, feats[1], feats[2], feats[3], feats[4], feats[5], feats[6])
      )
      conn.commit()

      thr = float(cfg.get("confidenceThreshold", 0.6))
      desired = "FLAT"
      if p_up > thr:
        desired = "LONG"
      elif p_up < (1.0 - thr):
        desired = "SHORT"

      # ---- Hold windows ----
      min_hold = int(cfg.get("minHoldSeconds", 60))
      max_hold = int(cfg.get("maxHoldSeconds", 900))
      min_hold_until = None
      max_hold_until = None
      if last_position_opened_ms:
        min_hold_until = last_position_opened_ms + min_hold * 1000
        max_hold_until = last_position_opened_ms + max_hold * 1000

      trading_enabled = bool(cfg.get("tradingEnabled", True))
      kill = bool(cfg.get("killSwitch", False))

      action_taken = {"type": None, "ok": True, "info": None}

      # ---- Trade gate ----
      if trading_enabled and (not kill) and client is not None:
        max_oph = int(cfg.get("maxOrdersPerHour", 120))
        now = time.time()
        last_order_ts[:] = [t for t in last_order_ts if now - t < 3600]
        can_order = len(last_order_ts) < max_oph

        if can_order:
          # max hold: exit if exceeded
          if pos_open and max_hold_until and ts_ms >= max_hold_until:
            await close_position_if_any(client, ticker, pos_open, pos_side, pos_size)
            last_order_ts.append(now)
            action_taken = {"type": "CLOSE_MAX_HOLD", "ok": True, "info": {"maxHoldSeconds": max_hold}}
            last_position_opened_ms = None

          else:
            # enter if flat and desired long/short
            if (not pos_open) and desired in ("LONG", "SHORT"):
              conf = abs(p_up - 0.5) * 2.0
              conf = clamp(conf, 0.0, 1.0)

              avail = None
              if sub_id:
                bal = requests.get(
                  f"{eth_base}/v1/subaccount/balance",
                  params={"subaccountId": sub_id},
                  timeout=20
                ).json()
                if bal.get("data"):
                  row = bal["data"][0]
                  avail = float(row.get("available") or 0)

              max_margin = float(cfg.get("maxMarginUsd", 100))
              lev = float(cfg.get("maxLeverage", 2))
              margin_use = min(max_margin, (avail or max_margin))
              notional = margin_use * lev * conf
              qty = notional / mid if mid > 0 else 0.0
              qty = max(0.0, qty)

              if qty > 0:
                side_int = 0 if desired == "LONG" else 1
                await place_market(client, ticker, side_int, qty)
                last_order_ts.append(now)
                last_position_opened_ms = ts_ms
                action_taken = {"type": f"OPEN_{desired}", "ok": True, "info": {"qty": qty, "conf": conf, "lev": lev, "margin": margin_use}}

            # flip if opposite (only after min hold)
            if pos_open and desired in ("LONG", "SHORT") and pos_side and desired != pos_side:
              if (not min_hold_until) or (ts_ms >= min_hold_until):
                await close_position_if_any(client, ticker, pos_open, pos_side, pos_size)
                last_order_ts.append(now)
                action_taken = {"type": "CLOSE_FOR_FLIP", "ok": True, "info": {"from": pos_side, "to": desired}}
                last_position_opened_ms = None

      # ---- Build status ----
      status_payload = {
        "updatedAt": int(time.time() * 1000),
        "bot": {
          "alive": True,
          "lastLoopAt": int(time.time() * 1000),
          "message": "running",
          "version": "uc5-bot/0.3 (sdk-fix + vps-telemetry)",
        },
        "market": {
          "ticker": ticker,
          "price": mid,
          "oraclePrice": oracle,
          "bestBid": best_bid,
          "bestAsk": best_ask,
        },
        "account": {
          "owner": cfg.get("ownerAddress"),
          "subaccountId": sub_id,
        },
        "position": {
          "open": bool(pos_open),
          "side": pos_side,
          "size": pos_size,
          "unrealizedPnl": pos_upnl,
          "updatedAt": int(time.time() * 1000),
        },
        "agent": {
          "desired": desired,
          "confidence": float(p_up),
          "reason": reason,
          "lastDecisionAt": int(time.time() * 1000),
          "minHoldUntil": min_hold_until,
          "maxHoldUntil": max_hold_until,
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
          "version": "uc5-bot/0.3 (sdk-fix + vps-telemetry)",
        },
      }

    # Update telemetry (served from VPS)
    with STATUS_LOCK:
      LATEST_STATUS = status_payload

    # Sleep — use config if available, else 3s
    try:
      interval = int((cfg_cache or {}).get("pollIntervalSeconds", 3))
    except Exception:
      interval = 3

    elapsed = time.time() - loop_started
    to_sleep = max(0.2, float(interval) - float(elapsed))
    await asyncio.sleep(to_sleep)


if __name__ == "__main__":
  asyncio.run(main())
