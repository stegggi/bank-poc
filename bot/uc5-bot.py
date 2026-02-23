# bot/uc5-bot.py
"""
UC5 Ethereal Autopilot Bot (mainnet)

Key runtime behavior:
- Fast risk/execution loop (default 1s)
- Flat decision loop (default 4s)
- In-position reassessment loop (default 8s)
- Slow perp-metrics loop (default 45s)

Storage:
- Daily SQLite rotation in UTC: uc5_YYYY-MM-DD.sqlite
- Retention cap: trim oldest files above 29GB down to <=28GB
"""

import os
import time
import json
import math
import uuid
import asyncio
import threading
from decimal import Decimal, ROUND_DOWN, ROUND_UP
from urllib.parse import parse_qs, urlparse
from typing import Any, Dict, List, Optional, Tuple
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

try:
  from ethereal import AsyncRESTClient, AsyncWSClient
except Exception:
  from ethereal.async_rest_client import AsyncRESTClient
  try:
    from ethereal.async_ws_client import AsyncWSClient
  except Exception:
    AsyncWSClient = None  # type: ignore[assignment]

from db import DailyDbManager
from strategy import (
  PositionState,
  SignalResult,
  StrategyConfig,
  clamp,
  evaluate_risk_exit,
  make_signal,
  should_close_for_confidence,
  size_liquidity_multiplier,
  update_position_extremes,
)


def _clean_secret(v: Optional[str]) -> str:
  return str(v or "").strip().strip('"').strip("'")


def _f(x: Any) -> Optional[float]:
  try:
    if x is None:
      return None
    return float(x)
  except Exception:
    return None


def _rate(x: Any) -> Optional[float]:
  """
  Parse funding-like rates and normalize to decimal fraction.
  Examples:
    "-0.0025%" -> -0.000025
    -0.000025  -> -0.000025
    -0.0025    -> -0.0025 (already decimal in many APIs)
    -0.25      -> -0.0025 (likely percent input)
  """
  if x is None:
    return None
  is_percent = False
  if isinstance(x, str):
    s = x.strip()
    if not s:
      return None
    if s.endswith("%"):
      is_percent = True
      s = s[:-1].strip()
    try:
      v = float(s)
    except Exception:
      return None
  else:
    try:
      v = float(x)
    except Exception:
      return None

  if is_percent:
    return v / 100.0

  # Heuristic: values above 5% are likely percent-style numbers.
  if abs(v) >= 0.05:
    return v / 100.0
  return v


def quantize_qty_to_lot(qty: float, lot_size: Optional[float]) -> float:
  q = Decimal(str(max(0.0, float(qty or 0.0))))
  if lot_size is None or float(lot_size) <= 0:
    return float(q)
  step = Decimal(str(lot_size))
  units = (q / step).to_integral_value(rounding=ROUND_DOWN)
  return float(units * step)


def quantize_price_to_tick(price: float, tick_size: Optional[float], side_int: int, aggressive: bool = True) -> float:
  p = Decimal(str(max(0.0, float(price or 0.0))))
  if tick_size is None or float(tick_size) <= 0:
    return float(p)
  step = Decimal(str(tick_size))
  if aggressive:
    rounding = ROUND_DOWN if side_int == 1 else ROUND_UP
  else:
    rounding = ROUND_DOWN if side_int == 0 else ROUND_UP
  units = (p / step).to_integral_value(rounding=rounding)
  out = units * step
  if out <= 0:
    out = step
  return float(out)


BOT_TOKEN = os.environ.get("UC5_BOT_TOKEN", "")
BOT_PRIVKEY = _clean_secret(os.environ.get("UC5_BOT_SIGNER_PRIVATE_KEY", ""))

DB_DIR = os.environ.get("UC5_DB_DIR", os.path.expanduser("~/uc5-runtime/db"))
DB_MAX_GB = float(os.environ.get("UC5_DB_MAX_GB", "15"))
DB_TARGET_GB = float(os.environ.get("UC5_DB_TARGET_GB", "14"))

RUNTIME_CONFIG_PATH = os.environ.get(
  "UC5_RUNTIME_CONFIG_PATH",
  os.path.expanduser("~/uc5-runtime/uc5.runtime.config.json"),
)

TELEMETRY_HOST = os.environ.get("UC5_TELEMETRY_HOST", "0.0.0.0")
TELEMETRY_PORT = int(os.environ.get("UC5_TELEMETRY_PORT", "8787"))
BOT_VERSION = "uc5-bot/1.0 (maker-chase+ws-quotes+daily-db)"

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

DB_MANAGER = DailyDbManager(
  db_dir=DB_DIR,
  max_gb=DB_MAX_GB,
  target_gb=DB_TARGET_GB,
  retention_interval_sec=300,
)


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


# ---- Runtime config + commands ----
def default_runtime_config() -> Dict[str, Any]:
  owner = os.environ.get("UC5_OWNER_ADDRESS", "")
  try:
    ingest_default = float(os.environ.get("UC5_INGEST_INTERVAL_SEC", "0.5"))
  except Exception:
    ingest_default = 0.5
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
    "killSwitch": False,
    "pollIntervalSeconds": 1,
    "ingestIntervalSec": float(ingest_default),
    "predictionHorizonSeconds": 30,
    "reassessIntervalSec": 8,
    "decisionLoopIntervalSec": 4,
    "inPositionReassessIntervalSec": 8,
    "riskLoopIntervalSec": 1,
    "metricsLoopIntervalSec": 45,
    "maxLeverage": 2,
    "maxMarginPct": 25.0,
    "maxMarginUsd": 100,
    "confidenceThreshold": 0.65,
    "openConfidenceThreshold": 0.65,
    "closeConfidenceThreshold": 0.55,
    "minHoldSeconds": 5,
    "maxHoldSeconds": 7200,
    "maxOrdersPerHour": 120,
    "smartEntryTimeoutMs": 900,
    "orderGuardMs": 200,
    "maxSpreadBpsForTrade": 12.0,
    "exitSpreadInsaneBps": 28.0,
    "feeEstimateBps": 3.0,
    "slippageBufferBps": 4.0,
    "minExpectedMoveBps": 0.0,
    "edgeCostMultiplier": 0.0,
    "entryMakerPreferred": True,
    "entryMarketFallbackEnabled": False,
    "entryMarketFallbackMinProb": 0.90,
    "cooldownAfterCloseSec": 5,
    "emergencyBreakoutEnabled": False,
    "emergencyBreakoutMinProb": 0.94,
    "emergencyBreakoutMinMoveBps": 35.0,
    "emergencyBreakoutMinAtrPercentile": 0.85,
    "entryChaseMaxSec": 5.0,
    "exitChaseMaxSec": 5.0,
    "executionRepriceMs": 200,
    "makerOrderGtdSec": 2,
    "stopLossPct": 0.003,
    "stopLossAtrMult": None,
    "takeProfitPct": 0.006,
    "takeProfitAtrMult": None,
    "trailingStopPct": None,
    "maxDailyLossUsd": 0.0,
    "tapeCvdEnabled": False,
  }


def _to_int(v: Any, default: int) -> int:
  try:
    return int(v)
  except Exception:
    return int(default)


def _to_float(v: Any, default: float) -> float:
  try:
    return float(v)
  except Exception:
    return float(default)


def _to_opt_float(v: Any) -> Optional[float]:
  if v is None:
    return None
  if isinstance(v, str) and not v.strip():
    return None
  try:
    return float(v)
  except Exception:
    return None


def sanitize_runtime_config(raw: Any) -> Dict[str, Any]:
  base = default_runtime_config()
  src = raw if isinstance(raw, dict) else {}

  for k in base.keys():
    if k in src:
      base[k] = src.get(k)

  base["ownerAddress"] = str(base.get("ownerAddress") or "")
  base["etherealApiBase"] = str(base.get("etherealApiBase") or "https://api.ethereal.trade")
  base["etherealArchiveBase"] = str(base.get("etherealArchiveBase") or "https://archive.ethereal.trade")
  base["etherealRpcUrl"] = str(base.get("etherealRpcUrl") or "https://rpc.ethereal.trade")
  base["ticker"] = str(base.get("ticker") or "BTCUSD")
  base["productId"] = str(base.get("productId") or "")
  base["subaccountId"] = str(base.get("subaccountId") or "")
  base["subaccountName"] = str(base.get("subaccountName") or "")
  base["botSignerAddress"] = str(base.get("botSignerAddress") or "")

  base["botSignerLinked"] = bool(base.get("botSignerLinked", False))
  base["ingestionEnabled"] = bool(base.get("ingestionEnabled", True))
  base["tradingEnabled"] = bool(base.get("tradingEnabled", True))
  base["killSwitch"] = False
  base["tapeCvdEnabled"] = bool(base.get("tapeCvdEnabled", False))

  # Legacy interval compatibility
  if "ingestIntervalSec" not in src and "pollIntervalSeconds" in src:
    base["ingestIntervalSec"] = src.get("pollIntervalSeconds")
  base["pollIntervalSeconds"] = max(1, int(round(_to_float(base.get("ingestIntervalSec", 0.5), 0.5))))

  base["ingestIntervalSec"] = clamp(_to_float(base.get("ingestIntervalSec", 0.5), 0.5), 0.2, 60.0)
  base["riskLoopIntervalSec"] = clamp(_to_int(base.get("riskLoopIntervalSec", 1), 1), 1, 5)
  base["decisionLoopIntervalSec"] = clamp(_to_int(base.get("decisionLoopIntervalSec", 4), 4), 3, 60)

  if "inPositionReassessIntervalSec" not in src and "reassessIntervalSec" in src:
    base["inPositionReassessIntervalSec"] = src.get("reassessIntervalSec")
  base["inPositionReassessIntervalSec"] = clamp(
    _to_int(base.get("inPositionReassessIntervalSec", 8), 8),
    5,
    300,
  )
  base["reassessIntervalSec"] = base["inPositionReassessIntervalSec"]

  base["metricsLoopIntervalSec"] = clamp(_to_int(base.get("metricsLoopIntervalSec", 45), 45), 30, 300)
  base["predictionHorizonSeconds"] = clamp(_to_int(base.get("predictionHorizonSeconds", 30), 30), 10, 259200)

  base["maxLeverage"] = clamp(_to_float(base.get("maxLeverage", 2), 2.0), 1.0, 20.0)
  base["maxMarginPct"] = clamp(_to_float(base.get("maxMarginPct", 25), 25.0), 0.0, 100.0)
  base["maxMarginUsd"] = max(1.0, _to_float(base.get("maxMarginUsd", 100), 100.0))

  legacy_thr = clamp(_to_float(base.get("confidenceThreshold", 0.65), 0.65), 0.5, 0.95)
  if "openConfidenceThreshold" in src:
    open_thr = clamp(_to_float(base.get("openConfidenceThreshold", legacy_thr), legacy_thr), 0.5, 0.95)
  else:
    open_thr = legacy_thr

  if "closeConfidenceThreshold" in src:
    close_thr = clamp(_to_float(base.get("closeConfidenceThreshold", max(0.5, open_thr - 0.1)), max(0.5, open_thr - 0.1)), 0.45, 0.9)
  else:
    close_thr = max(0.50, open_thr - 0.10)

  base["openConfidenceThreshold"] = open_thr
  base["closeConfidenceThreshold"] = close_thr
  base["confidenceThreshold"] = open_thr

  base["minHoldSeconds"] = clamp(_to_int(base.get("minHoldSeconds", 5), 5), 5, 259200)
  base["maxHoldSeconds"] = clamp(_to_int(base.get("maxHoldSeconds", 7200), 7200), base["minHoldSeconds"], 259200)

  base["maxOrdersPerHour"] = clamp(_to_int(base.get("maxOrdersPerHour", 120), 120), 1, 2000)
  base["smartEntryTimeoutMs"] = clamp(_to_int(base.get("smartEntryTimeoutMs", 900), 900), 200, 5000)
  base["orderGuardMs"] = clamp(_to_int(base.get("orderGuardMs", 200), 200), 200, 5000)
  base["maxSpreadBpsForTrade"] = clamp(_to_float(base.get("maxSpreadBpsForTrade", 12.0), 12.0), 1.0, 100.0)
  base["exitSpreadInsaneBps"] = clamp(_to_float(base.get("exitSpreadInsaneBps", 28.0), 28.0), 5.0, 300.0)
  base["feeEstimateBps"] = clamp(_to_float(base.get("feeEstimateBps", 3.0), 3.0), 0.0, 100.0)
  base["slippageBufferBps"] = clamp(_to_float(base.get("slippageBufferBps", 4.0), 4.0), 0.0, 100.0)
  base["minExpectedMoveBps"] = clamp(_to_float(base.get("minExpectedMoveBps", 0.0), 0.0), 0.0, 500.0)
  base["edgeCostMultiplier"] = clamp(_to_float(base.get("edgeCostMultiplier", 0.0), 0.0), 0.0, 5.0)
  base["entryMakerPreferred"] = True
  base["entryMarketFallbackEnabled"] = False
  base["entryMarketFallbackMinProb"] = clamp(
    _to_float(base.get("entryMarketFallbackMinProb", 0.90), 0.90),
    0.50,
    0.99,
  )
  base["cooldownAfterCloseSec"] = clamp(_to_int(base.get("cooldownAfterCloseSec", 5), 5), 0, 600)
  base["emergencyBreakoutEnabled"] = bool(base.get("emergencyBreakoutEnabled", False))
  base["emergencyBreakoutMinProb"] = clamp(
    _to_float(base.get("emergencyBreakoutMinProb", 0.94), 0.94),
    0.50,
    0.99,
  )
  base["emergencyBreakoutMinMoveBps"] = clamp(
    _to_float(base.get("emergencyBreakoutMinMoveBps", 35.0), 35.0),
    1.0,
    1000.0,
  )
  base["emergencyBreakoutMinAtrPercentile"] = clamp(
    _to_float(base.get("emergencyBreakoutMinAtrPercentile", 0.85), 0.85),
    0.0,
    1.0,
  )
  base["entryChaseMaxSec"] = clamp(_to_float(base.get("entryChaseMaxSec", 5.0), 5.0), 0.5, 30.0)
  base["exitChaseMaxSec"] = clamp(_to_float(base.get("exitChaseMaxSec", 5.0), 5.0), 0.5, 30.0)
  base["executionRepriceMs"] = clamp(_to_int(base.get("executionRepriceMs", 200), 200), 100, 2000)
  base["makerOrderGtdSec"] = clamp(_to_int(base.get("makerOrderGtdSec", 2), 2), 1, 10)

  base["stopLossPct"] = _to_opt_float(base.get("stopLossPct"))
  base["stopLossAtrMult"] = _to_opt_float(base.get("stopLossAtrMult"))
  base["takeProfitPct"] = _to_opt_float(base.get("takeProfitPct"))
  base["takeProfitAtrMult"] = _to_opt_float(base.get("takeProfitAtrMult"))
  base["trailingStopPct"] = _to_opt_float(base.get("trailingStopPct"))
  base["maxDailyLossUsd"] = max(0.0, _to_float(base.get("maxDailyLossUsd", 0.0), 0.0))

  return base


