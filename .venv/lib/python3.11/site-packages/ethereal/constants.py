from importlib.metadata import version

USER_AGENT = f"ethereal-py-sdk/{version('ethereal-sdk')}"
PRIVATE_KEY = "PRIVATE_KEY"
RPC_URL = "RPC_URL"

BASE_URL = "https://api.etherealtest.net"
API_PREFIX = "/v1"

WS_BASE_URL = "wss://ws.etherealtest.net"

# Network URLs
NETWORK_URLS = {
    "mainnet": "https://api.ethereal.trade",
    "testnet": "https://api.etherealtest.net",
    "devnet": "https://api.etherealdev.net",
}

ARCHIVE_NETWORK_URLS = {
    "mainnet": "https://archive.ethereal.trade",
    "testnet": "https://archive.etherealtest.net",
    "devnet": "https://archive.etherealdev.net",
}
WS_NAMESPACES = [
    "/",
    "/v1/stream",
]

X_RATELIMIT_LIMIT = "x-ratelimit-limit"
X_RATELIMIT_REMAINING = "x-ratelimit-remaining"
RETRY_AFTER = "retry-after"
RATE_LIMIT_HEADERS = {X_RATELIMIT_LIMIT, X_RATELIMIT_REMAINING, RETRY_AFTER}
REST_COMMON_FIELDS = {
    X_RATELIMIT_LIMIT: "rate_limit_limit",
    X_RATELIMIT_REMAINING: "rate_limit_remaining",
    RETRY_AFTER: "retry_after",
}
