import json
import math
from typing import Dict, List, Tuple, Optional

# This is intentionally simple:
# - We compute a few features from recent prices
# - We use a tiny online logistic model to estimate up/down probability
# - We add your manual sentimentBias (-1..+1) as an extra feature
#
# This does NOT guarantee profit. It’s a safe MVP skeleton that learns modestly from recent outcomes.

def _safe_log(x: float) -> float:
  return math.log(max(x, 1e-12))

def features_from_prices(prices: List[float], sentiment_bias: float) -> List[float]:
  if len(prices) < 5:
    return [0.0, 0.0, 0.0, float(sentiment_bias)]

  p = prices
  r1 = (p[-1] / p[-2]) - 1.0
  r5 = (p[-1] / p[-6]) - 1.0 if len(p) >= 6 else r1
  # crude volatility proxy
  window = p[-30:] if len(p) >= 30 else p
  rets = [(window[i] / window[i-1]) - 1.0 for i in range(1, len(window))]
  vol = math.sqrt(sum(x*x for x in rets) / max(1, len(rets)))
  return [r1, r5, vol, float(sentiment_bias)]

class OnlineLogit:
  def __init__(self, w: Optional[List[float]] = None, b: float = 0.0, lr: float = 0.15):
    self.w = w if w is not None else [0.0, 0.0, 0.0, 0.0]
    self.b = b
    self.lr = lr

  def predict_prob_up(self, x: List[float]) -> float:
    z = self.b + sum(self.w[i] * x[i] for i in range(len(self.w)))
    # sigmoid
    return 1.0 / (1.0 + math.exp(-max(-20.0, min(20.0, z))))

  def update(self, x: List[float], y: int) -> None:
    # y: 1 if up, 0 if down
    p = self.predict_prob_up(x)
    grad = (p - float(y))
    for i in range(len(self.w)):
      self.w[i] -= self.lr * grad * x[i]
    self.b -= self.lr * grad

  def dumps(self) -> str:
    return json.dumps({"w": self.w, "b": self.b, "lr": self.lr})

  @staticmethod
  def loads(s: str) -> "OnlineLogit":
    j = json.loads(s)
    return OnlineLogit(w=j.get("w"), b=float(j.get("b", 0.0)), lr=float(j.get("lr", 0.15)))

def decide_side(prob_up: float, threshold: float) -> Tuple[str, float]:
  # Convert probability to a signed score around 0
  score = (prob_up - 0.5) * 2.0  # -1..+1
  if score > threshold:
    return ("LONG", score)
  if score < -threshold:
    return ("SHORT", score)
  return ("FLAT", score)