def load_runtime_config_from_disk() -> Dict[str, Any]:
  try:
    if os.path.exists(RUNTIME_CONFIG_PATH):
      with open(RUNTIME_CONFIG_PATH, "r", encoding="utf-8") as f:
        return sanitize_runtime_config(json.load(f))
  except Exception:
    pass
  return sanitize_runtime_config({})


def save_runtime_config_to_disk(cfg: Dict[str, Any]) -> None:
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


def apply_command_updates(updates: List[Dict[str, Any]]) -> None:
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


LATEST_STATUS: Dict[str, Any] = {"bot": {"alive": False, "message": "starting"}}
STATUS_LOCK = threading.Lock()


def to_countdown_sec(target_ms: Optional[int], now_ms: Optional[int] = None) -> Optional[int]:
  if not target_ms:
    return None
  if now_ms is None:
    now_ms = int(time.time() * 1000)
  return max(0, int((int(target_ms) - int(now_ms) + 999) / 1000))


def confidence_band(conf: float) -> str:
  if conf >= 0.75:
    return "HIGH"
  if conf >= 0.6:
    return "MEDIUM"
  return "LOW"


def explain_agent_reason(raw_reason: str, desired: str, conf: float) -> Tuple[str, str]:
  conf_pct = int(clamp(conf, 0.0, 1.0) * 100)
  band = "High" if conf >= 0.75 else ("Medium" if conf >= 0.6 else "Low")
  direction = {"LONG": "bullish", "SHORT": "bearish", "FLAT": "neutral"}.get(desired, "neutral")
  human = f"{band} confidence ({conf_pct}%). Model is {direction}."
  return human, raw_reason


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

  def _send_json(self, code: int, obj: Any) -> None:
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
        data = clone_jsonable(LATEST_STATUS)
      return self._send_json(200, data)

    if path.startswith("/config"):
      return self._send_json(200, get_runtime_config())

    if path.startswith("/commands"):
      if not self._authorized():
        return self._send_json(403, {"error": "forbidden"})
      return self._send_json(200, {"commands": list_commands()})

    if path.startswith("/ingestion"):
      cfg = get_runtime_config()
      stats = DB_MANAGER.query_ingestion_stats()
      with STATUS_LOCK:
        s = clone_jsonable(LATEST_STATUS)
      return self._send_json(
        200,
        {
          "updatedAt": int(time.time() * 1000),
          "enabled": bool(cfg.get("ingestionEnabled", True)),
          "running": bool(s.get("bot", {}).get("alive", False)),
          "ingestIntervalSec": float(cfg.get("ingestIntervalSec", 0.5)),
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
      trading_status = s.get("trading") if isinstance(s.get("trading"), dict) else {}
      cooldown_until = trading_status.get("cooldownUntil")
      next_entry_eval = None
      if not pos_open:
        last_decision = agent.get("lastDecisionAt")
        decision_interval = int(agent.get("decisionIntervalSeconds") or cfg.get("decisionLoopIntervalSec") or 4)
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
          "cooldownUntil": cooldown_until,
          "nextDecisionAt": next_entry_eval,
          "countdowns": {
            "initialHoldEndsInSec": to_countdown_sec(min_hold_until, now_ms),
            "nextReassessInSec": to_countdown_sec(next_reassess_at, now_ms),
            "maxHoldEndsInSec": to_countdown_sec(max_hold_until, now_ms),
            "cooldownEndsInSec": to_countdown_sec(cooldown_until if not pos_open else None, now_ms),
            "nextDecisionInSec": to_countdown_sec(next_entry_eval, now_ms),
          },
          "lastAction": s.get("lastAction"),
        },
      )

    if path.startswith("/uc5/chart"):
      range_raw = qs.get("range", ["24h"])[0]
      res_raw = qs.get("resolution", ["1m"])[0]
      out = DB_MANAGER.query_chart_data(
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
      summary = DB_MANAGER.query_trades_summary()
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
      return self._send_json(200, DB_MANAGER.query_trades_summary())

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
      require_signer_link = str(os.environ.get("UC5_REQUIRE_SIGNER_LINK", "1")).strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
      )
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
            "status": (
              "linked"
              if signer_linked
              else ("required" if require_signer_link else "optional_recommended")
            ),
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

  def log_message(self, fmt: str, *args):
    return


def start_telemetry_server():
  class _UC5TelemetryServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

  srv = _UC5TelemetryServer((TELEMETRY_HOST, TELEMETRY_PORT), TelemetryHandler)
  t = threading.Thread(target=srv.serve_forever, daemon=True)
  t.start()
  return srv


# ---- Ethereal REST helpers ----
def fetch_product_id(eth_base: str, ticker: str) -> str:
  try:
    prod = requests.get(f"{eth_base}/v1/product", params={"ticker": ticker}, timeout=20).json()
    if prod.get("data"):
      return prod["data"][0]["id"]
  except Exception:
    return ""
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
  for k in (
    "lotSize",
    "baseLotSize",
    "qtyIncrement",
    "quantityIncrement",
    "stepSize",
    "sizeStep",
  ):
    v = product_row.get(k)
    try:
      x = float(v)
      if x > 0:
        return x
    except Exception:
      continue
  return fallback


def extract_tick_size(product_row: Dict[str, Any], fallback: float = 1.0) -> float:
  if not isinstance(product_row, dict):
    return fallback
  for k in (
    "tickSize",
    "priceIncrement",
    "quoteTickSize",
    "minPriceIncrement",
    "priceStep",
  ):
    v = product_row.get(k)
    try:
      x = float(v)
      if x > 0:
        return x
    except Exception:
      continue
  return fallback


def fetch_market_price(eth_base: str, product_id: str) -> Dict[str, Any]:
  try:
    r = requests.get(
      f"{eth_base}/v1/product/market-price",
      params={"productIds": product_id},
      timeout=20,
    ).json()
    if isinstance(r, dict) and isinstance(r.get("data"), list) and r["data"]:
      row = r["data"][0]
      if isinstance(row, dict):
        return row
  except Exception:
    pass

  try:
    r2 = requests.get(
      f"{eth_base}/v1/product/market-price",
      params={"productId": product_id},
      timeout=20,
    ).json()
    if isinstance(r2, dict) and isinstance(r2.get("data"), list) and r2["data"]:
      row = r2["data"][0]
      if isinstance(row, dict):
        return row
    return r2 if isinstance(r2, dict) else {}
  except Exception:
    return {}


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
      timeout=20,
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
        [
          "availableMarginUsd",
          "availableMargin",
          "available",
          "freeCollateral",
          "availableBalance",
          "availableUsd",
        ],
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


def parse_position(
  pos: Optional[Dict[str, Any]],
) -> Tuple[bool, Optional[str], float, Optional[float], Optional[float], Optional[int]]:
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

  entry_price = _f(pos.get("entryPrice")) or _f(pos.get("avgEntryPrice")) or _f(pos.get("averageEntryPrice"))

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


def fetch_funding_snapshot(eth_base: str, product_id: str) -> Dict[str, Optional[float]]:
  funding = None
  projected = None

  paths = [
    ("/v1/funding", {"productId": product_id}),
    ("/v1/funding-rate", {"productId": product_id}),
    ("/v1/product/funding", {"productId": product_id}),
  ]

  for path, params in paths:
    try:
      raw = requests.get(f"{eth_base}{path}", params=params, timeout=15).json()
      row = None
      if isinstance(raw, dict):
        data = raw.get("data")
        if isinstance(data, list) and data and isinstance(data[0], dict):
          row = data[0]
        elif isinstance(data, dict):
          row = data
        elif any(k in raw for k in ("funding", "fundingRate", "projectedFunding", "predictedFunding")):
          row = raw
      if not isinstance(row, dict):
        continue

      if funding is None:
        for k in (
          "funding",
          "fundingRate",
          "funding_rate",
          "hourlyFundingRate",
          "currentFundingRate",
          "lastFundingRate",
          "eightHourFundingRate",
        ):
          x = _rate(row.get(k))
          if x is not None:
            funding = x
            break

      if projected is None:
        for k in (
          "projectedFunding",
          "predictedFunding",
          "projectedFundingRate",
          "nextFundingRate",
          "nextFunding",
          "estimatedFundingRate",
        ):
          x = _rate(row.get(k))
          if x is not None:
            projected = x
            break

      if funding is not None or projected is not None:
        break
    except Exception:
      continue

  return {"funding": funding, "projectedFunding": projected}


def fetch_perp_metrics(
  eth_base: str,
  ticker: str,
  product_id: str,
  mid: Optional[float],
  bid: Optional[float],
  ask: Optional[float],
  oracle: Optional[float],
  prev_oi: Optional[float],
) -> Dict[str, Any]:
  row = fetch_product_row(eth_base, ticker, product_id)
  funding_raw = fetch_funding_snapshot(eth_base, product_id)

  funding = funding_raw.get("funding")
  projected = funding_raw.get("projectedFunding")

  if funding is None:
    for k in (
      "fundingRate",
      "funding",
      "funding_rate",
      "hourlyFundingRate",
      "currentFundingRate",
      "lastFundingRate",
      "eightHourFundingRate",
    ):
      x = _rate(row.get(k))
      if x is not None:
        funding = x
        break

  if projected is None:
    for k in (
      "projectedFunding",
      "predictedFunding",
      "projectedFundingRate",
      "nextFundingRate",
      "nextFunding",
      "estimatedFundingRate",
    ):
      x = _rate(row.get(k))
      if x is not None:
        projected = x
        break

  oi = None
  for k in ("openInterest", "oi", "openInterestUsd"):
    x = _f(row.get(k))
    if x is not None:
      oi = x
      break

  oi_delta = (oi - prev_oi) if (oi is not None and prev_oi is not None) else 0.0

  basis = ((float(mid) - float(oracle)) / float(oracle)) if (mid and oracle and oracle > 0) else 0.0
  spread_bps = ((float(ask) - float(bid)) / float(mid) * 10_000.0) if (bid and ask and mid and mid > 0) else None

  return {
    "funding": funding,
    "projectedFunding": projected,
    "openInterest": oi,
    "openInterestDelta": oi_delta,
    "basis": basis,
    "spreadBps": spread_bps,
  }


