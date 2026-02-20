import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple


def clamp(x: float, lo: float, hi: float) -> float:
  return max(lo, min(hi, x))


def sigmoid(x: float) -> float:
  x = clamp(x, -50.0, 50.0)
  return 1.0 / (1.0 + math.exp(-x))


@dataclass
class StrategyConfig:
  open_confidence_threshold: float = 0.65
  close_confidence_threshold: float = 0.55

  min_hold_seconds: int = 5
  max_hold_seconds: int = 7200

  stop_loss_pct: Optional[float] = 0.003
  stop_loss_atr_mult: Optional[float] = None

  take_profit_pct: Optional[float] = 0.006
  take_profit_atr_mult: Optional[float] = None

  trailing_stop_pct: Optional[float] = None

  max_spread_bps_for_trade: float = 12.0
  high_vol_percentile: float = 0.70
  low_vol_percentile: float = 0.35


@dataclass
class PositionState:
  open: bool
  side: Optional[str]
  qty: float
  entry_price: Optional[float]
  entry_ts_ms: Optional[int]
  peak_price: Optional[float] = None
  trough_price: Optional[float] = None


@dataclass
class SignalResult:
  p_up: float
  desired: str
  regime: str
  reason: str
  features: List[float]
  spread_bps: float
  atr_pct: float
  liquidity_score: float


@dataclass
class RiskCheckResult:
  should_exit: bool
  reason: Optional[str]
  rule: Optional[str]


def _price_at_or_before(ticks: Sequence[Dict[str, Any]], target_ms: int) -> Optional[float]:
  last = None
  for row in ticks:
    ts = int(row.get("ts_ms") or 0)
    px = row.get("price")
    if px is None:
      continue
    if ts <= target_ms:
      last = float(px)
    else:
      break
  return last


def _ret(ticks: Sequence[Dict[str, Any]], now_ms: int, back_sec: int) -> float:
  if not ticks:
    return 0.0
  p1 = float(ticks[-1].get("price") or 0.0)
  p0 = _price_at_or_before(ticks, now_ms - back_sec * 1000)
  if p0 is None or p0 <= 0 or p1 <= 0:
    return 0.0
  return (p1 / p0) - 1.0


def _atr_proxy_pct(ticks: Sequence[Dict[str, Any]], bars: int = 90) -> float:
  if len(ticks) < 3:
    return 0.0
  px = [float(t.get("price") or 0.0) for t in ticks[-bars:]]
  rets: List[float] = []
  for i in range(1, len(px)):
    prev = px[i - 1]
    cur = px[i]
    if prev <= 0 or cur <= 0:
      continue
    rets.append(abs((cur / prev) - 1.0))
  if not rets:
    return 0.0
  return float(sum(rets) / len(rets))


def _atr_percentile(ticks: Sequence[Dict[str, Any]], atr_now: float) -> float:
  if len(ticks) < 120:
    return 0.5

  px = [float(t.get("price") or 0.0) for t in ticks]
  samples: List[float] = []
  window = 30
  for i in range(window + 1, len(px)):
    segment = px[i - window : i]
    vals: List[float] = []
    for j in range(1, len(segment)):
      a = segment[j - 1]
      b = segment[j]
      if a > 0 and b > 0:
        vals.append(abs((b / a) - 1.0))
    if vals:
      samples.append(sum(vals) / len(vals))

  if not samples:
    return 0.5

  below = sum(1 for s in samples if s <= atr_now)
  return clamp(float(below) / float(len(samples)), 0.0, 1.0)


def _spread_bps(bid: Optional[float], ask: Optional[float], mid: float) -> float:
  if bid is None or ask is None or bid <= 0 or ask <= 0 or mid <= 0:
    return 999.0
  return ((ask - bid) / mid) * 10_000.0


def _basis(mid: float, oracle: Optional[float]) -> float:
  if oracle is None or oracle <= 0 or mid <= 0:
    return 0.0
  return (mid - oracle) / oracle


