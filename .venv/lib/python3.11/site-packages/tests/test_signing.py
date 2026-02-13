"""Tests for private_key override in signing functions.

This module tests that signing functions correctly use the private_key
parameter override instead of the client's default private key.
"""

import pytest
from decimal import Decimal, ROUND_HALF_UP
from eth_account import Account
from eth_account.messages import encode_typed_data
from ethereal.rest.util import client_order_id_to_bytes32, uuid_to_bytes32


def _round_price_to_tick_size(price: float, tick_size: float) -> float:
    """Round price to the nearest valid tick size.

    Args:
        price: The price to round
        tick_size: The tick size to round to

    Returns:
        The rounded price
    """
    if tick_size == 0:
        return price

    price_decimal = Decimal(str(price))
    tick_size_decimal = Decimal(str(tick_size))
    return float(
        (price_decimal / tick_size_decimal).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP
        )
        * tick_size_decimal
    )


def _verify_signature(
    signature: str,
    message: dict,
    domain: dict,
    types: dict,
    primary_type: str,
    expected_signer: str,
    should_not_be_signer: str,
) -> None:
    """Verify an EIP-712 signature matches the expected signer.

    Args:
        signature: The signature to verify
        message: The signed message data
        domain: The EIP-712 domain
        types: The EIP-712 type definitions
        primary_type: The primary type name
        expected_signer: The address that should have signed
        should_not_be_signer: The address that should NOT have signed

    Raises:
        AssertionError: If signature verification fails
    """
    # Reconstruct the full typed data message
    domain["chainId"] = int(domain["chainId"])
    full_message = {
        "types": types,
        "primaryType": primary_type,
        "domain": domain,
        "message": message,
    }

    # Encode and recover the signer address
    encoded_message = encode_typed_data(full_message=full_message)
    recovered_address = Account.recover_message(encoded_message, signature=signature)

    # Verify the signer is the expected account
    assert recovered_address == expected_signer, (
        f"Expected signature from {expected_signer}, "
        f"but got signature from {recovered_address}"
    )
    assert recovered_address != should_not_be_signer, (
        f"Signature should be from {expected_signer}, not {should_not_be_signer}"
    )


@pytest.mark.asyncio
async def test_sign_order_uses_default_key(async_rc, async_subaccount):
    """Test that sign_order uses the client's default key when no override is provided.

    This test verifies the default behavior: when no private_key parameter
    is provided, sign_order() uses the client's default private key.
    """
    # Get product info
    products = await async_rc.list_products()
    pid = products[0].id
    product_info = (await async_rc.products_by_id())[pid]
    tick_size = float(product_info.tick_size)

    # Get a valid price
    prices = (await async_rc.list_market_prices(product_ids=[pid]))[0]
    best_bid_price = float(prices.best_bid_price)
    bid_price = _round_price_to_tick_size(best_bid_price * 0.90, tick_size)

    # Prepare an order (without signature)
    order = await async_rc.prepare_order(
        sender=async_rc.chain.address,
        price=bid_price,
        quantity=0.003,
        side=0,
        subaccount=async_subaccount.name,
        onchain_id=product_info.onchain_id,
        order_type="LIMIT",
        time_in_force="GTD",
        post_only=False,
        include_signature=False,
    )

    # Sign the order WITHOUT providing a private_key override
    signed_order = await async_rc.sign_order(order)

    # Verify the signature is not empty
    assert signed_order.signature, "Signature should not be empty"
    assert signed_order.signature.startswith("0x"), "Signature should start with 0x"

    # Reconstruct the message for signature verification
    message = order.data.model_dump(mode="json", by_alias=True)
    message["quantity"] = int(Decimal(message["quantity"]) * Decimal("1e9"))
    message["price"] = int(Decimal(message.get("price", 0)) * Decimal("1e9"))
    message["productId"] = int(message["onchainId"])
    message["signedAt"] = int(message["signedAt"])
    if message.get("clientOrderId"):
        message["clientOrderId"] = client_order_id_to_bytes32(message["clientOrderId"])

    # Get domain and types for verification
    primary_type = "TradeOrder"
    domain = async_rc.rpc_config.domain.model_dump(mode="json", by_alias=True)
    types = async_rc.chain.get_signature_types(async_rc.rpc_config, primary_type)

    # Reconstruct the full typed data message
    domain["chainId"] = int(domain["chainId"])
    full_message = {
        "types": types,
        "primaryType": primary_type,
        "domain": domain,
        "message": message,
    }

    # Encode and recover the signer address
    encoded_message = encode_typed_data(full_message=full_message)
    recovered_address = Account.recover_message(
        encoded_message, signature=signed_order.signature
    )

    # Verify the signer is the client's default address
    assert recovered_address == async_rc.chain.address, (
        f"Expected signature from client's address {async_rc.chain.address}, "
        f"but got signature from {recovered_address}"
    )


