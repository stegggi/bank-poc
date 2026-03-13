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
from pathlib import Path
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
  RegimeDecision,
  StrategyConfig,
  clamp,
  desired_position_from_regime,
  evaluate_risk_exit,
  should_exit_for_regime,
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
WS_STALE_RECONNECT_MS = int(os.environ.get("UC5_WS_STALE_RECONNECT_MS", "15000"))
BOT_DIR = Path(__file__).resolve().parent
NODE_BIN = os.environ.get("UC5_NODE_BIN", "node")
REGIME_RUNNER_PATH = str(BOT_DIR / "regime_runner.mjs")
BOT_VERSION = "uc5-bot/2.0 (regime-node+maker-chase+ws-quotes+daily-db)"

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
    "regimeLookbackSeconds": 1800,
    "regimeBarSeconds": 1,
    "regimeSampleEverySec": 12,
    "trendHalfLifeMinSec": 450,
    "trendEntryStrength": 0.70,
    "flipCooldownSec": 15,
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
    "exitOnRegimeEnd": True,
    "regimeExitEnabled": False,
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
    "entryChaseMaxSec": 10.0,
    "exitChaseMaxSec": 5.0,
    "executionRepriceMs": 350,
    "makerOrderGtdSec": 2,
    "makerMinRestMs": 700,
    "makerReplaceOnlyOnTouchMove": True,
    "makerImproveOneTickOnWideSpread": True,
    "makerImproveMinSpreadTicks": 3.0,
    "entryMinFillRatio": 0.50,
    "stopLossPct": 0.003,
    "stopLossAtrMult": None,
    "atrStopLossConfirmSec": 120,
    "takeProfitPct": 0.006,
    "takeProfitAtrMult": None,
    "trailingStopPct": None,
    "maxDailyLossUsd": 0.0,
    "tapeCvdEnabled": False,
    "fundingRateLimitPct": 0.0,
    "maxDailyTrades": 0,
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


def _to_opt_bool(v: Any) -> Optional[bool]:
  if v is None:
    return None
  if isinstance(v, bool):
    return v
  if isinstance(v, (int, float)):
    return bool(v)
  if isinstance(v, str):
    txt = v.strip().lower()
    if txt in ("true", "1", "yes", "on"):
      return True
    if txt in ("false", "0", "no", "off"):
      return False
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
  base["regimeLookbackSeconds"] = clamp(_to_int(base.get("regimeLookbackSeconds", 1800), 1800), 60, 86400)
  base["regimeBarSeconds"] = clamp(_to_int(base.get("regimeBarSeconds", 1), 1), 1, 60)
  base["regimeSampleEverySec"] = clamp(_to_int(base.get("regimeSampleEverySec", max(12, int(base["regimeBarSeconds"]))), max(12, int(base["regimeBarSeconds"]))), 1, 300)
  base["trendHalfLifeMinSec"] = clamp(_to_int(base.get("trendHalfLifeMinSec", 450), 450), 60, 7200)
  base["trendEntryStrength"] = clamp(_to_float(base.get("trendEntryStrength", 0.70), 0.70), 0.5, 0.99)
  legacy_flip_cooldown = _to_int(base.get("cooldownAfterCloseSec", 15), 15)
  base["flipCooldownSec"] = clamp(_to_int(base.get("flipCooldownSec", legacy_flip_cooldown), legacy_flip_cooldown), 0, 600)
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

  base["minHoldSeconds"] = clamp(_to_int(base.get("minHoldSeconds", 5), 5), 0, 259200)
  base["maxHoldSeconds"] = clamp(_to_int(base.get("maxHoldSeconds", 7200), 7200), base["minHoldSeconds"], 259200)
  base["exitOnRegimeEnd"] = bool(base.get("exitOnRegimeEnd", True))
  base["regimeExitEnabled"] = bool(base.get("regimeExitEnabled", False))

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
  base["entryChaseMaxSec"] = clamp(_to_float(base.get("entryChaseMaxSec", 10.0), 10.0), 0.5, 30.0)
  base["exitChaseMaxSec"] = clamp(_to_float(base.get("exitChaseMaxSec", 5.0), 5.0), 0.5, 30.0)
  base["executionRepriceMs"] = clamp(_to_int(base.get("executionRepriceMs", 350), 350), 100, 2000)
  base["makerOrderGtdSec"] = clamp(_to_int(base.get("makerOrderGtdSec", 2), 2), 1, 10)
  base["makerMinRestMs"] = clamp(_to_int(base.get("makerMinRestMs", 700), 700), 100, 5000)
  base["makerReplaceOnlyOnTouchMove"] = bool(base.get("makerReplaceOnlyOnTouchMove", True))
  base["makerImproveOneTickOnWideSpread"] = bool(base.get("makerImproveOneTickOnWideSpread", True))
  base["makerImproveMinSpreadTicks"] = clamp(_to_float(base.get("makerImproveMinSpreadTicks", 3.0), 3.0), 1.0, 20.0)
  base["entryMinFillRatio"] = clamp(_to_float(base.get("entryMinFillRatio", 0.50), 0.50), 0.1, 1.0)

  base["stopLossPct"] = _to_opt_float(base.get("stopLossPct"))
  base["stopLossAtrMult"] = _to_opt_float(base.get("stopLossAtrMult"))
  base["atrStopLossConfirmSec"] = clamp(_to_int(base.get("atrStopLossConfirmSec", 120), 120), 0, 900)
  base["takeProfitPct"] = _to_opt_float(base.get("takeProfitPct"))
  base["takeProfitAtrMult"] = _to_opt_float(base.get("takeProfitAtrMult"))
  base["trailingStopPct"] = _to_opt_float(base.get("trailingStopPct"))
  base["maxDailyLossUsd"] = max(0.0, _to_float(base.get("maxDailyLossUsd", 0.0), 0.0))
  base["fundingRateLimitPct"] = clamp(_to_float(base.get("fundingRateLimitPct", 0.0), 0.0), 0.0, 1.0)
  base["maxDailyTrades"] = max(0, int(_to_float(base.get("maxDailyTrades", 0), 0.0)))

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


STATUS_LOCK = threading.Lock()


def _safe_call(default: Any, fn, *args, **kwargs) -> Any:
  try:
    return fn(*args, **kwargs)
  except Exception:
    return default