def _normalize_small(x: float, scale: float) -> float:
  if scale <= 0:
    return 0.0
  return clamp(x / scale, -2.0, 2.0)


def _rolling_cvd_from_ticks(ticks: Sequence[Dict[str, Any]], seconds: int, now_ms: int) -> float:
  cutoff = now_ms - seconds * 1000
  prev_px: Optional[float] = None
  cvd = 0.0
  for t in ticks:
    ts = int(t.get("ts_ms") or 0)
    if ts < cutoff:
      continue
    px = float(t.get("price") or 0.0)
    if px <= 0:
      continue
    if prev_px is None:
      prev_px = px
      continue
    if px > prev_px:
      cvd += 1.0
    elif px < prev_px:
      cvd -= 1.0
    prev_px = px
  return cvd


def _regime(
  atr_pct: float,
  atr_pctile: float,
  spread_bps: float,
  liquidity_score: float,
  basis: float,
  funding: float,
  cfg: StrategyConfig,
) -> str:
  if spread_bps > cfg.max_spread_bps_for_trade or liquidity_score < 0.2:
    return "no_trade"

  basis_extreme = abs(basis) >= 0.0009
  funding_extreme = abs(funding) >= 0.0002

  if atr_pctile >= cfg.high_vol_percentile and liquidity_score >= 0.4:
    return "momentum"

  if atr_pctile <= cfg.low_vol_percentile and (basis_extreme or funding_extreme):
    return "mean_reversion"

  if atr_pct >= 0.00025 and liquidity_score >= 0.3:
    return "momentum"

  return "no_trade"


def make_signal(
  ticks: Sequence[Dict[str, Any]],
  metrics: Dict[str, Any],
  cfg: StrategyConfig,
  now_ms: Optional[int] = None,
) -> SignalResult:
  if now_ms is None:
    now_ms = int(ticks[-1]["ts_ms"]) if ticks else 0
  if not ticks:
    return SignalResult(
      p_up=0.5,
      desired="FLAT",
      regime="no_data",
      reason="no ticks",
      features=[0.0] * 6,
      spread_bps=999.0,
      atr_pct=0.0,
      liquidity_score=0.0,
    )

  last = ticks[-1]
  mid = float(last.get("price") or 0.0)
  bid = float(last.get("bid")) if last.get("bid") is not None else None
  ask = float(last.get("ask")) if last.get("ask") is not None else None
  oracle = float(last.get("oracle")) if last.get("oracle") is not None else None

  r10s = _ret(ticks, now_ms, 10)
  r30s = _ret(ticks, now_ms, 30)
  r2m = _ret(ticks, now_ms, 120)
  r5m = _ret(ticks, now_ms, 300)

  atr_pct = _atr_proxy_pct(ticks, bars=180)
  atr_pctile = _atr_percentile(ticks, atr_pct)

  spread_bps = _spread_bps(bid, ask, mid)
  basis = _basis(mid, oracle)

  funding = float(metrics.get("funding") or 0.0)
  projected_funding = float(metrics.get("projectedFunding") or 0.0)

  oi_delta = float(metrics.get("openInterestDelta") or 0.0)
  oi_score = _normalize_small(oi_delta, 50_000.0)

  cvd10 = float(metrics.get("cvd10s") or _rolling_cvd_from_ticks(ticks, 10, now_ms))
  cvd30 = float(metrics.get("cvd30s") or _rolling_cvd_from_ticks(ticks, 30, now_ms))
  cvd2m = float(metrics.get("cvd2m") or _rolling_cvd_from_ticks(ticks, 120, now_ms))

  cvd_score = _normalize_small((0.5 * cvd10 + 0.3 * cvd30 + 0.2 * cvd2m), 30.0)

  liquidity_score = clamp(1.0 - max(0.0, spread_bps - 2.0) / 20.0, 0.0, 1.0)

  regime = _regime(
    atr_pct=atr_pct,
    atr_pctile=atr_pctile,
    spread_bps=spread_bps,
    liquidity_score=liquidity_score,
    basis=basis,
    funding=funding,
    cfg=cfg,
  )

  mom_score = (
    1.7 * _normalize_small(r10s, 0.0012)
    + 1.2 * _normalize_small(r30s, 0.0020)
    + 0.8 * _normalize_small(r2m, 0.0035)
    + 0.5 * _normalize_small(r5m, 0.0060)
    + 0.6 * cvd_score
    + 0.35 * oi_score
    - 0.35 * _normalize_small(spread_bps, 25.0)
  )

  mr_score = (
    -1.4 * _normalize_small(basis, 0.0015)
    -0.8 * _normalize_small(funding + 0.5 * projected_funding, 0.0003)
    -0.6 * _normalize_small(r30s, 0.0020)
    -0.4 * _normalize_small(r2m, 0.0035)
    +0.4 * liquidity_score
    +0.2 * _normalize_small(atr_pctile - 0.5, 0.5)
  )

  if regime == "momentum":
    score = mom_score
  elif regime == "mean_reversion":
    score = mr_score
  else:
    score = 0.0

  p_up = clamp(sigmoid(score), 0.01, 0.99)

  desired = "FLAT"
  if regime != "no_trade":
    if p_up >= cfg.open_confidence_threshold:
      desired = "LONG"
    elif p_up <= (1.0 - cfg.open_confidence_threshold):
      desired = "SHORT"

  reason = (
    f"regime={regime}, p_up={p_up:.3f}, r10s={r10s:.5f}, r30s={r30s:.5f}, "
    f"r2m={r2m:.5f}, r5m={r5m:.5f}, atrPct={atr_pct:.6f}, atrPctile={atr_pctile:.2f}, "
    f"basis={basis:.5f}, funding={funding:.6f}, pfunding={projected_funding:.6f}, "
    f"spreadBps={spread_bps:.2f}, oiDelta={oi_delta:.2f}, cvd={cvd_score:.3f}"
  )

  feats = [r10s, r30s, r2m, r5m, basis, funding]

  return SignalResult(
    p_up=p_up,
    desired=desired,
    regime=regime,
    reason=reason,
    features=feats,
    spread_bps=spread_bps,
    atr_pct=atr_pct,
    liquidity_score=liquidity_score,
  )


