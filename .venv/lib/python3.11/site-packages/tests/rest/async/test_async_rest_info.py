"""Pure async tests for REST info endpoints."""

import pytest
from typing import List
from pydantic import BaseModel


@pytest.mark.asyncio
async def test_rest_subaccounts(async_rc):
    subs = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    assert isinstance(subs, List)
    assert all(isinstance(sa, BaseModel) for sa in subs)


@pytest.mark.asyncio
async def test_rest_subaccount(async_rc):
    subs = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = await async_rc.get_subaccount(subs[0].id)
    assert isinstance(sub, BaseModel)


@pytest.mark.asyncio
async def test_rest_rpc_config(async_rc):
    cfg = await async_rc.get_rpc_config()
    assert isinstance(cfg, BaseModel)


@pytest.mark.asyncio
async def test_rest_products(async_rc):
    products = await async_rc.list_products()
    assert isinstance(products, List)
    assert all(isinstance(p, BaseModel) for p in products)


@pytest.mark.asyncio
async def test_rest_tokens(async_rc):
    tokens = await async_rc.list_tokens()
    assert isinstance(tokens, List)
    assert all(isinstance(t, BaseModel) for t in tokens)


@pytest.mark.asyncio
async def test_rest_market_prices(async_rc):
    products = await async_rc.list_products()
    if products:
        prices = await async_rc.list_market_prices(product_ids=[products[0].id])
        assert isinstance(prices, List)
        assert all(isinstance(p, BaseModel) for p in prices)


@pytest.mark.asyncio
async def test_rest_list_projected_funding(async_rc):
    """Test listing projected funding rates for multiple products."""
    products = await async_rc.list_products()
    assert len(products) > 0, "No products available for testing"

    # Test with up to 3 products (API supports 1-10)
    product_ids = [p.id for p in products[:3]]

    projected_funding = await async_rc.list_projected_funding(product_ids=product_ids)
    assert isinstance(projected_funding, List)
    assert len(projected_funding) > 0
    assert all(isinstance(pf, BaseModel) for pf in projected_funding)

    # Verify each result has required fields
    for pf in projected_funding:
        assert hasattr(pf, "product_id")
        assert hasattr(pf, "funding_rate_projected1h")
        assert hasattr(pf, "funding_rate1h")
        assert pf.product_id in product_ids


@pytest.mark.asyncio
async def test_rest_get_projected_funding_single(async_rc):
    """Test getting projected funding for a single product."""
    products = await async_rc.list_products()
    assert len(products) > 0, "No products available for testing"

    product_id = products[0].id
    projected_funding = await async_rc.get_projected_funding(product_id=product_id)

    assert isinstance(projected_funding, BaseModel)
    assert hasattr(projected_funding, "funding_rate_projected1h")
    assert hasattr(projected_funding, "funding_rate1h")
