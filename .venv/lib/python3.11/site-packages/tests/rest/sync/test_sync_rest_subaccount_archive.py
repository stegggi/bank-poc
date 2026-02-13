"""Sync archive subaccount endpoint coverage."""

import time
from typing import List


def test_get_subaccount_balance_history(rc):
    subaccounts = rc.list_subaccounts(sender=rc.chain.address)
    sub = subaccounts[0]

    end_ms = int(time.time() * 1000)
    start_ms = end_ms - 24 * 60 * 60 * 1000

    entries = rc.get_subaccount_balance_history(
        subaccount_id=sub.id,
        start_time=start_ms,
        end_time=end_ms,
        resolution="hour1",
        order="asc",
        limit=10,
    )

    assert isinstance(entries, List)
    if entries:
        assert isinstance(entries[0], rc._models.BalanceHistoryDto)


def test_get_subaccount_unrealized_pnl_history(rc):
    subaccounts = rc.list_subaccounts(sender=rc.chain.address)
    sub = subaccounts[0]

    end_ms = int(time.time() * 1000)
    start_ms = end_ms - 24 * 60 * 60 * 1000

    entries = rc.get_subaccount_unrealized_pnl_history(
        subaccount_id=sub.id,
        start_time=start_ms,
        end_time=end_ms,
        resolution="hour1",
        order="asc",
        limit=10,
    )

    assert isinstance(entries, List)
    if entries:
        assert isinstance(entries[0], rc._models.UnrealizedPnlHistoryDto)


def test_get_subaccount_volume_history(rc):
    subaccounts = rc.list_subaccounts(sender=rc.chain.address)
    sub = subaccounts[0]

    end_ms = int(time.time() * 1000)
    start_ms = end_ms - 24 * 60 * 60 * 1000

    entries = rc.get_subaccount_volume_history(
        subaccount_id=sub.id,
        start_time=start_ms,
        end_time=end_ms,
        resolution="hour1",
        order="asc",
        limit=10,
    )

    assert isinstance(entries, List)
    if entries:
        assert isinstance(entries[0], rc._models.SubaccountVolumeHistoryDto)


def test_get_subaccount_funding_history(rc):
    subaccounts = rc.list_subaccounts(sender=rc.chain.address)
    sub = subaccounts[0]

    end_ms = int(time.time() * 1000)
    start_ms = end_ms - 24 * 60 * 60 * 1000

    entries = rc.get_subaccount_funding_history(
        subaccount_id=sub.id,
        start_time=start_ms,
        end_time=end_ms,
        order="asc",
        limit=10,
    )

    assert isinstance(entries, List)
    if entries:
        assert isinstance(entries[0], rc._models.PositionFundingHistoryDto)
