"""Pure async tests for token operations."""

import warnings
import pytest
from ethereal.rest.util import ensure_bytes32_hex

DEFAULT_DESTINATION_ENDPOINT = 0


async def get_usd_token(client):
    """Helper to get the USD token."""
    tokens = await client.list_tokens()
    return next((t for t in tokens if t.name == "USD"), None)


@pytest.mark.asyncio
async def test_prepare_withdraw_token(async_rc_ro, network):
    subaccounts = await async_rc_ro.list_subaccounts(sender=async_rc_ro.chain.address)
    sub = subaccounts[0]
    token = await get_usd_token(async_rc_ro)
    destination_endpoint = DEFAULT_DESTINATION_ENDPOINT
    destination_address = async_rc_ro.chain.address
    dto = await async_rc_ro.prepare_withdraw_token(
        subaccount=sub.name,
        token=token.address,
        amount=100000,
        account=async_rc_ro.chain.address,
        destination_address=destination_address,
        destination_endpoint=destination_endpoint,
    )
    assert (
        isinstance(dto, async_rc_ro._models.InitiateWithdrawDto)
        and dto.data.token == token.address
        and dto.data.subaccount == sub.name
        and dto.data.amount == 100000
        and dto.data.account == async_rc_ro.chain.address
        and dto.signature == ""
        and dto.data.lz_destination_address == ensure_bytes32_hex(destination_address)
        and dto.data.lz_destination_eid.value == destination_endpoint
    )


@pytest.mark.asyncio
async def test_prepare_and_sign_withdraw_token(async_rc, network):
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]
    token = await get_usd_token(async_rc)
    destination_address = async_rc.chain.address
    dto = await async_rc.prepare_withdraw_token(
        subaccount=sub.name,
        token=token.address,
        amount=100000,
        account=async_rc.chain.address,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
    )
    signed = await async_rc.sign_withdraw_token(dto)
    assert (
        isinstance(signed, async_rc._models.InitiateWithdrawDto)
        and signed.signature != ""
    )


@pytest.mark.asyncio
async def test_prepare_with_automatic_signing(async_rc, network):
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]
    token = await get_usd_token(async_rc)
    destination_address = async_rc.chain.address
    dto = await async_rc.prepare_withdraw_token(
        subaccount=sub.name,
        token=token.address,
        amount=100000,
        account=async_rc.chain.address,
        include_signature=True,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
    )
    assert isinstance(dto, async_rc._models.InitiateWithdrawDto) and dto.signature != ""


@pytest.mark.asyncio
async def test_prepare_withdraw_token_with_custom_nonce(async_rc_ro, network):
    subaccounts = await async_rc_ro.list_subaccounts(sender=async_rc_ro.chain.address)
    sub = subaccounts[0]
    token = await get_usd_token(async_rc_ro)
    nonce = "123456789"
    destination_address = async_rc_ro.chain.address
    dto = await async_rc_ro.prepare_withdraw_token(
        subaccount=sub.name,
        token=token.address,
        amount=100000,
        account=async_rc_ro.chain.address,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
        nonce=nonce,
    )
    assert (
        isinstance(dto, async_rc_ro._models.InitiateWithdrawDto)
        and dto.data.nonce == nonce
    )


@pytest.mark.asyncio
async def test_prepare_withdraw_token_with_custom_signed_at(async_rc_ro, network):
    subaccounts = await async_rc_ro.list_subaccounts(sender=async_rc_ro.chain.address)
    sub = subaccounts[0]
    token = await get_usd_token(async_rc_ro)
    ts = 1620000000
    destination_address = async_rc_ro.chain.address
    dto = await async_rc_ro.prepare_withdraw_token(
        subaccount=sub.name,
        token=token.address,
        amount=100000,
        account=async_rc_ro.chain.address,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
        signed_at=ts,
    )
    assert (
        isinstance(dto, async_rc_ro._models.InitiateWithdrawDto)
        and dto.data.signed_at == ts
    )


@pytest.mark.asyncio
async def test_prepare_withdraw_token_with_custom_destination(async_rc_ro, network):
    subaccounts = await async_rc_ro.list_subaccounts(sender=async_rc_ro.chain.address)
    sub = subaccounts[0]
    token = await get_usd_token(async_rc_ro)
    destination_address = async_rc_ro.chain.address
    destination_endpoint = 40422
    dto = await async_rc_ro.prepare_withdraw_token(
        subaccount=sub.name,
        token=token.address,
        amount=100000,
        account=async_rc_ro.chain.address,
        destination_address=destination_address,
        destination_endpoint=destination_endpoint,
    )
    assert (
        isinstance(dto, async_rc_ro._models.InitiateWithdrawDto)
        and dto.data.token == token.address
        and dto.data.subaccount == sub.name
        and dto.data.amount == 100000
        and dto.data.account == async_rc_ro.chain.address
        and dto.signature == ""
        and dto.data.lz_destination_address == ensure_bytes32_hex(destination_address)
        and dto.data.lz_destination_eid.value == destination_endpoint
    )


