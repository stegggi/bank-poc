"""Pure sync tests for token operations."""

import warnings
import pytest
from ethereal.rest.util import ensure_bytes32_hex

DEFAULT_DESTINATION_ENDPOINT = 0


def get_usd_token(client):
    """Helper to get the USD token."""
    tokens = client.list_tokens()
    return next((t for t in tokens if t.name == "USD"), None)


def test_prepare_withdraw_token(rc_ro, network):
    subaccounts = rc_ro.list_subaccounts(sender=rc_ro.chain.address)
    sub = subaccounts[0]
    token = get_usd_token(rc_ro)
    destination_endpoint = DEFAULT_DESTINATION_ENDPOINT
    destination_address = rc_ro.chain.address
    dto = rc_ro.prepare_withdraw_token(
        subaccount=sub.name,
        token=token.address,
        amount=100000,
        account=rc_ro.chain.address,
        destination_address=destination_address,
        destination_endpoint=destination_endpoint,
    )
    assert (
        isinstance(dto, rc_ro._models.InitiateWithdrawDto)
        and dto.data.token == token.address
        and dto.data.subaccount == sub.name
        and dto.data.amount == 100000
        and dto.data.account == rc_ro.chain.address
        and dto.signature == ""
        and dto.data.lz_destination_address == ensure_bytes32_hex(destination_address)
        and dto.data.lz_destination_eid.value == destination_endpoint
    )


def test_prepare_and_sign_withdraw_token(rc, network):
    subaccounts = rc.list_subaccounts(sender=rc.chain.address)
    sub = subaccounts[0]
    token = get_usd_token(rc)
    destination_address = rc.chain.address
    dto = rc.prepare_withdraw_token(
        subaccount=sub.name,
        token=token.address,
        amount=100000,
        account=rc.chain.address,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
    )
    signed = rc.sign_withdraw_token(dto)
    assert isinstance(signed, rc._models.InitiateWithdrawDto) and signed.signature != ""


def test_prepare_with_automatic_signing(rc, network):
    subaccounts = rc.list_subaccounts(sender=rc.chain.address)
    sub = subaccounts[0]
    token = get_usd_token(rc)
    destination_address = rc.chain.address
    dto = rc.prepare_withdraw_token(
        subaccount=sub.name,
        token=token.address,
        amount=100000,
        account=rc.chain.address,
        include_signature=True,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
    )
    assert isinstance(dto, rc._models.InitiateWithdrawDto) and dto.signature != ""


def test_prepare_withdraw_token_with_custom_nonce(rc_ro, network):
    subaccounts = rc_ro.list_subaccounts(sender=rc_ro.chain.address)
    sub = subaccounts[0]
    token = get_usd_token(rc_ro)
    nonce = "123456789"
    destination_address = rc_ro.chain.address
    dto = rc_ro.prepare_withdraw_token(
        subaccount=sub.name,
        token=token.address,
        amount=100000,
        account=rc_ro.chain.address,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
        nonce=nonce,
    )
    assert (
        isinstance(dto, rc_ro._models.InitiateWithdrawDto) and dto.data.nonce == nonce
    )


def test_prepare_withdraw_token_with_custom_signed_at(rc_ro, network):
    subaccounts = rc_ro.list_subaccounts(sender=rc_ro.chain.address)
    sub = subaccounts[0]
    token = get_usd_token(rc_ro)
    ts = 1620000000
    destination_address = rc_ro.chain.address
    dto = rc_ro.prepare_withdraw_token(
        subaccount=sub.name,
        token=token.address,
        amount=100000,
        account=rc_ro.chain.address,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
        signed_at=ts,
    )
    assert (
        isinstance(dto, rc_ro._models.InitiateWithdrawDto) and dto.data.signed_at == ts
    )


def test_prepare_withdraw_token_with_custom_destination(rc_ro, network):
    subaccounts = rc_ro.list_subaccounts(sender=rc_ro.chain.address)
    sub = subaccounts[0]
    token = get_usd_token(rc_ro)
    destination_address = rc_ro.chain.address
    destination_endpoint = 40422
    dto = rc_ro.prepare_withdraw_token(
        subaccount=sub.name,
        token=token.address,
        amount=100000,
        account=rc_ro.chain.address,
        destination_address=destination_address,
        destination_endpoint=destination_endpoint,
    )
    assert (
        isinstance(dto, rc_ro._models.InitiateWithdrawDto)
        and dto.data.token == token.address
        and dto.data.subaccount == sub.name
        and dto.data.amount == 100000
        and dto.data.account == rc_ro.chain.address
        and dto.signature == ""
        and dto.data.lz_destination_address == ensure_bytes32_hex(destination_address)
        and dto.data.lz_destination_eid.value == destination_endpoint
    )


