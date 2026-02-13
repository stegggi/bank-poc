# bot/uc5-bot.py
"""
UC5 Ethereal Autopilot Bot (mainnet)

- Reads config + commands from your Vercel dashboard
- Stores price history + online-learning weights in SQLite
- Places MARKET orders via linked signer (recommended) using ethereal-sdk
- Posts status back to /api/uc5/bot/status

IMPORTANT:
This is a demo trading bot. It can lose money. Start tiny (e.g. 100 USDe) and keep leverage low.
"""

import os, time, json, math, sqlite3, requests, asyncio
from dataclasses import dataclass
from typing import Optional, Dict, Any, List, Tuple

# ethereal-sdk (async)
from ethereal.async_rest_client import AsyncRESTClient

DASH_BASE = os.environ.get("UC5_DASHBOARD_BASE_URL", "").rstrip("/")
BOT_TOKEN = os.environ.get("UC5_BOT_TOKEN", "")
BOT_PRIVKEY = os.environ.get("UC5_BOT_SIGNER_PRIVATE_KEY", "")  # linked signer EOA private key (0x...)

if not DASH_BASE or not BOT_TOKEN:
  raise SystemExit("Missing env: UC5_DASHBOARD_BASE_URL and/or UC5_BOT_TOKEN")

DB_PATH = os.environ.get("UC5_SQLITE_PATH", os.path.join(os.path.dirname(__file__), "uc5.sqlite"))

def http_get(path: str) -> Any:
  r = requests.get(f"{DASH_BASE}{path}", timeout=20)
  r.raise_for_status()
  return r.json()

def http_post(path: str, payload: Any, headers: Optional[Dict[str,str]]=None) -> Any:
  h = {"Content-Type": "application/json"}
  if headers: h.update(headers)
  r = requests.post(f"{DASH_BASE}{path}", data=json.dumps(payload), headers=h, timeout=20)
  r.raise_for_status()
  return r.json()

def bot_headers() -> Dict[str,str]:
  return {"x-uc5-bot-token": BOT_TOKEN}

def db_connect():
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
  # start near-neutral
  w = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
  conn.execute("INSERT INTO model(id,w0,w1,w2,w3,w4,w5,w6,updated_ms) VALUES (1,?,?,?,?,?,?,?,?)",
               (w[0],w[1],w[2],w[3],w[4],w[5],w[6], int(time.time()*1000)))
  conn.commit()
  return w

def set_model(conn, w: List[float]):
  conn.execute("UPDATE model SET w0=?,w1=?,w2=?,w3=?,w4=?,w5=?,w6=?,updated_ms=? WHERE id=1",
               (w[0],w[1],w[2],w[3],w[4],w[5],w[6], int(time.time()*1000)))
  conn.commit()

def last_prices(conn, n: int) -> List[Tuple[int,float]]:
  rows = conn.execute("SELECT ts_ms, price FROM prices ORDER BY ts_ms DESC LIMIT ?", (n,)).fetchall()
  rows.reverse()
  return rows

def compute_features(conn) -> Tuple[List[float], str]:
  """
  Simple pattern features (starter):
  f1: 1m return
  f2: 5m return
  f3: SMA(20)-SMA(60) normalized
  f4: RSI(14) normalized
  f5: short-term volatility (std of returns)
  f6: oracle deviation (price-oracle)/oracle
  """
  rows = last_prices(conn, 400)
  if len(rows) < 80:
    return [1.0, 0,0,0,0,0,0], "warming up (need more history)"

  ts = [r[0] for r in rows]
  px = [r[1] for r in rows]

  def ret_over(ms_back: int) -> float:
    t_now = ts[-1]
    target = t_now - ms_back
    # find first ts >= target
    i = 0
    while i < len(ts) and ts[i] < target:
      i += 1
    if i >= len(px): i = len(px) - 1
    p0 = px[i]
    p1 = px[-1]
    return (p1 / p0) - 1.0 if p0 > 0 else 0.0

  r1m = ret_over(60_000)
  r5m = ret_over(300_000)

  def sma(window: int) -> float:
    if len(px) < window: return sum(px)/len(px)
    s = sum(px[-window:])
    return s / window

  sma20 = sma(20)
  sma60 = sma(60)
  trend = (sma20 - sma60) / px[-1]

  # RSI(14)
  gains, losses = 0.0, 0.0
  for i in range(max(1, len(px)-15), len(px)):
    d = px[i] - px[i-1]
    if d >= 0: gains += d
    else: losses += -d
  rs = (gains/14.0) / (losses/14.0 + 1e-9)
  rsi = 100.0 - (100.0 / (1.0 + rs))
  rsi_n = (rsi - 50.0) / 50.0  # -1..+1

  # volatility
  rets = []
  for i in range(max(1, len(px)-60), len(px)):
    rets.append((px[i]/px[i-1]) - 1.0)
  mu = sum(rets)/len(rets)
  var = sum((x-mu)*(x-mu) for x in rets)/max(1, len(rets)-1)
  vol = math.sqrt(var)

  # oracle deviation (use last oracle from prices table if present)
  row = conn.execute("SELECT oracle FROM prices ORDER BY ts_ms DESC LIMIT 1").fetchone()
  oracle = row[0] if row else None
  dev = ((px[-1] - oracle)/oracle) if (oracle and oracle > 0) else 0.0

  # intercept + 6 features
  feats = [1.0, r1m, r5m, trend, rsi_n, vol, dev]
  reason = f"r1m={r1m:.4f}, r5m={r5m:.4f}, trend={trend:.4f}, rsiN={rsi_n:.3f}, vol={vol:.5f}, dev={dev:.5f}"
  return feats, reason