# ---- SDK helpers ----
async def ensure_client(cfg: Dict[str, Any]) -> AsyncRESTClient:
  eth_base = cfg.get("etherealApiBase", "https://api.ethereal.trade")
  eth_rpc = cfg.get("etherealRpcUrl", "https://rpc.ethereal.trade")
  try:
    return await AsyncRESTClient.create(
      {
        "base_url": eth_base,
        "chain_config": {
          "rpc_url": eth_rpc,
          "private_key": BOT_PRIVKEY,
        },
      }
    )
  except TypeError:
    return await AsyncRESTClient.create(
      private_key=BOT_PRIVKEY,
      api_url=eth_base,
      chain_rpc_url=eth_rpc,
    )


async def _try_create_order(client: AsyncRESTClient, kwargs_variants: List[Dict[str, Any]]):
  last_err: Optional[Exception] = None
  for kw in kwargs_variants:
    try:
      return await client.create_order(**kw)
    except TypeError as e:
      last_err = e
      continue
    except Exception as e:
      last_err = e
      break
  if last_err:
    raise last_err
  raise RuntimeError("No valid order payload variant")


async def place_market(
  client: AsyncRESTClient,
  ticker: str,
  side_int: int,
  qty: float,
  sender: str,
  subaccount: str,
  lot_size: Optional[float] = None,
):
  q_adj = quantize_qty_to_lot(qty, lot_size)
  if q_adj <= 0:
    raise RuntimeError(f"Quantity {qty} rounds to 0 at lotSize={lot_size}")

  q = Decimal(str(q_adj))

  base_variants = [
    {
      "order_type": "MARKET",
      "quantity": q,
      "side": side_int,
      "price": None,
      "ticker": ticker,
      "sender": sender,
      "subaccount": subaccount,
    },
    {
      "order_type": "MARKET",
      "quantity": q,
      "side": side_int,
      "price": Decimal("0"),
      "ticker": ticker,
      "sender": sender,
      "subaccount": subaccount,
    },
    {
      "order_type": "MARKET",
      "quantity": q,
      "side": side_int,
      "ticker": ticker,
      "sender": sender,
      "subaccount": subaccount,
    },
    {
      "order_type": "MARKET",
      "quantity": q,
      "side": side_int,
      "ticker": ticker,
    },
  ]

  try:
    return await _try_create_order(client, base_variants)
  except Exception as first_error:
    err = str(first_error or "")
    if (
      ("401" in err or "Unauthorized" in err)
      and BOT_SIGNER_ADDRESS
      and BOT_SIGNER_ADDRESS.lower() != str(sender or "").lower()
    ):
      variants = []
      for v in base_variants:
        cp = dict(v)
        cp["sender"] = BOT_SIGNER_ADDRESS
        variants.append(cp)
      return await _try_create_order(client, variants)
    raise


async def place_limit_ioc(
  client: AsyncRESTClient,
  ticker: str,
  side_int: int,
  qty: float,
  limit_price: float,
  sender: str,
  subaccount: str,
  lot_size: Optional[float] = None,
):
  q_adj = quantize_qty_to_lot(qty, lot_size)
  if q_adj <= 0:
    raise RuntimeError(f"Quantity {qty} rounds to 0 at lotSize={lot_size}")

  p = Decimal(str(limit_price))
  q = Decimal(str(q_adj))

  variants = [
    {
      "order_type": "LIMIT",
      "quantity": q,
      "side": side_int,
      "price": p,
      "ticker": ticker,
      "sender": sender,
      "subaccount": subaccount,
      "time_in_force": "IOC",
    },
    {
      "order_type": "LIMIT",
      "quantity": q,
      "side": side_int,
      "price": p,
      "ticker": ticker,
      "sender": sender,
      "subaccount": subaccount,
      "tif": "IOC",
    },
    {
      "order_type": "LIMIT",
      "quantity": q,
      "side": side_int,
      "price": p,
      "ticker": ticker,
      "sender": sender,
      "subaccount": subaccount,
    },
  ]

  try:
    return await _try_create_order(client, variants)
  except Exception as first_error:
    err = str(first_error or "")
    if (
      ("401" in err or "Unauthorized" in err)
      and BOT_SIGNER_ADDRESS
      and BOT_SIGNER_ADDRESS.lower() != str(sender or "").lower()
    ):
      signer_variants = []
      for v in variants:
        cp = dict(v)
        cp["sender"] = BOT_SIGNER_ADDRESS
        signer_variants.append(cp)
      return await _try_create_order(client, signer_variants)
    raise


async def place_limit_post_only(
  client: AsyncRESTClient,
  ticker: str,
  side_int: int,
  qty: float,
  limit_price: float,
  sender: str,
  subaccount: str,
  lot_size: Optional[float] = None,
  gtd_sec: int = 2,
  reduce_only: bool = False,
  close: Optional[bool] = None,
):
  q_adj = quantize_qty_to_lot(qty, lot_size)
  if q_adj <= 0:
    raise RuntimeError(f"Quantity {qty} rounds to 0 at lotSize={lot_size}")

  p = Decimal(str(limit_price))
  q = Decimal(str(q_adj))
  now_s = int(time.time())
  expires_at_s = now_s + max(1, int(gtd_sec))
  expires_at_ms = expires_at_s * 1000
  common = {
    "order_type": "LIMIT",
    "quantity": q,
    "side": side_int,
    "price": p,
    "ticker": ticker,
    "sender": sender,
    "subaccount": subaccount,
    "reduce_only": bool(reduce_only),
  }
  if close is not None:
    common["close"] = bool(close)

  variants = [
    {
      **common,
      "time_in_force": "GTD",
      "post_only": True,
      "expires_at": expires_at_s,
    },
    {
      **common,
      "time_in_force": "GTD",
      "postOnly": True,
      "expiresAt": expires_at_ms,
    },
    {
      **common,
      "tif": "GTD",
      "post_only": True,
      "expires_at": expires_at_ms,
    },
    {
      **common,
      "tif": "GTD",
      "postOnly": True,
      "expiresAt": expires_at_s,
    },
  ]

  try:
    return await _try_create_order(client, variants)
  except Exception as first_error:
    err = str(first_error or "")
    if (
      ("401" in err or "Unauthorized" in err)
      and BOT_SIGNER_ADDRESS
      and BOT_SIGNER_ADDRESS.lower() != str(sender or "").lower()
    ):
      signer_variants = []
      for v in variants:
        cp = dict(v)
        cp["sender"] = BOT_SIGNER_ADDRESS
        signer_variants.append(cp)
      return await _try_create_order(client, signer_variants)
    raise


async def cancel_open_orders(client: AsyncRESTClient, ticker: str, sender: str, subaccount: str):
  methods = ["cancel_all_orders", "cancel_orders", "cancel_all"]
  payloads = [
    {"ticker": ticker, "sender": sender, "subaccount": subaccount},
    {"ticker": ticker, "sender": sender},
    {"ticker": ticker},
    {"subaccount": subaccount},
    {},
  ]

  for m in methods:
    fn = getattr(client, m, None)
    if not callable(fn):
      continue
    for p in payloads:
      try:
        await fn(**p)
        return
      except TypeError:
        continue
      except Exception:
        continue


def _order_guard_ok(now_ms: int, last_submit_ms: int, guard_ms: int) -> bool:
  return (now_ms - int(last_submit_ms)) >= int(guard_ms)


def _side_to_int(side: str) -> int:
  s = str(side or "").upper()
  if s == "LONG":
    return 0
  if s == "SHORT":
    return 1
  raise ValueError(f"Unsupported side={side}")


def _exit_side_int(position_side: str) -> int:
  side = str(position_side or "").upper()
  if side == "LONG":
    return 1
  if side == "SHORT":
    return 0
  raise ValueError(f"Unsupported position side={position_side}")


def _calc_limit_price(
  side_int: int,
  mid: float,
  bid: Optional[float],
  ask: Optional[float],
  tick_size: Optional[float] = None,
  aggressive: bool = True,
) -> float:
  if mid <= 0:
    raise RuntimeError("invalid mid")
  bid = bid if bid and bid > 0 else None
  ask = ask if ask and ask > 0 else None

  if bid is not None and ask is not None and ask >= bid:
    if aggressive:
      spread = ask - bid
      if side_int == 0:
        # buy near the bid edge but still likely to cross quickly in IOC
        px = min(ask, max(bid, bid + spread * 0.65))
      else:
        # sell near the ask edge
        px = max(bid, min(ask, ask - spread * 0.65))
    else:
      # maker-favoring touch price
      px = bid if side_int == 0 else ask
    return quantize_price_to_tick(float(px), tick_size, side_int, aggressive=aggressive)

  return quantize_price_to_tick(float(mid), tick_size, side_int, aggressive=aggressive)


def _estimate_expected_move_bps(signal: SignalResult, horizon_sec: int) -> float:
  conf = clamp(abs(float(signal.p_up) - 0.5) * 2.0, 0.0, 1.0)
  horizon = max(10.0, float(horizon_sec))

  feats = signal.features if isinstance(signal.features, list) else []
  abs_rets = [abs(float(feats[i])) for i in range(min(4, len(feats)))]
  ret_move_bps = (max(abs_rets) * 10_000.0) if abs_rets else 0.0

  atr_move_bps = max(0.0, float(signal.atr_pct)) * 10_000.0 * math.sqrt(horizon / 10.0)
  regime_mult = 1.10 if signal.regime == "momentum" else (0.95 if signal.regime == "mean_reversion" else 0.80)

  est = max(
    ret_move_bps * (0.35 + 0.95 * conf),
    atr_move_bps * (0.30 + 0.90 * conf) * regime_mult,
  )
  return max(0.0, float(est))


def _realized_pnl(side: Optional[str], entry_price: Optional[float], exit_price: Optional[float], qty: float) -> Optional[float]:
  if not side or not entry_price or not exit_price or qty <= 0:
    return None
  s = str(side).upper()
  if s == "LONG":
    return (float(exit_price) - float(entry_price)) * float(qty)
  if s == "SHORT":
    return (float(entry_price) - float(exit_price)) * float(qty)
  return None


def _ws_base_url_from_api(eth_base: str) -> str:
  raw = str(os.environ.get("UC5_ETHEREAL_WS_BASE", "")).strip()
  if raw:
    return raw
  s = str(eth_base or "https://api.ethereal.trade").strip()
  if s.startswith("https://"):
    s = "wss://" + s[len("https://") :]
  elif s.startswith("http://"):
    s = "ws://" + s[len("http://") :]
  if "://api." in s:
    s = s.replace("://api.", "://ws.", 1)
  return s


def _to_plain_dict(obj: Any) -> Dict[str, Any]:
  if isinstance(obj, dict):
    return obj
  if hasattr(obj, "model_dump"):
    try:
      out = obj.model_dump(by_alias=True)
      return out if isinstance(out, dict) else {}
    except Exception:
      pass
  if hasattr(obj, "dict"):
    try:
      out = obj.dict()
      return out if isinstance(out, dict) else {}
    except Exception:
      pass
  return {}


def _extract_best_bid_ask_from_ws_payload(payload: Any) -> Tuple[Optional[float], Optional[float]]:
  if not isinstance(payload, dict):
    return (None, None)

  direct_bid = _f(payload.get("bestBidPrice") or payload.get("bestBid") or payload.get("bid"))
  direct_ask = _f(payload.get("bestAskPrice") or payload.get("bestAsk") or payload.get("ask"))
  if direct_bid and direct_ask:
    return (direct_bid, direct_ask)

  def _first_price(levels: Any) -> Optional[float]:
    if not isinstance(levels, list) or not levels:
      return None
    top = levels[0]
    if isinstance(top, dict):
      return _f(top.get("price") or top.get("p"))
    if isinstance(top, (list, tuple)) and top:
      return _f(top[0])
    return None

  for key in ("book", "data", "payload"):
    inner = payload.get(key)
    if isinstance(inner, dict):
      b, a = _extract_best_bid_ask_from_ws_payload(inner)
      if b or a:
        return (b, a)

  bids = payload.get("bids")
  asks = payload.get("asks")
  if isinstance(bids, list) or isinstance(asks, list):
    return (_first_price(bids), _first_price(asks))

  return (None, None)