@pytest.mark.skip(reason="This test actually submits a withdrawal request")
@pytest.mark.asyncio
async def test_prepare_sign_submit_withdraw_token(async_rc, network):
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]
    token = await get_usd_token(async_rc)
    destination_address = async_rc.chain.address
    dto = await async_rc.prepare_withdraw_token(
        subaccount=sub.name,
        token=token.address,
        amount=5,
        account=async_rc.chain.address,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
    )
    signed = await async_rc.sign_withdraw_token(dto)
    result = await async_rc.withdraw_token(signed, token_id=token.id)
    assert (
        isinstance(result, async_rc._models.WithdrawDto)
        and result.token == token.address
        and result.subaccount == sub.name
    )


@pytest.mark.asyncio
async def test_withdraw_token_dto_without_submit(async_rc, network):
    """Test withdrawal using the dto approach without submitting."""
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]
    token = await get_usd_token(async_rc)
    destination_address = async_rc.chain.address
    dto = await async_rc.prepare_withdraw_token(
        subaccount=sub.name,
        token=token.address,
        amount=50,
        account=async_rc.chain.address,
        include_signature=True,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
    )
    result = await async_rc.withdraw_token(dto, token_id=token.id, submit=False)
    assert (
        isinstance(result, async_rc._models.InitiateWithdrawDto)
        and result.data.token == token.address
        and result.data.subaccount == sub.name
        and result.signature != ""
    )


@pytest.mark.asyncio
async def test_withdraw_token_friendly_without_submit(async_rc, network):
    """Test withdrawal using the friendly params approach without submitting."""
    token = await get_usd_token(async_rc)
    destination_address = async_rc.chain.address

    result = await async_rc.withdraw_token(
        token_id=token.id,
        amount=50,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
        submit=False,
    )
    assert (
        isinstance(result, async_rc._models.InitiateWithdrawDto)
        and result.data.token == token.address
    )


@pytest.mark.asyncio
async def test_withdraw_token_friendly_params(async_rc, network):
    """Test the new friendly parameter interface for withdraw_token (without submit)."""
    token = await get_usd_token(async_rc)
    destination_address = async_rc.chain.address

    # Use the new friendly param interface with submit=False
    result = await async_rc.withdraw_token(
        token_id=token.id,
        amount=100,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
        submit=False,
    )

    assert isinstance(result, async_rc._models.InitiateWithdrawDto)
    assert result.data.token == token.address
    assert result.data.amount == 100
    assert result.signature != ""  # Should be signed by default


@pytest.mark.asyncio
async def test_withdraw_token_friendly_params_no_sign(async_rc, network):
    """Test the friendly parameter interface without signing."""
    token = await get_usd_token(async_rc)
    destination_address = async_rc.chain.address

    result = await async_rc.withdraw_token(
        token_id=token.id,
        amount=100000,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
        sign=False,
        submit=False,
    )

    assert isinstance(result, async_rc._models.InitiateWithdrawDto)
    assert result.signature == ""  # Should not be signed


@pytest.mark.asyncio
async def test_withdraw_token_deprecated_dto_warns(async_rc, network):
    """Test that using dto parameter triggers deprecation warning."""
    token = await get_usd_token(async_rc)
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]
    destination_address = async_rc.chain.address

    # Prepare a DTO the old way
    dto = await async_rc.prepare_withdraw_token(
        subaccount=sub.name,
        token=token.address,
        amount=100,
        account=async_rc.chain.address,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
        include_signature=True,
    )

    # Using dto should trigger deprecation warning
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        result = await async_rc.withdraw_token(dto, token_id=token.id, submit=False)

        # Check that deprecation warning was raised
        deprecation_warnings = [
            x for x in w if issubclass(x.category, DeprecationWarning)
        ]
        assert len(deprecation_warnings) >= 1
        assert "dto" in str(deprecation_warnings[0].message).lower()

    # Verify DTO is returned unchanged
    assert isinstance(result, async_rc._models.InitiateWithdrawDto)
    assert result.signature != ""
