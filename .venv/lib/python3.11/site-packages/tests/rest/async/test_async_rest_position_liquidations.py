"""Pure async tests for REST position liquidation endpoints."""

import pytest
from typing import List
from pydantic import BaseModel


@pytest.mark.asyncio
async def test_rest_list_position_liquidations(async_rc):
    """Test listing position liquidations."""
    liquidations = await async_rc.list_position_liquidations()
    assert isinstance(liquidations, List)
    assert all(isinstance(liq, BaseModel) for liq in liquidations)