class WsQuoteCache:
  def __init__(self) -> None:
    self._lock = threading.Lock()
    self.best_bid: Optional[float] = None
    self.best_ask: Optional[float] = None
    self.last_update_ms: Optional[int] = None
    self.connected = False
    self.subscribed = False
    self.last_error: Optional[str] = None
    self.product_id: str = ""

  def set_product(self, product_id: str) -> None:
    with self._lock:
      self.product_id = str(product_id or "")
      self.subscribed = False

  def set_conn(self, connected: bool) -> None:
    with self._lock:
      self.connected = bool(connected)

  def set_error(self, err: Optional[str]) -> None:
    with self._lock:
      self.last_error = str(err) if err else None

  def update_book(self, payload: Any) -> None:
    bid, ask = _extract_best_bid_ask_from_ws_payload(payload)
    if bid is None and ask is None:
      return
    now_ms = int(time.time() * 1000)
    with self._lock:
      if bid is not None and bid > 0:
        self.best_bid = bid
      if ask is not None and ask > 0:
        self.best_ask = ask
      self.last_update_ms = now_ms
      self.subscribed = True

  def snapshot(self) -> Dict[str, Any]:
    with self._lock:
      return {
        "bestBid": self.best_bid,
        "bestAsk": self.best_ask,
        "lastUpdateMs": self.last_update_ms,
        "connected": self.connected,
        "subscribed": self.subscribed,
        "lastError": self.last_error,
        "productId": self.product_id,
      }


async def _run_ws_book_depth_loop(
  eth_base: str,
  product_id: str,
  quote_cache: WsQuoteCache,
) -> None:
  if AsyncWSClient is None:
    quote_cache.set_error("AsyncWSClient unavailable in ethereal SDK")
    while True:
      await asyncio.sleep(5)

  ws_base = _ws_base_url_from_api(eth_base)
  quote_cache.set_product(product_id)

  while True:
    ws_client = None
    try:
      quote_cache.set_error(None)
      ws_client = AsyncWSClient({"base_url": ws_base, "verbose": False})

      async def _on_book(data: Dict[str, Any]) -> None:
        quote_cache.update_book(data)

      ws_client.callbacks["BookDepth"] = [_on_book]
      await ws_client.open(namespaces=["/v1/stream"])
      quote_cache.set_conn(True)
      await ws_client.subscribe(stream_type="BookDepth", product_id=product_id)
      while True:
        await asyncio.sleep(1.0)
    except asyncio.CancelledError:
      quote_cache.set_conn(False)
      if ws_client is not None:
        try:
          await ws_client.close()
        except Exception:
          pass
      raise
    except Exception as e:
      quote_cache.set_conn(False)
      quote_cache.set_error(str(e))
      await asyncio.sleep(2.0)
    finally:
      if ws_client is not None:
        try:
          await ws_client.close()
        except Exception:
          pass


def _maker_touch_price(
  side_int: int,
  bid: Optional[float],
  ask: Optional[float],
  mid: Optional[float],
  tick_size: Optional[float],
) -> float:
  b = bid if bid and bid > 0 else None
  a = ask if ask and ask > 0 else None
  if side_int == 0 and b is not None:
    return quantize_price_to_tick(float(b), tick_size, side_int, aggressive=False)
  if side_int == 1 and a is not None:
    return quantize_price_to_tick(float(a), tick_size, side_int, aggressive=False)
  m = float(mid or 0.0)
  if m <= 0:
    raise RuntimeError("No valid quote for maker touch price")
  return _calc_limit_price(side_int, m, b, a, tick_size=tick_size, aggressive=False)


async def fetch_fills_audit(
  client: AsyncRESTClient,
  subaccount_id: str,
  product_id: str,
  limit: int = 20,
  created_after_ms: Optional[int] = None,
) -> Dict[str, Any]:
  rows: List[Dict[str, Any]] = []
  if not subaccount_id:
    return {"fills": [], "summary": {"count": 0, "makerRatePct": 0.0, "totalFeesUsd": 0.0}}

  variants: List[Dict[str, Any]] = [
    {
      "subaccount_id": subaccount_id,
      "product_ids": [product_id] if product_id else None,
      "limit": int(limit),
      "order": "desc",
      "order_by": "createdAt",
      "created_after": created_after_ms,
    },
    {
      "subaccountId": subaccount_id,
      "productIds": [product_id] if product_id else None,
      "limit": int(limit),
      "order": "desc",
      "orderBy": "createdAt",
      "createdAfter": created_after_ms,
    },
  ]

  last_err: Optional[str] = None
  for kwargs in variants:
    kwargs = {k: v for k, v in kwargs.items() if v is not None}
    try:
      raw = await client.list_fills(**kwargs)
      rows = [_to_plain_dict(x) for x in (raw or [])]
      break
    except TypeError as e:
      last_err = str(e)
      continue
    except Exception as e:
      last_err = str(e)
      continue
  if rows is None:
    rows = []

  rows = [r for r in rows if isinstance(r, dict)]
  if product_id:
    rows = [r for r in rows if str(r.get("productId") or r.get("product_id") or "") == str(product_id)]
  if created_after_ms is not None:
    rows = [r for r in rows if int(float(r.get("createdAt") or r.get("created_at") or 0)) >= int(created_after_ms)]
  rows.sort(key=lambda r: int(float(r.get("createdAt") or r.get("created_at") or 0)), reverse=True)
  rows = rows[: max(1, int(limit))]

  normalized: List[Dict[str, Any]] = []
  maker_count = 0
  total_fees = 0.0
  for r in rows:
    is_maker = bool(r.get("isMaker") if "isMaker" in r else r.get("is_maker"))
    fee_usd = _f(r.get("feeUsd") if "feeUsd" in r else r.get("fee_usd")) or 0.0
    total_fees += fee_usd
    if is_maker:
      maker_count += 1
    normalized.append(
      {
        "id": str(r.get("id") or ""),
        "orderId": str(r.get("orderId") or r.get("order_id") or ""),
        "price": _f(r.get("price")),
        "qty": _f(r.get("filled")),
        "side": r.get("side"),
        "type": str(r.get("type") or ""),
        "isMaker": is_maker,
        "feeUsd": fee_usd,
        "createdAt": int(float(r.get("createdAt") or r.get("created_at") or 0)),
      }
    )

  count = len(normalized)
  summary = {
    "count": count,
    "makerCount": maker_count,
    "makerRatePct": ((maker_count / count) * 100.0) if count else 0.0,
    "totalFeesUsd": total_fees,
    "error": last_err if (last_err and not normalized) else None,
  }
  return {"fills": normalized, "summary": summary}


def _print_maker_audit(label: str, audit: Dict[str, Any]) -> None:
  try:
    summary = audit.get("summary") if isinstance(audit, dict) else {}
    fills = audit.get("fills") if isinstance(audit, dict) else []
    print(
      f"[MAKER_AUDIT] {label} count={int(summary.get('count') or 0)} "
      f"makerRatePct={float(summary.get('makerRatePct') or 0.0):.1f} "
      f"feesUsd={float(summary.get('totalFeesUsd') or 0.0):.6f}"
    )
    for f in list(fills or [])[:5]:
      print(
        "[MAKER_AUDIT_FILL] "
        f"label={label} ts={int(f.get('createdAt') or 0)} side={f.get('side')} "
        f"type={f.get('type')} px={f.get('price')} qty={f.get('qty')} "
        f"isMaker={bool(f.get('isMaker'))} feeUsd={float(f.get('feeUsd') or 0.0):.6f}"
      )
  except Exception:
    pass


def _print_chase_attempts(label: str, result: Dict[str, Any]) -> None:
  try:
    print(
      f"[EXEC_CHASE] {label} attempts={int(result.get('attemptCount') or 0)} "
      f"submitted={int(result.get('submittedCount') or 0)} filled={float(result.get('filledQty') or 0.0):.8f} "
      f"remaining={float(result.get('remainingQty') or 0.0):.8f} "
      f"timedOut={bool(result.get('timedOut'))} marketSafety={bool(result.get('marketSafetyUsed'))}"
    )
    for a in list(result.get("attempts") or [])[:30]:
      print(
        "[EXEC_CHASE_ATTEMPT] "
        f"label={label} ts={int(a.get('tsMs') or 0)} bid={a.get('bid')} ask={a.get('ask')} "
        f"px={a.get('price')} submitted={bool(a.get('submitted'))} "
        f"filled={a.get('filled')} remaining={a.get('remaining')} err={a.get('error')}"
      )
  except Exception:
    pass


async def execute_maker_chase(
  *,
  client: AsyncRESTClient,
  eth_base: str,
  sub_id: str,
  product_id: str,
  ticker: str,
  sender: str,
  subaccount: str,
  order_side_int: int,
  target_qty: float,
  lot_size: Optional[float],
  tick_size: Optional[float],
  last_mid: Optional[float],
  last_bid: Optional[float],
  last_ask: Optional[float],
  quote_cache: Optional[WsQuoteCache],
  chase_max_sec: float,
  reprice_ms: int,
  gtd_sec: int,
  last_order_submit_ms: int,
  order_guard_ms: int,
  position_mode: str,
  expected_side: Optional[str] = None,
  reduce_only: bool = False,
  allow_market_safety: bool = False,
) -> Dict[str, Any]:
  start_ms = int(time.time() * 1000)
  deadline_ms = start_ms + int(max(0.2, chase_max_sec) * 1000)
  qty = quantize_qty_to_lot(target_qty, lot_size)
  attempts: List[Dict[str, Any]] = []
  errors: List[str] = []
  submitted = 0
  filled = 0.0
  remaining = qty
  market_safety_used = False

  while remaining > 0 and int(time.time() * 1000) < deadline_ms:
    now_ms = int(time.time() * 1000)
    if not _order_guard_ok(now_ms, last_order_submit_ms, max(100, int(order_guard_ms))):
      await asyncio.sleep(0.05)
      continue

    ws_snap = quote_cache.snapshot() if quote_cache is not None else {}
    bid = _f(ws_snap.get("bestBid")) or last_bid
    ask = _f(ws_snap.get("bestAsk")) or last_ask
    quote_age_ms = None
    if ws_snap.get("lastUpdateMs"):
      quote_age_ms = max(0, now_ms - int(ws_snap.get("lastUpdateMs")))
      if quote_age_ms > 4000:
        bid = last_bid or bid
        ask = last_ask or ask

    limit_px = _maker_touch_price(order_side_int, bid, ask, last_mid, tick_size)
    attempt: Dict[str, Any] = {
      "tsMs": now_ms,
      "price": limit_px,
      "bid": bid,
      "ask": ask,
      "quoteAgeMs": quote_age_ms,
    }
    try:
      await place_limit_post_only(
        client,
        ticker,
        order_side_int,
        remaining,
        limit_px,
        sender,
        subaccount,
        lot_size,
        gtd_sec=gtd_sec,
        reduce_only=reduce_only,
      )
      submitted += 1
      last_order_submit_ms = int(time.time() * 1000)
      attempt["submitted"] = True
    except Exception as e:
      err = str(e)
      attempt["submitted"] = False
      attempt["error"] = err
      errors.append(err)
      try:
        await cancel_open_orders(client, ticker, sender, subaccount)
      except Exception:
        pass
      attempts.append(attempt)
      await asyncio.sleep(min(0.2, max(0.05, reprice_ms / 1000.0)))
      continue

    sleep_ms = min(int(reprice_ms), max(50, deadline_ms - int(time.time() * 1000)))
    await asyncio.sleep(max(0.05, sleep_ms / 1000.0))
    try:
      await cancel_open_orders(client, ticker, sender, subaccount)
    except Exception as e:
      errors.append(f"cancel:{e}")

    pos_now = fetch_active_position(eth_base, sub_id, product_id)
    o, s, sz, _, _, _ = parse_position(pos_now)
    abs_sz = abs(float(sz)) if sz is not None else 0.0

    if position_mode == "entry":
      if o and s == expected_side:
        filled = abs_sz
      else:
        filled = 0.0
      remaining = max(0.0, qty - filled)
    else:
      remaining = abs_sz if (o and s == expected_side) else 0.0
      filled = max(0.0, qty - remaining)

    attempt["filled"] = filled
    attempt["remaining"] = remaining
    attempts.append(attempt)

  remaining = quantize_qty_to_lot(max(0.0, remaining), lot_size)
  if remaining > 0:
    try:
      await cancel_open_orders(client, ticker, sender, subaccount)
    except Exception:
      pass

  if remaining > 0 and allow_market_safety:
    await place_market(client, ticker, order_side_int, remaining, sender, subaccount, lot_size)
    await cancel_open_orders(client, ticker, sender, subaccount)
    market_safety_used = True
    last_order_submit_ms = int(time.time() * 1000)
    submitted += 1
    pos_now = fetch_active_position(eth_base, sub_id, product_id)
    o, s, sz, _, _, _ = parse_position(pos_now)
    abs_sz = abs(float(sz)) if sz is not None else 0.0
    if position_mode == "entry":
      if o and s == expected_side:
        filled = abs_sz
      else:
        filled = 0.0
      remaining = max(0.0, qty - filled)
    else:
      remaining = abs_sz if (o and s == expected_side) else 0.0
      filled = max(0.0, qty - remaining)

  return {
    "startMs": start_ms,
    "endMs": int(time.time() * 1000),
    "targetQty": qty,
    "filledQty": quantize_qty_to_lot(max(0.0, filled), lot_size),
    "remainingQty": quantize_qty_to_lot(max(0.0, remaining), lot_size),
    "attempts": attempts,
    "attemptCount": len(attempts),
    "submittedCount": submitted,
    "marketSafetyUsed": market_safety_used,
    "timedOut": bool(remaining > 0),
    "errors": errors[-5:],
    "lastOrderSubmitMs": last_order_submit_ms,
  }


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
    },
  }

  r = requests.post(f"{eth_base}/v1/linked-signer/link", json=body, timeout=20)
  if r.status_code >= 300:
    txt = str(r.text or "")
    # Some deployments return 400 when signer is already linked.
    # Treat this as idempotent success to keep setup flow stable.
    if r.status_code == 400 and "Signer previously linked" in txt:
      try:
        parsed = r.json() if r.content else {}
      except Exception:
        parsed = {}
      return {
        "status": "LINKED_ALREADY",
        "linked": True,
        "message": parsed.get("message") if isinstance(parsed, dict) else txt,
      }
    raise RuntimeError(f"Link signer failed: {r.status_code} {txt}")
  try:
    return r.json()
  except Exception:
    return {"status": "DONE"}


