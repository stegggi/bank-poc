import sqlite3
from typing import Any, Dict, List, Optional, Tuple

SCHEMA = """
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
  side TEXT NOT NULL,          -- LONG | SHORT | FLAT
  score REAL NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  ts_ms INTEGER NOT NULL,
  side TEXT NOT NULL,          -- BUY | SELL
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
  conn = sqlite3.connect(db_path, check_same_thread=False)
  conn.execute("PRAGMA foreign_keys=ON;")
  conn.executescript(SCHEMA)
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
