from web3 import Web3
from ethereal.models.config import (
    BaseConfig,
    WSConfig,
    ChainConfig,
    RESTConfig,
)
from ethereal.base_client import BaseClient
from ethereal.ws.ws_base import WSBase
from ethereal.chain_client import ChainClient
from ethereal.rest_client import RESTClient


def test_base_client_with_dict():
    """Test BaseClient initialization with dict config."""
    bc = BaseClient({"verbose": True})
    assert bc is not None


def test_base_client_with_class():
    """Test BaseClient initialization with BaseConfig class."""
    config = BaseConfig(verbose=True)
    bc = BaseClient(config)
    assert bc is not None


def test_ws_client_with_dict(network_config):
    """Test WSBase initialization with dict config using network fixture."""
    wsc = WSBase({"base_url": network_config["ws_url"], "verbose": True})
    assert wsc is not None
    assert str(wsc.base_url) == network_config["ws_url"]


def test_ws_client_with_class(network_config):
    """Test WSBase initialization with WSConfig class using network fixture."""
    config = WSConfig(base_url=network_config["ws_url"], verbose=True)
    wsc = WSBase(config)
    assert wsc is not None
    assert str(wsc.base_url) == network_config["ws_url"]


def test_chain_client_with_dict(network_config):
    """Test ChainClient initialization with dict config using network fixture."""
    test_account = Web3().eth.account.create()
    private_key = test_account.key.hex()

    cc = ChainClient(
        {
            "rpc_url": network_config["rpc_url"],
            "private_key": private_key,
        }
    )
    assert cc is not None
    assert cc.chain_id == network_config["chain_id"]


def test_chain_client_with_class(network_config):
    """Test ChainClient initialization with ChainConfig class using network fixture."""
    test_account = Web3().eth.account.create()
    private_key = test_account.key.hex()

    config = ChainConfig(
        rpc_url=network_config["rpc_url"],
        private_key=private_key,
    )
    cc = ChainClient(config)
    assert cc is not None
    assert cc.chain_id == network_config["chain_id"]


def test_rest_client_with_dict(network_config):
    """Test RESTClient initialization with dict config using network fixture."""
    test_account = Web3().eth.account.create()
    private_key = test_account.key.hex()

    rc = RESTClient(
        {
            "base_url": network_config["base_url"],
            "chain_config": {
                "private_key": private_key,
                "rpc_url": network_config["rpc_url"],
            },
        }
    )
    assert rc is not None
    assert rc._async_client.chain.chain_id == network_config["chain_id"]
    rc.close()


def test_rest_client_with_class(network_config):
    """Test RESTClient initialization with RESTConfig class using network fixture."""
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
    rc = RESTClient(config)
    assert rc is not None
    assert rc._async_client.chain.chain_id == network_config["chain_id"]
    rc.close()


def test_rest_client_without_chain():
    """Test RESTClient initialization without chain config."""
    rc = RESTClient()
    assert rc is not None
    assert rc._async_client.chain is None
    rc.close()  # Properly cleanup


def test_rest_client_with_empty_config():
    """Test RESTClient initialization with empty RESTConfig."""
    config = RESTConfig()
    rc = RESTClient(config)
    assert rc is not None
    assert rc._async_client.chain is None
    rc.close()  # Properly cleanup


def test_rest_client_with_context_manager():
    """Test RESTClient as context manager for automatic cleanup."""
    with RESTClient() as rc:
        assert rc is not None
        assert rc._async_client.chain is None
    # Client should be closed automatically


def test_sync_client_list_products():
    """Test sync client listing products."""
    rc = RESTClient()
    try:
        products = rc.list_products()
        assert products is not None
        assert isinstance(products, list)
    finally:
        rc.close()


def test_client_with_network_parameter(network, network_config):
    """Test client initialization with network parameter."""
    test_account = Web3().eth.account.create()
    private_key = test_account.key.hex()

    rc = RESTClient(
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
    assert rc is not None
    assert rc._async_client.chain.chain_id == network_config["chain_id"]

    if hasattr(rc._async_client, "config") and hasattr(
        rc._async_client.config, "network"
    ):
        assert rc._async_client.config.network == network

    rc.close()


def test_read_only_client(network_config):
    """Test read-only client initialization (address instead of private_key)."""
    test_account = Web3().eth.account.create()
    address = test_account.address

    rc = RESTClient(
        {
            "base_url": network_config["base_url"],
            "chain_config": {
                "chain_id": network_config["chain_id"],
                "rpc_url": network_config["rpc_url"],
                "address": address,
            },
        }
    )
    assert rc is not None
    assert rc._async_client.chain.chain_id == network_config["chain_id"]
    assert rc._async_client.chain.address == address
    rc.close()


def test_verbose_logging_configs(network_config):
    """Test verbose logging configuration across different clients."""
    verbose = True

    ws_config = WSConfig(base_url=network_config["ws_url"], verbose=verbose)
    wsc = WSBase(ws_config)
    assert wsc is not None
    assert wsc.config.verbose == verbose