def predict(w: List[float], feats: List[float]) -> float:
  x = sum(w[i]*feats[i] for i in range(len(w)))
  return sigmoid(x)

def train_online(conn, w: List[float], lr: float = 0.5):
  """
  Once horizon has passed, label decision y (1 if price went up vs decision time).
  Then run one SGD step per labeled row.
  """
  # find unlabeled decisions older than horizon
  rows = conn.execute("""
    SELECT id, ts_ms, horizon_sec, f1,f2,f3,f4,f5,f6, trained
    FROM decisions
    WHERE y IS NULL
    ORDER BY id ASC
    LIMIT 50
  """).fetchall()

  if not rows:
    return w

  # need future price to label
  for (did, ts_ms, horizon, f1,f2,f3,f4,f5,f6, trained) in rows:
    future_ts = ts_ms + int(horizon*1000)
    # get price at/after future_ts
    fut = conn.execute("SELECT price FROM prices WHERE ts_ms >= ? ORDER BY ts_ms ASC LIMIT 1", (future_ts,)).fetchone()
    nowp = conn.execute("SELECT price FROM prices WHERE ts_ms = ?", (ts_ms,)).fetchone()
    if not fut or not nowp:
      continue
    y = 1 if fut[0] > nowp[0] else 0
    conn.execute("UPDATE decisions SET y=? WHERE id=?", (y, did))
  conn.commit()

  labeled = conn.execute("""
    SELECT id, p_up, f1,f2,f3,f4,f5,f6, y, trained
    FROM decisions
    WHERE y IS NOT NULL AND trained=0
    ORDER BY id ASC
    LIMIT 200
  """).fetchall()

  for (did, p_up, f1,f2,f3,f4,f5,f6, y, trained) in labeled:
    feats = [1.0, f1,f2,f3,f4,f5,f6]
    p = predict(w, feats)
    # gradient of logloss: (p - y) * x
    err = (p - y)
    for i in range(len(w)):
      w[i] = w[i] - lr * err * feats[i]
    conn.execute("UPDATE decisions SET trained=1 WHERE id=?", (did,))
  conn.commit()
  return w

