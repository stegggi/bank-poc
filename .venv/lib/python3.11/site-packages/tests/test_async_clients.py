import pytest
from web3 import Web3
from ethereal.models.config import (
    ChainConfig,
    RESTConfig,
)
from ethereal.async_rest_client import AsyncRESTClient


@pytest.mark.asyncio
async def test_async_rest_client_with_dict(network_config):
    """Test AsyncRESTClient initialization with dict config using network fixture."""
    test_account = Web3().eth.account.create()
    private_key = test_account.key.hex()
    client = await AsyncRESTClient.create(
        {
            "base_url": network_config["base_url"],
            "chain_config": {
                "private_key": private_key,
                "rpc_url": network_config["rpc_url"],
            },
        }
    )
    try:
        assert client is not None
        assert client.chain.chain_id == network_config["chain_id"]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_async_rest_client_with_class(network_config):
    """Test AsyncRESTClient initialization with RESTConfig class using network fixture."""
    test_account = Web3().eth.account.create()
    private_key = test_account.key.hex()

    chain_config = ChainConfig(
        rpc_url=network_config["rpc_url"],
        private_key=private_key,
    )

    config = RESTConfig(
        base_url=network_config["base_url"],
        chain_config=chain_config,
    )
    client = await AsyncRESTClient.create(config)
    try:
        assert client is not None
        assert client.chain.chain_id == network_config["chain_id"]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_async_rest_client_without_chain():
    """Test AsyncRESTClient initialization without chain config."""
    client = await AsyncRESTClient.create()
    try:
        assert client is not None
        assert client.chain is None
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_async_rest_client_with_empty_config():
    """Test AsyncRESTClient initialization with empty RESTConfig."""
    config = RESTConfig()
    client = await AsyncRESTClient.create(config)
    try:
        assert client is not None
        assert client.chain is None
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_async_client_with_network_parameter(network, network_config):
    """Test async client initialization with network parameter."""
    test_account = Web3().eth.account.create()
    private_key = test_account.key.hex()

    client = await AsyncRESTClient.create(
        {
            "network": network,
            "base_url": network_config["base_url"],
            "chain_config": {
                "chain_id": network_config["chain_id"],
                "rpc_url": network_config["rpc_url"],
                "private_key": private_key,
            },
        }
    )
    try:
        assert client is not None
        assert client.chain.chain_id == network_config["chain_id"]
        if hasattr(client, "config") and hasattr(client.config, "network"):
            assert client.config.network == network
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_async_read_only_client(network_config):
    """Test read-only async client initialization (address instead of private_key)."""
    test_account = Web3().eth.account.create()
    address = test_account.address

    client = await AsyncRESTClient.create(
        {
            "base_url": network_config["base_url"],
            "chain_config": {
                "chain_id": network_config["chain_id"],
                "rpc_url": network_config["rpc_url"],
                "address": address,
            },
        }
    )
    try:
        assert client is not None
        assert client.chain.chain_id == network_config["chain_id"]
        assert client.chain.address == address
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_list_products(async_rc):
    """Test listing products with the async client."""
    # Yield-style async fixture provides the ready client directly
    client = async_rc
    products = await client.list_products()
    assert products is not None
    assert isinstance(products, list)
    assert len(products) > 0


@pytest.mark.asyncio
async def test_async_client_methods_basic():
    """Test async client method-based accessors instead of async properties."""
    client = await AsyncRESTClient.create()
    try:
        products = await client.list_products()
        assert isinstance(products, list)

        tokens = await client.list_tokens()
        assert isinstance(tokens, list)

        # Build simple indices client-side for validation
        by_id = {p.id: p for p in products}
        assert isinstance(by_id, dict)
        if products and hasattr(products[0], "ticker"):
            by_ticker = {
                getattr(p, "ticker"): p for p in products if getattr(p, "ticker", None)
            }
            assert isinstance(by_ticker, dict)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_async_client_methods():
    """Test basic async client methods."""
    client = await AsyncRESTClient.create()
    try:
        # Test RPC config retrieval
        rpc_config = await client.get_rpc_config()
        assert rpc_config is not None

        # Test products first
        products = await client.list_products()
        assert isinstance(products, list)

        # Test market prices with product IDs if products exist
        if products:
            product_ids = [
                p.id for p in products[:2]
            ]  # Just test with first 2 products
            prices = await client.list_market_prices(product_ids=product_ids)
            assert isinstance(prices, list)
    finally:
        await client.close()
