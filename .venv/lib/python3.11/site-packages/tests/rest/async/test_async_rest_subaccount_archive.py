"""Async archive subaccount endpoint coverage."""

import time
from typing import List

import pytest


@pytest.mark.asyncio
async def test_get_subaccount_balance_history(async_rc, network):
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]

    end_ms = int(time.time() * 1000)
    start_ms = end_ms - 24 * 60 * 60 * 1000

    entries = await async_rc.get_subaccount_balance_history(
        subaccount_id=sub.id,
        start_time=start_ms,
        end_time=end_ms,
        resolution="hour1",
        order="asc",
        limit=10,
    )

    assert isinstance(entries, List)
    if entries:
        assert isinstance(entries[0], async_rc._models.BalanceHistoryDto)


@pytest.mark.asyncio
async def test_get_subaccount_unrealized_pnl_history(async_rc, network):
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]

    end_ms = int(time.time() * 1000)
    start_ms = end_ms - 24 * 60 * 60 * 1000

    entries = await async_rc.get_subaccount_unrealized_pnl_history(
        subaccount_id=sub.id,
        start_time=start_ms,
        end_time=end_ms,
        resolution="hour1",
        order="asc",
        limit=10,
    )

    assert isinstance(entries, List)
    if entries:
        assert isinstance(entries[0], async_rc._models.UnrealizedPnlHistoryDto)


@pytest.mark.asyncio
async def test_get_subaccount_volume_history(async_rc, network):
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]

    end_ms = int(time.time() * 1000)
    start_ms = end_ms - 24 * 60 * 60 * 1000

    entries = await async_rc.get_subaccount_volume_history(
        subaccount_id=sub.id,
        start_time=start_ms,
        end_time=end_ms,
        resolution="hour1",
        order="asc",
        limit=10,
    )

    assert isinstance(entries, List)
    if entries:
        assert isinstance(entries[0], async_rc._models.SubaccountVolumeHistoryDto)


@pytest.mark.asyncio
async def test_get_subaccount_funding_history(async_rc, network):
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]

    end_ms = int(time.time() * 1000)
    start_ms = end_ms - 24 * 60 * 60 * 1000

    entries = await async_rc.get_subaccount_funding_history(
        subaccount_id=sub.id,
        start_time=start_ms,
        end_time=end_ms,
        order="asc",
        limit=10,
    )

    assert isinstance(entries, List)
    if entries:
        assert isinstance(entries[0], async_rc._models.PositionFundingHistoryDto)


@pytest.mark.asyncio
async def test_get_subaccount_total_volume(async_rc, network):
    """Test getting total trading volume for a subaccount."""
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]

    total_volume = await async_rc.get_subaccount_total_volume(subaccount_id=sub.id)

    assert isinstance(total_volume, async_rc._models.TotalSubaccountVolumeDto)
    assert hasattr(total_volume, "volume_usd")

    # Volume should be a string representing a decimal number
    volume_str = total_volume.volume_usd
    assert isinstance(volume_str, str)

    # Should be parseable as a float
    volume_float = float(volume_str)
    assert volume_float >= 0.0
