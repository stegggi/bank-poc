from dataclasses import dataclass
from typing import Any, Dict, Optional


def clamp(x: float, lo: float, hi: float) -> float:
  return max(lo, min(hi, x))


@dataclass
class StrategyConfig:
  trend_entry_strength: float = 0.70
  flip_cooldown_sec: int = 15

  min_hold_seconds: int = 5
  max_hold_seconds: int = 7200

  stop_loss_pct: Optional[float] = 0.003
  stop_loss_atr_mult: Optional[float] = None

  take_profit_pct: Optional[float] = 0.006
  take_profit_atr_mult: Optional[float] = None

  trailing_stop_pct: Optional[float] = None

  max_spread_bps_for_trade: float = 12.0


@dataclass
class PositionState:
  open: bool
  side: Optional[str]
  qty: float
  entry_price: Optional[float]
  entry_ts_ms: Optional[int]
  peak_price: Optional[float] = None
  trough_price: Optional[float] = None
  entry_atr_pct: Optional[float] = None
  fixed_stop_pct: Optional[float] = None
  fixed_take_pct: Optional[float] = None
  fixed_stop_price: Optional[float] = None
  fixed_take_price: Optional[float] = None
  stop_loss_is_atr_based: Optional[bool] = None
  margin_usd: Optional[float] = None
  leverage: Optional[float] = None


@dataclass
class RegimeDecision:
  state: str
  direction: Optional[str]
  strength: float
  reason: str
  ts_ms: int
  diagnostics: Optional[Dict[str, Any]] = None


@dataclass
class RiskCheckResult:
  should_exit: bool
  reason: Optional[str]
  rule: Optional[str]


def desired_position_from_regime(regime: RegimeDecision, cfg: StrategyConfig) -> str:
  if str(regime.state or "").upper() != "TREND":
    return "FLAT"
  if float(regime.strength or 0.0) < float(cfg.trend_entry_strength):
    return "FLAT"
  direction = str(regime.direction or "").upper()
  if direction == "UP":
    return "LONG"
  if direction == "DOWN":
    return "SHORT"
  return "FLAT"


def should_exit_for_regime(
  position_side: str,
  regime: RegimeDecision,
  exit_on_regime_end: bool = True,
) -> Optional[str]:
  side = str(position_side or "").upper()
  state = str(regime.state or "").upper()
  direction = str(regime.direction or "").upper()
  if side not in ("LONG", "SHORT"):
    return None
  # Always exit immediately on active direction reversal.
  if side == "LONG" and state == "TREND" and direction == "DOWN":
    return "REGIME_FLIP"
  if side == "SHORT" and state == "TREND" and direction == "UP":
    return "REGIME_FLIP"
  # Optionally exit when the regime becomes uncertain/flat.
  # Disable this to hold through noisy regime oscillations and only exit on flips.
  if exit_on_regime_end and state != "TREND":
    return "REGIME_END"
  return None


def update_position_extremes(position: PositionState, mark_price: float) -> PositionState:
  if not position.open or mark_price <= 0:
    return position

  if position.peak_price is None:
    position.peak_price = mark_price
  if position.trough_price is None:
    position.trough_price = mark_price

  position.peak_price = max(float(position.peak_price), float(mark_price))
  position.trough_price = min(float(position.trough_price), float(mark_price))
  return position


def _resolve_stop_pct(cfg: StrategyConfig, atr_pct: float) -> Optional[float]:
  if cfg.stop_loss_pct is not None and cfg.stop_loss_pct > 0:
    return cfg.stop_loss_pct
  if cfg.stop_loss_atr_mult is not None and cfg.stop_loss_atr_mult > 0 and atr_pct > 0:
    return cfg.stop_loss_atr_mult * atr_pct
  return None


def _resolve_take_pct(cfg: StrategyConfig, atr_pct: float) -> Optional[float]:
  if cfg.take_profit_pct is not None and cfg.take_profit_pct > 0:
    return cfg.take_profit_pct
  if cfg.take_profit_atr_mult is not None and cfg.take_profit_atr_mult > 0 and atr_pct > 0:
    return cfg.take_profit_atr_mult * atr_pct
  return None


def evaluate_risk_exit(
  cfg: StrategyConfig,
  position: PositionState,
  mark_price: float,
  atr_pct: float,
  now_ms: int,
  min_hold_enforced: bool = False,
) -> RiskCheckResult:
  if not position.open or not position.side or not position.entry_price or mark_price <= 0:
    return RiskCheckResult(False, None, None)

  side = str(position.side).upper()
  entry = float(position.entry_price)

  held_sec = 0
  if position.entry_ts_ms:
    held_sec = max(0, int((now_ms - int(position.entry_ts_ms)) / 1000))

  if held_sec >= int(cfg.max_hold_seconds):
    return RiskCheckResult(True, "max_hold", "MAX_HOLD")

  if min_hold_enforced and held_sec < int(cfg.min_hold_seconds):
    return RiskCheckResult(False, None, None)

  stop_pct = _resolve_stop_pct(cfg, atr_pct)
  take_pct = _resolve_take_pct(cfg, atr_pct)
  fixed_stop_price = float(position.fixed_stop_price) if position.fixed_stop_price and position.fixed_stop_price > 0 else None
  fixed_take_price = float(position.fixed_take_price) if position.fixed_take_price and position.fixed_take_price > 0 else None
  stop_price = fixed_stop_price
  take_price = fixed_take_price
  if stop_price is None and stop_pct and stop_pct > 0:
    stop_price = entry * (1.0 - stop_pct) if side == "LONG" else entry * (1.0 + stop_pct)
  if take_price is None and take_pct and take_pct > 0:
    take_price = entry * (1.0 + take_pct) if side == "LONG" else entry * (1.0 - take_pct)
  trail_pct = cfg.trailing_stop_pct if cfg.trailing_stop_pct and cfg.trailing_stop_pct > 0 else None

  if side == "LONG":
    if stop_price and mark_price <= stop_price:
      return RiskCheckResult(True, "stop_loss", "SL")
    if take_price and mark_price >= take_price:
      return RiskCheckResult(True, "take_profit", "TP")
    if trail_pct and position.peak_price and mark_price <= float(position.peak_price) * (1.0 - trail_pct):
      return RiskCheckResult(True, "trailing_stop", "TRAIL")

  if side == "SHORT":
    if stop_price and mark_price >= stop_price:
      return RiskCheckResult(True, "stop_loss", "SL")
    if take_price and mark_price <= take_price:
      return RiskCheckResult(True, "take_profit", "TP")
    if trail_pct and position.trough_price and mark_price >= float(position.trough_price) * (1.0 + trail_pct):
      return RiskCheckResult(True, "trailing_stop", "TRAIL")

  return RiskCheckResult(False, None, None)


def size_liquidity_multiplier(spread_bps: float, liquidity_score: float) -> float:
  spread_penalty = clamp((spread_bps - 2.0) / 30.0, 0.0, 0.8)
  liq_penalty = clamp(1.0 - liquidity_score, 0.0, 0.7)
  m = 1.0 - max(spread_penalty, liq_penalty)
  return clamp(m, 0.2, 1.0)