@pytest.mark.skip(reason="This test actually submits a withdrawal request")
def test_prepare_sign_submit_withdraw_token(rc, network):
    subaccounts = rc.list_subaccounts(sender=rc.chain.address)
    sub = subaccounts[0]
    token = get_usd_token(rc)
    destination_address = rc.chain.address
    dto = rc.prepare_withdraw_token(
        subaccount=sub.name,
        token=token.address,
        amount=5,
        account=rc.chain.address,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
    )
    signed = rc.sign_withdraw_token(dto)
    result = rc.withdraw_token(signed, token_id=token.id)
    assert (
        isinstance(result, rc._models.WithdrawDto)
        and result.token == token.address
        and result.subaccount == sub.name
    )


def test_withdraw_token_dto_without_submit(rc, network):
    """Test withdrawal using the dto approach without submitting."""
    subaccounts = rc.list_subaccounts(sender=rc.chain.address)
    sub = subaccounts[0]
    token = get_usd_token(rc)
    destination_address = rc.chain.address
    dto = rc.prepare_withdraw_token(
        subaccount=sub.name,
        token=token.address,
        amount=50,
        account=rc.chain.address,
        include_signature=True,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
    )
    result = rc.withdraw_token(dto, token_id=token.id, submit=False)
    assert (
        isinstance(result, rc._models.InitiateWithdrawDto)
        and result.data.token == token.address
        and result.data.subaccount == sub.name
        and result.signature != ""
    )


def test_withdraw_token_friendly_without_submit(rc, network):
    """Test withdrawal using the friendly params approach without submitting."""
    token = get_usd_token(rc)
    destination_address = rc.chain.address

    result = rc.withdraw_token(
        token_id=token.id,
        amount=50,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
        submit=False,
    )
    assert (
        isinstance(result, rc._models.InitiateWithdrawDto)
        and result.data.token == token.address
    )


def test_withdraw_token_friendly_params(rc, network):
    """Test the new friendly parameter interface for withdraw_token (without submit)."""
    token = get_usd_token(rc)
    destination_address = rc.chain.address

    # Use the new friendly param interface with submit=False
    result = rc.withdraw_token(
        token_id=token.id,
        amount=100,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
        submit=False,
    )

    assert isinstance(result, rc._models.InitiateWithdrawDto)
    assert result.data.token == token.address
    assert result.data.amount == 100
    assert result.signature != ""  # Should be signed by default


def test_withdraw_token_friendly_params_no_sign(rc, network):
    """Test the friendly parameter interface without signing."""
    token = get_usd_token(rc)
    destination_address = rc.chain.address

    result = rc.withdraw_token(
        token_id=token.id,
        amount=100,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
        sign=False,
        submit=False,
    )

    assert isinstance(result, rc._models.InitiateWithdrawDto)
    assert result.signature == ""  # Should not be signed


def test_withdraw_token_deprecated_dto_warns(rc, network):
    """Test that using dto parameter triggers deprecation warning."""
    token = get_usd_token(rc)
    subaccounts = rc.list_subaccounts(sender=rc.chain.address)
    sub = subaccounts[0]
    destination_address = rc.chain.address

    # Prepare a DTO the old way
    dto = rc.prepare_withdraw_token(
        subaccount=sub.name,
        token=token.address,
        amount=100,
        account=rc.chain.address,
        destination_address=destination_address,
        destination_endpoint=DEFAULT_DESTINATION_ENDPOINT,
        include_signature=True,
    )

    # Using dto should trigger deprecation warning
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        result = rc.withdraw_token(dto, token_id=token.id, submit=False)

        # Check that deprecation warning was raised
        deprecation_warnings = [
            x for x in w if issubclass(x.category, DeprecationWarning)
        ]
        assert len(deprecation_warnings) >= 1
        assert "dto" in str(deprecation_warnings[0].message).lower()

    # Verify DTO is returned unchanged
    assert isinstance(result, rc._models.InitiateWithdrawDto)
    assert result.signature != ""
