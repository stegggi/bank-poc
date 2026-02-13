import pytest
from web3 import Web3


def test_provider(rc):
    rc.logger.info(f"Chain ID: {rc.chain.chain_id}")
    assert rc.provider is not None
    assert isinstance(rc.provider, Web3)


def test_block(rc):
    """Test block method."""
    block = rc.provider.eth.get_block("latest")
    assert block is not None
    assert block.get("number") is not None
    assert block.get("hash") is not None


def test_nonce(rc):
    """Test nonce method."""
    nonce = rc.chain.get_nonce(rc.chain.address)
    rc.logger.info(f"Nonce: {nonce}")
    assert nonce is not None


def test_gas(rc):
    """Test gas methods."""
    gas_price = rc.provider.eth.gas_price
    rc.logger.info(f"Gas Price: {gas_price}")
    assert gas_price is not None
    assert gas_price > 0

    max_priority_fee = rc.provider.eth.max_priority_fee
    rc.logger.info(f"Max Priority Fee: {max_priority_fee}")
    assert max_priority_fee is not None

    gas_limit = rc.provider.eth.estimate_gas(
        {"from": rc.chain.address, "to": rc.chain.address, "value": 1}
    )
    rc.logger.info(f"Gas Limit: {gas_limit}")
    assert gas_limit is not None
    assert gas_limit > 0


def test_eth_balance(rc):
    """Test eth balance method."""
    balance = rc.chain.get_balance(rc.chain.address)
    rc.logger.info(f"Balance: {balance}")
    assert balance is not None
    assert balance >= 0


def test_usde_balance(rc):
    """Test token balance method."""
    balance = rc.chain.get_token_balance(rc.chain.address, rc.chain.usde.address)
    rc.logger.info(f"Balance: {balance}")
    assert balance is not None
    assert balance >= 0


def test_deposit_usde(rc):
    """Test USDe deposit."""
    deposit_tx = rc.chain.deposit_usde(100)
    rc.logger.info(f"Deposit Tx: {deposit_tx}")

    assert deposit_tx is not None
    assert deposit_tx.get("data") is not None
    assert deposit_tx.get("value") == rc.chain.provider.to_wei(100, "ether")
    assert rc.provider.is_checksum_address(deposit_tx.get("from"))
    assert rc.provider.is_checksum_address(deposit_tx.get("to"))


def test_deposit_usde_with_account_name_bytes(rc):
    """Test USDe deposit with account_name_bytes."""
    account_name_bytes = rc.chain.provider.to_hex(text="primary").ljust(66, "0")
    deposit_tx = rc.chain.deposit_usde(
        100, account_name=None, account_name_bytes=account_name_bytes
    )
    rc.logger.info(f"Deposit Tx: {deposit_tx}")

    assert deposit_tx is not None
    assert deposit_tx.get("data") is not None
    assert deposit_tx.get("value") == rc.chain.provider.to_wei(100, "ether")
    assert rc.provider.is_checksum_address(deposit_tx.get("from"))
    assert rc.provider.is_checksum_address(deposit_tx.get("to"))


def test_deposit_usde_with_both_params_fails(rc):
    """Test USDe deposit fails when both account_name and account_name_bytes are provided."""
    account_name_bytes = rc.chain.provider.to_hex(text="custom").ljust(66, "0")

    with pytest.raises(
        ValueError, match="Cannot provide both account_name and account_name_bytes"
    ):
        rc.chain.deposit_usde(
            100, account_name="custom", account_name_bytes=account_name_bytes
        )