def _runtime_status_defaults(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
  c = cfg if isinstance(cfg, dict) else get_runtime_config()
  return {
    "ingestionEnabled": bool(c.get("ingestionEnabled", True)),
    "tradingEnabled": bool(c.get("tradingEnabled", True)),
    "riskLoopIntervalSec": int(c.get("riskLoopIntervalSec", 1)),
    "decisionLoopIntervalSec": int(c.get("decisionLoopIntervalSec", 4)),
    "inPositionReassessIntervalSec": int(c.get("inPositionReassessIntervalSec", 8)),
    "metricsLoopIntervalSec": int(c.get("metricsLoopIntervalSec", 45)),
    "reassessIntervalSec": int(c.get("inPositionReassessIntervalSec", 8)),
    "minHoldSeconds": int(c.get("minHoldSeconds", 5)),
    "maxHoldSeconds": int(c.get("maxHoldSeconds", 7200)),
    "trendEntryStrength": float(c.get("trendEntryStrength", 0.70)),
    "stopLossPct": _to_opt_float(c.get("stopLossPct")),
    "stopLossAtrMult": _to_opt_float(c.get("stopLossAtrMult")),
    "atrStopLossConfirmSec": int(c.get("atrStopLossConfirmSec", 120)),
    "takeProfitPct": _to_opt_float(c.get("takeProfitPct")),
    "takeProfitAtrMult": _to_opt_float(c.get("takeProfitAtrMult")),
    "trailingStopPct": _to_opt_float(c.get("trailingStopPct")),
    "maxDailyTrades": int(c.get("maxDailyTrades", 0)),
  }


def _position_status_defaults(now_ms: Optional[int] = None) -> Dict[str, Any]:
  ts = int(now_ms or int(time.time() * 1000))
  return {
    "open": False,
    "side": None,
    "size": 0.0,
    "entryPrice": None,
    "entryAt": None,
    "ageSec": None,
    "unrealizedPnl": 0.0,
    "atrPct": 0.0,
    "liveAtrPct": 0.0,
    "entryAtrPct": None,
    "fixedStopPct": None,
    "fixedTakePct": None,
    "fixedStopPrice": None,
    "fixedTakePrice": None,
    "atrStopLossDebounceActive": False,
    "atrStopLossConfirmSec": 120,
    "atrStopLossBreachSec": None,
    "atrStopLossConfirmRemainingSec": None,
    "updatedAt": ts,
  }


def _status_payload_base(message: str, alive: bool = True, cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
  c = cfg if isinstance(cfg, dict) else get_runtime_config()
  now_ms = int(time.time() * 1000)
  return {
    "updatedAt": now_ms,
    "bot": {
      "alive": bool(alive),
      "lastLoopAt": now_ms,
      "message": str(message),
      "version": BOT_VERSION,
    },
    "runtime": _runtime_status_defaults(c),
    "market": {
      "ticker": str(c.get("ticker", "BTCUSD")),
      "price": None,
      "oraclePrice": None,
      "bestBid": None,
      "bestAsk": None,
    },
    "account": {
      "owner": str(c.get("ownerAddress") or ""),
      "subaccountId": str(c.get("subaccountId") or ""),
      "subaccountName": str(c.get("subaccountName") or ""),
    },
    "position": _position_status_defaults(now_ms),
    "agent": {},
    "trading": {
      "enabled": bool(c.get("tradingEnabled", True)),
      "running": False,
      "positionOpen": False,
      "entryAt": None,
      "initialHoldEndsAt": None,
      "nextReassessAt": None,
      "maxHoldEndsAt": None,
      "cooldownUntil": None,
      "nextDecisionAt": None,
      "tradesToday": 0,
      "maxDailyTrades": int(c.get("maxDailyTrades", 0)),
      "countdowns": {
        "initialHoldEndsInSec": None,
        "nextReassessInSec": None,
        "maxHoldEndsInSec": None,
        "cooldownEndsInSec": None,
        "nextDecisionInSec": None,
      },
    },
    "ingestion": {"running": bool(c.get("ingestionEnabled", True)), "lastTickAt": None, "ticksCount": 0},
    "execution": {},
    "db": {
      "dir": DB_DIR,
      "todayPath": _safe_call("", DB_MANAGER.today_path),
      "sizeBytes": 0,
      "maxBytes": int(DB_MAX_GB * 1024 * 1024 * 1024),
      "targetBytes": int(DB_TARGET_GB * 1024 * 1024 * 1024),
    },
    "lastAction": None,
  }


LATEST_STATUS: Dict[str, Any] = _status_payload_base("starting", alive=False)


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


def explain_agent_reason(raw_reason: str, desired: str, conf: float, regime_state: str, regime_direction: Optional[str]) -> Tuple[str, str]:
  strength_pct = int(clamp(conf, 0.0, 1.0) * 100)
  band = "High" if conf >= 0.75 else ("Medium" if conf >= 0.6 else "Low")
  if regime_state == "TREND":
    human = f"{band} trend strength ({strength_pct}%). Regime is trending {str(regime_direction or '').lower() or 'unknown'}."
  elif regime_state == "RANGE":
    human = f"{band} range strength ({strength_pct}%). Regime is non-trending."
  else:
    human = f"{band} regime strength ({strength_pct}%). Regime is unknown."
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
      body = json.dumps(obj, default=_json_safe).encode("utf-8")
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
      stats = _safe_call({}, DB_MANAGER.query_ingestion_stats)
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
      summary = _safe_call(
        {
          "totalTrades": 0,
          "winRate": 0.0,
          "avgWin": 0.0,
          "avgLoss": 0.0,
          "realizedPnlTotal": 0.0,
          "realizedPnlToday": 0.0,
          "closedByConfidence": 0,
          "closedByRegimeEnd": 0,
          "closedByRegimeFlip": 0,
          "closedByRiskLoop": 0,
          "closedByOther": 0,
        },
        DB_MANAGER.query_trades_summary,
      )
      used = _f(snap.get("usedMarginUsd")) or 0.0
      pv = _f(snap.get("portfolioValueUsd"))
      used_pct = ((used / pv) * 100.0) if pv and pv > 0 else (0.0 if used == 0 else None)
      unrealized = _f(s.get("position", {}).get("unrealizedPnl"))
      # Write portfolio start value on first observation (persisted across restarts).
      if pv and pv > 0 and not DB_MANAGER.model_get("portfolio_start_value"):
        DB_MANAGER.model_set("portfolio_start_value", str(pv))
        DB_MANAGER.model_set("portfolio_start_ts", str(int(time.time() * 1000)))
      start_value_raw = DB_MANAGER.model_get("portfolio_start_value")
      start_ts_raw = DB_MANAGER.model_get("portfolio_start_ts")
      return self._send_json(
        200,
        {
          "updatedAt": int(time.time() * 1000),
          **snap,
          "usedMarginPct": used_pct,
          "unrealizedPnl": 0.0 if unrealized is None else unrealized,
          "realizedPnlToday": float(summary.get("realizedPnlToday") or 0.0),
          "realizedPnlTotal": float(summary.get("realizedPnlTotal") or 0.0),
          "startPortfolioValueUsd": _f(start_value_raw),
          "startPortfolioAt": int(start_ts_raw) if start_ts_raw else None,
        },
      )

    if path.startswith("/uc5/trades/summary") or path.startswith("/trades-summary"):
      return self._send_json(
        200,
        _safe_call(
          {
            "totalTrades": 0,
            "winRate": 0.0,
            "avgWin": 0.0,
            "avgLoss": 0.0,
            "realizedPnlTotal": 0.0,
            "realizedPnlToday": 0.0,
            "closedByConfidence": 0,
            "closedByRegimeEnd": 0,
            "closedByRegimeFlip": 0,
            "closedByRiskLoop": 0,
            "closedByOther": 0,
          },
          DB_MANAGER.query_trades_summary,
        ),
      )

    if path.startswith("/uc5/trades"):
      limit = max(1, min(100, int((qs.get("limit") or ["10"])[0])))
      offset = max(0, int((qs.get("offset") or ["0"])[0]))
      trades = DB_MANAGER.query_trades_list(limit=limit, offset=offset)
      total = DB_MANAGER.query_trades_count()
      return self._send_json(200, {"trades": trades, "total": total, "limit": limit, "offset": offset})

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

  entry_price = (
      _f(pos.get("entryPrice"))
      or _f(pos.get("avgEntryPrice"))
      or _f(pos.get("averageEntryPrice"))
      or _f(pos.get("entry_price"))
      or _f(pos.get("avg_entry_price"))
      or _f(pos.get("averageOpenPrice"))
      or _f(pos.get("avgOpenPrice"))
      or _f(pos.get("entryPx"))
      or _f(pos.get("entry_px"))
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

  # Ethereal validates GTD against signedAt; give expiry extra headroom to absorb signing/network delay.
  def _build_variants(extra_buffer_s: int = 0) -> List[Dict[str, Any]]:
    base_gtd = max(1, int(gtd_sec))
    now_s = int(time.time())
    expires_at_s = now_s + base_gtd + 2 + max(0, int(extra_buffer_s))
    expires_at_ms = expires_at_s * 1000
    return [
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
    return await _try_create_order(client, _build_variants())
  except Exception as first_error:
    err = str(first_error or "")
    if (
      "InvalidExpireTime" in err
      or ("expiresAt" in err and "signedAt" in err and "greater than" in err)
    ):
      return await _try_create_order(client, _build_variants(extra_buffer_s=5))
    if (
      ("401" in err or "Unauthorized" in err)
      and BOT_SIGNER_ADDRESS
      and BOT_SIGNER_ADDRESS.lower() != str(sender or "").lower()
    ):
      signer_variants = []
      for v in _build_variants():
        cp = dict(v)
        cp["sender"] = BOT_SIGNER_ADDRESS
        signer_variants.append(cp)
      try:
        return await _try_create_order(client, signer_variants)
      except Exception as signer_error:
        signer_err = str(signer_error or "")
        if (
          "InvalidExpireTime" in signer_err
          or ("expiresAt" in signer_err and "signedAt" in signer_err and "greater than" in signer_err)
        ):
          signer_retry_variants = []
          for v in _build_variants(extra_buffer_s=5):
            cp = dict(v)
            cp["sender"] = BOT_SIGNER_ADDRESS
            signer_retry_variants.append(cp)
          return await _try_create_order(client, signer_retry_variants)
        raise
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
      try:
        out = obj.model_dump(by_alias=True, mode="json")
      except TypeError:
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


def _json_safe(value: Any) -> Any:
  if value is None or isinstance(value, (str, int, float, bool)):
    return value
  if isinstance(value, dict):
    return {str(k): _json_safe(v) for k, v in value.items()}
  if isinstance(value, (list, tuple)):
    return [_json_safe(v) for v in value]
  if hasattr(value, "value"):
    try:
      return _json_safe(getattr(value, "value"))
    except Exception:
      pass
  return str(value)


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
    self.restart_count = 0
    self.last_restart_ms: Optional[int] = None
    self.last_restart_reason: Optional[str] = None

  def set_product(self, product_id: str) -> None:
    with self._lock:
      self.product_id = str(product_id or "")
      self.subscribed = False

  def set_conn(self, connected: bool) -> None:
    with self._lock:
      self.connected = bool(connected)
      if not connected:
        self.subscribed = False

  def set_error(self, err: Optional[str]) -> None:
    with self._lock:
      self.last_error = str(err) if err else None

  def mark_restart(self, reason: Optional[str]) -> None:
    with self._lock:
      self.restart_count += 1
      self.last_restart_ms = int(time.time() * 1000)
      self.last_restart_reason = str(reason) if reason else None

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
        "restartCount": self.restart_count,
        "lastRestartMs": self.last_restart_ms,
        "lastRestartReason": self.last_restart_reason,
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
      print(f"[WS_CONNECT] productId={product_id} action=open base={ws_base}")

      async def _on_book(data: Dict[str, Any]) -> None:
        quote_cache.update_book(data)

      ws_client.callbacks["BookDepth"] = [_on_book]
      await ws_client.open(namespaces=["/v1/stream"])
      quote_cache.set_conn(True)
      print(f"[WS_CONNECT] productId={product_id} action=open_ok")
      print(f"[WS_CONNECT] productId={product_id} action=subscribe stream=BookDepth")
      await ws_client.subscribe(stream_type="BookDepth", product_id=product_id)
      print(f"[WS_CONNECT] productId={product_id} action=subscribe_ok stream=BookDepth")
      while True:
        snap = quote_cache.snapshot()
        last_update_ms = _f(snap.get("lastUpdateMs"))
        if last_update_ms is not None and last_update_ms > 0:
          age_ms = int(time.time() * 1000) - int(last_update_ms)
          if age_ms > max(5000, int(WS_STALE_RECONNECT_MS)):
            quote_cache.set_error(f"ws_bookdepth stale ({age_ms}ms) - reconnecting")
            raise RuntimeError(f"WS BookDepth stale for {age_ms}ms")
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
      print(f"[WS_CONNECT] productId={product_id} action=error error={str(e)}")
      await asyncio.sleep(2.0)
    finally:
      if ws_client is not None:
        try:
          await ws_client.close()
        except Exception:
          pass


class NodeRegimeRunner:
  def __init__(self, node_bin: str, runner_path: str) -> None:
    self.node_bin = str(node_bin or "node")
    self.runner_path = str(runner_path)
    self.proc: Optional[asyncio.subprocess.Process] = None
    self._lock = asyncio.Lock()
    self._req_id = 0
    self._stderr_task: Optional[asyncio.Task] = None

  async def ensure_started(self) -> None:
    if self.proc is not None and self.proc.returncode is None:
      return
    if not os.path.exists(self.runner_path):
      raise RuntimeError(f"Missing regime runner: {self.runner_path}")
    self.proc = await asyncio.create_subprocess_exec(
      self.node_bin,
      self.runner_path,
      stdin=asyncio.subprocess.PIPE,
      stdout=asyncio.subprocess.PIPE,
      stderr=asyncio.subprocess.PIPE,
      cwd=os.path.dirname(self.runner_path),
    )
    if self.proc.stderr is not None:
      self._stderr_task = asyncio.create_task(self._drain_stderr())

  async def _drain_stderr(self) -> None:
    assert self.proc is not None
    assert self.proc.stderr is not None
    while True:
      line = await self.proc.stderr.readline()
      if not line:
        return
      msg = line.decode("utf-8", errors="replace").strip()
      if msg:
        print(f"[REGIME_NODE] {msg}")

  async def stop(self) -> None:
    proc = self.proc
    self.proc = None
    if proc is None:
      return
    try:
      proc.terminate()
      await asyncio.wait_for(proc.wait(), timeout=3.0)
    except Exception:
      try:
        proc.kill()
      except Exception:
        pass
    if self._stderr_task is not None:
      self._stderr_task.cancel()
      self._stderr_task = None

  async def evaluate(self, payload: Dict[str, Any], timeout_sec: float = 5.0) -> Dict[str, Any]:
    async with self._lock:
      await self.ensure_started()
      assert self.proc is not None and self.proc.stdin is not None and self.proc.stdout is not None
      self._req_id += 1
      req_id = self._req_id
      req = {"id": req_id, "payload": payload}
      self.proc.stdin.write((json.dumps(req) + "\n").encode("utf-8"))
      await self.proc.stdin.drain()
      try:
        raw_line = await asyncio.wait_for(self.proc.stdout.readline(), timeout=timeout_sec)
      except Exception:
        await self.stop()
        raise
      if not raw_line:
        await self.stop()
        raise RuntimeError("Node regime runner exited without response")
      resp = json.loads(raw_line.decode("utf-8"))
      if int(resp.get("id") or -1) != req_id:
        raise RuntimeError(f"Node regime runner response id mismatch: expected {req_id}, got {resp.get('id')}")
      if not bool(resp.get("ok")):
        raise RuntimeError(str(resp.get("error") or "regime runner error"))
      result = resp.get("result")
      if not isinstance(result, dict):
        raise RuntimeError("regime runner returned invalid result")
      return result


def _maker_touch_price(
  side_int: int,
  bid: Optional[float],
  ask: Optional[float],
  mid: Optional[float],
  tick_size: Optional[float],
  improve_one_tick_on_wide_spread: bool = True,
  improve_min_spread_ticks: float = 3.0,
) -> float:
  b = bid if bid and bid > 0 else None
  a = ask if ask and ask > 0 else None
  tick = float(tick_size or 0.0) if tick_size else 0.0
  if (
    improve_one_tick_on_wide_spread
    and tick > 0
    and b is not None
    and a is not None
    and a > b
  ):
    spread_ticks = (a - b) / tick if tick > 0 else 0.0
    if spread_ticks >= float(improve_min_spread_ticks):
      if side_int == 0:
        improved = b + tick
        if improved < a:
          return quantize_price_to_tick(float(improved), tick_size, side_int, aggressive=False)
      elif side_int == 1:
        improved = a - tick
        if improved > b:
          return quantize_price_to_tick(float(improved), tick_size, side_int, aggressive=False)
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
        "side": _json_safe(r.get("side")),
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
  min_rest_ms: int = 700,
  replace_only_on_touch_move: bool = True,
  improve_one_tick_on_wide_spread: bool = True,
  improve_min_spread_ticks: float = 3.0,
  entry_min_fill_ratio: float = 1.0,
) -> Dict[str, Any]:
  start_ms = int(time.time() * 1000)
  deadline_ms = start_ms + int(max(0.2, chase_max_sec) * 1000)
  qty = quantize_qty_to_lot(target_qty, lot_size)
  attempts: List[Dict[str, Any]] = []
  errors: List[str] = []
  submitted = 0
  replace_count = 0
  cancel_count = 0
  keep_count = 0
  filled = 0.0
  remaining = qty
  market_safety_used = False
  accepted_partial = False
  first_fill_ms: Optional[int] = None
  active_order_price: Optional[float] = None
  active_order_submitted_ms: Optional[int] = None
  active_quote_bid: Optional[float] = None
  active_quote_ask: Optional[float] = None
  last_seen_touch: Optional[Tuple[Optional[float], Optional[float]]] = None

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

    # Refresh fill progress before deciding whether to replace/cancel, so we don't throw away queue priority unnecessarily.
    if active_order_price is not None:
      pos_now = fetch_active_position(eth_base, sub_id, product_id)
      o, s, sz, _, _, _ = parse_position(pos_now)
      abs_sz = abs(float(sz)) if sz is not None else 0.0

      if position_mode == "entry":
        if o and s == expected_side:
          filled = abs_sz
          if first_fill_ms is None and filled > 0:
            first_fill_ms = now_ms
        else:
          filled = 0.0
        remaining = max(0.0, qty - filled)
        if qty > 0 and filled > 0 and (filled / qty) >= float(entry_min_fill_ratio):
          accepted_partial = True
          remaining = 0.0
      else:
        remaining = abs_sz if (o and s == expected_side) else 0.0
        filled = max(0.0, qty - remaining)
        if first_fill_ms is None and filled > 0:
          first_fill_ms = now_ms

      if remaining <= 0:
        break

    limit_px = _maker_touch_price(
      order_side_int,
      bid,
      ask,
      last_mid,
      tick_size,
      improve_one_tick_on_wide_spread=improve_one_tick_on_wide_spread,
      improve_min_spread_ticks=improve_min_spread_ticks,
    )
    touch_now = (bid, ask)
    touch_moved = (last_seen_touch != touch_now)
    last_seen_touch = touch_now

    attempt: Dict[str, Any] = {
      "tsMs": now_ms,
      "price": limit_px,
      "bid": bid,
      "ask": ask,
      "quoteAgeMs": quote_age_ms,
    }
    should_submit = False
    if active_order_price is None:
      should_submit = True
      attempt["action"] = "submit_new"
    else:
      age_ms = now_ms - int(active_order_submitted_ms or now_ms)
      gtd_expiring_soon = age_ms >= max(200, int(gtd_sec * 1000) - max(120, int(reprice_ms)))
      price_changed = abs(float(limit_px) - float(active_order_price)) > 1e-12
      can_replace = age_ms >= int(min_rest_ms)
      should_replace = False
      replace_reason = None
      if gtd_expiring_soon and can_replace:
        should_replace = True
        replace_reason = "gtd_refresh"
      elif price_changed and can_replace:
        if (not replace_only_on_touch_move) or touch_moved:
          should_replace = True
          replace_reason = "touch_move"

      if should_replace:
        try:
          await cancel_open_orders(client, ticker, sender, subaccount)
          cancel_count += 1
          replace_count += 1
          active_order_price = None
          active_order_submitted_ms = None
          attempt["action"] = "replace"
          attempt["replaceReason"] = replace_reason
          should_submit = True
        except Exception as e:
          errors.append(f"cancel:{e}")
          attempt["action"] = "cancel_error"
          attempt["error"] = f"cancel:{e}"
          attempts.append(attempt)
          await asyncio.sleep(min(0.5, max(0.05, reprice_ms / 1000.0)))
          continue
      else:
        keep_count += 1
        attempt["action"] = "keep_resting"
        attempt["activePrice"] = active_order_price
        attempt["activeAgeMs"] = age_ms
        attempt["touchMoved"] = touch_moved
        attempt["filled"] = filled
        attempt["remaining"] = remaining
        attempts.append(attempt)
        sleep_ms = min(int(reprice_ms), max(50, deadline_ms - int(time.time() * 1000)))
        await asyncio.sleep(max(0.05, sleep_ms / 1000.0))
        continue

    if should_submit:
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
        active_order_price = float(limit_px)
        active_order_submitted_ms = last_order_submit_ms
        active_quote_bid = bid
        active_quote_ask = ask
        attempt["submitted"] = True
      except Exception as e:
        err = str(e)
        attempt["submitted"] = False
        attempt["error"] = err
        errors.append(err)
        # A post-only reject is expected sometimes; avoid unnecessary extra cancel spam.
        attempts.append(attempt)
        await asyncio.sleep(min(0.5, max(0.05, reprice_ms / 1000.0)))
        continue

      attempt["activePrice"] = active_order_price
      attempt["filled"] = filled
      attempt["remaining"] = remaining
      attempts.append(attempt)
      sleep_ms = min(int(reprice_ms), max(50, deadline_ms - int(time.time() * 1000)))
      await asyncio.sleep(max(0.05, sleep_ms / 1000.0))

  remaining = quantize_qty_to_lot(max(0.0, remaining), lot_size)
  if active_order_price is not None or remaining > 0:
    try:
      await cancel_open_orders(client, ticker, sender, subaccount)
      cancel_count += 1
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
    "replaceCount": replace_count,
    "cancelCount": cancel_count,
    "keepCount": keep_count,
    "marketSafetyUsed": market_safety_used,
    "acceptedPartial": accepted_partial,
    "partialFillRatio": (float(filled) / float(qty)) if qty > 0 else 0.0,
    "firstFillMs": first_fill_ms,
    "timeToFirstFillMs": ((int(first_fill_ms) - int(start_ms)) if first_fill_ms is not None else None),
    "lastWorkingPrice": active_order_price,
    "lastWorkingQuoteBid": active_quote_bid,
    "lastWorkingQuoteAsk": active_quote_ask,
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


def _funding_gate_blocked(desired: str, cfg: Dict[str, Any], metrics_cache: Dict[str, Any]) -> bool:
  """Return True if the entry should be skipped due to an adverse funding rate."""
  limit = float(cfg.get("fundingRateLimitPct", 0.0))
  if limit <= 0.0:
    return False
  funding = float(metrics_cache.get("funding") or 0.0)
  if desired == "LONG" and funding > limit:
    return True
  if desired == "SHORT" and funding < -limit:
    return True
  return False


def _daily_trades_gate_blocked(cfg: Dict[str, Any], day_start_ms: int) -> bool:
  """Return True if the daily trade cap has been reached."""
  max_trades = int(cfg.get("maxDailyTrades", 0))
  if max_trades <= 0:
    return False
  return DB_MANAGER.query_trade_count_since(day_start_ms) >= max_trades


def _build_strategy_cfg(cfg: Dict[str, Any]) -> StrategyConfig:
  return StrategyConfig(
    trend_entry_strength=float(cfg.get("trendEntryStrength", 0.70)),
    flip_cooldown_sec=int(cfg.get("flipCooldownSec", cfg.get("cooldownAfterCloseSec", 15))),
    min_hold_seconds=int(cfg.get("minHoldSeconds", 5)),
    max_hold_seconds=int(cfg.get("maxHoldSeconds", 7200)),
    stop_loss_pct=_to_opt_float(cfg.get("stopLossPct")),
    stop_loss_atr_mult=_to_opt_float(cfg.get("stopLossAtrMult")),
    take_profit_pct=_to_opt_float(cfg.get("takeProfitPct")),
    take_profit_atr_mult=_to_opt_float(cfg.get("takeProfitAtrMult")),
    trailing_stop_pct=_to_opt_float(cfg.get("trailingStopPct")),
    max_spread_bps_for_trade=float(cfg.get("maxSpreadBpsForTrade", 12.0)),
  )


def _parse_json_object(raw: Any) -> Dict[str, Any]:
  if isinstance(raw, dict):
    return dict(raw)
  if isinstance(raw, str):
    txt = raw.strip()
    if not txt:
      return {}
    try:
      parsed = json.loads(txt)
      if isinstance(parsed, dict):
        return parsed
    except Exception:
      return {}
  return {}


def _extract_entry_risk_from_reason(reason_json: Any) -> Dict[str, Any]:
  payload = _parse_json_object(reason_json)
  return {
    "entry_atr_pct": _f(payload.get("entryAtrPct") or payload.get("entry_atr_pct")),
    "fixed_stop_pct": _f(payload.get("fixedStopPct") or payload.get("fixed_stop_pct")),
    "fixed_take_pct": _f(payload.get("fixedTakePct") or payload.get("fixed_take_pct")),
    "fixed_stop_price": _f(payload.get("fixedStopPrice") or payload.get("fixed_stop_price")),
    "fixed_take_price": _f(payload.get("fixedTakePrice") or payload.get("fixed_take_price")),
    "atr_stop_loss_is_atr": _to_opt_bool(
      payload.get("atrStopLossIsAtr")
      if "atrStopLossIsAtr" in payload
      else payload.get("atr_stop_loss_is_atr")
    ),
  }


def _resolve_risk_pcts_from_entry(cfg: StrategyConfig, entry_atr_pct: Optional[float]) -> Tuple[Optional[float], Optional[float]]:
  atr = float(entry_atr_pct or 0.0)
  stop_pct: Optional[float] = None
  take_pct: Optional[float] = None
  if cfg.stop_loss_pct is not None and float(cfg.stop_loss_pct) > 0:
    stop_pct = float(cfg.stop_loss_pct)
  elif cfg.stop_loss_atr_mult is not None and float(cfg.stop_loss_atr_mult) > 0 and atr > 0:
    stop_pct = float(cfg.stop_loss_atr_mult) * atr

  if cfg.take_profit_pct is not None and float(cfg.take_profit_pct) > 0:
    take_pct = float(cfg.take_profit_pct)
  elif cfg.take_profit_atr_mult is not None and float(cfg.take_profit_atr_mult) > 0 and atr > 0:
    take_pct = float(cfg.take_profit_atr_mult) * atr
  return stop_pct, take_pct


def _ensure_frozen_risk_levels(position: PositionState, cfg: StrategyConfig, live_atr_pct: Optional[float]) -> None:
  if not position.open:
    return
  side = str(position.side or "").upper()
  if side not in ("LONG", "SHORT"):
    return
  entry = _f(position.entry_price)
  if entry is None or entry <= 0:
    return

  if (position.entry_atr_pct is None or float(position.entry_atr_pct or 0.0) <= 0) and (live_atr_pct is not None and float(live_atr_pct) > 0):
    position.entry_atr_pct = float(live_atr_pct)

  stop_pct_from_cfg, take_pct_from_cfg = _resolve_risk_pcts_from_entry(cfg, position.entry_atr_pct)
  existing_stop_pct = _f(position.fixed_stop_pct)
  existing_take_pct = _f(position.fixed_take_pct)
  effective_stop_pct = existing_stop_pct if existing_stop_pct and existing_stop_pct > 0 else stop_pct_from_cfg
  effective_take_pct = existing_take_pct if existing_take_pct and existing_take_pct > 0 else take_pct_from_cfg
  cfg_has_fixed_sl = cfg.stop_loss_pct is not None and float(cfg.stop_loss_pct) > 0
  cfg_has_atr_sl = (
    (not cfg_has_fixed_sl)
    and cfg.stop_loss_atr_mult is not None
    and float(cfg.stop_loss_atr_mult) > 0
    and position.entry_atr_pct is not None
    and float(position.entry_atr_pct) > 0
  )

  if position.fixed_stop_pct is None and effective_stop_pct and effective_stop_pct > 0:
    position.fixed_stop_pct = float(effective_stop_pct)
  if position.fixed_take_pct is None and effective_take_pct and effective_take_pct > 0:
    position.fixed_take_pct = float(effective_take_pct)

  if position.fixed_stop_price is None and effective_stop_pct and effective_stop_pct > 0:
    position.fixed_stop_price = float(entry * (1.0 - effective_stop_pct) if side == "LONG" else entry * (1.0 + effective_stop_pct))
  if position.fixed_take_price is None and effective_take_pct and effective_take_pct > 0:
    position.fixed_take_price = float(entry * (1.0 + effective_take_pct) if side == "LONG" else entry * (1.0 - effective_take_pct))
  if position.stop_loss_is_atr_based is None:
    if existing_stop_pct and stop_pct_from_cfg and stop_pct_from_cfg > 0:
      tol = max(1e-10, abs(float(stop_pct_from_cfg)) * 0.05)
      position.stop_loss_is_atr_based = bool(cfg_has_atr_sl and abs(float(existing_stop_pct) - float(stop_pct_from_cfg)) <= tol)
    elif effective_stop_pct and effective_stop_pct > 0:
      position.stop_loss_is_atr_based = bool(cfg_has_atr_sl)
    else:
      position.stop_loss_is_atr_based = False


def _regime_from_runner_result(result: Dict[str, Any], now_ms: int) -> RegimeDecision:
  state = str(result.get("state") or "UNKNOWN").upper()
  if state not in ("TREND", "RANGE", "UNKNOWN"):
    state = "UNKNOWN"
  direction = str(result.get("direction") or "").upper()
  if direction not in ("UP", "DOWN"):
    direction = None
  diagnostics = result.get("diagnostics") if isinstance(result.get("diagnostics"), dict) else None
  return RegimeDecision(
    state=state,
    direction=direction,
    strength=clamp(float(result.get("strength") or 0.0), 0.0, 1.0),
    reason=str(result.get("reason") or ""),
    ts_ms=int(result.get("ts") or now_ms),
    diagnostics=diagnostics,
  )


async def evaluate_regime(
  regime_runner: NodeRegimeRunner,
  cfg: Dict[str, Any],
  now_ms: int,
) -> Tuple[RegimeDecision, List[Dict[str, Any]]]:
  lookback_seconds = int(cfg.get("regimeLookbackSeconds", 1800))
  bar_seconds = int(cfg.get("regimeBarSeconds", 1))
  sample_every_sec = int(cfg.get("regimeSampleEverySec", max(12, bar_seconds)))
  bars = DB_MANAGER.get_recent_bars(lookback_seconds, bar_seconds, now_ms=now_ms)
  if not bars:
    return (
      RegimeDecision(
        state="UNKNOWN",
        direction=None,
        strength=0.0,
        reason="no bars",
        ts_ms=now_ms,
        diagnostics={
          "failureCode": "no_bars",
          "windowSec": lookback_seconds,
          "barSeconds": bar_seconds,
          "sampleEverySec": sample_every_sec,
          "barsProvided": 0,
          "sampleCount": 0,
        },
      ),
      [],
    )

  result = await regime_runner.evaluate(
    {
      "bars": bars,
      "regimeLookbackSeconds": lookback_seconds,
      "regimeBarSeconds": bar_seconds,
      "regimeSampleEverySec": sample_every_sec,
      "trendHalfLifeMinSec": int(cfg.get("trendHalfLifeMinSec", min(lookback_seconds, 450))),
    }
  )
  return (_regime_from_runner_result(result, now_ms), bars)


async def main():
  global LATEST_STATUS

  DB_MANAGER.run_retention_if_due(force=True)
  start_telemetry_server()

  if not BOT_PRIVKEY:
    raise SystemExit("Missing env UC5_BOT_SIGNER_PRIVATE_KEY (bot signer private key).")

  client: Optional[AsyncRESTClient] = None
  regime_runner = NodeRegimeRunner(NODE_BIN, REGIME_RUNNER_PATH)
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
  last_conf = 0.0
  last_regime_state = "UNKNOWN"
  last_regime_direction: Optional[str] = None
  last_regime_change_ms: Optional[int] = None
  last_regime_diagnostics: Dict[str, Any] = {
    "failureCode": "warming_up",
  }

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
  current_trade_entry_atr_pct: Optional[float] = None
  current_trade_fixed_stop_pct: Optional[float] = None
  current_trade_fixed_take_pct: Optional[float] = None
  current_trade_fixed_stop_price: Optional[float] = None
  current_trade_fixed_take_price: Optional[float] = None
  current_trade_stop_loss_is_atr: Optional[bool] = None
  atr_sl_breach_started_ms: Optional[int] = None
  # Restore entry price from DB in case bot restarted with an open position.
  # Without this, FLATTEN/risk-exit would compute pnl=None on restart.
  try:
    _open_entry = DB_MANAGER.query_last_open_entry()
    if _open_entry:
      current_trade_entry_price = _open_entry.get("entry_price")
      current_trade_entry_ts = _open_entry.get("entry_ts")
      _entry_risk = _extract_entry_risk_from_reason(_open_entry.get("reason_json"))
      current_trade_entry_atr_pct = _entry_risk.get("entry_atr_pct")
      current_trade_fixed_stop_pct = _entry_risk.get("fixed_stop_pct")
      current_trade_fixed_take_pct = _entry_risk.get("fixed_take_pct")
      current_trade_fixed_stop_price = _entry_risk.get("fixed_stop_price")
      current_trade_fixed_take_price = _entry_risk.get("fixed_take_price")
      current_trade_stop_loss_is_atr = _entry_risk.get("atr_stop_loss_is_atr")
  except Exception as _e:
    print(f"[startup] Could not restore entry price from DB: {_e}")
  last_close_ts_ms: Optional[int] = DB_MANAGER.query_last_close_ts()
  last_regime_exit_ts_ms: Optional[int] = None
  last_regime_exit_reason: Optional[str] = None
  last_entry_fill_audit: Optional[Dict[str, Any]] = None
  last_exit_fill_audit: Optional[Dict[str, Any]] = None
  fills_audit_last20: Optional[Dict[str, Any]] = None
  last_entry_fill_info: Optional[Dict[str, Any]] = None
  last_exit_method: Optional[str] = None
  maker_entry_chases = 0
  maker_entry_opened = 0
  maker_entry_partial_accepts = 0
  maker_entry_timeouts = 0
  maker_entry_ttf_ms_samples: List[int] = []

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
          ws_quote_cache.mark_restart("initial_product_subscribe")
          ws_quote_task = asyncio.create_task(_run_ws_book_depth_loop(eth_base, product_id, ws_quote_cache))
        cached_product_id = product_id

      ws_snap = ws_quote_cache.snapshot()
      ws_last_update_ms = _f(ws_snap.get("lastUpdateMs"))
      ws_age_ms = (
        max(0, int(now_ms - int(ws_last_update_ms)))
        if ws_last_update_ms is not None and ws_last_update_ms > 0
        else None
      )
      ws_last_restart_ms = _f(ws_snap.get("lastRestartMs"))
      ws_since_restart_ms = (
        max(0, int(now_ms - int(ws_last_restart_ms)))
        if ws_last_restart_ms is not None and ws_last_restart_ms > 0
        else None
      )
      ws_task_done = bool(ws_quote_task is not None and ws_quote_task.done())
      ws_restart_reason: Optional[str] = None
      if AsyncWSClient is not None:
        if ws_quote_task is None:
          ws_restart_reason = "missing_ws_task"
        elif ws_task_done:
          ws_restart_reason = "ws_task_stopped"
        elif (
          bool(ws_snap.get("connected"))
          and not bool(ws_snap.get("subscribed"))
          and (ws_since_restart_ms is None or ws_since_restart_ms > 5000)
        ):
          ws_restart_reason = "ws_never_subscribed"
        elif (
          bool(ws_snap.get("connected"))
          and bool(ws_snap.get("subscribed"))
          and ws_age_ms is None
          and (ws_since_restart_ms is None or ws_since_restart_ms > max(5000, int(WS_STALE_RECONNECT_MS)))
        ):
          ws_restart_reason = "ws_no_quote_updates"
        elif ws_age_ms is not None and ws_age_ms > max(5000, int(WS_STALE_RECONNECT_MS)):
          ws_restart_reason = f"ws_stale_{ws_age_ms}ms"
        elif not bool(ws_snap.get("connected")) and (ws_age_ms is None or ws_age_ms > 5000):
          ws_restart_reason = "ws_disconnected"
      if ws_restart_reason:
        if ws_quote_task is not None:
          ws_quote_task.cancel()
          try:
            await ws_quote_task
          except asyncio.CancelledError:
            pass
          except Exception:
            pass
        ws_quote_cache = WsQuoteCache()
        ws_quote_cache.set_product(product_id)
        ws_quote_cache.mark_restart(ws_restart_reason)
        print(f"[WS_RECONNECT] productId={product_id} reason={ws_restart_reason}")
        ws_quote_task = asyncio.create_task(_run_ws_book_depth_loop(eth_base, product_id, ws_quote_cache))

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
        signer_active = await asyncio.to_thread(is_linked_signer_active, eth_base, sub_id, configured_signer_addr)
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
        mp = await asyncio.to_thread(fetch_market_price, eth_base, product_id)
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
      pos = await asyncio.to_thread(fetch_active_position, eth_base, sub_id, product_id)
      pos_open, pos_side, pos_size, pos_upnl, pos_entry_price, pos_entry_at_ms = parse_position(pos)
      if pos_open and pos_side:
        position_state.open = True
        position_state.side = pos_side
        position_state.qty = abs(float(pos_size))
        position_state.entry_price = pos_entry_price or position_state.entry_price
        position_state.entry_ts_ms = pos_entry_at_ms or position_state.entry_ts_ms
        # Restore entry price from DB-backed fallback when API doesn't provide it
        if not position_state.entry_price and current_trade_entry_price:
          position_state.entry_price = float(current_trade_entry_price)
        if not position_state.entry_ts_ms and current_trade_entry_ts:
          position_state.entry_ts_ms = int(current_trade_entry_ts)
        if current_trade_entry_atr_pct and not position_state.entry_atr_pct:
          position_state.entry_atr_pct = float(current_trade_entry_atr_pct)
        if current_trade_fixed_stop_pct and not position_state.fixed_stop_pct:
          position_state.fixed_stop_pct = float(current_trade_fixed_stop_pct)
        if current_trade_fixed_take_pct and not position_state.fixed_take_pct:
          position_state.fixed_take_pct = float(current_trade_fixed_take_pct)
        if current_trade_fixed_stop_price and not position_state.fixed_stop_price:
          position_state.fixed_stop_price = float(current_trade_fixed_stop_price)
        if current_trade_fixed_take_price and not position_state.fixed_take_price:
          position_state.fixed_take_price = float(current_trade_fixed_take_price)
        if current_trade_stop_loss_is_atr is not None and position_state.stop_loss_is_atr_based is None:
          position_state.stop_loss_is_atr_based = bool(current_trade_stop_loss_is_atr)
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
        current_trade_entry_atr_pct = None
        current_trade_fixed_stop_pct = None
        current_trade_fixed_take_pct = None
        current_trade_fixed_stop_price = None
        current_trade_fixed_take_price = None
        current_trade_stop_loss_is_atr = None
        atr_sl_breach_started_ms = None
      if was_open and not pos_open:
        last_close_ts_ms = now_ms

      if position_state.open:
        _ensure_frozen_risk_levels(
          position=position_state,
          cfg=_build_strategy_cfg(cfg),
          live_atr_pct=_f(metrics_cache.get("atrPct")),
        )
        current_trade_entry_atr_pct = _f(position_state.entry_atr_pct) or current_trade_entry_atr_pct
        current_trade_fixed_stop_pct = _f(position_state.fixed_stop_pct) or current_trade_fixed_stop_pct
        current_trade_fixed_take_pct = _f(position_state.fixed_take_pct) or current_trade_fixed_take_pct
        current_trade_fixed_stop_price = _f(position_state.fixed_stop_price) or current_trade_fixed_stop_price
        current_trade_fixed_take_price = _f(position_state.fixed_take_price) or current_trade_fixed_take_price
        if position_state.stop_loss_is_atr_based is not None:
          current_trade_stop_loss_is_atr = bool(position_state.stop_loss_is_atr_based)

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

        # ATR computation: 14 × 5-min candles from tick data
        atr_pct = 0.0
        try:
          atr_ticks = DB_MANAGER.load_ticks(now_ms - (75 * 60 * 1000), now_ms)
          if len(atr_ticks) > 10 and last_mid and last_mid > 0:
            bucket_ms = 5 * 60 * 1000
            candles: List[Tuple[float, float]] = []  # (high, low) per bucket
            cur_bucket = None
            cur_hi = 0.0
            cur_lo = float("inf")
            for tk in atr_ticks:
              px = float(tk.get("price") or 0)
              if px <= 0:
                continue
              b = (int(tk["ts_ms"]) // bucket_ms) * bucket_ms
              if cur_bucket is None:
                cur_bucket = b
              if b != cur_bucket:
                if cur_hi > 0 and cur_lo < float("inf"):
                  candles.append((cur_hi, cur_lo))
                cur_bucket = b
                cur_hi = px
                cur_lo = px
              else:
                cur_hi = max(cur_hi, px)
                cur_lo = min(cur_lo, px)
            if cur_hi > 0 and cur_lo < float("inf"):
              candles.append((cur_hi, cur_lo))
            if len(candles) >= 3:
              ranges = [h - l for h, l in candles[-14:]]
              atr_usd = sum(ranges) / len(ranges)
              atr_pct = atr_usd / float(last_mid)
        except Exception:
          pass

        metrics_cache = {
          **pm,
          "atrPct": atr_pct,
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
              atr_sl_breach_started_ms = None

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
            atr_sl_breach_started_ms = None
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
            min_hold_enforced=False,
          )
          atr_sl_confirm_sec = int(cfg.get("atrStopLossConfirmSec", 120))
          allow_risk_exit = bool(risk_result.should_exit and position_state.side and position_state.qty > 0)
          atr_sl_requires_confirm = bool(
            allow_risk_exit
            and risk_result.reason == "stop_loss"
            and position_state.stop_loss_is_atr_based
            and atr_sl_confirm_sec > 0
          )
          if atr_sl_requires_confirm:
            if atr_sl_breach_started_ms is None:
              atr_sl_breach_started_ms = now_ms
            breached_sec = max(0, int((now_ms - int(atr_sl_breach_started_ms)) / 1000))
            remaining_sec = max(0, int(atr_sl_confirm_sec - breached_sec))
            if breached_sec < atr_sl_confirm_sec:
              allow_risk_exit = False
              last_action = {
                "type": "RISK_WAIT_ATR_SL_CONFIRM",
                "ok": True,
                "info": {
                  "rule": risk_result.rule,
                  "reason": risk_result.reason,
                  "breachSec": breached_sec,
                  "confirmSec": atr_sl_confirm_sec,
                  "remainingSec": remaining_sec,
                },
              }
          else:
            atr_sl_breach_started_ms = None

          if allow_risk_exit:
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
                reprice_ms=int(cfg.get("executionRepriceMs", 350)),
                gtd_sec=int(cfg.get("makerOrderGtdSec", 2)),
                last_order_submit_ms=last_order_submit_ms,
                order_guard_ms=int(cfg.get("orderGuardMs", 200)),
                position_mode="exit",
                expected_side=position_state.side,
                reduce_only=True,
                allow_market_safety=True,
                min_rest_ms=int(cfg.get("makerMinRestMs", 700)),
                replace_only_on_touch_move=bool(cfg.get("makerReplaceOnlyOnTouchMove", True)),
                improve_one_tick_on_wide_spread=bool(cfg.get("makerImproveOneTickOnWideSpread", True)),
                improve_min_spread_ticks=float(cfg.get("makerImproveMinSpreadTicks", 3.0)),
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
              atr_sl_breach_started_ms = None
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

      # Regime loop while flat: only TREND opens are allowed.
      if (
        not position_state.open
        and trading_enabled
        and has_trade_account_ctx
        and signer_active
        and last_mid
        and now_ms >= next_decision_ms
      ):
        next_decision_ms = now_ms + int(cfg.get("decisionLoopIntervalSec", 4)) * 1000
        strategy_cfg = _build_strategy_cfg(cfg)
        regime_decision, _bars = await evaluate_regime(regime_runner, cfg, now_ms)
        desired = desired_position_from_regime(regime_decision, strategy_cfg)

        if (regime_decision.state, regime_decision.direction) != (last_regime_state, last_regime_direction):
          last_regime_change_ms = int(regime_decision.ts_ms or now_ms)

        last_decision_at_ms = now_ms
        last_reason = regime_decision.reason
        last_desired = desired
        last_conf = float(regime_decision.strength)
        last_regime_state = regime_decision.state
        last_regime_direction = regime_decision.direction
        last_regime_diagnostics = clone_jsonable(regime_decision.diagnostics or {})
        metrics_cache["regime"] = regime_decision.state

        DB_MANAGER.insert_decision(
          ts_ms=now_ms,
          p_up=regime_decision.strength,
          desired=desired,
          regime=regime_decision.state,
          reason=regime_decision.reason,
          horizon_sec=int(cfg.get("regimeLookbackSeconds", 1800)),
          features=[
            float(1.0 if regime_decision.state == "TREND" else 0.0),
            float(1.0 if regime_decision.direction == "UP" else (-1.0 if regime_decision.direction == "DOWN" else 0.0)),
            float(regime_decision.strength),
            0.0,
            0.0,
            0.0,
          ],
        )

        max_daily_loss = float(cfg.get("maxDailyLossUsd", 0.0))
        day_start_ms, _ = DB_MANAGER.utc_day_bounds_ms(now_ms)
        realized_today = DB_MANAGER.query_realized_pnl_since(day_start_ms)
        daily_loss_hit = max_daily_loss > 0 and realized_today <= -abs(max_daily_loss)

        now_sec = time.time()
        last_order_ts[:] = [x for x in last_order_ts if now_sec - x < 3600]
        can_open = len(last_order_ts) < int(cfg.get("maxOrdersPerHour", 120))
        flip_cooldown_sec = int(cfg.get("flipCooldownSec", cfg.get("cooldownAfterCloseSec", 15)))
        cooldown_until_ms = (
          (int(last_regime_exit_ts_ms) + flip_cooldown_sec * 1000)
          if (last_regime_exit_ts_ms and flip_cooldown_sec > 0)
          else None
        )
        in_cooldown = bool(cooldown_until_ms is not None and now_ms < int(cooldown_until_ms))

        if daily_loss_hit:
          last_action = {
            "type": "DAILY_LOSS_LIMIT",
            "ok": False,
            "info": {"realizedToday": realized_today, "maxDailyLossUsd": max_daily_loss},
          }
        elif desired in ("LONG", "SHORT") and not can_open:
          last_action = {
            "type": "RATE_LIMITED",
            "ok": False,
            "info": {"maxOrdersPerHour": int(cfg.get("maxOrdersPerHour", 120))},
          }
        elif desired in ("LONG", "SHORT") and in_cooldown:
          last_action = {
            "type": "FLIP_COOLDOWN",
            "ok": True,
            "info": {
              "flipCooldownSec": flip_cooldown_sec,
              "cooldownUntil": cooldown_until_ms,
              "cooldownRemainingSec": to_countdown_sec(cooldown_until_ms, now_ms),
              "lastRegimeExitReason": last_regime_exit_reason,
            },
          }
        elif desired in ("LONG", "SHORT") and _funding_gate_blocked(desired, cfg, metrics_cache):
          current_funding = float(metrics_cache.get("funding") or 0.0)
          last_action = {
            "type": "FUNDING_GATE",
            "ok": False,
            "info": {
              "fundingRate": current_funding,
              "fundingRateLimitPct": float(cfg.get("fundingRateLimitPct", 0.0)),
              "desired": desired,
            },
          }
        elif desired in ("LONG", "SHORT") and _daily_trades_gate_blocked(cfg, day_start_ms):
          trades_today = DB_MANAGER.query_trade_count_since(day_start_ms)
          last_action = {
            "type": "MAX_DAILY_TRADES",
            "ok": False,
            "info": {
              "tradesToday": trades_today,
              "maxDailyTrades": int(cfg.get("maxDailyTrades", 0)),
            },
          }
        elif desired in ("LONG", "SHORT"):
          snap = await asyncio.to_thread(fetch_portfolio_snapshot, eth_base, sub_id)
          avail = _f(snap.get("availableMarginUsd"))
          pv = _f(snap.get("portfolioValueUsd"))
          max_margin = float(cfg.get("maxMarginUsd", 100.0))
          if pv and pv > 0:
            max_margin = min(max_margin, pv * float(cfg.get("maxMarginPct", 25.0)) / 100.0)
          if avail is not None:
            max_margin = min(max_margin, avail)

          spread_bps = (
            ((last_ask - last_bid) / last_mid * 10_000.0)
            if (last_ask and last_bid and last_mid and last_mid > 0)
            else 999.0
          )
          liquidity_score = clamp(1.0 - max(0.0, spread_bps - 2.0) / 20.0, 0.0, 1.0)
          size_mult = size_liquidity_multiplier(spread_bps, liquidity_score)
          if spread_bps > float(cfg.get("maxSpreadBpsForTrade", 12.0)):
            size_mult = 0.0

          strength = clamp(float(regime_decision.strength), 0.25, 1.0)
          notional = max_margin * float(cfg.get("maxLeverage", 2.0)) * strength * size_mult
          qty_raw = (notional / float(last_mid)) if last_mid and last_mid > 0 else 0.0
          qty = quantize_qty_to_lot(qty_raw, cached_lot_size)

          if qty > 0:
            cerr = await ensure_client_ready()
            if not cerr and client is not None:
              guard_ms = int(cfg.get("orderGuardMs", 200))
              if not _order_guard_ok(now_ms, last_order_submit_ms, guard_ms):
                await asyncio.sleep(0.2)

              side_int = _side_to_int(desired)
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
                gtd_sec=int(cfg.get("makerOrderGtdSec", 4)),
                last_order_submit_ms=last_order_submit_ms,
                order_guard_ms=guard_ms,
                position_mode="entry",
                expected_side=desired,
                reduce_only=False,
                allow_market_safety=False,
                min_rest_ms=int(cfg.get("makerMinRestMs", 700)),
                replace_only_on_touch_move=bool(cfg.get("makerReplaceOnlyOnTouchMove", True)),
                improve_one_tick_on_wide_spread=bool(cfg.get("makerImproveOneTickOnWideSpread", True)),
                improve_min_spread_ticks=float(cfg.get("makerImproveMinSpreadTicks", 3.0)),
                entry_min_fill_ratio=float(cfg.get("entryMinFillRatio", 0.50)),
              )
              last_order_submit_ms = int(exec_result.get("lastOrderSubmitMs") or last_order_submit_ms)
              _print_chase_attempts(f"ENTRY_{desired}", exec_result)
              maker_entry_chases += 1
              filled = float(exec_result.get("filledQty") or 0.0)
              remain = float(exec_result.get("remainingQty") or 0.0)
              submitted_any = int(exec_result.get("submittedCount") or 0) > 0
              maker_err = "; ".join([str(x) for x in (exec_result.get("errors") or []) if x])[:500]

              pos_final = fetch_active_position(eth_base, sub_id, product_id)
              of, sf, szf, _, epf, etsf = parse_position(pos_final)
              opened_qty = abs(float(szf)) if of and sf == desired else 0.0
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
                if any(isinstance(f, dict) and not bool(f.get("isMaker")) for f in (fills_list or [])):
                  print("[MAKER ENTRY VIOLATION] entry fill reported taker")
              except Exception:
                pass

              if opened_qty <= 0:
                if bool(exec_result.get("timedOut")):
                  maker_entry_timeouts += 1
                if submitted_any:
                  last_order_ts.append(time.time())
                last_action = {
                "type": "SKIP_ENTRY_UNFILLED",
                "ok": True,
                "info": {
                  "desired": desired,
                  "qty": qty,
                    "filled": filled,
                    "remain": remain,
                  "regimeState": regime_decision.state,
                  "regimeDirection": regime_decision.direction,
                  "regimeStrength": regime_decision.strength,
                  "regimeDiagnostics": clone_jsonable(regime_decision.diagnostics or {}),
                  "makerError": maker_err or None,
                  "chaseAttempts": int(exec_result.get("attemptCount") or 0),
                },
              }
              else:
                maker_entry_opened += 1
                if bool(exec_result.get("acceptedPartial")):
                  maker_entry_partial_accepts += 1
                ttf = exec_result.get("timeToFirstFillMs")
                try:
                  ttf_i = int(ttf) if ttf is not None else None
                except Exception:
                  ttf_i = None
                if ttf_i is not None and ttf_i >= 0:
                  maker_entry_ttf_ms_samples.append(ttf_i)
                  if len(maker_entry_ttf_ms_samples) > 200:
                    maker_entry_ttf_ms_samples = maker_entry_ttf_ms_samples[-200:]
                entry_px = float(epf if epf and epf > 0 else last_mid)
                entry_mode = "maker_partial" if opened_qty > filled > 0 else "maker"
                entry_risk_state = PositionState(
                  open=True,
                  side=desired,
                  qty=opened_qty,
                  entry_price=entry_px,
                  entry_ts_ms=etsf or now_ms,
                )
                _ensure_frozen_risk_levels(
                  position=entry_risk_state,
                  cfg=strategy_cfg,
                  live_atr_pct=_f(metrics_cache.get("atrPct")),
                )
                entry_reason_payload = {
                  "reason": "regime_entry",
                  "regimeState": regime_decision.state,
                  "regimeDirection": regime_decision.direction,
                  "regimeStrength": regime_decision.strength,
                  "entryMode": entry_mode,
                  "makerFilledQty": filled,
                  "entryChaseAttempts": int(exec_result.get("attemptCount") or 0),
                  "entryTimedOut": bool(exec_result.get("timedOut")),
                  "entryAcceptedPartial": bool(exec_result.get("acceptedPartial")),
                  "entryPartialFillRatio": float(exec_result.get("partialFillRatio") or 0.0),
                  "entryAtrPct": entry_risk_state.entry_atr_pct,
                  "fixedStopPct": entry_risk_state.fixed_stop_pct,
                  "fixedTakePct": entry_risk_state.fixed_take_pct,
                  "fixedStopPrice": entry_risk_state.fixed_stop_price,
                  "fixedTakePrice": entry_risk_state.fixed_take_price,
                  "atrStopLossIsAtr": bool(entry_risk_state.stop_loss_is_atr_based),
                }

                _entry_maker_pct = float(
                  (last_entry_fill_audit or {}).get("summary", {}).get("makerRatePct") or 0.0
                ) if last_entry_fill_audit else 0.0
                DB_MANAGER.insert_trade_event(
                  trade_id=str(uuid.uuid4()),
                  ts_ms=now_ms,
                  event_type="ENTRY",
                  side=desired,
                  qty=opened_qty,
                  price=entry_px,
                  pnl=None,
                  tag="regime_entry",
                  reason_json=json.dumps(entry_reason_payload),
                  entry_ts=etsf or now_ms,
                  entry_price=entry_px,
                  note=f"maker:{round(_entry_maker_pct)}%" if _entry_maker_pct > 0 else "taker",
                )

                current_trade_entry_price = entry_px
                current_trade_entry_ts = etsf or now_ms
                current_trade_entry_atr_pct = _f(entry_risk_state.entry_atr_pct)
                current_trade_fixed_stop_pct = _f(entry_risk_state.fixed_stop_pct)
                current_trade_fixed_take_pct = _f(entry_risk_state.fixed_take_pct)
                current_trade_fixed_stop_price = _f(entry_risk_state.fixed_stop_price)
                current_trade_fixed_take_price = _f(entry_risk_state.fixed_take_price)
                current_trade_stop_loss_is_atr = (
                  bool(entry_risk_state.stop_loss_is_atr_based)
                  if entry_risk_state.stop_loss_is_atr_based is not None
                  else None
                )
                atr_sl_breach_started_ms = None
                if submitted_any:
                  last_order_ts.append(time.time())

                last_action = {
                  "type": f"OPEN_{desired}",
                  "ok": True,
                  "info": {
                    "qty": opened_qty,
                    "qtyRaw": qty_raw,
                    "regimeState": regime_decision.state,
                    "regimeDirection": regime_decision.direction,
                    "regimeStrength": regime_decision.strength,
                    "regimeDiagnostics": clone_jsonable(regime_decision.diagnostics or {}),
                    "sizeMultiplier": size_mult,
                    "makerFilledQty": filled,
                    "entryChaseAttempts": int(exec_result.get("attemptCount") or 0),
                    "entryAcceptedPartial": bool(exec_result.get("acceptedPartial")),
                    "entryPartialFillRatio": float(exec_result.get("partialFillRatio") or 0.0),
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
                "regimeStrength": regime_decision.strength,
                "regimeDiagnostics": clone_jsonable(regime_decision.diagnostics or {}),
                "maxSpreadBpsForTrade": float(cfg.get("maxSpreadBpsForTrade", 12.0)),
              },
            }
        else:
          last_action = {
            "type": "SKIP_NO_TREND",
            "ok": True,
            "info": {
              "desired": desired,
              "regimeState": regime_decision.state,
              "regimeDirection": regime_decision.direction,
              "regimeStrength": regime_decision.strength,
              "regimeDiagnostics": clone_jsonable(regime_decision.diagnostics or {}),
            },
          }

      # Regime reassessment while in position: exit on regime end/flip, subject to minHold; risk exits are handled above.
      if (
        position_state.open
        and trading_enabled
        and has_trade_account_ctx
        and signer_active
        and last_mid
        and now_ms >= next_reassess_ms
      ):
        next_reassess_ms = now_ms + int(cfg.get("inPositionReassessIntervalSec", 8)) * 1000
        strategy_cfg = _build_strategy_cfg(cfg)
        regime_decision, _bars = await evaluate_regime(regime_runner, cfg, now_ms)
        desired = desired_position_from_regime(regime_decision, strategy_cfg)

        if (regime_decision.state, regime_decision.direction) != (last_regime_state, last_regime_direction):
          last_regime_change_ms = int(regime_decision.ts_ms or now_ms)

        last_decision_at_ms = now_ms
        last_reason = regime_decision.reason
        last_desired = desired
        last_conf = float(regime_decision.strength)
        last_regime_state = regime_decision.state
        last_regime_direction = regime_decision.direction
        last_regime_diagnostics = clone_jsonable(regime_decision.diagnostics or {})

        DB_MANAGER.insert_decision(
          ts_ms=now_ms,
          p_up=regime_decision.strength,
          desired=desired,
          regime=regime_decision.state,
          reason=regime_decision.reason,
          horizon_sec=int(cfg.get("regimeLookbackSeconds", 1800)),
          features=[
            float(1.0 if regime_decision.state == "TREND" else 0.0),
            float(1.0 if regime_decision.direction == "UP" else (-1.0 if regime_decision.direction == "DOWN" else 0.0)),
            float(regime_decision.strength),
            0.0,
            0.0,
            0.0,
          ],
        )

        regime_exit_reason = (
          should_exit_for_regime(
            position_state.side or "",
            regime_decision,
            exit_on_regime_end=bool(cfg.get("exitOnRegimeEnd", True)),
          )
          if bool(cfg.get("regimeExitEnabled", False))
          else None
        )
        if regime_exit_reason and position_state.side and position_state.qty > 0:
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
                gtd_sec=int(cfg.get("makerOrderGtdSec", 4)),
                last_order_submit_ms=last_order_submit_ms,
                order_guard_ms=guard_ms,
                position_mode="exit",
                expected_side=position_state.side,
                reduce_only=True,
                allow_market_safety=True,
                min_rest_ms=int(cfg.get("makerMinRestMs", 700)),
                replace_only_on_touch_move=bool(cfg.get("makerReplaceOnlyOnTouchMove", True)),
                improve_one_tick_on_wide_spread=bool(cfg.get("makerImproveOneTickOnWideSpread", True)),
                improve_min_spread_ticks=float(cfg.get("makerImproveMinSpreadTicks", 3.0)),
              )
              last_order_submit_ms = int(exec_result.get("lastOrderSubmitMs") or last_order_submit_ms)
              _print_chase_attempts(f"EXIT_{regime_exit_reason}", exec_result)
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
                _print_maker_audit(f"EXIT_{regime_exit_reason}", last_exit_fill_audit or {})
                _print_maker_audit("LAST20", fills_audit_last20 or {})
              except Exception:
                pass
              last_exit_method = "market_safety" if bool(exec_result.get("marketSafetyUsed")) else "maker"

              px = float(last_mid)
              pnl = _realized_pnl(position_state.side, current_trade_entry_price or position_state.entry_price, px, position_state.qty)
              close_tag = "regime_flip" if regime_exit_reason == "REGIME_FLIP" else "regime_end"
              DB_MANAGER.insert_trade_event(
                trade_id=str(uuid.uuid4()),
                ts_ms=now_ms,
                event_type="EXIT",
                side=position_state.side,
                qty=position_state.qty,
                price=px,
                pnl=pnl,
                tag=close_tag,
                reason_json=json.dumps(
                  {
                    "reason": close_tag,
                    "regimeState": regime_decision.state,
                    "regimeDirection": regime_decision.direction,
                    "regimeStrength": regime_decision.strength,
                    "exitMethod": ("market_safety" if bool(exec_result.get("marketSafetyUsed")) else "maker"),
                  }
                ),
                entry_ts=current_trade_entry_ts,
                exit_ts=now_ms,
                entry_price=current_trade_entry_price,
                exit_price=px,
              )
              last_close_ts_ms = now_ms
              last_regime_exit_ts_ms = now_ms
              last_regime_exit_reason = regime_exit_reason
              last_action = {
                "type": regime_exit_reason,
                "ok": True,
                "info": {
                  "regimeState": regime_decision.state,
                  "regimeDirection": regime_decision.direction,
                  "regimeStrength": regime_decision.strength,
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
              "info": {"heldSec": held_sec, "minHoldSeconds": int(cfg.get("minHoldSeconds", 5)), "exitReason": regime_exit_reason},
            }
        else:
          last_action = {
            "type": "HOLD_REASSESS",
            "ok": True,
                "info": {
                  "side": position_state.side,
                  "regimeState": regime_decision.state,
                  "regimeDirection": regime_decision.direction,
                  "regimeStrength": regime_decision.strength,
                  "regimeDiagnostics": clone_jsonable(regime_decision.diagnostics or {}),
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
        int(last_regime_exit_ts_ms) + int(cfg.get("flipCooldownSec", cfg.get("cooldownAfterCloseSec", 15))) * 1000
        if (
          last_regime_exit_ts_ms
          and int(cfg.get("flipCooldownSec", cfg.get("cooldownAfterCloseSec", 15))) > 0
        )
        else None
      )

      human_reason, raw_reason = explain_agent_reason(
        last_reason,
        last_desired,
        float(last_conf),
        last_regime_state,
        last_regime_direction,
      )

      atr_sl_confirm_sec_runtime = int(cfg.get("atrStopLossConfirmSec", 120))
      atr_sl_debounce_active = bool(
        position_state.open
        and position_state.stop_loss_is_atr_based
        and atr_sl_confirm_sec_runtime > 0
        and atr_sl_breach_started_ms is not None
      )
      atr_sl_breach_sec = (
        max(0, int((now_ms - int(atr_sl_breach_started_ms)) / 1000))
        if atr_sl_debounce_active and atr_sl_breach_started_ms is not None
        else None
      )
      atr_sl_remaining_sec = (
        max(0, int(atr_sl_confirm_sec_runtime - int(atr_sl_breach_sec or 0)))
        if atr_sl_debounce_active and atr_sl_breach_sec is not None
        else None
      )

      day_start_ms = _safe_call(now_ms, lambda: DB_MANAGER.utc_day_bounds_ms(now_ms)[0])
      trades_today = _safe_call(0, DB_MANAGER.query_trade_count_since, int(day_start_ms))
      ingestion_stats = _safe_call({}, DB_MANAGER.query_ingestion_stats)
      ticks_count = int(ingestion_stats.get("ticksCollected", 0) or 0)
      today_path = _safe_call("", DB_MANAGER.today_path)
      db_size_bytes = _safe_call(0, DB_MANAGER.folder_size_bytes)
      db_files = _safe_call(0, DB_MANAGER.db_file_count)

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
          "regimeLookbackSeconds": int(cfg.get("regimeLookbackSeconds", 1800)),
          "regimeBarSeconds": int(cfg.get("regimeBarSeconds", 1)),
          "regimeSampleEverySec": int(cfg.get("regimeSampleEverySec", max(12, int(cfg.get("regimeBarSeconds", 1))))),
          "trendHalfLifeMinSec": int(cfg.get("trendHalfLifeMinSec", 450)),
          "trendEntryStrength": float(cfg.get("trendEntryStrength", 0.70)),
          "flipCooldownSec": int(cfg.get("flipCooldownSec", cfg.get("cooldownAfterCloseSec", 15))),
          "riskLoopIntervalSec": int(cfg.get("riskLoopIntervalSec", 1)),
          "decisionLoopIntervalSec": int(cfg.get("decisionLoopIntervalSec", 4)),
          "inPositionReassessIntervalSec": int(cfg.get("inPositionReassessIntervalSec", 8)),
          "metricsLoopIntervalSec": int(cfg.get("metricsLoopIntervalSec", 45)),
          "reassessIntervalSec": int(cfg.get("inPositionReassessIntervalSec", 8)),
          "minHoldSeconds": int(cfg.get("minHoldSeconds", 5)),
          "maxHoldSeconds": int(cfg.get("maxHoldSeconds", 7200)),
          "maxLeverage": float(cfg.get("maxLeverage", 2)),
          "maxMarginUsd": float(cfg.get("maxMarginUsd", 100)),
          "maxMarginPct": float(cfg.get("maxMarginPct", 25.0)),
          "entryMakerPreferred": True,
          "entryMarketFallbackEnabled": False,
          "entryChaseMaxSec": float(cfg.get("entryChaseMaxSec", 10.0)),
          "exitChaseMaxSec": float(cfg.get("exitChaseMaxSec", 5.0)),
          "executionRepriceMs": int(cfg.get("executionRepriceMs", 350)),
          "makerOrderGtdSec": int(cfg.get("makerOrderGtdSec", 2)),
          "makerMinRestMs": int(cfg.get("makerMinRestMs", 700)),
          "makerReplaceOnlyOnTouchMove": bool(cfg.get("makerReplaceOnlyOnTouchMove", True)),
          "makerImproveOneTickOnWideSpread": bool(cfg.get("makerImproveOneTickOnWideSpread", True)),
          "makerImproveMinSpreadTicks": float(cfg.get("makerImproveMinSpreadTicks", 3.0)),
          "entryMinFillRatio": float(cfg.get("entryMinFillRatio", 0.50)),
          "stopLossPct": _to_opt_float(cfg.get("stopLossPct")),
          "stopLossAtrMult": _to_opt_float(cfg.get("stopLossAtrMult")),
          "atrStopLossConfirmSec": int(cfg.get("atrStopLossConfirmSec", 120)),
          "takeProfitPct": _to_opt_float(cfg.get("takeProfitPct")),
          "takeProfitAtrMult": _to_opt_float(cfg.get("takeProfitAtrMult")),
          "trailingStopPct": _to_opt_float(cfg.get("trailingStopPct")),
          "maxDailyLossUsd": float(cfg.get("maxDailyLossUsd", 0.0)),
          "fundingRateLimitPct": float(cfg.get("fundingRateLimitPct", 0.0)),
          "maxDailyTrades": int(cfg.get("maxDailyTrades", 0)),
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
          "entryPrice": position_state.entry_price or current_trade_entry_price,
          "entryAt": position_state.entry_ts_ms or current_trade_entry_ts,
          "ageSec": (
            max(0, int((now_ms - int(position_state.entry_ts_ms)) / 1000))
            if position_state.entry_ts_ms
            else None
          ),
          "unrealizedPnl": pos_upnl,
          "atrPct": (
            float(position_state.entry_atr_pct)
            if position_state.open and position_state.entry_atr_pct is not None and float(position_state.entry_atr_pct) > 0
            else float(metrics_cache.get("atrPct") or 0.0)
          ),
          "liveAtrPct": float(metrics_cache.get("atrPct") or 0.0),
          "entryAtrPct": _f(position_state.entry_atr_pct),
          "fixedStopPct": _f(position_state.fixed_stop_pct),
          "fixedTakePct": _f(position_state.fixed_take_pct),
          "fixedStopPrice": _f(position_state.fixed_stop_price),
          "fixedTakePrice": _f(position_state.fixed_take_price),
          "atrStopLossDebounceActive": atr_sl_debounce_active,
          "atrStopLossConfirmSec": atr_sl_confirm_sec_runtime,
          "atrStopLossBreachSec": atr_sl_breach_sec,
          "atrStopLossConfirmRemainingSec": atr_sl_remaining_sec,
          "updatedAt": int(time.time() * 1000),
        },
        "agent": {
          "desired": last_desired,
          "confidence": float(last_conf),
          "confidenceBand": confidence_band(float(last_conf)),
          "regime": last_regime_state,
          "regimeState": last_regime_state,
          "regimeDirection": last_regime_direction,
          "regimeStrength": float(last_conf),
          "regimeDiagnostics": clone_jsonable(last_regime_diagnostics),
          "lastRegimeChangeAt": last_regime_change_ms,
          "reason": raw_reason,
          "reasonHuman": human_reason,
          "reasonRaw": raw_reason,
          "lastDecisionAt": last_decision_at_ms,
          "decisionHorizonSeconds": int(cfg.get("regimeLookbackSeconds", 1800)),
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
          "tradesToday": int(trades_today),
          "maxDailyTrades": int(cfg.get("maxDailyTrades", 0)),
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
          "ticksCount": ticks_count,
        },
        "execution": {
          "makerOnlyEntry": True,
          "makerFirstExitWithMarketSafety": True,
          "exitMarketSafetyAfterSec": float(cfg.get("exitChaseMaxSec", 5.0)),
          "quoteSource": (
            "ws_bookdepth"
            if (
              bool(ws_quote_cache.snapshot().get("subscribed"))
              and (
                ws_quote_cache.snapshot().get("lastUpdateMs") is None
                or (int(now_ms) - int(ws_quote_cache.snapshot().get("lastUpdateMs") or 0)) <= max(5000, int(WS_STALE_RECONNECT_MS))
              )
            )
            else "rest"
          ),
          "wsQuotes": {
            **ws_quote_cache.snapshot(),
            "stale": (
              False
              if ws_quote_cache.snapshot().get("lastUpdateMs") is None
              else (int(now_ms) - int(ws_quote_cache.snapshot().get("lastUpdateMs") or 0)) > max(5000, int(WS_STALE_RECONNECT_MS))
            ),
            "staleAfterMs": max(5000, int(WS_STALE_RECONNECT_MS)),
          },
          "lastEntryFillAudit": last_entry_fill_audit,
          "lastEntryFill": last_entry_fill_info,
          "lastExitFillAudit": last_exit_fill_audit,
          "lastExitMethod": last_exit_method,
          "fillsAuditLast20": fills_audit_last20,
          "entryMakerChases": maker_entry_chases,
          "entryMakerOpened": maker_entry_opened,
          "entryMakerTimeouts": maker_entry_timeouts,
          "entryMakerPartialAccepts": maker_entry_partial_accepts,
          "entryMakerFillRatePct": ((maker_entry_opened / maker_entry_chases) * 100.0) if maker_entry_chases else 0.0,
          "entryMakerPartialRatePct": ((maker_entry_partial_accepts / maker_entry_opened) * 100.0) if maker_entry_opened else 0.0,
          "avgEntryTimeToFirstFillMs": (
            (sum(maker_entry_ttf_ms_samples) / len(maker_entry_ttf_ms_samples)) if maker_entry_ttf_ms_samples else None
          ),
        },
        "db": {
          "dir": DB_DIR,
          "todayPath": today_path,
          "sizeBytes": db_size_bytes,
          "maxBytes": int(DB_MAX_GB * 1024 * 1024 * 1024),
          "targetBytes": int(DB_TARGET_GB * 1024 * 1024 * 1024),
          "dbFiles": db_files,
        },
        "lastAction": last_action,
      }

    except Exception as e:
      cfg = get_runtime_config()
      status_payload = _status_payload_base(f"error: {str(e)}", alive=True, cfg=cfg)
      with STATUS_LOCK:
        prev_status = clone_jsonable(LATEST_STATUS)
      if isinstance(prev_status, dict):
        for section in ("runtime", "account", "position", "agent", "trading", "ingestion", "execution", "db"):
          prev_value = prev_status.get(section)
          if isinstance(prev_value, dict):
            status_payload[section] = clone_jsonable(prev_value)
        prev_market = prev_status.get("market")
        if isinstance(prev_market, dict):
          status_payload["market"] = clone_jsonable(prev_market)
      status_payload["updatedAt"] = int(time.time() * 1000)
      status_payload["bot"] = {
        "alive": True,
        "lastLoopAt": int(time.time() * 1000),
        "message": f"error: {str(e)}",
        "version": BOT_VERSION,
      }
      status_payload["market"] = {
        **(status_payload.get("market") if isinstance(status_payload.get("market"), dict) else {}),
        "ticker": str(cfg.get("ticker", "BTCUSD")),
        "price": last_mid,
        "oraclePrice": last_oracle,
        "bestBid": last_bid,
        "bestAsk": last_ask,
      }
      status_payload["lastAction"] = {"type": "ERROR", "ok": False, "info": {"error": str(e)}}

    with STATUS_LOCK:
      LATEST_STATUS = status_payload

    elapsed = time.time() - started
    await asyncio.sleep(max(0.12, 1.0 - elapsed))


if __name__ == "__main__":
  asyncio.run(main())
