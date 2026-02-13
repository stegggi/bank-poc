"""Sync tests for REST position liquidation endpoints."""

from typing import List
from pydantic import BaseModel


def test_rest_list_position_liquidations(rc):
    """Test listing position liquidations."""
    liquidations = rc.list_position_liquidations()
    assert isinstance(liquidations, List)
    assert all(isinstance(liq, BaseModel) for liq in liquidations)