def should_close_for_confidence(position_side: str, p_up: float, close_threshold: float) -> bool:
  side = str(position_side or "").upper()
  if side == "LONG":
    return p_up < close_threshold
  if side == "SHORT":
    return p_up > (1.0 - close_threshold)
  return False


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
  min_hold_enforced: bool = True,
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
  trail_pct = cfg.trailing_stop_pct if cfg.trailing_stop_pct and cfg.trailing_stop_pct > 0 else None

  if side == "LONG":
    if stop_pct and mark_price <= entry * (1.0 - stop_pct):
      return RiskCheckResult(True, "stop_loss", "SL")
    if take_pct and mark_price >= entry * (1.0 + take_pct):
      return RiskCheckResult(True, "take_profit", "TP")
    if trail_pct and position.peak_price and mark_price <= float(position.peak_price) * (1.0 - trail_pct):
      return RiskCheckResult(True, "trailing_stop", "TRAIL")

  if side == "SHORT":
    if stop_pct and mark_price >= entry * (1.0 + stop_pct):
      return RiskCheckResult(True, "stop_loss", "SL")
    if take_pct and mark_price <= entry * (1.0 - take_pct):
      return RiskCheckResult(True, "take_profit", "TP")
    if trail_pct and position.trough_price and mark_price >= float(position.trough_price) * (1.0 + trail_pct):
      return RiskCheckResult(True, "trailing_stop", "TRAIL")

  return RiskCheckResult(False, None, None)


def size_liquidity_multiplier(spread_bps: float, liquidity_score: float) -> float:
  spread_penalty = clamp((spread_bps - 2.0) / 30.0, 0.0, 0.8)
  liq_penalty = clamp(1.0 - liquidity_score, 0.0, 0.7)
  m = 1.0 - max(spread_penalty, liq_penalty)
  return clamp(m, 0.2, 1.0)
