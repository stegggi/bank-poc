import os
import re
import glob
import time
import json
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

UTC = timezone.utc
DAY_RE = re.compile(r"^uc5_(\d{4}-\d{2}-\d{2})\.sqlite$")


def _f(x: Any) -> Optional[float]:
  try:
    if x is None:
      return None
    return float(x)
  except Exception:
    return None


def _row_get(row: Any, idx: int, default: Any = None) -> Any:
  try:
    if row is None:
      return default
    return row[idx]
  except Exception:
    return default

SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA temp_store=MEMORY;

CREATE TABLE IF NOT EXISTS ticks (
  ts_ms INTEGER PRIMARY KEY,
  price REAL NOT NULL,
  bid REAL,
  ask REAL,
  oracle REAL,
  basis REAL,
  spread REAL,
  cvd REAL,
  volume REAL,
  source TEXT
);

-- Backward compatibility with older readers.
CREATE TABLE IF NOT EXISTS prices (
  ts_ms INTEGER PRIMARY KEY,
  price REAL NOT NULL,
  oracle REAL,
  bid REAL,
  ask REAL
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL,
  horizon_sec INTEGER,
  p_up REAL,
  desired TEXT,
  regime TEXT,
  reason TEXT,
  f1 REAL,
  f2 REAL,
  f3 REAL,
  f4 REAL,
  f5 REAL,
  f6 REAL,
  y INTEGER,
  trained INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts_ms);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  ts_ms INTEGER,
  entry_ts INTEGER,
  exit_ts INTEGER,
  event_type TEXT,
  side TEXT,
  qty REAL,
  entry_price REAL,
  exit_price REAL,
  price REAL,
  pnl REAL,
  tag TEXT,
  reason_json TEXT,
  fees REAL,
  slippage_bps REAL,
  note TEXT,
  mid_at_entry REAL,
  mid_at_exit REAL
);

CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts_ms);
CREATE INDEX IF NOT EXISTS idx_trades_entry_ts ON trades(entry_ts);
CREATE INDEX IF NOT EXISTS idx_trades_exit_ts ON trades(exit_ts);

CREATE TABLE IF NOT EXISTS metrics (
  ts_ms INTEGER PRIMARY KEY,
  funding REAL,
  projected_funding REAL,
  open_interest REAL,
  oi_delta REAL,
  basis REAL,
  spread REAL,
  cvd_10s REAL,
  cvd_30s REAL,
  cvd_2m REAL,
  cvd_5m REAL,
  atr_pct REAL,
  liquidity_score REAL,
  regime TEXT
);

CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(ts_ms);

