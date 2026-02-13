"""Pure sync tests for REST info endpoints."""

from typing import List
from pydantic import BaseModel


def test_rest_subaccounts(rc):
    subs = rc.list_subaccounts(sender=rc.chain.address)
    assert isinstance(subs, List)
    assert all(isinstance(sa, BaseModel) for sa in subs)


def test_rest_subaccount(rc):
    subs = rc.list_subaccounts(sender=rc.chain.address)
    sub = rc.get_subaccount(subs[0].id)
    assert isinstance(sub, BaseModel)


def test_rest_rpc_config(rc):
    cfg = rc.get_rpc_config()
    assert isinstance(cfg, BaseModel)


def test_rest_products(rc):
    products = rc.list_products()
    assert isinstance(products, List)
    assert all(isinstance(p, BaseModel) for p in products)


def test_rest_tokens(rc):
    tokens = rc.list_tokens()
    assert isinstance(tokens, List)
    assert all(isinstance(t, BaseModel) for t in tokens)


def test_rest_market_prices(rc):
    products = rc.list_products()
    if products:
        prices = rc.list_market_prices(product_ids=[products[0].id])
        assert isinstance(prices, List)
        assert all(isinstance(p, BaseModel) for p in prices)