def _build_strategy_cfg(cfg: Dict[str, Any]) -> StrategyConfig:
  return StrategyConfig(
    open_confidence_threshold=float(cfg.get("openConfidenceThreshold", 0.65)),
    close_confidence_threshold=float(cfg.get("closeConfidenceThreshold", 0.55)),
    min_hold_seconds=int(cfg.get("minHoldSeconds", 5)),
    max_hold_seconds=int(cfg.get("maxHoldSeconds", 7200)),
    stop_loss_pct=_to_opt_float(cfg.get("stopLossPct")),
    stop_loss_atr_mult=_to_opt_float(cfg.get("stopLossAtrMult")),
    take_profit_pct=_to_opt_float(cfg.get("takeProfitPct")),
    take_profit_atr_mult=_to_opt_float(cfg.get("takeProfitAtrMult")),
    trailing_stop_pct=_to_opt_float(cfg.get("trailingStopPct")),
    max_spread_bps_for_trade=float(cfg.get("maxSpreadBpsForTrade", 12.0)),
  )


async def main():
  global LATEST_STATUS

  DB_MANAGER.run_retention_if_due(force=True)
  start_telemetry_server()

  if not BOT_PRIVKEY:
    raise SystemExit("Missing env UC5_BOT_SIGNER_PRIVATE_KEY (bot signer private key).")

  client: Optional[AsyncRESTClient] = None
  ws_quote_cache = WsQuoteCache()
  ws_quote_task: Optional[asyncio.Task] = None
  cached_product_id = ""
  cached_lot_size = 0.00001
  cached_tick_size = 1.0

  last_mid: Optional[float] = None
  last_bid: Optional[float] = None
  last_ask: Optional[float] = None
  last_oracle: Optional[float] = None
  last_tick_ts_ms: Optional[int] = None

  metrics_cache: Dict[str, Any] = {}
  prev_open_interest: Optional[float] = None

  position_state = PositionState(open=False, side=None, qty=0.0, entry_price=None, entry_ts_ms=None)

  last_reason = "warming up"
  last_desired = "FLAT"
  last_conf = 0.5
  last_regime = "no_data"

  last_decision_at_ms: Optional[int] = None
  next_decision_ms = 0
  next_reassess_ms = 0
  next_metrics_ms = 0
  next_risk_ms = 0
  next_ingest_ms = 0

  last_order_submit_ms = 0
  last_order_ts: List[float] = []

  current_trade_entry_price: Optional[float] = None
  current_trade_entry_ts: Optional[int] = None
  last_close_ts_ms: Optional[int] = DB_MANAGER.query_last_close_ts()
  last_entry_fill_audit: Optional[Dict[str, Any]] = None
  last_exit_fill_audit: Optional[Dict[str, Any]] = None
  fills_audit_last20: Optional[Dict[str, Any]] = None
  last_entry_fill_info: Optional[Dict[str, Any]] = None
  last_exit_method: Optional[str] = None

  while True:
    started = time.time()
    now_ms = int(time.time() * 1000)

    status_payload: Dict[str, Any] = {}
    last_action: Dict[str, Any] = {"type": "NO_ACTION", "ok": True, "info": None}

    try:
      cfg = get_runtime_config()
      DB_MANAGER.run_retention_if_due()

      eth_base = str(cfg.get("etherealApiBase") or "https://api.ethereal.trade")
      ticker = str(cfg.get("ticker") or "BTCUSD")
      ingest_enabled = bool(cfg.get("ingestionEnabled", True))
      trading_enabled = bool(cfg.get("tradingEnabled", True))

      product_id = str(cfg.get("productId") or "") or fetch_product_id(eth_base, ticker)
      if not product_id:
        raise RuntimeError(f"No productId found for ticker={ticker}")

      if product_id != cached_product_id:
        product_row = fetch_product_row(eth_base, ticker, product_id)
        cached_lot_size = extract_lot_size(product_row, fallback=0.00001)
        cached_tick_size = extract_tick_size(product_row, fallback=1.0)
        if ws_quote_task is not None:
          ws_quote_task.cancel()
          try:
            await ws_quote_task
          except asyncio.CancelledError:
            pass
          except Exception:
            pass
          ws_quote_task = None
        ws_quote_cache = WsQuoteCache()
        if AsyncWSClient is not None:
          ws_quote_task = asyncio.create_task(_run_ws_book_depth_loop(eth_base, product_id, ws_quote_cache))
        cached_product_id = product_id

      owner_addr_raw = str(cfg.get("ownerAddress") or "")
      owner_addr = owner_addr_raw.lower()
      sub_id = str(cfg.get("subaccountId") or "")
      subaccount_name = str(cfg.get("subaccountName") or "")
      sub_id, subaccount_name = resolve_subaccount_context(
        eth_base=eth_base,
        sender=owner_addr,
        subaccount_id=sub_id,
        subaccount_name=subaccount_name,
      )

      configured_signer_addr = str(cfg.get("botSignerAddress") or "")
      signer_active = True
      if configured_signer_addr and sub_id:
        signer_active = is_linked_signer_active(eth_base, sub_id, configured_signer_addr)
        if bool(cfg.get("botSignerLinked", False)) != signer_active:
          cfg = set_runtime_config({**cfg, "botSignerLinked": signer_active})

      has_trade_account_ctx = bool(owner_addr_raw and subaccount_name)
      missing_trade_ctx = []
      if not owner_addr_raw:
        missing_trade_ctx.append("ownerAddress")
      if not subaccount_name:
        missing_trade_ctx.append("subaccountName")

      # Ingest loop (1-2s default)
      ingest_interval = float(cfg.get("ingestIntervalSec", 0.5))
      if now_ms >= next_ingest_ms:
        ws_snap = ws_quote_cache.snapshot()
        mp = fetch_market_price(eth_base, product_id)
        rest_bid = _f(mp.get("bestBidPrice") or mp.get("bestBid"))
        rest_ask = _f(mp.get("bestAskPrice") or mp.get("bestAsk"))
        best_bid = _f(ws_snap.get("bestBid")) or rest_bid
        best_ask = _f(ws_snap.get("bestAsk")) or rest_ask
        oracle = _f(mp.get("oraclePrice") or mp.get("oracle") or mp.get("price"))
        mid = None
        if best_bid and best_ask:
          mid = (best_bid + best_ask) / 2.0
        elif oracle:
          mid = oracle
        elif best_bid:
          mid = best_bid
        elif best_ask:
          mid = best_ask

        if mid is None or mid <= 0:
          raise RuntimeError(f"Market price unavailable for ticker={ticker}, productId={product_id}")

        last_mid = mid
        last_bid = best_bid
        last_ask = best_ask
        last_oracle = oracle
        last_tick_ts_ms = now_ms

        if ingest_enabled:
          basis = ((mid - oracle) / oracle) if (oracle and oracle > 0) else None
          spread_bps = ((best_ask - best_bid) / mid * 10_000.0) if (best_ask and best_bid and mid > 0) else None
          DB_MANAGER.write_tick(
            ts_ms=now_ms,
            price=float(mid),
            bid=best_bid,
            ask=best_ask,
            oracle=oracle,
            basis=basis,
            spread=spread_bps,
          )

        next_ingest_ms = now_ms + int(max(0.2, ingest_interval) * 1000)

      # Keep per-loop position snapshot fresh for risk + commands + status
      was_open = bool(position_state.open)
      pos = fetch_active_position(eth_base, sub_id, product_id)
      pos_open, pos_side, pos_size, pos_upnl, pos_entry_price, pos_entry_at_ms = parse_position(pos)
      if pos_open and pos_side:
        position_state.open = True
        position_state.side = pos_side
        position_state.qty = abs(float(pos_size))
        position_state.entry_price = pos_entry_price or position_state.entry_price
        position_state.entry_ts_ms = pos_entry_at_ms or position_state.entry_ts_ms
        if position_state.entry_ts_ms is None:
          open_leg = DB_MANAGER.query_open_leg_from_trades()
          if open_leg and open_leg.get("ts_ms"):
            position_state.entry_ts_ms = int(open_leg["ts_ms"])
            position_state.entry_price = _f(open_leg.get("price")) or position_state.entry_price
        if position_state.entry_price and not current_trade_entry_price:
          current_trade_entry_price = position_state.entry_price
        if position_state.entry_ts_ms and not current_trade_entry_ts:
          current_trade_entry_ts = position_state.entry_ts_ms
      else:
        position_state = PositionState(open=False, side=None, qty=0.0, entry_price=None, entry_ts_ms=None)
        current_trade_entry_price = None
        current_trade_entry_ts = None
      if was_open and not pos_open:
        last_close_ts_ms = now_ms

      if position_state.open and last_mid:
        position_state = update_position_extremes(position_state, float(last_mid))

      # Slow metrics loop (30-60s)
      metrics_interval = int(cfg.get("metricsLoopIntervalSec", 45))
      if now_ms >= next_metrics_ms and last_mid:
        pm = fetch_perp_metrics(
          eth_base=eth_base,
          ticker=ticker,
          product_id=product_id,
          mid=last_mid,
          bid=last_bid,
          ask=last_ask,
          oracle=last_oracle,
          prev_oi=prev_open_interest,
        )
        prev_open_interest = _f(pm.get("openInterest"))

        ticks_5m = DB_MANAGER.load_ticks(now_ms - (5 * 60 * 1000), now_ms)
        # Directional tick imbalance as light CVD proxy.
        cvd_10 = 0.0
        cvd_30 = 0.0
        cvd_120 = 0.0
        cvd_300 = 0.0
        if len(ticks_5m) > 2:
          def _cvd(sec: int) -> float:
            cutoff = now_ms - sec * 1000
            prev_px = None
            acc = 0.0
            for rr in ticks_5m:
              if int(rr.get("ts_ms") or 0) < cutoff:
                continue
              px = float(rr.get("price") or 0)
              if px <= 0:
                continue
              if prev_px is None:
                prev_px = px
                continue
              if px > prev_px:
                acc += 1
              elif px < prev_px:
                acc -= 1
              prev_px = px
            return acc

          cvd_10 = _cvd(10)
          cvd_30 = _cvd(30)
          cvd_120 = _cvd(120)
          cvd_300 = _cvd(300)

        metrics_cache = {
          **pm,
          "cvd10s": cvd_10,
          "cvd30s": cvd_30,
          "cvd2m": cvd_120,
          "cvd5m": cvd_300,
          "regime": metrics_cache.get("regime"),
        }
        DB_MANAGER.write_metric(now_ms, metrics_cache)
        next_metrics_ms = now_ms + metrics_interval * 1000

      # Commands (flatten/link signer)
      cmds = get_new_commands()
      updates: List[Dict[str, Any]] = []

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

      for c in cmds:
        if c.get("status") != "NEW":
          continue
        cid = str(c.get("id") or "")
        ctype = str(c.get("type") or "")
        try:
          if ctype == "FLATTEN":
            if not has_trade_account_ctx:
              updates.append(
                {
                  "id": cid,
                  "status": "ERROR",
                  "result": {
                    "error": f"Missing {', '.join(missing_trade_ctx)} in config. Discover subaccount and save config first."
                  },
                }
              )
              continue

            if not position_state.open:
              updates.append({"id": cid, "status": "DONE", "result": {"ok": True, "flattened": False}})
              continue

            cerr = await ensure_client_ready()
            if cerr or client is None:
              updates.append({"id": cid, "status": "ERROR", "result": {"error": cerr or "SDK client unavailable"}})
              continue

            side = position_state.side
            qty = abs(position_state.qty)
            if side and qty > 0:
              if not _order_guard_ok(now_ms, last_order_submit_ms, int(cfg.get("orderGuardMs", 200))):
                await asyncio.sleep(0.2)
              exit_side_int = _exit_side_int(side)
              await place_market(client, ticker, exit_side_int, qty, owner_addr, subaccount_name, cached_lot_size)
              await cancel_open_orders(client, ticker, owner_addr, subaccount_name)
              last_order_submit_ms = int(time.time() * 1000)

              px = float(last_mid or position_state.entry_price or 0.0) if (last_mid or position_state.entry_price) else None
              pnl = _realized_pnl(side, current_trade_entry_price or position_state.entry_price, px, qty)
              DB_MANAGER.insert_trade_event(
                trade_id=str(uuid.uuid4()),
                ts_ms=now_ms,
                event_type="FLATTEN",
                side=side,
                qty=qty,
                price=px,
                pnl=pnl,
                tag="manual_flatten",
                reason_json=json.dumps({"reason": "manual_flatten_command"}),
                entry_ts=current_trade_entry_ts,
                exit_ts=now_ms,
                entry_price=current_trade_entry_price,
                exit_price=px,
              )
              last_close_ts_ms = now_ms

            updates.append({"id": cid, "status": "DONE", "result": {"ok": True, "flattened": True}})

          elif ctype == "LINK_SIGNER":
            out = await process_link_signer(cfg, c)
            link_status = str((out or {}).get("status") or "").strip().upper()
            linked_now = link_status in ("ACTIVE", "LINKED", "DONE", "LINKED_ALREADY")
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

      # Fast risk/execution loop (1s)
      if now_ms >= next_risk_ms:
        next_risk_ms = now_ms + int(cfg.get("riskLoopIntervalSec", 1)) * 1000

        if trading_enabled is False and position_state.open and has_trade_account_ctx and signer_active:
          cerr = await ensure_client_ready()
          if not cerr and client is not None and position_state.side and position_state.qty > 0:
            if not _order_guard_ok(now_ms, last_order_submit_ms, int(cfg.get("orderGuardMs", 200))):
              await asyncio.sleep(0.2)
            exit_side_int = _exit_side_int(position_state.side)
            await place_market(client, ticker, exit_side_int, position_state.qty, owner_addr, subaccount_name, cached_lot_size)
            await cancel_open_orders(client, ticker, owner_addr, subaccount_name)
            last_order_submit_ms = int(time.time() * 1000)

            px = float(last_mid or position_state.entry_price or 0.0) if (last_mid or position_state.entry_price) else None
            pnl = _realized_pnl(position_state.side, current_trade_entry_price or position_state.entry_price, px, position_state.qty)
            DB_MANAGER.insert_trade_event(
              trade_id=str(uuid.uuid4()),
              ts_ms=now_ms,
              event_type="FLATTEN",
              side=position_state.side,
              qty=position_state.qty,
              price=px,
              pnl=pnl,
              tag="trading_disabled",
              reason_json=json.dumps({"reason": "trading_disabled"}),
              entry_ts=current_trade_entry_ts,
              exit_ts=now_ms,
              entry_price=current_trade_entry_price,
              exit_price=px,
            )
            last_close_ts_ms = now_ms
            last_action = {"type": "AUTO_FLATTEN_TRADING_OFF", "ok": True, "info": None}
          else:
            last_action = {
              "type": "SKIP_CLIENT_UNAVAILABLE",
              "ok": False,
              "info": {"error": cerr or "SDK client unavailable"},
            }

        elif position_state.open and trading_enabled and has_trade_account_ctx and signer_active and last_mid:
          strategy_cfg = _build_strategy_cfg(cfg)
          risk_result = evaluate_risk_exit(
            cfg=strategy_cfg,
            position=position_state,
            mark_price=float(last_mid),
            atr_pct=float(metrics_cache.get("atrPct") or 0.0),
            now_ms=now_ms,
            min_hold_enforced=True,
          )
          if risk_result.should_exit and position_state.side and position_state.qty > 0:
            cerr = await ensure_client_ready()
            if not cerr and client is not None:
              if not _order_guard_ok(now_ms, last_order_submit_ms, int(cfg.get("orderGuardMs", 200))):
                await asyncio.sleep(0.2)

              spread_bps = (
                ((last_ask - last_bid) / last_mid * 10_000.0)
                if (last_ask and last_bid and last_mid and last_mid > 0)
                else 999.0
              )
              exit_side_int = _exit_side_int(position_state.side)
              exec_result = await execute_maker_chase(
                client=client,
                eth_base=eth_base,
                sub_id=sub_id,
                product_id=product_id,
                ticker=ticker,
                sender=owner_addr,
                subaccount=subaccount_name,
                order_side_int=exit_side_int,
                target_qty=position_state.qty,
                lot_size=cached_lot_size,
                tick_size=cached_tick_size,
                last_mid=last_mid,
                last_bid=last_bid,
                last_ask=last_ask,
                quote_cache=ws_quote_cache,
                chase_max_sec=float(cfg.get("exitChaseMaxSec", 5.0)),
                reprice_ms=int(cfg.get("executionRepriceMs", 200)),
                gtd_sec=int(cfg.get("makerOrderGtdSec", 2)),
                last_order_submit_ms=last_order_submit_ms,
                order_guard_ms=int(cfg.get("orderGuardMs", 200)),
                position_mode="exit",
                expected_side=position_state.side,
                reduce_only=True,
                allow_market_safety=True,
              )
              last_order_submit_ms = int(exec_result.get("lastOrderSubmitMs") or last_order_submit_ms)
              _print_chase_attempts("EXIT_RISK", exec_result)
              try:
                last_exit_fill_audit = await fetch_fills_audit(
                  client,
                  sub_id,
                  product_id,
                  limit=20,
                  created_after_ms=int(exec_result.get("startMs") or now_ms) - 2000,
                )
                fills_audit_last20 = await fetch_fills_audit(client, sub_id, product_id, limit=20)
                _print_maker_audit("EXIT_RISK", last_exit_fill_audit or {})
                _print_maker_audit("LAST20", fills_audit_last20 or {})
              except Exception:
                pass
              last_exit_method = "market_safety" if bool(exec_result.get("marketSafetyUsed")) else "maker"
              px = float(last_mid)
              pnl = _realized_pnl(position_state.side, current_trade_entry_price or position_state.entry_price, px, position_state.qty)
              DB_MANAGER.insert_trade_event(
                trade_id=str(uuid.uuid4()),
                ts_ms=now_ms,
                event_type="EXIT",
                side=position_state.side,
                qty=position_state.qty,
                price=px,
                pnl=pnl,
                tag="risk_exit",
                reason_json=json.dumps(
                  {
                    "reason": risk_result.reason,
                    "rule": risk_result.rule,
                    "exitMethod": ("market_safety" if bool(exec_result.get("marketSafetyUsed")) else "maker"),
                  }
                ),
                entry_ts=current_trade_entry_ts,
                exit_ts=now_ms,
                entry_price=current_trade_entry_price,
                exit_price=px,
              )
              last_close_ts_ms = now_ms
              last_action = {
                "type": "RISK_EXIT",
                "ok": True,
                "info": {
                  "reason": risk_result.reason,
                  "rule": risk_result.rule,
                  "execution": {
                    "attempts": int(exec_result.get("attemptCount") or 0),
                    "timedOut": bool(exec_result.get("timedOut")),
                    "marketSafetyUsed": bool(exec_result.get("marketSafetyUsed")),
                    "spreadBps": spread_bps,
                  },
                },
              }
            else:
              last_action = {
                "type": "SKIP_CLIENT_UNAVAILABLE",
                "ok": False,
                "info": {"error": cerr or "SDK client unavailable"},
              }

      # Decision loop (flat) every ~3-5s default
      if (
        not position_state.open
        and trading_enabled
        and has_trade_account_ctx
        and signer_active
        and last_mid
        and now_ms >= next_decision_ms
      ):
        next_decision_ms = now_ms + int(cfg.get("decisionLoopIntervalSec", 4)) * 1000

        ticks = DB_MANAGER.load_ticks(now_ms - (6 * 60 * 60 * 1000), now_ms)
        latest_metric = DB_MANAGER.load_latest_metric(now_ms)
        merged_metric = {**metrics_cache, **latest_metric}

        strategy_cfg = _build_strategy_cfg(cfg)
        signal = make_signal(ticks=ticks, metrics=merged_metric, cfg=strategy_cfg, now_ms=now_ms)

        last_decision_at_ms = now_ms
        last_reason = signal.reason
        last_desired = signal.desired
        last_conf = float(signal.p_up)
        last_regime = signal.regime
        metrics_cache["regime"] = signal.regime
        metrics_cache["atrPct"] = signal.atr_pct

        DB_MANAGER.insert_decision(
          ts_ms=now_ms,
          p_up=signal.p_up,
          desired=signal.desired,
          regime=signal.regime,
          reason=signal.reason,
          horizon_sec=int(cfg.get("predictionHorizonSeconds", 30)),
          features=signal.features,
        )

        max_daily_loss = float(cfg.get("maxDailyLossUsd", 0.0))
        day_start_ms, _ = DB_MANAGER.utc_day_bounds_ms(now_ms)
        realized_today = DB_MANAGER.query_realized_pnl_since(day_start_ms)
        daily_loss_hit = max_daily_loss > 0 and realized_today <= -abs(max_daily_loss)

        # order rate cap
        now_sec = time.time()
        last_order_ts[:] = [x for x in last_order_ts if now_sec - x < 3600]
        can_open = len(last_order_ts) < int(cfg.get("maxOrdersPerHour", 120))

        if daily_loss_hit:
          last_action = {
            "type": "DAILY_LOSS_LIMIT",
            "ok": False,
            "info": {"realizedToday": realized_today, "maxDailyLossUsd": max_daily_loss},
          }
        elif signal.desired in ("LONG", "SHORT") and can_open:
          directional_prob = float(signal.p_up) if signal.desired == "LONG" else (1.0 - float(signal.p_up))
          expected_move_bps = _estimate_expected_move_bps(signal, int(cfg.get("predictionHorizonSeconds", 30)))
          fee_bps = float(cfg.get("feeEstimateBps", 3.0))
          slippage_bps = float(cfg.get("slippageBufferBps", 4.0))
          edge_mult = float(cfg.get("edgeCostMultiplier", 0.0))
          min_expected_move_bps = float(cfg.get("minExpectedMoveBps", 0.0))
          cost_bps = max(0.0, fee_bps) + max(0.0, float(signal.spread_bps)) + max(0.0, slippage_bps)
          required_move_bps = 0.0
          if edge_mult > 0 or min_expected_move_bps > 0:
            required_move_bps = max(max(0.0, min_expected_move_bps), max(0.0, edge_mult) * cost_bps)
          cooldown_after_close_sec = int(cfg.get("cooldownAfterCloseSec", 5))
          cooldown_until_ms = (
            (int(last_close_ts_ms) + cooldown_after_close_sec * 1000)
            if (last_close_ts_ms and cooldown_after_close_sec > 0)
            else None
          )
          in_cooldown = bool(cooldown_until_ms is not None and now_ms < int(cooldown_until_ms))

          emergency_breakout = False
          if in_cooldown:
            emergency_breakout = (
              bool(cfg.get("emergencyBreakoutEnabled", False))
              and signal.regime == "momentum"
              and directional_prob >= float(cfg.get("emergencyBreakoutMinProb", 0.94))
              and signal.atr_pctile >= float(cfg.get("emergencyBreakoutMinAtrPercentile", 0.85))
              and expected_move_bps >= max(required_move_bps, float(cfg.get("emergencyBreakoutMinMoveBps", 35.0)))
              and signal.spread_bps <= float(cfg.get("maxSpreadBpsForTrade", 12.0))
            )

          if in_cooldown and not emergency_breakout:
            last_action = {
              "type": "COOLDOWN_ACTIVE",
              "ok": True,
              "info": {
                "cooldownAfterCloseSec": cooldown_after_close_sec,
                "cooldownUntil": cooldown_until_ms,
                "cooldownRemainingSec": to_countdown_sec(cooldown_until_ms, now_ms),
                "directionalProb": directional_prob,
              },
            }
          elif required_move_bps > 0 and expected_move_bps < required_move_bps:
            last_action = {
              "type": "EDGE_FILTER_BLOCKED",
              "ok": True,
              "info": {
                "expectedMoveBps": expected_move_bps,
                "requiredMoveBps": required_move_bps,
                "costBps": cost_bps,
                "spreadBps": signal.spread_bps,
                "feeEstimateBps": fee_bps,
                "slippageBufferBps": slippage_bps,
                "edgeMultiplier": edge_mult,
                "cooldownBypassed": emergency_breakout,
              },
            }
          else:
            snap = fetch_portfolio_snapshot(eth_base, sub_id)
            avail = _f(snap.get("availableMarginUsd"))
            pv = _f(snap.get("portfolioValueUsd"))

            max_margin = float(cfg.get("maxMarginUsd", 100.0))
            if pv and pv > 0:
              max_margin = min(max_margin, pv * float(cfg.get("maxMarginPct", 25.0)) / 100.0)
            if avail is not None:
              max_margin = min(max_margin, avail)

            confidence = clamp(abs(signal.p_up - 0.5) * 2.0, 0.0, 1.0)
            size_mult = size_liquidity_multiplier(signal.spread_bps, signal.liquidity_score)
            if signal.spread_bps > float(cfg.get("maxSpreadBpsForTrade", 12.0)):
              size_mult = 0.0

            notional = max_margin * float(cfg.get("maxLeverage", 2.0)) * confidence * size_mult
            qty_raw = (notional / float(last_mid)) if last_mid and last_mid > 0 else 0.0
            qty = quantize_qty_to_lot(qty_raw, cached_lot_size)

            if qty > 0:
              cerr = await ensure_client_ready()
              if not cerr and client is not None:
                guard_ms = int(cfg.get("orderGuardMs", 200))
                if not _order_guard_ok(now_ms, last_order_submit_ms, guard_ms):
                  await asyncio.sleep(0.2)

                side_int = _side_to_int(signal.desired)
                exec_result = await execute_maker_chase(
                  client=client,
                  eth_base=eth_base,
                  sub_id=sub_id,
                  product_id=product_id,
                  ticker=ticker,
                  sender=owner_addr,
                  subaccount=subaccount_name,
                  order_side_int=side_int,
                  target_qty=qty,
                  lot_size=cached_lot_size,
                  tick_size=cached_tick_size,
                  last_mid=last_mid,
                  last_bid=last_bid,
                  last_ask=last_ask,
                  quote_cache=ws_quote_cache,
                  chase_max_sec=float(cfg.get("entryChaseMaxSec", 5.0)),
                  reprice_ms=int(cfg.get("executionRepriceMs", 200)),
                  gtd_sec=int(cfg.get("makerOrderGtdSec", 2)),
                  last_order_submit_ms=last_order_submit_ms,
                  order_guard_ms=guard_ms,
                  position_mode="entry",
                  expected_side=signal.desired,
                  reduce_only=False,
                  allow_market_safety=False,
                )
                last_order_submit_ms = int(exec_result.get("lastOrderSubmitMs") or last_order_submit_ms)
                _print_chase_attempts(f"ENTRY_{signal.desired}", exec_result)
                filled = float(exec_result.get("filledQty") or 0.0)
                remain = float(exec_result.get("remainingQty") or 0.0)
                submitted_any = int(exec_result.get("submittedCount") or 0) > 0
                maker_err = "; ".join([str(x) for x in (exec_result.get("errors") or []) if x])[:500]
                used_market_fallback = False

                pos_final = fetch_active_position(eth_base, sub_id, product_id)
                of, sf, szf, _, epf, etsf = parse_position(pos_final)
                opened_qty = abs(float(szf)) if of and sf == signal.desired else 0.0
                try:
                  last_entry_fill_audit = await fetch_fills_audit(
                    client,
                    sub_id,
                    product_id,
                    limit=20,
                    created_after_ms=int(exec_result.get("startMs") or now_ms) - 2000,
                  )
                  fills_audit_last20 = await fetch_fills_audit(client, sub_id, product_id, limit=20)
                  _print_maker_audit("ENTRY", last_entry_fill_audit or {})
                  _print_maker_audit("LAST20", fills_audit_last20 or {})
                  fills_list = (last_entry_fill_audit or {}).get("fills") if isinstance(last_entry_fill_audit, dict) else []
                  if isinstance(fills_list, list) and fills_list and isinstance(fills_list[0], dict):
                    last_entry_fill_info = fills_list[0]
                except Exception:
                  pass

                if opened_qty <= 0:
                  if submitted_any:
                    last_order_ts.append(time.time())
                  last_action = {
                    "type": "SKIP_ENTRY_UNFILLED",
                    "ok": True,
                    "info": {
                      "desired": signal.desired,
                      "qty": qty,
                      "filled": filled,
                      "remain": remain,
                      "preferMaker": True,
                      "marketFallbackAllowed": False,
                      "marketFallbackUsed": False,
                      "directionalProb": directional_prob,
                      "fallbackMinProb": None,
                      "makerError": maker_err or None,
                      "expectedMoveBps": expected_move_bps,
                      "requiredMoveBps": required_move_bps,
                      "chaseAttempts": int(exec_result.get("attemptCount") or 0),
                    },
                  }
                else:
                  entry_px = float(last_mid)
                  if epf and epf > 0:
                    entry_px = epf

                  entry_mode = "maker"
                  if opened_qty > filled > 0:
                    entry_mode = "maker_partial"

                  DB_MANAGER.insert_trade_event(
                    trade_id=str(uuid.uuid4()),
                    ts_ms=now_ms,
                    event_type="ENTRY",
                    side=signal.desired,
                    qty=opened_qty,
                    price=entry_px,
                    pnl=None,
                    tag="model_entry",
                    reason_json=json.dumps(
                      {
                        "reason": signal.reason,
                        "regime": signal.regime,
                        "p_up": signal.p_up,
                        "openThreshold": float(cfg.get("openConfidenceThreshold", 0.65)),
                        "expectedMoveBps": expected_move_bps,
                        "requiredMoveBps": required_move_bps,
                        "costBps": cost_bps,
                        "entryMode": entry_mode,
                        "makerFilledQty": filled,
                        "marketFallbackUsed": False,
                        "cooldownBypassed": emergency_breakout,
                        "entryChaseAttempts": int(exec_result.get("attemptCount") or 0),
                        "entryTimedOut": bool(exec_result.get("timedOut")),
                      }
                    ),
                    entry_ts=etsf or now_ms,
                    entry_price=entry_px,
                  )

                  current_trade_entry_price = entry_px
                  current_trade_entry_ts = etsf or now_ms
                  if submitted_any:
                    last_order_ts.append(time.time())

                  last_action = {
                    "type": f"OPEN_{signal.desired}",
                    "ok": True,
                    "info": {
                      "qty": opened_qty,
                      "qtyRaw": qty_raw,
                      "lotSize": cached_lot_size,
                      "tickSize": cached_tick_size,
                      "confidence": confidence,
                      "sizeMultiplier": size_mult,
                      "expectedMoveBps": expected_move_bps,
                      "requiredMoveBps": required_move_bps,
                      "costBps": cost_bps,
                      "makerFilledQty": filled,
                      "marketFallbackUsed": False,
                      "cooldownBypassed": emergency_breakout,
                      "entryChaseAttempts": int(exec_result.get("attemptCount") or 0),
                    },
                  }
              else:
                last_action = {
                  "type": "SKIP_CLIENT_UNAVAILABLE",
                  "ok": False,
                  "info": {"error": cerr or "SDK client unavailable"},
                }
            else:
              last_action = {
                "type": "SKIP_QTY_BELOW_LOT",
                "ok": False,
                "info": {
                  "qtyRaw": qty_raw,
                  "lotSize": cached_lot_size,
                  "spreadBps": signal.spread_bps,
                  "expectedMoveBps": expected_move_bps,
                  "requiredMoveBps": required_move_bps,
                },
              }
        elif signal.desired in ("LONG", "SHORT") and not can_open:
          last_action = {
            "type": "RATE_LIMITED",
            "ok": False,
            "info": {"maxOrdersPerHour": int(cfg.get("maxOrdersPerHour", 120))},
          }
        else:
          last_action = {"type": "SKIP_NO_SIGNAL", "ok": True, "info": {"desired": signal.desired}}

      # In-position reassessment loop (5-15s default)
      if (
        position_state.open
        and trading_enabled
        and has_trade_account_ctx
        and signer_active
        and last_mid
        and now_ms >= next_reassess_ms
      ):
        next_reassess_ms = now_ms + int(cfg.get("inPositionReassessIntervalSec", 8)) * 1000

        ticks = DB_MANAGER.load_ticks(now_ms - (6 * 60 * 60 * 1000), now_ms)
        latest_metric = DB_MANAGER.load_latest_metric(now_ms)
        merged_metric = {**metrics_cache, **latest_metric}
        strategy_cfg = _build_strategy_cfg(cfg)
        signal = make_signal(ticks=ticks, metrics=merged_metric, cfg=strategy_cfg, now_ms=now_ms)

        last_decision_at_ms = now_ms
        last_reason = signal.reason
        last_desired = signal.desired
        last_conf = float(signal.p_up)
        last_regime = signal.regime

        DB_MANAGER.insert_decision(
          ts_ms=now_ms,
          p_up=signal.p_up,
          desired=signal.desired,
          regime=signal.regime,
          reason=signal.reason,
          horizon_sec=int(cfg.get("predictionHorizonSeconds", 30)),
          features=signal.features,
        )

        close_thr = float(cfg.get("closeConfidenceThreshold", 0.55))
        should_close = should_close_for_confidence(position_state.side or "", signal.p_up, close_thr)

        if should_close and position_state.side and position_state.qty > 0:
          held_sec = (
            max(0, int((now_ms - int(position_state.entry_ts_ms)) / 1000))
            if position_state.entry_ts_ms
            else 0
          )
          if held_sec >= int(cfg.get("minHoldSeconds", 5)):
            cerr = await ensure_client_ready()
            if not cerr and client is not None:
              guard_ms = int(cfg.get("orderGuardMs", 200))
              if not _order_guard_ok(now_ms, last_order_submit_ms, guard_ms):
                await asyncio.sleep(0.2)

              exit_side_int = _exit_side_int(position_state.side)
              exec_result = await execute_maker_chase(
                client=client,
                eth_base=eth_base,
                sub_id=sub_id,
                product_id=product_id,
                ticker=ticker,
                sender=owner_addr,
                subaccount=subaccount_name,
                order_side_int=exit_side_int,
                target_qty=position_state.qty,
                lot_size=cached_lot_size,
                tick_size=cached_tick_size,
                last_mid=last_mid,
                last_bid=last_bid,
                last_ask=last_ask,
                quote_cache=ws_quote_cache,
                chase_max_sec=float(cfg.get("exitChaseMaxSec", 5.0)),
                reprice_ms=int(cfg.get("executionRepriceMs", 200)),
                gtd_sec=int(cfg.get("makerOrderGtdSec", 2)),
                last_order_submit_ms=last_order_submit_ms,
                order_guard_ms=guard_ms,
                position_mode="exit",
                expected_side=position_state.side,
                reduce_only=True,
                allow_market_safety=True,
              )
              last_order_submit_ms = int(exec_result.get("lastOrderSubmitMs") or last_order_submit_ms)
              _print_chase_attempts("EXIT_CONFIDENCE", exec_result)
              last_order_ts.append(time.time())
              try:
                last_exit_fill_audit = await fetch_fills_audit(
                  client,
                  sub_id,
                  product_id,
                  limit=20,
                  created_after_ms=int(exec_result.get("startMs") or now_ms) - 2000,
                )
                fills_audit_last20 = await fetch_fills_audit(client, sub_id, product_id, limit=20)
                _print_maker_audit("EXIT_CONFIDENCE", last_exit_fill_audit or {})
                _print_maker_audit("LAST20", fills_audit_last20 or {})
              except Exception:
                pass
              last_exit_method = "market_safety" if bool(exec_result.get("marketSafetyUsed")) else "maker"

              px = float(last_mid)
              pnl = _realized_pnl(position_state.side, current_trade_entry_price or position_state.entry_price, px, position_state.qty)
              DB_MANAGER.insert_trade_event(
                trade_id=str(uuid.uuid4()),
                ts_ms=now_ms,
                event_type="EXIT",
                side=position_state.side,
                qty=position_state.qty,
                price=px,
                pnl=pnl,
                tag="close_confidence",
                reason_json=json.dumps(
                  {
                    "reason": "close_confidence",
                    "p_up": signal.p_up,
                    "closeThreshold": close_thr,
                    "regime": signal.regime,
                    "exitMethod": ("market_safety" if bool(exec_result.get("marketSafetyUsed")) else "maker"),
                  }
                ),
                entry_ts=current_trade_entry_ts,
                exit_ts=now_ms,
                entry_price=current_trade_entry_price,
                exit_price=px,
              )
              last_close_ts_ms = now_ms
              last_action = {
                "type": "CLOSE_CONFIDENCE",
                "ok": True,
                "info": {
                  "pUp": signal.p_up,
                  "closeThreshold": close_thr,
                  "execution": {
                    "attempts": int(exec_result.get("attemptCount") or 0),
                    "timedOut": bool(exec_result.get("timedOut")),
                    "marketSafetyUsed": bool(exec_result.get("marketSafetyUsed")),
                  },
                },
              }
            else:
              last_action = {
                "type": "SKIP_CLIENT_UNAVAILABLE",
                "ok": False,
                "info": {"error": cerr or "SDK client unavailable"},
              }
          else:
            last_action = {
              "type": "HOLD_MIN_HOLD",
              "ok": True,
              "info": {"heldSec": held_sec, "minHoldSeconds": int(cfg.get("minHoldSeconds", 5))},
            }
        else:
          last_action = {
            "type": "HOLD_REASSESS",
            "ok": True,
            "info": {
              "side": position_state.side,
              "pUp": signal.p_up,
              "closeThreshold": close_thr,
            },
          }

      if next_decision_ms <= 0:
        next_decision_ms = now_ms
      if next_reassess_ms <= 0:
        next_reassess_ms = now_ms
      if next_metrics_ms <= 0:
        next_metrics_ms = now_ms
      if next_risk_ms <= 0:
        next_risk_ms = now_ms

      min_hold_until = (
        int(position_state.entry_ts_ms) + int(cfg.get("minHoldSeconds", 5)) * 1000
        if position_state.entry_ts_ms
        else None
      )
      max_hold_until = (
        int(position_state.entry_ts_ms) + int(cfg.get("maxHoldSeconds", 7200)) * 1000
        if position_state.entry_ts_ms
        else None
      )
      cooldown_until = (
        int(last_close_ts_ms) + int(cfg.get("cooldownAfterCloseSec", 5)) * 1000
        if (last_close_ts_ms and int(cfg.get("cooldownAfterCloseSec", 5)) > 0)
        else None
      )

      human_reason, raw_reason = explain_agent_reason(last_reason, last_desired, float(last_conf))

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
          "ingestIntervalSec": float(cfg.get("ingestIntervalSec", 0.5)),
          "riskLoopIntervalSec": int(cfg.get("riskLoopIntervalSec", 1)),
          "decisionLoopIntervalSec": int(cfg.get("decisionLoopIntervalSec", 4)),
          "inPositionReassessIntervalSec": int(cfg.get("inPositionReassessIntervalSec", 8)),
          "metricsLoopIntervalSec": int(cfg.get("metricsLoopIntervalSec", 45)),
          "reassessIntervalSec": int(cfg.get("inPositionReassessIntervalSec", 8)),
          "predictionHorizonSeconds": int(cfg.get("predictionHorizonSeconds", 30)),
          "minHoldSeconds": int(cfg.get("minHoldSeconds", 5)),
          "maxHoldSeconds": int(cfg.get("maxHoldSeconds", 7200)),
          "maxLeverage": float(cfg.get("maxLeverage", 2)),
          "maxMarginUsd": float(cfg.get("maxMarginUsd", 100)),
          "maxMarginPct": float(cfg.get("maxMarginPct", 25.0)),
          "confidenceThreshold": float(cfg.get("openConfidenceThreshold", 0.65)),
          "openConfidenceThreshold": float(cfg.get("openConfidenceThreshold", 0.65)),
          "closeConfidenceThreshold": float(cfg.get("closeConfidenceThreshold", 0.55)),
          "feeEstimateBps": float(cfg.get("feeEstimateBps", 3.0)),
          "slippageBufferBps": float(cfg.get("slippageBufferBps", 4.0)),
          "minExpectedMoveBps": float(cfg.get("minExpectedMoveBps", 0.0)),
          "edgeCostMultiplier": float(cfg.get("edgeCostMultiplier", 0.0)),
          "entryMakerPreferred": True,
          "entryMarketFallbackEnabled": False,
          "entryMarketFallbackMinProb": float(cfg.get("entryMarketFallbackMinProb", 0.90)),
          "cooldownAfterCloseSec": int(cfg.get("cooldownAfterCloseSec", 5)),
          "emergencyBreakoutEnabled": bool(cfg.get("emergencyBreakoutEnabled", False)),
          "emergencyBreakoutMinProb": float(cfg.get("emergencyBreakoutMinProb", 0.94)),
          "emergencyBreakoutMinMoveBps": float(cfg.get("emergencyBreakoutMinMoveBps", 35.0)),
          "emergencyBreakoutMinAtrPercentile": float(cfg.get("emergencyBreakoutMinAtrPercentile", 0.85)),
          "entryChaseMaxSec": float(cfg.get("entryChaseMaxSec", 5.0)),
          "exitChaseMaxSec": float(cfg.get("exitChaseMaxSec", 5.0)),
          "executionRepriceMs": int(cfg.get("executionRepriceMs", 200)),
          "makerOrderGtdSec": int(cfg.get("makerOrderGtdSec", 2)),
          "stopLossPct": _to_opt_float(cfg.get("stopLossPct")),
          "stopLossAtrMult": _to_opt_float(cfg.get("stopLossAtrMult")),
          "takeProfitPct": _to_opt_float(cfg.get("takeProfitPct")),
          "takeProfitAtrMult": _to_opt_float(cfg.get("takeProfitAtrMult")),
          "trailingStopPct": _to_opt_float(cfg.get("trailingStopPct")),
          "maxDailyLossUsd": float(cfg.get("maxDailyLossUsd", 0.0)),
        },
        "market": {
          "ticker": ticker,
          "price": last_mid,
          "oraclePrice": last_oracle,
          "bestBid": (_f(ws_quote_cache.snapshot().get("bestBid")) or last_bid),
          "bestAsk": (_f(ws_quote_cache.snapshot().get("bestAsk")) or last_ask),
        },
        "account": {
          "owner": owner_addr_raw,
          "subaccountId": sub_id,
          "subaccountName": subaccount_name,
        },
        "position": {
          "open": bool(position_state.open),
          "side": position_state.side,
          "size": position_state.qty,
          "entryPrice": position_state.entry_price,
          "entryAt": position_state.entry_ts_ms,
          "ageSec": (
            max(0, int((now_ms - int(position_state.entry_ts_ms)) / 1000))
            if position_state.entry_ts_ms
            else None
          ),
          "unrealizedPnl": pos_upnl,
          "updatedAt": int(time.time() * 1000),
        },
        "agent": {
          "desired": last_desired,
          "confidence": float(last_conf),
          "confidenceBand": confidence_band(float(last_conf)),
          "regime": last_regime,
          "reason": raw_reason,
          "reasonHuman": human_reason,
          "reasonRaw": raw_reason,
          "lastDecisionAt": last_decision_at_ms,
          "decisionHorizonSeconds": int(cfg.get("predictionHorizonSeconds", 30)),
          "decisionIntervalSeconds": int(cfg.get("decisionLoopIntervalSec", 4)),
          "inPositionIntervalSeconds": int(cfg.get("inPositionReassessIntervalSec", 8)),
          "nextReassessAt": next_reassess_ms if position_state.open else None,
          "minHoldUntil": min_hold_until,
          "maxHoldUntil": max_hold_until,
        },
        "trading": {
          "enabled": trading_enabled,
          "running": trading_enabled,
          "positionOpen": bool(position_state.open),
          "entryAt": position_state.entry_ts_ms,
          "initialHoldEndsAt": min_hold_until,
          "nextReassessAt": next_reassess_ms if position_state.open else None,
          "maxHoldEndsAt": max_hold_until,
          "cooldownUntil": cooldown_until,
          "nextDecisionAt": None if position_state.open else next_decision_ms,
          "countdowns": {
            "initialHoldEndsInSec": to_countdown_sec(min_hold_until, now_ms),
            "nextReassessInSec": to_countdown_sec(next_reassess_ms if position_state.open else None, now_ms),
            "maxHoldEndsInSec": to_countdown_sec(max_hold_until, now_ms),
            "cooldownEndsInSec": to_countdown_sec(cooldown_until if not position_state.open else None, now_ms),
            "nextDecisionInSec": to_countdown_sec(None if position_state.open else next_decision_ms, now_ms),
          },
        },
        "ingestion": {
          "running": bool(ingest_enabled),
          "lastTickAt": last_tick_ts_ms,
          "ticksCount": DB_MANAGER.query_ingestion_stats().get("ticksCollected", 0),
        },
        "execution": {
          "makerOnlyEntry": True,
          "makerFirstExitWithMarketSafety": True,
          "exitMarketSafetyAfterSec": float(cfg.get("exitChaseMaxSec", 5.0)),
          "quoteSource": "ws_bookdepth" if bool(ws_quote_cache.snapshot().get("subscribed")) else "rest",
          "wsQuotes": ws_quote_cache.snapshot(),
          "lastEntryFillAudit": last_entry_fill_audit,
          "lastEntryFill": last_entry_fill_info,
          "lastExitFillAudit": last_exit_fill_audit,
          "lastExitMethod": last_exit_method,
          "fillsAuditLast20": fills_audit_last20,
        },
        "db": {
          "dir": DB_DIR,
          "todayPath": DB_MANAGER.today_path(),
          "sizeBytes": DB_MANAGER.folder_size_bytes(),
          "maxBytes": int(DB_MAX_GB * 1024 * 1024 * 1024),
          "targetBytes": int(DB_TARGET_GB * 1024 * 1024 * 1024),
        },
        "lastAction": last_action,
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
        "lastAction": {"type": "ERROR", "ok": False, "info": {"error": str(e)}},
      }

    with STATUS_LOCK:
      LATEST_STATUS = status_payload

    elapsed = time.time() - started
    await asyncio.sleep(max(0.12, 1.0 - elapsed))


if __name__ == "__main__":
  asyncio.run(main())