@pytest.mark.asyncio
async def test_sign_order_with_private_key_override(async_rc, async_subaccount):
    """Test that sign_order uses the private_key override correctly.

    This test verifies that when a private_key parameter is provided to
    sign_order(), the signature is created using that key rather than
    the client's default private key.
    """
    # Create a random account for testing
    random_account = Account.create()
    random_private_key = random_account.key.hex()

    # Get product info
    products = await async_rc.list_products()
    pid = products[0].id
    product_info = (await async_rc.products_by_id())[pid]
    tick_size = float(product_info.tick_size)

    # Get a valid price
    prices = (await async_rc.list_market_prices(product_ids=[pid]))[0]
    best_bid_price = float(prices.best_bid_price)
    bid_price = _round_price_to_tick_size(best_bid_price * 0.90, tick_size)

    # Prepare an order (without signature)
    order = await async_rc.prepare_order(
        sender=async_rc.chain.address,
        price=bid_price,
        quantity=0.003,
        side=0,
        subaccount=async_subaccount.name,
        onchain_id=product_info.onchain_id,
        order_type="LIMIT",
        time_in_force="GTD",
        post_only=False,
        include_signature=False,
    )

    # Sign the order with the random account's private key
    signed_order = await async_rc.sign_order(order, private_key=random_private_key)

    # Verify the signature is not empty
    assert signed_order.signature, "Signature should not be empty"
    assert signed_order.signature.startswith("0x"), "Signature should start with 0x"

    # Reconstruct the message for signature verification
    message = order.data.model_dump(mode="json", by_alias=True)
    message["quantity"] = int(Decimal(message["quantity"]) * Decimal("1e9"))
    message["price"] = int(Decimal(message.get("price", 0)) * Decimal("1e9"))
    message["productId"] = int(message["onchainId"])
    message["signedAt"] = int(message["signedAt"])
    if message.get("clientOrderId"):
        message["clientOrderId"] = client_order_id_to_bytes32(message["clientOrderId"])

    # Get domain and types for verification
    primary_type = "TradeOrder"
    domain = async_rc.rpc_config.domain.model_dump(mode="json", by_alias=True)
    types = async_rc.chain.get_signature_types(async_rc.rpc_config, primary_type)

    # Verify the signature was created with the override key
    _verify_signature(
        signature=signed_order.signature,
        message=message,
        domain=domain,
        types=types,
        primary_type=primary_type,
        expected_signer=random_account.address,
        should_not_be_signer=async_rc.chain.address,
    )


