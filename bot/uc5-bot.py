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
from decimal import Decimal
from typing import Optional, Dict, Any, List, Tuple
from http.server import BaseHTTPRequestHandler, HTTPServer

# ethereal-sdk (async) — support both import styles
try:
  from ethereal import AsyncRESTClient
except Exception:
  from ethereal.async_rest_client import AsyncRESTClient


# ---- Env ----
BOT_TOKEN = os.environ.get("UC5_BOT_TOKEN", "")
BOT_PRIVKEY = os.environ.get("UC5_BOT_SIGNER_PRIVATE_KEY", "")  # linked signer EOA private key (0x...)

DB_PATH = os.environ.get("UC5_SQLITE_PATH", os.path.join(os.path.dirname(__file__), "uc5.sqlite"))
RUNTIME_CONFIG_PATH = os.environ.get("UC5_RUNTIME_CONFIG_PATH", os.path.join(os.path.dirname(__file__), "uc5.runtime.config.json"))

# Telemetry server (VPS)
TELEMETRY_HOST = os.environ.get("UC5_TELEMETRY_HOST", "0.0.0.0")
TELEMETRY_PORT = int(os.environ.get("UC5_TELEMETRY_PORT", "8787"))
BOT_VERSION = "uc5-bot/0.4 (vm-control + low-blob)"

if not BOT_TOKEN:
  raise SystemExit("Missing env: UC5_BOT_TOKEN")


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
    "tradingEnabled": True,
    "killSwitch": False,
    "pollIntervalSeconds": 2,
    "predictionHorizonSeconds": 3600,  # force >= 60m trade horizon
    "maxLeverage": 2,
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
  cfg["tradingEnabled"] = bool(cfg.get("tradingEnabled", True))
  cfg["killSwitch"] = bool(cfg.get("killSwitch", False))

  try:
    cfg["pollIntervalSeconds"] = int(cfg.get("pollIntervalSeconds", 2))
  except Exception:
    cfg["pollIntervalSeconds"] = 2
  cfg["pollIntervalSeconds"] = max(2, min(60, cfg["pollIntervalSeconds"]))

  try:
    cfg["predictionHorizonSeconds"] = int(cfg.get("predictionHorizonSeconds", 3600))
  except Exception:
    cfg["predictionHorizonSeconds"] = 3600
  cfg["predictionHorizonSeconds"] = max(3600, min(259200, cfg["predictionHorizonSeconds"]))

  try:
    cfg["maxLeverage"] = float(cfg.get("maxLeverage", 2))
  except Exception:
    cfg["maxLeverage"] = 2.0
  cfg["maxLeverage"] = max(1.0, min(20.0, cfg["maxLeverage"]))

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
  cfg["minHoldSeconds"] = max(3600, min(259200, cfg["minHoldSeconds"]))

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
    body = json.dumps(obj).encode("utf-8")
    self.send_response(code)
    self.send_header("Content-Type", "application/json")
    self.send_header("Access-Control-Allow-Origin", "*")
    self.send_header("Access-Control-Allow-Headers", "content-type, x-uc5-bot-token")
    self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    self.send_header("Cache-Control", "no-store")
    self.end_headers()
    self.wfile.write(body)

  def do_OPTIONS(self):
    return self._send_json(200, {"ok": True})

  def do_GET(self):
    if self.path.startswith("/health"):
      return self._send_json(200, {"ok": True})
    if self.path.startswith("/status"):
      with STATUS_LOCK:
        data = LATEST_STATUS
      return self._send_json(200, data)
    if self.path.startswith("/config"):
      return self._send_json(200, get_runtime_config())
    if self.path.startswith("/commands"):
      if not self._authorized():
        return self._send_json(403, {"error": "forbidden"})
      return self._send_json(200, {"commands": list_commands()})
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


async def place_market(
  client: AsyncRESTClient,
  ticker: str,
  side_int: int,
  qty: float,
  sender: str,
  subaccount: str,
):
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
      sender=sender,
      subaccount=subaccount,
    )
  except TypeError:
    await client.create_order(
      order_type="MARKET",
      quantity=q,
      side=side_int,
      price=Decimal("0"),
      ticker=ticker,
      sender=sender,
      subaccount=subaccount,
    )