CREATE TABLE IF NOT EXISTS model (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
);
"""


def _utc_day_key(ts_ms: Optional[int] = None) -> str:
  if ts_ms is None:
    ts_ms = int(time.time() * 1000)
  return datetime.fromtimestamp(ts_ms / 1000.0, tz=UTC).strftime("%Y-%m-%d")


def _day_start_ms(day_key: str) -> int:
  dt = datetime.strptime(day_key, "%Y-%m-%d").replace(tzinfo=UTC)
  return int(dt.timestamp() * 1000)


def _to_day_key(v: datetime) -> str:
  return v.astimezone(UTC).strftime("%Y-%m-%d")


def _file_size(path: str) -> int:
  try:
    return os.path.getsize(path)
  except Exception:
    return 0


def _classify_close_reason(tag: Optional[str], reason_json: Optional[str]) -> str:
  tag_text = str(tag or "").strip().lower()
  reason_text = ""
  if reason_json:
    try:
      parsed = json.loads(reason_json)
      if isinstance(parsed, dict):
        reason_text = str(parsed.get("reason") or parsed.get("rule") or "").strip().lower()
      else:
        reason_text = str(parsed).strip().lower()
    except Exception:
      reason_text = str(reason_json).strip().lower()

  blob = f"{tag_text} {reason_text}"
  if "regime_end" in blob:
    return "regime_end"
  if "regime_flip" in blob:
    return "regime_flip"
  if "confidence" in blob or "close_confidence" in blob:
    return "confidence_change"
  if (
    "risk" in blob
    or "stop_loss" in blob
    or "take_profit" in blob
    or "trailing" in blob
    or "max_hold" in blob
  ):
    return "risk_loop"
  return "other"


def _downsample_series(points: List[Dict[str, Any]], max_points: int) -> List[Dict[str, Any]]:
  if max_points <= 0 or len(points) <= max_points:
    return points
  stride = max(1, len(points) // max_points)
  sampled = points[::stride]
  if sampled and points and sampled[-1].get("t") != points[-1].get("t"):
    sampled.append(points[-1])
  if len(sampled) > max_points:
    sampled = sampled[-max_points:]
  return sampled


class DailyDbManager:
  """
  UTC daily DB rotation + disk retention.

  File pattern:
    uc5_YYYY-MM-DD.sqlite
  """

  def __init__(
    self,
    db_dir: str,
    max_gb: float = 15.0,
    target_gb: float = 14.0,
    retention_interval_sec: int = 300,
  ):
    self.db_dir = os.path.abspath(os.path.expanduser(db_dir))
    self.max_bytes = int(max_gb * 1024 * 1024 * 1024)
    self.target_bytes = int(target_gb * 1024 * 1024 * 1024)
    self.retention_interval_sec = max(60, int(retention_interval_sec))

    self._lock = threading.RLock()
    self._conns: Dict[str, sqlite3.Connection] = {}
    self._last_retention_check = 0.0

    self._stats_cache: Optional[Dict[str, Any]] = None
    self._stats_cache_ms = 0

    os.makedirs(self.db_dir, exist_ok=True)
    self._get_conn_for_day(_utc_day_key())

  def today_path(self, now_ms: Optional[int] = None) -> str:
    return self.path_for_day(_utc_day_key(now_ms))

  def path_for_day(self, day_key: str) -> str:
    return os.path.join(self.db_dir, f"uc5_{day_key}.sqlite")

  def run_retention_if_due(self, force: bool = False) -> None:
    now = time.time()
    with self._lock:
      if not force and (now - self._last_retention_check) < self.retention_interval_sec:
        return
      self._last_retention_check = now
    self.enforce_disk_cap()

  def enforce_disk_cap(self) -> None:
    with self._lock:
      total = self.folder_size_bytes()
      if total <= self.max_bytes:
        return

      today = _utc_day_key()
      yesterday = _utc_day_key(int((time.time() - 86400) * 1000))
      base_files = self._list_daily_db_files()
      base_files.sort(key=lambda x: x[0])

      def _delete_day(day_key: str, base_path: str) -> None:
        nonlocal total
        for path in (base_path, f"{base_path}-wal", f"{base_path}-shm"):
          try:
            os.remove(path)
          except FileNotFoundError:
            pass
          except Exception:
            pass
        conn = self._conns.pop(day_key, None)
        if conn is not None:
          try:
            conn.close()
          except Exception:
            pass
        total = self.folder_size_bytes()

      # Pass 1: preserve today and yesterday if possible.
      for day_key, base_path in base_files:
        if total <= self.target_bytes:
          break
        if day_key in (today, yesterday):
          continue
        _delete_day(day_key, base_path)

      # Pass 2: if still over cap, yesterday may be removed as a last resort.
      if total > self.target_bytes:
        for day_key, base_path in base_files:
          if total <= self.target_bytes:
            break
          if day_key == today:
            continue
          _delete_day(day_key, base_path)

  def folder_size_bytes(self) -> int:
    total = 0
    for path in glob.glob(os.path.join(self.db_dir, "*")):
      if os.path.isfile(path):
        total += _file_size(path)
    return total

  def db_file_count(self) -> int:
    return len(self._list_daily_db_files())

  def close(self) -> None:
    with self._lock:
      for conn in self._conns.values():
        try:
          conn.close()
        except Exception:
          pass
      self._conns.clear()

  def write_tick(
    self,
    ts_ms: int,
    price: float,
    bid: Optional[float],
    ask: Optional[float],
    oracle: Optional[float],
    basis: Optional[float] = None,
    spread: Optional[float] = None,
    cvd: Optional[float] = None,
    volume: Optional[float] = None,
    source: str = "market_price",
  ) -> None:
    day = _utc_day_key(ts_ms)
    conn = self._get_conn_for_day(day)

    conn.execute(
      """
      INSERT OR REPLACE INTO ticks(ts_ms, price, bid, ask, oracle, basis, spread, cvd, volume, source)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      """,
      (int(ts_ms), float(price), bid, ask, oracle, basis, spread, cvd, volume, source),
    )
    conn.execute(
      "INSERT OR REPLACE INTO prices(ts_ms, price, oracle, bid, ask) VALUES(?,?,?,?,?)",
      (int(ts_ms), float(price), oracle, bid, ask),
    )
    conn.commit()

  def write_metric(self, ts_ms: int, metric: Dict[str, Any]) -> None:
    day = _utc_day_key(ts_ms)
    conn = self._get_conn_for_day(day)
    conn.execute(
      """
      INSERT OR REPLACE INTO metrics(
        ts_ms, funding, projected_funding, open_interest, oi_delta,
        basis, spread, cvd_10s, cvd_30s, cvd_2m, cvd_5m,
        atr_pct, liquidity_score, regime
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      """,
      (
        int(ts_ms),
        metric.get("funding"),
        metric.get("projectedFunding"),
        metric.get("openInterest"),
        metric.get("openInterestDelta"),
        metric.get("basis"),
        metric.get("spreadBps"),
        metric.get("cvd10s"),
        metric.get("cvd30s"),
        metric.get("cvd2m"),
        metric.get("cvd5m"),
        metric.get("atrPct"),
        metric.get("liquidityScore"),
        metric.get("regime"),
      ),
    )
    conn.commit()

  def insert_decision(
    self,
    ts_ms: int,
    p_up: float,
    desired: str,
    regime: str,
    reason: str,
    horizon_sec: int,
    features: Sequence[float],
  ) -> None:
    f = list(features) + [None] * 6
    day = _utc_day_key(ts_ms)
    conn = self._get_conn_for_day(day)
    conn.execute(
      """
      INSERT INTO decisions(
        ts_ms, horizon_sec, p_up, desired, regime, reason,
        f1, f2, f3, f4, f5, f6
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      """,
      (
        int(ts_ms),
        int(horizon_sec),
        float(p_up),
        str(desired),
        str(regime),
        str(reason),
        f[0],
        f[1],
        f[2],
        f[3],
        f[4],
        f[5],
      ),
    )
    conn.commit()

  def insert_trade_event(
    self,
    trade_id: str,
    ts_ms: int,
    event_type: str,
    side: Optional[str],
    qty: Optional[float],
    price: Optional[float],
    pnl: Optional[float],
    tag: Optional[str],
    reason_json: Optional[str],
    fees: Optional[float] = None,
    slippage_bps: Optional[float] = None,
    note: Optional[str] = None,
    entry_ts: Optional[int] = None,
    exit_ts: Optional[int] = None,
    entry_price: Optional[float] = None,
    exit_price: Optional[float] = None,
    mid_at_entry: Optional[float] = None,
    mid_at_exit: Optional[float] = None,
  ) -> None:
    day = _utc_day_key(ts_ms)
    conn = self._get_conn_for_day(day)
    conn.execute(
      """
      INSERT OR REPLACE INTO trades(
        id, ts_ms, entry_ts, exit_ts, event_type, side, qty,
        entry_price, exit_price, price, pnl, tag, reason_json, fees, slippage_bps, note,
        mid_at_entry, mid_at_exit
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      """,
      (
        str(trade_id),
        int(ts_ms),
        entry_ts,
        exit_ts,
        event_type,
        side,
        qty,
        entry_price,
        exit_price,
        price,
        pnl,
        tag,
        reason_json,
        fees,
        slippage_bps,
        note,
        mid_at_entry,
        mid_at_exit,
      ),
    )
    conn.commit()

  def model_get(self, key: str) -> Optional[str]:
    with self._lock:
      day_files = self._list_daily_db_files()
      day_files.sort(key=lambda x: x[0], reverse=True)

      for day_key, path in day_files:
        conn = self._conns.get(day_key)
        try:
          if conn is None:
            conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
          row = conn.execute(
            "SELECT value FROM model WHERE key=? ORDER BY updated_ms DESC LIMIT 1",
            (str(key),),
          ).fetchone()
          if row and row[0] is not None:
            return str(row[0])
        except Exception:
          pass
        finally:
          if day_key not in self._conns and conn is not None:
            try:
              conn.close()
            except Exception:
              pass
    return None

  def model_set(self, key: str, value: str, ts_ms: Optional[int] = None) -> None:
    if ts_ms is None:
      ts_ms = int(time.time() * 1000)
    conn = self._get_conn_for_day(_utc_day_key(ts_ms))
    conn.execute(
      "INSERT OR REPLACE INTO model(key, value, updated_ms) VALUES(?,?,?)",
      (str(key), str(value), int(ts_ms)),
    )
    conn.commit()

  def last_ticks(self, limit: int) -> List[Tuple[int, float]]:
    limit = max(1, int(limit))
    now_ms = int(time.time() * 1000)
    from_ms = now_ms - (48 * 60 * 60 * 1000)
    rows = self.load_ticks(from_ms, now_ms)
    out = [(int(r["ts_ms"]), float(r["price"])) for r in rows[-limit:]]
    return out

  def load_ticks(self, from_ms: int, to_ms: int) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for conn in self._connections_for_range(from_ms, to_ms):
      cur = conn.execute(
        """
        SELECT ts_ms, price, bid, ask, oracle, basis, spread, cvd, volume
        FROM ticks
        WHERE ts_ms >= ? AND ts_ms <= ?
        ORDER BY ts_ms ASC
        """,
        (int(from_ms), int(to_ms)),
      )
      for r in cur.fetchall():
        rows.append(
          {
            "ts_ms": int(r[0]),
            "price": float(r[1]),
            "bid": r[2],
            "ask": r[3],
            "oracle": r[4],
            "basis": r[5],
            "spread": r[6],
            "cvd": r[7],
            "volume": r[8],
          }
        )
    rows.sort(key=lambda x: int(x["ts_ms"]))
    return rows

  def get_recent_bars(self, lookback_seconds: int, bar_seconds: int, now_ms: Optional[int] = None) -> List[Dict[str, Any]]:
    if now_ms is None:
      now_ms = int(time.time() * 1000)
    lookback_seconds = max(60, int(lookback_seconds))
    bar_seconds = max(1, int(bar_seconds))
    from_ms = now_ms - lookback_seconds * 1000
    bucket_ms = bar_seconds * 1000
    ticks = self.load_ticks(from_ms, now_ms)
    if not ticks:
      return []

    bars: List[Dict[str, Any]] = []
    bucket_t: Optional[int] = None
    prices: List[float] = []
    volume_count = 0

    def _flush(bucket_time: Optional[int], bucket_prices: List[float], tick_count: int) -> None:
      if bucket_time is None or not bucket_prices:
        return
      bars.append(
        {
          "t": int(bucket_time),
          "o": float(bucket_prices[0]),
          "h": float(max(bucket_prices)),
          "l": float(min(bucket_prices)),
          "c": float(bucket_prices[-1]),
          "v": float(tick_count),
        }
      )

    for row in ticks:
      ts_ms = int(row.get("ts_ms") or 0)
      price = _f(row.get("price"))
      if price is None or price <= 0:
        continue
      current_bucket = (ts_ms // bucket_ms) * bucket_ms
      if bucket_t is None:
        bucket_t = current_bucket
      if current_bucket != bucket_t:
        _flush(bucket_t, prices, volume_count)
        bucket_t = current_bucket
        prices = []
        volume_count = 0
      prices.append(float(price))
      volume_count += 1

    _flush(bucket_t, prices, volume_count)
    return bars

  def load_latest_metric(self, now_ms: Optional[int] = None) -> Dict[str, Any]:
    if now_ms is None:
      now_ms = int(time.time() * 1000)
    from_ms = now_ms - (48 * 60 * 60 * 1000)
    latest: Optional[Tuple[int, sqlite3.Connection]] = None

    for conn in self._connections_for_range(from_ms, now_ms):
      row = conn.execute(
        """
        SELECT ts_ms FROM metrics WHERE ts_ms <= ? ORDER BY ts_ms DESC LIMIT 1
        """,
        (int(now_ms),),
      ).fetchone()
      if row is None:
        continue
      ts = int(row[0])
      if latest is None or ts > latest[0]:
        latest = (ts, conn)

    if latest is None:
      return {}

    row = latest[1].execute(
      """
      SELECT ts_ms, funding, projected_funding, open_interest, oi_delta,
             basis, spread, cvd_10s, cvd_30s, cvd_2m, cvd_5m,
             atr_pct, liquidity_score, regime
      FROM metrics WHERE ts_ms=?
      """,
      (latest[0],),
    ).fetchone()

    if row is None:
      return {}

    return {
      "ts_ms": int(row[0]),
      "funding": row[1],
      "projectedFunding": row[2],
      "openInterest": row[3],
      "openInterestDelta": row[4],
      "basis": row[5],
      "spreadBps": row[6],
      "cvd10s": row[7],
      "cvd30s": row[8],
      "cvd2m": row[9],
      "cvd5m": row[10],
      "atrPct": row[11],
      "liquidityScore": row[12],
      "regime": row[13],
    }

  def query_ingestion_stats(self) -> Dict[str, Any]:
    now_ms = int(time.time() * 1000)
    if self._stats_cache and (now_ms - self._stats_cache_ms) < 2000:
      return dict(self._stats_cache)

    day_ago = now_ms - 24 * 60 * 60 * 1000
    five_min_ago = now_ms - 5 * 60 * 1000

    min_ts: Optional[int] = None
    max_ts: Optional[int] = None
    total = 0
    cnt_24h = 0
    cnt_5m = 0

    for day_key, conn in self._iter_all_connections():
      try:
        row = conn.execute(
          """
          SELECT MIN(ts_ms), MAX(ts_ms), COUNT(*),
                 SUM(CASE WHEN ts_ms >= ? THEN 1 ELSE 0 END),
                 SUM(CASE WHEN ts_ms >= ? THEN 1 ELSE 0 END)
          FROM ticks
          """,
          (int(day_ago), int(five_min_ago)),
        ).fetchone()
      except Exception:
        continue
      if row is None:
        continue
      try:
        if len(row) < 5:
          continue
      except Exception:
        continue

      this_min = _row_get(row, 0)
      this_max = _row_get(row, 1)
      if this_min is not None:
        min_ts = int(this_min) if min_ts is None else min(min_ts, int(this_min))
      if this_max is not None:
        max_ts = int(this_max) if max_ts is None else max(max_ts, int(this_max))

      total += int(_row_get(row, 2, 0) or 0)
      cnt_24h += int(_row_get(row, 3, 0) or 0)
      cnt_5m += int(_row_get(row, 4, 0) or 0)

    folder_size = self.folder_size_bytes()
    out = {
      "collectingSince": min_ts,
      "lastTickAt": max_ts,
      "ticksCollected": total,
      "ticks24h": cnt_24h,
      "dbSizeBytes": folder_size,
      "ingestionRatePerMin5m": float(cnt_5m) / 5.0,
      "lastTickAgeSec": (max(0, int((now_ms - max_ts) / 1000)) if max_ts else None),
      "dbFiles": self.db_file_count(),
    }
    self._stats_cache = dict(out)
    self._stats_cache_ms = now_ms
    return out

  def query_chart_data(self, range_hours: int = 24, resolution_sec: int = 60) -> Dict[str, Any]:
    now_ms = int(time.time() * 1000)
    from_ms = now_ms - max(1, int(range_hours)) * 60 * 60 * 1000
    bucket_ms = max(1000, int(resolution_sec) * 1000)

    rows = self.load_ticks(from_ms, now_ms)

    candles: List[Dict[str, Any]] = []
    if rows:
      bucket = None
      bucket_prices: List[float] = []
      for r in rows:
        ts = int(r["ts_ms"])
        px = float(r["price"])
        b = (ts // bucket_ms) * bucket_ms
        if bucket is None:
          bucket = b
        if b != bucket:
          if bucket_prices:
            candles.append(
              {
                "t": int(bucket),
                "open": float(bucket_prices[0]),
                "high": float(max(bucket_prices)),
                "low": float(min(bucket_prices)),
                "close": float(bucket_prices[-1]),
              }
            )
          bucket = b
          bucket_prices = []
        bucket_prices.append(px)

      if bucket is not None and bucket_prices:
        candles.append(
          {
            "t": int(bucket),
            "open": float(bucket_prices[0]),
            "high": float(max(bucket_prices)),
            "low": float(min(bucket_prices)),
            "close": float(bucket_prices[-1]),
          }
        )

    markers: List[Dict[str, Any]] = []
    for conn in self._connections_for_range(from_ms, now_ms):
      cur = conn.execute(
        """
        SELECT ts_ms, event_type, side, price, tag, reason_json
        FROM trades
        WHERE ts_ms >= ?
          AND event_type IN ('ENTRY', 'EXIT', 'FLATTEN')
        ORDER BY ts_ms ASC
        """,
        (int(from_ms),),
      )
      for r in cur.fetchall():
        et = str(r[1] or "")
        marker: Dict[str, Any] = {
          "t": int(r[0]),
          "price": float(r[3]) if r[3] is not None else None,
          "type": "ENTRY" if et == "ENTRY" else "EXIT",
          "side": r[2],
          "eventType": et,
        }
        if et in ("EXIT", "FLATTEN"):
          marker["closeReason"] = _classify_close_reason(r[4], r[5])
        markers.append(marker)

    confidence: List[Dict[str, Any]] = []
    regime_strength: List[Dict[str, Any]] = []
    for conn in self._connections_for_range(from_ms, now_ms):
      cur = conn.execute(
        """
        SELECT ts_ms, p_up, regime, desired, reason
        FROM decisions
        WHERE ts_ms >= ? AND ts_ms <= ? AND p_up IS NOT NULL
        ORDER BY ts_ms ASC
        """,
        (int(from_ms), int(now_ms)),
      )
      for r in cur.fetchall():
        try:
          p_up = float(r[1])
        except Exception:
          continue
        state = str(r[2] or "")
        desired = str(r[3] or "")
        confidence.append(
          {
            "t": int(r[0]),
            "pUp": max(0.0, min(1.0, p_up)),
          }
        )
        regime_strength.append(
          {
            "t": int(r[0]),
            "strength": max(0.0, min(1.0, p_up)),
            "state": state,
            "direction": ("UP" if desired == "LONG" else ("DOWN" if desired == "SHORT" else None)),
            "reason": str(r[4] or ""),
          }
        )

    markers.sort(key=lambda x: int(x["t"]))
    confidence.sort(key=lambda x: int(x["t"]))
    regime_strength.sort(key=lambda x: int(x["t"]))
    wanted_days = set(self._days_for_range(from_ms, now_ms))
    present_days = {
      day_key
      for day_key in wanted_days
      if os.path.exists(self.path_for_day(day_key))
    }
    partial_24h = len(present_days) < len(wanted_days)
    return {
      "candles": candles[-1440:],
      "markers": markers[-500:],
      "confidence": _downsample_series(confidence, 3000),
      "regimeStrength": _downsample_series(regime_strength, 3000),
      "partial24h": partial_24h,
      "missingDays": sorted(list(wanted_days - present_days)),
    }

  def query_trades_summary(self) -> Dict[str, Any]:
    rows: List[Tuple] = []
    for _, conn in self._iter_all_connections():
      try:
        cur = conn.execute(
          """
          SELECT ts_ms, event_type, side, qty, price, pnl, tag, reason_json, fees, slippage_bps
          FROM trades
          WHERE event_type IN ('ENTRY', 'EXIT', 'FLATTEN')
          ORDER BY ts_ms ASC
          """
        )
      except Exception:
        continue
      for r in cur.fetchall():
        ts_ms_raw = _row_get(r, 0)
        et_raw = _row_get(r, 1)
        if ts_ms_raw is None or et_raw is None:
          continue
        try:
          ts_ms = int(ts_ms_raw)
        except Exception:
          continue
        rows.append(
          (
            ts_ms,
            str(et_raw or ""),
            str(_row_get(r, 2, "") or "") if _row_get(r, 2) is not None else None,
            float(_row_get(r, 3)) if _row_get(r, 3) is not None else None,
            float(_row_get(r, 4)) if _row_get(r, 4) is not None else None,
            float(_row_get(r, 5)) if _row_get(r, 5) is not None else None,
            str(_row_get(r, 6, "") or "") if _row_get(r, 6) is not None else None,
            str(_row_get(r, 7, "") or "") if _row_get(r, 7) is not None else None,
            float(_row_get(r, 8)) if _row_get(r, 8) is not None else None,
            float(_row_get(r, 9)) if _row_get(r, 9) is not None else None,
          )
        )

    rows.sort(key=lambda x: x[0])

    open_leg: Optional[Dict[str, Any]] = None
    closed: List[Tuple[int, Optional[float]]] = []
    close_reasons: List[str] = []
    all_fees: List[float] = []
    all_slippage: List[float] = []
    fees_with_ts: List[Tuple[int, float]] = []

    for ts_ms, et, side, qty, price, pnl, tag, reason_json, fees, slip_bps in rows:
      if et == "ENTRY":
        open_leg = {
          "ts_ms": ts_ms,
          "side": (side or "").upper(),
          "qty": qty,
          "price": price,
        }
        continue
      if et not in ("EXIT", "FLATTEN"):
        continue

      realized = pnl
      if (realized is None or abs(realized) < 1e-12) and open_leg:
        oside = str(open_leg.get("side") or "").upper()
        oqty = open_leg.get("qty")
        oprice = open_leg.get("price")
        if oqty and oprice and price:
          if oside == "LONG":
            realized = (price - oprice) * oqty
          elif oside == "SHORT":
            realized = (oprice - price) * oqty

      closed.append((ts_ms, realized))
      close_reasons.append(_classify_close_reason(tag, reason_json))
      if fees is not None:
        all_fees.append(float(fees))
        fees_with_ts.append((ts_ms, float(fees)))
      if slip_bps is not None:
        all_slippage.append(float(slip_bps))
      open_leg = None

    pnls = [float(p) for (_, p) in closed if p is not None]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]

    now_ms = int(time.time() * 1000)
    day_ago = now_ms - 24 * 60 * 60 * 1000
    realized_24h = sum(float(p or 0.0) for (ts, p) in closed if ts >= day_ago and p is not None)
    fees_24h = sum(f for (ts, f) in fees_with_ts if ts >= day_ago)
    total_fees = sum(all_fees) if all_fees else 0.0
    closed_by_confidence = sum(1 for r in close_reasons if r == "confidence_change")
    closed_by_regime_end = sum(1 for r in close_reasons if r == "regime_end")
    closed_by_regime_flip = sum(1 for r in close_reasons if r == "regime_flip")
    closed_by_risk = sum(1 for r in close_reasons if r == "risk_loop")
    closed_by_other = sum(1 for r in close_reasons if r == "other")

    return {
      "totalTrades": len(closed),
      "winRate": (len(wins) / len(pnls)) if pnls else 0.0,
      "avgWin": (sum(wins) / len(wins)) if wins else 0.0,
      "avgLoss": (sum(losses) / len(losses)) if losses else 0.0,
      "realizedPnlTotal": sum(pnls) if pnls else 0.0,
      "realizedPnlToday": realized_24h,
      "totalFeesUsd": total_fees,
      "feesTodayUsd": fees_24h,
      "netPnlTotal": (sum(pnls) - total_fees) if pnls else 0.0,
      "netPnlToday": realized_24h - fees_24h,
      "avgSlippageBps": (sum(all_slippage) / len(all_slippage)) if all_slippage else None,
      "closedByConfidence": closed_by_confidence,
      "closedByRegimeEnd": closed_by_regime_end,
      "closedByRegimeFlip": closed_by_regime_flip,
      "closedByRiskLoop": closed_by_risk,
      "closedByOther": closed_by_other,
    }

  def query_realized_pnl_since(self, from_ms: int) -> float:
    pnl = 0.0
    now_ms = int(time.time() * 1000)
    for conn in self._connections_for_range(from_ms, now_ms):
      cur = conn.execute(
        """
        SELECT pnl FROM trades
        WHERE ts_ms >= ?
          AND event_type IN ('EXIT', 'FLATTEN')
        """,
        (int(from_ms),),
      )
      for r in cur.fetchall():
        if r[0] is not None:
          try:
            pnl += float(r[0])
          except Exception:
            pass
    return pnl

  def query_trade_count_since(self, from_ms: int) -> int:
    """Count completed trades (EXIT + FLATTEN) since from_ms."""
    count = 0
    now_ms = int(time.time() * 1000)
    for conn in self._connections_for_range(from_ms, now_ms):
      try:
        cur = conn.execute(
          """
          SELECT COUNT(*) FROM trades
          WHERE ts_ms >= ?
            AND event_type IN ('EXIT', 'FLATTEN')
          """,
          (int(from_ms),),
        )
        row = cur.fetchone()
      except Exception:
        continue
      raw_count = _row_get(row, 0)
      if raw_count:
        try:
          count += int(raw_count)
        except Exception:
          pass
    return count

  def query_last_close_ts(self) -> Optional[int]:
    latest: Optional[int] = None
    for _, conn in self._iter_all_connections():
      try:
        row = conn.execute(
          """
          SELECT ts_ms
          FROM trades
          WHERE event_type IN ('EXIT', 'FLATTEN')
          ORDER BY ts_ms DESC
          LIMIT 1
          """
        ).fetchone()
      except Exception:
        continue
      if not row or row[0] is None:
        continue
      ts = int(row[0])
      latest = ts if latest is None else max(latest, ts)
    return latest

  def query_open_leg_from_trades(self) -> Optional[Dict[str, Any]]:
    rows: List[Tuple[int, str, Optional[str], Optional[float], Optional[float]]] = []
    for _, conn in self._iter_all_connections():
      cur = conn.execute(
        """
        SELECT ts_ms, event_type, side, qty, price
        FROM trades
        WHERE event_type IN ('ENTRY', 'EXIT', 'FLATTEN')
        ORDER BY ts_ms ASC
        """
      )
      for r in cur.fetchall():
        rows.append(
          (
            int(r[0]),
            str(r[1] or ""),
            str(r[2] or "") if r[2] is not None else None,
            float(r[3]) if r[3] is not None else None,
            float(r[4]) if r[4] is not None else None,
          )
        )

    rows.sort(key=lambda x: x[0])
    open_leg: Optional[Dict[str, Any]] = None
    for ts_ms, et, side, qty, price in rows:
      if et == "ENTRY":
        open_leg = {"ts_ms": ts_ms, "side": (side or "").upper(), "qty": qty, "price": price}
      elif et in ("EXIT", "FLATTEN"):
        open_leg = None
    return open_leg

  def query_last_open_entry(self) -> Optional[Dict[str, Any]]:
    """Return the most recent ENTRY row that has no following EXIT/FLATTEN (i.e. currently open position).
    Walks all DB files in order to match the same pairing logic as query_open_leg_from_trades,
    but returns the full row including entry_price and entry_ts."""
    rows: List[Tuple[int, str, Optional[str], Optional[float], Optional[float], Optional[float], Optional[int], Optional[str]]] = []
    for _, conn in self._iter_all_connections():
      cur = conn.execute(
        """
        SELECT ts_ms, event_type, side, qty, price, entry_price, entry_ts, reason_json
        FROM trades
        WHERE event_type IN ('ENTRY', 'EXIT', 'FLATTEN')
        ORDER BY ts_ms ASC
        """
      )
      for r in cur.fetchall():
        rows.append((
          int(r[0]),
          str(r[1] or ""),
          str(r[2] or "") if r[2] is not None else None,
          float(r[3]) if r[3] is not None else None,
          float(r[4]) if r[4] is not None else None,
          float(r[5]) if r[5] is not None else None,
          int(r[6]) if r[6] is not None else None,
          str(r[7]) if r[7] is not None else None,
        ))

    rows.sort(key=lambda x: x[0])
    open_row: Optional[Dict[str, Any]] = None
    for ts_ms, et, side, qty, price, entry_price, entry_ts, reason_json in rows:
      if et == "ENTRY":
        open_row = {
          "ts_ms": ts_ms,
          "side": (side or "").upper(),
          "qty": qty,
          "price": price,
          "entry_price": entry_price if entry_price is not None else price,
          "entry_ts": entry_ts if entry_ts is not None else ts_ms,
          "reason_json": reason_json,
        }
      elif et in ("EXIT", "FLATTEN"):
        open_row = None
    return open_row

  def query_trades_list(self, limit: int = 10, offset: int = 0) -> List[Dict[str, Any]]:
    """Return closed trades (EXIT + FLATTEN) newest first, with full detail."""
    rows: List[Dict[str, Any]] = []
    for _, conn in self._iter_all_connections():
      cur = conn.execute(
        """
        SELECT id, ts_ms, entry_ts, exit_ts, side, qty,
               entry_price, exit_price, pnl, fees, slippage_bps,
               tag, reason_json, note, mid_at_entry, mid_at_exit
        FROM trades
        WHERE event_type IN ('EXIT', 'FLATTEN')
        """
      )
      for r in cur.fetchall():
        entry_ts_val = int(r[2]) if r[2] is not None else None
        exit_ts_val = int(r[3]) if r[3] is not None else int(r[1]) if r[1] is not None else None
        duration_sec = None
        if entry_ts_val and exit_ts_val and exit_ts_val > entry_ts_val:
          duration_sec = int((exit_ts_val - entry_ts_val) / 1000)
        rows.append({
          "id": str(r[0] or ""),
          "ts_ms": int(r[1]) if r[1] is not None else None,
          "entry_ts": entry_ts_val,
          "exit_ts": exit_ts_val,
          "side": str(r[4] or "").upper() if r[4] else None,
          "qty": float(r[5]) if r[5] is not None else None,
          "entry_price": float(r[6]) if r[6] is not None else None,
          "exit_price": float(r[7]) if r[7] is not None else None,
          "pnl": float(r[8]) if r[8] is not None else None,
          "fees": float(r[9]) if r[9] is not None else None,
          "slippage_bps": float(r[10]) if r[10] is not None else None,
          "tag": str(r[11] or "") if r[11] else None,
          "close_reason": _classify_close_reason(r[11], r[12]),
          "note": str(r[13] or "") if r[13] else None,
          "mid_at_entry": float(r[14]) if r[14] is not None else None,
          "mid_at_exit": float(r[15]) if r[15] is not None else None,
          "duration_sec": duration_sec,
        })

    rows.sort(key=lambda x: x.get("ts_ms") or 0, reverse=True)
    return rows[offset: offset + limit]

  def query_trades_count(self) -> int:
    """Total count of closed trades (EXIT + FLATTEN) across all DB files."""
    count = 0
    for _, conn in self._iter_all_connections():
      try:
        row = conn.execute(
          "SELECT COUNT(*) FROM trades WHERE event_type IN ('EXIT', 'FLATTEN')"
        ).fetchone()
        raw_count = _row_get(row, 0)
        if raw_count:
          count += int(raw_count)
      except Exception:
        pass
    return count

  def utc_day_bounds_ms(self, now_ms: Optional[int] = None) -> Tuple[int, int]:
    if now_ms is None:
      now_ms = int(time.time() * 1000)
    dt = datetime.fromtimestamp(now_ms / 1000.0, tz=UTC)
    start = dt.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)

  def _get_conn_for_day(self, day_key: str) -> sqlite3.Connection:
    with self._lock:
      conn = self._conns.get(day_key)
      if conn is not None:
        return conn

      path = self.path_for_day(day_key)
      os.makedirs(os.path.dirname(path), exist_ok=True)
      conn = sqlite3.connect(path, check_same_thread=False, timeout=30)
      conn.row_factory = sqlite3.Row
      conn.executescript(SCHEMA_SQL)
      self._ensure_trade_columns(conn)
      conn.commit()
      self._conns[day_key] = conn
      return conn

  def _ensure_trade_columns(self, conn: sqlite3.Connection) -> None:
    cols = {r[1] for r in conn.execute("PRAGMA table_info(trades)").fetchall()}
    expected = {
      "entry_ts": "INTEGER",
      "exit_ts": "INTEGER",
      "entry_price": "REAL",
      "exit_price": "REAL",
      "tag": "TEXT",
      "reason_json": "TEXT",
      "fees": "REAL",
      "slippage_bps": "REAL",
      "note": "TEXT",
      "ts_ms": "INTEGER",
      "price": "REAL",
      "pnl": "REAL",
      "qty": "REAL",
      "side": "TEXT",
      "event_type": "TEXT",
      "mid_at_entry": "REAL",
      "mid_at_exit": "REAL",
    }
    for col, ddl in expected.items():
      if col not in cols:
        conn.execute(f"ALTER TABLE trades ADD COLUMN {col} {ddl}")

  def _iter_all_connections(self) -> Iterable[Tuple[str, sqlite3.Connection]]:
    for day_key, _ in self._list_daily_db_files():
      yield day_key, self._get_conn_for_day(day_key)

  def _connections_for_range(self, from_ms: int, to_ms: int) -> List[sqlite3.Connection]:
    conns: List[sqlite3.Connection] = []
    for day_key in self._days_for_range(from_ms, to_ms):
      path = self.path_for_day(day_key)
      if not os.path.exists(path):
        continue
      conns.append(self._get_conn_for_day(day_key))
    return conns

  def _days_for_range(self, from_ms: int, to_ms: int) -> List[str]:
    if to_ms < from_ms:
      from_ms, to_ms = to_ms, from_ms

    start = datetime.fromtimestamp(from_ms / 1000.0, tz=UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    end = datetime.fromtimestamp(to_ms / 1000.0, tz=UTC).replace(hour=0, minute=0, second=0, microsecond=0)

    days: List[str] = []
    cur = start
    while cur <= end:
      days.append(_to_day_key(cur))
      cur += timedelta(days=1)
    return days

  def _list_daily_db_files(self) -> List[Tuple[str, str]]:
    out: List[Tuple[str, str]] = []
    for path in glob.glob(os.path.join(self.db_dir, "uc5_*.sqlite")):
      name = os.path.basename(path)
      m = DAY_RE.match(name)
      if not m:
        continue
      out.append((m.group(1), path))
    return out


# ---- Backward-compatible helpers for older run.py / ethereal_bot.py ----
LEGACY_SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS ticks (
  ts_ms INTEGER NOT NULL,
  oracle_price REAL NOT NULL,
  best_bid REAL,
  best_ask REAL,
  PRIMARY KEY (ts_ms)
);

CREATE TABLE IF NOT EXISTS decisions (
  ts_ms INTEGER NOT NULL PRIMARY KEY,
  side TEXT NOT NULL,
  score REAL NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  ts_ms INTEGER NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  status TEXT NOT NULL,
  info TEXT,
  PRIMARY KEY (ts_ms, side, qty)
);

CREATE TABLE IF NOT EXISTS model (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


def connect(db_path: str) -> sqlite3.Connection:
  parent = os.path.dirname(os.path.abspath(db_path))
  os.makedirs(parent, exist_ok=True)
  conn = sqlite3.connect(db_path, check_same_thread=False)
  conn.execute("PRAGMA foreign_keys=ON;")
  conn.executescript(LEGACY_SCHEMA)
  return conn


def insert_tick(conn: sqlite3.Connection, ts_ms: int, oracle: float, bid: Optional[float], ask: Optional[float]) -> None:
  conn.execute(
    "INSERT OR REPLACE INTO ticks(ts_ms, oracle_price, best_bid, best_ask) VALUES(?,?,?,?)",
    (ts_ms, oracle, bid, ask),
  )
  conn.commit()


def last_ticks(conn: sqlite3.Connection, limit: int) -> List[Tuple[int, float]]:
  cur = conn.execute(
    "SELECT ts_ms, oracle_price FROM ticks ORDER BY ts_ms DESC LIMIT ?",
    (limit,),
  )
  rows = cur.fetchall()
  rows.reverse()
  return rows


def insert_decision(conn: sqlite3.Connection, ts_ms: int, side: str, score: float, reason: str) -> None:
  conn.execute(
    "INSERT OR REPLACE INTO decisions(ts_ms, side, score, reason) VALUES(?,?,?,?)",
    (ts_ms, side, score, reason),
  )
  conn.commit()


def insert_trade(conn: sqlite3.Connection, ts_ms: int, side: str, qty: float, status: str, info: str = "") -> None:
  conn.execute(
    "INSERT OR REPLACE INTO trades(ts_ms, side, qty, status, info) VALUES(?,?,?,?,?)",
    (ts_ms, side, qty, status, info),
  )
  conn.commit()


def model_get(conn: sqlite3.Connection, key: str) -> Optional[str]:
  cur = conn.execute("SELECT value FROM model WHERE key=?", (key,))
  row = cur.fetchone()
  return row[0] if row else None


def model_set(conn: sqlite3.Connection, key: str, value: str) -> None:
  conn.execute("INSERT OR REPLACE INTO model(key, value) VALUES(?,?)", (key, value))
  conn.commit()