@pytest.mark.asyncio
async def test_sign_cancel_order_uses_default_key(async_rc, async_subaccount):
    """Test that sign_cancel_order uses the client's default key when no override is provided.

    This test verifies the default behavior: when no private_key parameter
    is provided, sign_cancel_order() uses the client's default private key.
    """
    # Prepare a cancel order (without signature)
    cancel_order = await async_rc.prepare_cancel_order(
        sender=async_rc.chain.address,
        subaccount=async_subaccount.name,
        order_ids=[],
        client_order_ids=[],
        include_signature=False,
    )

    # Sign WITHOUT providing a private_key override
    signed_cancel = await async_rc.sign_cancel_order(cancel_order)

    # Verify the signature is not empty
    assert signed_cancel.signature, "Signature should not be empty"
    assert signed_cancel.signature.startswith("0x"), "Signature should start with 0x"

    # Reconstruct the message for signature verification
    message = cancel_order.data.model_dump(mode="json", by_alias=True)

    order_ids = (
        [uuid_to_bytes32(str(order_id)) for order_id in cancel_order.data.order_ids]
        if cancel_order.data.order_ids
        else []
    )
    message["orderIds"] = order_ids

    client_order_ids = (
        [client_order_id_to_bytes32(id) for id in cancel_order.data.client_order_ids]
        if cancel_order.data.client_order_ids
        else []
    )
    message["clientOrderIds"] = client_order_ids

    # Get domain and types for verification
    primary_type = "CancelOrder"
    domain = async_rc.rpc_config.domain.model_dump(mode="json", by_alias=True)
    types = async_rc.chain.get_signature_types(async_rc.rpc_config, primary_type)

    # Reconstruct the full typed data message
    domain["chainId"] = int(domain["chainId"])
    full_message = {
        "types": types,
        "primaryType": primary_type,
        "domain": domain,
        "message": message,
    }

    # Encode and recover the signer address
    encoded_message = encode_typed_data(full_message=full_message)
    recovered_address = Account.recover_message(
        encoded_message, signature=signed_cancel.signature
    )

    # Verify the signer is the client's default address
    assert recovered_address == async_rc.chain.address, (
        f"Expected signature from client's address {async_rc.chain.address}, "
        f"but got signature from {recovered_address}"
    )


@pytest.mark.asyncio
async def test_sign_cancel_order_with_private_key_override(async_rc, async_subaccount):
    """Test that sign_cancel_order uses the private_key override correctly.

    This test verifies that when a private_key parameter is provided to
    sign_cancel_order(), the signature is created using that key rather than
    the client's default private key.
    """
    # Create a random account for testing
    random_account = Account.create()
    random_private_key = random_account.key.hex()

    # Prepare a cancel order (without signature)
    cancel_order = await async_rc.prepare_cancel_order(
        sender=async_rc.chain.address,
        subaccount=async_subaccount.name,
        order_ids=[],
        client_order_ids=[],
        include_signature=False,
    )

    # Sign with the random account's private key
    signed_cancel = await async_rc.sign_cancel_order(
        cancel_order, private_key=random_private_key
    )

    # Verify the signature is not empty
    assert signed_cancel.signature, "Signature should not be empty"
    assert signed_cancel.signature.startswith("0x"), "Signature should start with 0x"

    # Reconstruct the message for signature verification
    message = cancel_order.data.model_dump(mode="json", by_alias=True)

    order_ids = (
        [uuid_to_bytes32(str(order_id)) for order_id in cancel_order.data.order_ids]
        if cancel_order.data.order_ids
        else []
    )
    message["orderIds"] = order_ids

    client_order_ids = (
        [client_order_id_to_bytes32(id) for id in cancel_order.data.client_order_ids]
        if cancel_order.data.client_order_ids
        else []
    )
    message["clientOrderIds"] = client_order_ids

    # Get domain and types for verification
    primary_type = "CancelOrder"
    domain = async_rc.rpc_config.domain.model_dump(mode="json", by_alias=True)
    types = async_rc.chain.get_signature_types(async_rc.rpc_config, primary_type)

    # Verify the signature was created with the override key
    _verify_signature(
        signature=signed_cancel.signature,
        message=message,
        domain=domain,
        types=types,
        primary_type=primary_type,
        expected_signer=random_account.address,
        should_not_be_signer=async_rc.chain.address,
    )