async def process_link_signer(cfg: Dict[str,Any], cmd: Dict[str,Any], client: AsyncRESTClient) -> Dict[str,Any]:
  """
  Finalize LINK_SIGNER by providing signerSignature (bot) and calling Ethereal endpoint.
  """
  eth_base = cfg["etherealApiBase"]
  payload = cmd["payload"]

  # fetch EIP712 domain
  rpc = requests.get(f"{eth_base}/v1/rpc/config", timeout=20).json()
  domain = rpc.get("domain")
  if not domain:
    raise RuntimeError("Could not fetch /v1/rpc/config domain")

  # build typed data dict for eth-account compatible signing
  typed = {
    "types": {
      "EIP712Domain": [
        {"name":"name","type":"string"},
        {"name":"version","type":"string"},
        {"name":"chainId","type":"uint256"},
        {"name":"verifyingContract","type":"address"},
      ],
      "LinkSigner": [
        {"name":"sender","type":"address"},
        {"name":"signer","type":"address"},
        {"name":"subaccount","type":"bytes32"},
        {"name":"nonce","type":"uint64"},
        {"name":"signedAt","type":"uint64"},
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

  # ethereal-sdk uses eth-account under the hood; easiest is to use its signing utilities indirectly:
  # We'll sign by using client._account (internal). If SDK changes, we fall back to raw eth_account.
  signer_sig = None
  try:
    # best-effort: use client.account if available
    acct = getattr(client, "_account", None) or getattr(client, "account", None)
    if acct is None:
      raise Exception("no account on client")
    from eth_account.messages import encode_typed_data
    msg = encode_typed_data(full_message=typed)
    signer_sig = acct.sign_message(msg).signature.hex()
  except Exception:
    # fallback
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

async def place_close(client: AsyncRESTClient, ticker: str):
  # Ethereal: close entire position => close=True + reduce_only=True + quantity="0" on MARKET
  await client.create_order(
    order_type="MARKET",
    quantity="0",
    side="BUY",  # ignored when close=True; SDK may still require a side; it will close regardless
    price=None,
    ticker=ticker,
    reduce_only=True,
    close=True,
  )

async def main():
  conn = db_connect()
  w = ensure_model(conn)

  # build client (linked signer key)
  if not BOT_PRIVKEY:
    raise SystemExit("Missing env UC5_BOT_SIGNER_PRIVATE_KEY (bot signer private key).")

  # We'll initialize client lazily after config load (needs api_url)
  client: Optional[AsyncRESTClient] = None
  last_order_ts = []  # timestamps of orders (rate limit)
  last_position_opened_ms: Optional[int] = None

  while True:
    loop_started = time.time()
    try:
      cfg = http_get("/api/uc5/config")
      if client is None:
        client = await AsyncRESTClient.create(
          private_key=BOT_PRIVKEY,
          api_url=cfg.get("etherealApiBase", "https://api.ethereal.trade"),
          chain_rpc_url="https://rpc.ethereal.trade",  # not used for REST-only actions, ok
          subaccount="primary",
        )

      # Commands
      cmds_file = requests.get(f"{DASH_BASE}/api/uc5/bot/commands", headers=bot_headers(), timeout=20).json()
      cmds = cmds_file.get("commands", [])
      updates = []

      # process NEW commands
      for c in cmds:
        if c.get("status") != "NEW":
          continue
        cid = c.get("id")
        try:
          if c.get("type") == "FLATTEN":
            await place_close(client, cfg.get("ticker", "BTCUSD"))
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

      # Market price (REST)
      product_id = cfg.get("productId", "")
      ticker = cfg.get("ticker", "BTCUSD")

      # Discover productId if not present (optional, but useful for position/active)
      if not product_id:
        prod = requests.get(f"{cfg['etherealApiBase']}/v1/product", params={"ticker": ticker}, timeout=20).json()
        if prod.get("data"):
          product_id = prod["data"][0]["id"]

      mp = requests.get(f"{cfg['etherealApiBase']}/v1/product/market-price", params={"productId": product_id}, timeout=20).json()
      best_bid = float(mp.get("bestBidPrice") or 0)
      best_ask = float(mp.get("bestAskPrice") or 0)
      oracle = float(mp.get("oraclePrice") or 0)
      mid = (best_bid + best_ask) / 2.0 if best_bid and best_ask else (oracle or best_bid or best_ask)

      ts_ms = int(time.time() * 1000)
      conn.execute("INSERT OR REPLACE INTO prices(ts_ms, price, oracle, bid, ask) VALUES (?,?,?,?,?)",
                   (ts_ms, mid, oracle, best_bid, best_ask))
      conn.commit()

      # Online learning update
      w = train_online(conn, w, lr=0.25)
      set_model(conn, w)

      feats, reason = compute_features(conn)
      p_up = predict(w, feats)

      # store decision row for future labeling
      conn.execute(
        "INSERT INTO decisions(ts_ms, horizon_sec, p_up, f1,f2,f3,f4,f5,f6) VALUES (?,?,?,?,?,?,?,?,?)",
        (ts_ms, int(cfg.get("predictionHorizonSeconds", 60)), p_up, feats[1],feats[2],feats[3],feats[4],feats[5],feats[6])
      )
      conn.commit()

      # Desired action
      thr = float(cfg.get("confidenceThreshold", 0.6))
      desired = "FLAT"
      if p_up > thr:
        desired = "LONG"
      elif p_up < (1.0 - thr):
        desired = "SHORT"

      # Position (requires subaccountId + productId)
      pos = None
      sub_id = cfg.get("subaccountId", "")
      if sub_id and product_id:
        try:
          pos = requests.get(f"{cfg['etherealApiBase']}/v1/position/active",
                             params={"subaccountId": sub_id, "productId": product_id}, timeout=20).json()
        except Exception:
          pos = None

      pos_open = False
      pos_side = None
      pos_size = 0.0
      pos_upnl = None
      if isinstance(pos, dict) and pos.get("size") is not None:
        pos_size = float(pos.get("size") or 0)
        pos_open = abs(pos_size) > 0
        side_int = pos.get("side")
        pos_side = "LONG" if side_int == 0 else "SHORT"
        # unrealized pnl isn't always in active response; use realizedPnl etc if present
        if pos.get("realizedPnl") is not None:
          pos_upnl = float(pos.get("realizedPnl") or 0)

      # Hold windows
      min_hold = int(cfg.get("minHoldSeconds", 60))
      max_hold = int(cfg.get("maxHoldSeconds", 900))
      min_hold_until = None
      max_hold_until = None
      if last_position_opened_ms:
        min_hold_until = last_position_opened_ms + min_hold*1000
        max_hold_until = last_position_opened_ms + max_hold*1000

      # Trading gate
      trading_enabled = bool(cfg.get("tradingEnabled", True))
      kill = bool(cfg.get("killSwitch", False))

      action_taken = {"type": None, "ok": True, "info": None}

      # If kill switch is on: do not place orders, but still update status
      if trading_enabled and (not kill) and client is not None:
        # Rate guard: maxOrdersPerHour
        max_oph = int(cfg.get("maxOrdersPerHour", 120))
        now = time.time()
        last_order_ts[:] = [t for t in last_order_ts if now - t < 3600]
        can_order = len(last_order_ts) < max_oph

        # Decide trade
        if can_order:
          # max hold: exit if exceeded
          if pos_open and max_hold_until and ts_ms >= max_hold_until:
            await place_close(client, ticker)
            last_order_ts.append(now)
            action_taken = {"type": "CLOSE_MAX_HOLD", "ok": True, "info": {"maxHoldSeconds": max_hold}}
            last_position_opened_ms = None

          else:
            # If no position and desired is LONG/SHORT => enter
            if (not pos_open) and desired in ("LONG", "SHORT"):
              # size by confidence (0..1)
              conf = abs(p_up - 0.5) * 2.0
              conf = clamp(conf, 0.0, 1.0)

              # find available margin
              avail = None
              used = None
              total = None
              if sub_id:
                bal = requests.get(f"{cfg['etherealApiBase']}/v1/subaccount/balance", params={"subaccountId": sub_id}, timeout=20).json()
                if bal.get("data"):
                  row = bal["data"][0]
                  avail = float(row.get("available") or 0)
                  used = float(row.get("totalUsed") or 0)
                  total = float(row.get("amount") or 0)

              max_margin = float(cfg.get("maxMarginUsd", 100))
              lev = float(cfg.get("maxLeverage", 2))
              margin_use = min(max_margin, (avail or max_margin))
              notional = margin_use * lev * conf
              qty = notional / mid if mid > 0 else 0.0
              qty = max(0.0, qty)

              # place MARKET
              side = "BUY" if desired == "LONG" else "SELL"
              if qty > 0:
                await client.create_order(
                  order_type="MARKET",
                  quantity=str(qty),
                  side=side,
                  price=None,
                  ticker=ticker,
                  reduce_only=False,
                  close=False,
                )
                last_order_ts.append(now)
                last_position_opened_ms = ts_ms
                action_taken = {"type": f"OPEN_{desired}", "ok": True, "info": {"qty": qty, "conf": conf, "lev": lev, "margin": margin_use}}

            # If position exists and desired is opposite => flip (but only after min hold)
            if pos_open and desired in ("LONG", "SHORT") and pos_side and desired != pos_side:
              if (not min_hold_until) or (ts_ms >= min_hold_until):
                await place_close(client, ticker)
                last_order_ts.append(now)
                action_taken = {"type": "CLOSE_FOR_FLIP", "ok": True, "info": {"from": pos_side, "to": desired}}
                last_position_opened_ms = None

      # Post status
      st = {
        "updatedAt": int(time.time()*1000),
        "bot": {
          "alive": True,
          "lastLoopAt": int(time.time()*1000),
          "message": "running",
          "version": "uc5-bot/0.1",
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
          "updatedAt": int(time.time()*1000),
        },
        "agent": {
          "desired": desired,
          "confidence": float(p_up),
          "reason": reason,
          "lastDecisionAt": int(time.time()*1000),
          "minHoldUntil": min_hold_until,
          "maxHoldUntil": max_hold_until,
        },
        "lastAction": action_taken,
      }
      http_post("/api/uc5/bot/status", st, headers=bot_headers())

    except Exception as e:
      # Post error status (but don't crash)
      try:
        http_post("/api/uc5/bot/status", {
          "updatedAt": int(time.time()*1000),
          "bot": {"alive": True, "lastLoopAt": int(time.time()*1000), "message": f"error: {str(e)}", "version": "uc5-bot/0.1"},
        }, headers=bot_headers())
      except Exception:
        pass

    # sleep based on config if possible
    try:
      cfg2 = http_get("/api/uc5/config")
      interval = int(cfg2.get("pollIntervalSeconds", 3))
    except Exception:
      interval = 3

    elapsed = time.time() - loop_started
    to_sleep = max(0.2, interval - elapsed)
    time.sleep(to_sleep)

if __name__ == "__main__":
  asyncio.run(main())
