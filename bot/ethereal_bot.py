import os
import time
import json
import httpx
from typing import Any, Dict, Optional, List, Tuple

from ethereal import AsyncRESTClient  # official SDK :contentReference[oaicite:13]{index=13}

from db import insert_tick, last_ticks, insert_decision, insert_trade, model_get, model_set
from strategy import OnlineLogit, features_from_prices, decide_side

def _env(name: str, default: Optional[str] = None) -> str:
  v = os.getenv(name, default)
  if v is None or v == "":
    raise RuntimeError(f"Missing env var: {name}")
  return v

def _num(x: Any) -> Optional[float]:
  try:
    if x is None:
      return None
    return float(x)
  except:
    return None

class UC5Bot:
  def __init__(self, db_conn):
    self.db = db_conn

    self.dashboard_url = _env("UC5_DASHBOARD_URL").rstrip("/")
    self.bot_token = _env("UC5_BOT_TOKEN")

    self.api_url = _env("ETHEREAL_API_URL", "https://api.ethereal.trade").rstrip("/")
    self.chain_rpc = _env("ETHEREAL_CHAIN_RPC_URL", "https://rpc.ethereal.trade").rstrip("/")

    self.private_key = _env("ETHEREAL_PRIVATE_KEY")
    self.subaccount_name = _env("ETHEREAL_SUBACCOUNT_NAME", "primary")
    self.subaccount_id = _env("ETHEREAL_SUBACCOUNT_ID")
    self.ticker = _env("ETHEREAL_TICKER", "BTCUSD")

    self.client: Optional[AsyncRESTClient] = None
    self.product_id: Optional[str] = None

    # model
    s = model_get(self.db, "logit_v1")
    self.model = OnlineLogit.loads(s) if s else OnlineLogit()

    self.last_trade_ts = 0

  async def start(self):
    self.client = await AsyncRESTClient.create(
      private_key=self.private_key,
      api_url=self.api_url,
      chain_rpc_url=self.chain_rpc,
      subaccount=self.subaccount_name,
    )
    # fetch product UUID by ticker (public endpoint)
    async with httpx.AsyncClient(timeout=10) as h:
      r = await h.get(f"{self.api_url}/v1/product", params={"ticker": self.ticker})
      j = r.json()
      prod = j.get("data", [None])[0]
      if not prod or not prod.get("id"):
        raise RuntimeError(f"Could not find product for ticker={self.ticker}")
      self.product_id = prod["id"]

  async def fetch_config(self) -> Dict[str, Any]:
    async with httpx.AsyncClient(timeout=10) as h:
      r = await h.get(f"{self.dashboard_url}/api/uc5/config", headers={"cache-control": "no-store"})
      j = r.json()
      return j.get("config") or {}

  async def publish_journal(self, events: List[Dict[str, Any]]) -> None:
    payload = {"events": events}
    async with httpx.AsyncClient(timeout=10) as h:
      await h.post(
        f"{self.dashboard_url}/api/uc5/journal",
        json=payload,
        headers={"x-uc5-bot-token": self.bot_token, "content-type": "application/json"},
      )

  async def market_price(self) -> Tuple[int, float, Optional[float], Optional[float]]:
    # GET /v1/product/market-price returns array for productIds (market updates ~1s) :contentReference[oaicite:14]{index=14}
    assert self.product_id is not None
    params = [("productIds", self.product_id)]
    async with httpx.AsyncClient(timeout=10) as h:
      r = await h.get(f"{self.api_url}/v1/product/market-price", params=params)
      j = r.json()
      row = (j.get("data") or [None])[0]
      ts_ms = int(time.time() * 1000)
      oracle = float(row.get("oraclePrice"))
      bid = _num(row.get("bestBidPrice"))
      ask = _num(row.get("bestAskPrice"))
      return ts_ms, oracle, bid, ask

  async def maybe_trade(self, cfg: Dict[str, Any], side: str, price: float, score: float) -> Optional[Dict[str, Any]]:
    # Guardrails
    enabled = bool(cfg.get("enabled", False))
    cooldown_sec = float(cfg.get("cooldownSec", 45))
    max_leverage = float(cfg.get("maxLeverage", 2))
    position_usd = float(cfg.get("positionUsd", 40))

    if not enabled:
      return None

    now = int(time.time())
    if (now - self.last_trade_ts) < int(cooldown_sec):
      return None

    # Very simple: we submit a market-style order (SDK handles signing/auth)
    # Qty in BTC = notional / price
    qty = position_usd / max(price, 1e-9)
    # keep qty tiny by default; you can tune in dashboard

    if side == "FLAT":
      return None

    order_side = "BUY" if side == "LONG" else "SELL"

    try:
      assert self.client is not None
      # Most reliable MVP: MARKET order
      resp = await self.client.create_order(
        order_type="MARKET",
        quantity=str(qty),
        side=order_side,
        ticker=self.ticker,
        # leverage is enforced by margin engine; we cap notional ourselves
      )
      self.last_trade_ts = now
      return {"ok": True, "orderSide": order_side, "qty": qty, "resp": resp, "score": score}
    except Exception as e:
      return {"ok": False, "orderSide": order_side, "qty": qty, "err": str(e), "score": score}

  async def loop(self):
    if not self.client or not self.product_id:
      raise RuntimeError("Bot not started")

    journal_batch: List[Dict[str, Any]] = []

    while True:
      # 1) Collect tick
      ts_ms, oracle, bid, ask = await self.market_price()
      insert_tick(self.db, ts_ms, oracle, bid, ask)
      journal_batch.append({"t": "tick", "ts": ts_ms, "price": oracle})

      # 2) Load current config (from your dashboard)
      cfg = await self.fetch_config()
      decision_interval = int(cfg.get("decisionIntervalSec", 30))
      threshold = float(cfg.get("signalThreshold", 0.18))
      sentiment_bias = float(cfg.get("sentimentBias", 0))

      # 3) Every decision_interval seconds: compute features + decide
      if (ts_ms // 1000) % max(5, decision_interval) == 0:
        ticks = last_ticks(self.db, 120)  # last ~2 minutes (at 1s tick)
        prices = [p for (_, p) in ticks]
        x = features_from_prices(prices, sentiment_bias)
        prob_up = self.model.predict_prob_up(x)
        side, score = decide_side(prob_up, threshold)

        reason = f"p_up={prob_up:.3f}, score={score:.3f}, sentiment={sentiment_bias:.2f}"
        insert_decision(self.db, ts_ms, side, float(score), reason)
        journal_batch.append({"t": "decision", "ts": ts_ms, "side": side, "score": float(score), "reason": reason})

        # 4) Try trade (guard-railed)
        trade = await self.maybe_trade(cfg, side, oracle, float(score))
        if trade:
          if trade.get("ok"):
            insert_trade(self.db, ts_ms, trade["orderSide"], float(trade["qty"]), "submitted", "")
            journal_batch.append({"t": "trade", "ts": ts_ms, "side": trade["orderSide"], "qty": float(trade["qty"]), "status": "submitted"})
          else:
            insert_trade(self.db, ts_ms, trade["orderSide"], float(trade["qty"]), "error", trade.get("err", ""))
            journal_batch.append({"t": "trade", "ts": ts_ms, "side": trade["orderSide"], "qty": float(trade["qty"]), "status": "error", "info": trade.get("err", "")})

        # 5) Online “learning” update (very small):
        # Label: did price go up in the next N seconds?
        # We approximate by looking back: if we have price from N seconds ago, update now.
        horizon = 30
        if len(prices) > horizon + 5:
          p_now = prices[-1]
          p_then = prices[-1 - horizon]
          y = 1 if (p_now > p_then) else 0
          self.model.update(x, y)
          model_set(self.db, "logit_v1", self.model.dumps())

      # 6) Publish journal periodically
      if len(journal_batch) >= 10:
        await self.publish_journal(journal_batch[-200:])  # keep it bounded
        journal_batch = journal_batch[-50:]

      time.sleep(1.0)