async def close_position_if_any(
  client: AsyncRESTClient,
  ticker: str,
  pos_open: bool,
  pos_side: Optional[str],
  pos_size: float,
  sender: str,
  subaccount: str,
):
  if not pos_open or not pos_side or abs(pos_size) <= 0:
    return
  # If LONG -> SELL to close, if SHORT -> BUY to close
  side_int = 1 if pos_side == "LONG" else 0
  await place_market(client, ticker, side_int, abs(pos_size), sender, subaccount)


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
  next_reassess_ms: Optional[int] = None
  last_decision_at_ms: Optional[int] = None
  last_reason = "warming up (need more history)"
  last_conf = 0.5
  last_desired = "FLAT"

  while True:
    loop_started = time.time()
    status_payload: Dict[str, Any] = {}

    try:
      cfg = get_runtime_config()
      eth_base = cfg.get("etherealApiBase", "https://api.ethereal.trade")

      # Ensure client (SDK)
      if client is None:
        client = await ensure_client(cfg)

      # Resolve identifiers early (so commands can use them)
      ticker = cfg.get("ticker", "BTCUSD")
      product_id = cfg.get("productId", "") or fetch_product_id(eth_base, ticker)
      if not product_id:
        raise RuntimeError(f"No productId found for ticker={ticker}")
      sub_id = str(cfg.get("subaccountId", "") or "")
      owner_addr = str(cfg.get("ownerAddress") or "")
      subaccount_name = str(cfg.get("subaccountName") or "")
      sub_id, subaccount_name = resolve_subaccount_context(
        eth_base=eth_base,
        sender=owner_addr,
        subaccount_id=sub_id,
        subaccount_name=subaccount_name,
      )
      missing_trade_ctx = []
      if not owner_addr:
        missing_trade_ctx.append("ownerAddress")
      if not subaccount_name:
        missing_trade_ctx.append("subaccountName")
      has_trade_account_ctx = bool(owner_addr and subaccount_name)

      # Fetch active position once per loop (used for FLATTEN and status)
      pos = fetch_active_position(eth_base, sub_id, product_id)
      pos_open, pos_side, pos_size, pos_upnl = parse_position(pos)

      # ---- Commands ----
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
              await close_position_if_any(client, ticker, pos_open, pos_side, pos_size, owner_addr, subaccount_name)
              updates.append({"id": cid, "status": "DONE", "result": {"ok": True}})
          elif c.get("type") == "LINK_SIGNER":
            out = await process_link_signer(cfg, c, client)
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

      ts_ms = int(time.time() * 1000)
      conn.execute(
        "INSERT OR REPLACE INTO prices(ts_ms, price, oracle, bid, ask) VALUES (?,?,?,?,?)",
        (ts_ms, mid, oracle, best_bid, best_ask)
      )
      conn.commit()

      # ---- Learning + decision cadence ----
      w = train_online(conn, w, lr=0.25)
      set_model(conn, w)

      horizon_sec = max(3600, int(cfg.get("predictionHorizonSeconds", 3600)))
      horizon_ms = int(horizon_sec * 1000)
      max_hold = max(int(cfg.get("maxHoldSeconds", 7200)), horizon_sec)

      # Sync timers with current position state.
      if pos_open:
        if last_position_opened_ms is None:
          last_position_opened_ms = ts_ms
        if next_reassess_ms is None:
          next_reassess_ms = last_position_opened_ms + horizon_ms
      else:
        last_position_opened_ms = None
        next_reassess_ms = None

      evaluate_now = False
      if last_decision_at_ms is None:
        evaluate_now = True
      elif (not pos_open) and (ts_ms - last_decision_at_ms >= horizon_ms):
        evaluate_now = True
      elif pos_open and next_reassess_ms and ts_ms >= next_reassess_ms:
        evaluate_now = True

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

        if pos_open and next_reassess_ms and ts_ms >= next_reassess_ms:
          next_reassess_ms = ts_ms + horizon_ms

      min_hold_until = (last_position_opened_ms + horizon_ms) if last_position_opened_ms else None
      max_hold_until = (last_position_opened_ms + max_hold * 1000) if last_position_opened_ms else None

      trading_enabled = bool(cfg.get("tradingEnabled", True))
      kill = bool(cfg.get("killSwitch", False))

      action_taken = {"type": "NO_ACTION", "ok": True, "info": None}

      # ---- Trade gate ----
      if trading_enabled and (not kill) and client is not None:
        if not has_trade_account_ctx:
          action_taken = {
            "type": "SKIP_ACCOUNT_CONTEXT_MISSING",
            "ok": False,
            "info": {"missing": missing_trade_ctx},
          }
        else:
          max_oph = int(cfg.get("maxOrdersPerHour", 120))
          now = time.time()
          last_order_ts[:] = [t for t in last_order_ts if now - t < 3600]
          can_open = len(last_order_ts) < max_oph

          # Force close if max position age is reached.
          if pos_open and max_hold_until and ts_ms >= max_hold_until:
            await close_position_if_any(client, ticker, pos_open, pos_side, pos_size, owner_addr, subaccount_name)
            last_order_ts.append(now)
            last_position_opened_ms = None
            next_reassess_ms = None
            action_taken = {"type": "CLOSE_MAX_HOLD", "ok": True, "info": {"maxHoldSeconds": max_hold}}

          elif not pos_open:
            # Only evaluate new entries at horizon cadence (>= 60m).
            if not evaluate_now:
              action_taken = {
                "type": "WAIT_ENTRY_REASSESS",
                "ok": True,
                "info": {"nextAt": (last_decision_at_ms + horizon_ms) if last_decision_at_ms else ts_ms},
              }
            elif desired in ("LONG", "SHORT"):
              if not can_open:
                action_taken = {"type": "RATE_LIMITED", "ok": False, "info": {"maxOrdersPerHour": max_oph}}
              else:
                conf = clamp(abs(p_up - 0.5) * 2.0, 0.0, 1.0)
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
                qty = max(0.0, (notional / mid) if mid > 0 else 0.0)

                if qty > 0:
                  side_int = 0 if desired == "LONG" else 1
                  await place_market(client, ticker, side_int, qty, owner_addr, subaccount_name)
                  last_order_ts.append(now)
                  last_position_opened_ms = ts_ms
                  next_reassess_ms = ts_ms + horizon_ms
                  action_taken = {"type": f"OPEN_{desired}", "ok": True, "info": {"qty": qty, "conf": conf, "lev": lev, "margin": margin_use}}
                else:
                  action_taken = {"type": "SKIP_ZERO_QTY", "ok": False, "info": None}
            else:
              action_taken = {"type": "SKIP_NO_SIGNAL", "ok": True, "info": {"desired": desired}}

          else:
            # In trade: hold for at least horizon, then reassess periodically.
            if not evaluate_now:
              action_taken = {"type": "HOLD_UNTIL_REASSESS", "ok": True, "info": {"nextAt": next_reassess_ms}}
            elif desired == pos_side:
              action_taken = {"type": "HOLD_AFTER_REASSESS", "ok": True, "info": {"nextAt": next_reassess_ms}}
            else:
              await close_position_if_any(client, ticker, pos_open, pos_side, pos_size, owner_addr, subaccount_name)
              last_order_ts.append(now)
              last_position_opened_ms = None
              next_reassess_ms = None
              action_taken = {
                "type": "LIQUIDATE_REASSESS",
                "ok": True,
                "info": {"from": pos_side, "modelDesired": desired},
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
          "subaccountName": subaccount_name,
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
          "lastDecisionAt": last_decision_at_ms,
          "decisionHorizonSeconds": horizon_sec,
          "nextReassessAt": next_reassess_ms,
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
          "version": BOT_VERSION,
        },
      }

    # Update telemetry (served from VPS)
    with STATUS_LOCK:
      LATEST_STATUS = status_payload

    # Sleep — use runtime config (2s default)
    try:
      interval = int(get_runtime_config().get("pollIntervalSeconds", 2))
    except Exception:
      interval = 2

    elapsed = time.time() - loop_started
    to_sleep = max(0.2, float(interval) - float(elapsed))
    await asyncio.sleep(to_sleep)


if __name__ == "__main__":
  asyncio.run(main())
