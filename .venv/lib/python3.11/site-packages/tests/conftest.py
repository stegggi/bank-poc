import os
import pytest
from dotenv import load_dotenv
from eth_account import Account
import ethereal
from ethereal.async_rest_client import AsyncRESTClient
from ethereal.rest.util import encode_account_name
import pytest_asyncio
from ethereal.ws.ws_base import WSBase
from ethereal.ws.async_ws_base import AsyncWSBase

# Force reload of the dotenv file.
load_dotenv(override=True)

# Network configurations with hardcoded URLs
NETWORKS = {
    "devnet": {
        "chain_id": 13374201,
        "base_url": "https://api.etherealdev.net/",
        "rpc_url": "https://rpc.etherealdev.net",
        "ws_url": "wss://ws.etherealdev.net/",
    },
    "testnet": {
        "chain_id": 13374202,
        "base_url": "https://api.etherealtest.net/",
        "rpc_url": "https://rpc.etherealtest.net",
        "ws_url": "wss://ws.etherealtest.net/",
    },
    "mainnet": {
        "chain_id": 5064014,
        "base_url": "https://api.ethereal.trade/",
        "rpc_url": "https://rpc.ethereal.trade",
        "ws_url": "wss://ws.ethereal.trade/",
    },
}


def pytest_addoption(parser):
    """Add --network option to pytest."""
    parser.addoption(
        "--network",
        action="store",
        default=os.getenv("NETWORK", "testnet"),
        choices=list(NETWORKS.keys()),
        help="Network to test against (default: testnet)",
    )


def pytest_collection_modifyitems(config, items):
    """Skip tests based on network markers."""
    network = config.getoption("--network")

    for item in items:
        # Skip tests marked for specific networks only
        if item.get_closest_marker(f"{network}_only") is None:
            # Check if it's marked for another network
            for net in NETWORKS:
                if net != network and item.get_closest_marker(f"{net}_only"):
                    item.add_marker(pytest.mark.skip(reason=f"Only runs on {net}"))

        # Skip tests marked to skip on current network
        if item.get_closest_marker(f"skip_{network}"):
            item.add_marker(pytest.mark.skip(reason=f"Skipped on {network}"))


@pytest.fixture(scope="session")
def network(request):
    """Current network being tested."""
    return request.config.getoption("--network")


@pytest.fixture(scope="session")
def network_config(network):
    """Network configuration for current network."""
    return NETWORKS[network]


@pytest.fixture(scope="session")
def private_key():
    """Get private key from environment."""
    key = os.getenv("PRIVATE_KEY")
    if not key:
        pytest.fail("PRIVATE_KEY environment variable is required")
    return key


@pytest.fixture(scope="session")
def rc(network, network_config, private_key):
    """REST client for testing."""
    config = {
        "network": network,
        "base_url": network_config["base_url"],
        "chain_config": {
            "chain_id": network_config["chain_id"],
            "rpc_url": network_config["rpc_url"],
            "private_key": private_key,
        },
    }
    rc = ethereal.RESTClient(config)
    assert rc is not None
    assert rc.chain is not None
    try:
        yield rc
    finally:
        rc.close()


@pytest.fixture(scope="session")
def rc_ro(network, network_config, private_key):
    """Read-only REST client for testing."""
    account = Account.from_key(private_key)
    address = account.address

    config = {
        "network": network,
        "base_url": network_config["base_url"],
        "chain_config": {
            "chain_id": network_config["chain_id"],
            "rpc_url": network_config["rpc_url"],
            "address": address,
        },
    }
    rc = ethereal.RESTClient(config)
    assert rc is not None
    assert rc.chain is not None
    return rc


@pytest.fixture(scope="session")
def ws_base(network_config):
    """Base WebSocket client for testing."""
    config = {
        "base_url": network_config["ws_url"],
    }
    ws = WSBase(config)
    ws.open(namespaces=["/", "/v1/stream"])
    assert ws is not None
    try:
        yield ws
    finally:
        try:
            ws.close()
        except RuntimeError:
            pass


@pytest.fixture(scope="session")
def ws(network_config):
    """WebSocket client for testing."""
    config = {
        "base_url": network_config["ws_url"],
    }
    ws = ethereal.WSClient(config)
    ws.open(namespaces=["/", "/v1/stream"])
    assert ws is not None
    try:
        yield ws
    finally:
        try:
            ws.close()
        except RuntimeError:
            pass


@pytest_asyncio.fixture
async def async_ws_base(network_config):
    """Async base WebSocket client for testing."""
    config = {
        "base_url": network_config["ws_url"],
    }
    ws = AsyncWSBase(config)
    await ws.open(namespaces=["/", "/v1/stream"])
    assert ws is not None
    try:
        yield ws
    finally:
        await ws.close()


@pytest_asyncio.fixture
async def async_ws(network_config):
    """Async WebSocket client for testing."""
    config = {
        "base_url": network_config["ws_url"],
    }
    ws = ethereal.AsyncWSClient(config)
    await ws.open(namespaces=["/", "/v1/stream"])
    assert ws is not None
    try:
        yield ws
    finally:
        await ws.close()


@pytest.fixture(scope="session")
def sid(rc):
    """Return the subaccount id for the current test."""
    if len(rc.subaccounts) == 0:
        raise ValueError("No subaccounts found for the connected address.")

    # get the `test` subaccount
    test_name = encode_account_name("test")
    for sub in rc.subaccounts:
        if sub.name == test_name:
            return sub.id
    raise ValueError("No 'test' subaccount found for the connected address.")


@pytest.fixture(scope="session")
def sname(rc):
    """Return the subaccount name for the current test."""
    if len(rc.subaccounts) == 0:
        raise ValueError("No subaccounts found for the connected address.")
    return rc.subaccounts[0].name


@pytest_asyncio.fixture
async def async_rc(network, network_config, private_key):
    """Asynchronous REST client for testing."""
    config = {
        "network": network,
        "base_url": network_config["base_url"],
        "chain_config": {
            "chain_id": network_config["chain_id"],
            "rpc_url": network_config["rpc_url"],
            "private_key": private_key,
        },
    }
    rc = await AsyncRESTClient.create(config)
    assert rc is not None
    assert rc.chain is not None
    try:
        yield rc
    finally:
        await rc.close()


@pytest_asyncio.fixture
async def async_rc_ro(network, network_config, private_key):
    """Read-only asynchronous REST client for testing."""
    account = Account.from_key(private_key)
    address = account.address

    config = {
        "network": network,
        "base_url": network_config["base_url"],
        "chain_config": {
            "chain_id": network_config["chain_id"],
            "rpc_url": network_config["rpc_url"],
            "address": address,
        },
    }
    rc = await AsyncRESTClient.create(config)
    assert rc is not None
    assert rc.chain is not None
    try:
        yield rc
    finally:
        await rc.close()


@pytest_asyncio.fixture
async def async_subaccount(async_rc):
    """Get first subaccount for async client."""
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    if not subaccounts:
        raise ValueError("No subaccounts found for the connected address.")
    return subaccounts[0]


@pytest_asyncio.fixture
async def async_subaccount_ro(async_rc_ro):
    """Get first subaccount for read-only async client."""
    subaccounts = await async_rc_ro.list_subaccounts(sender=async_rc_ro.chain.address)
    if not subaccounts:
        raise ValueError("No subaccounts found for the connected address.")
    return subaccounts[0]
