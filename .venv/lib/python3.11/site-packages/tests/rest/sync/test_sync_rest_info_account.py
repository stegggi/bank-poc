"""Pure sync tests for REST info endpoints that require an account."""

from decimal import Decimal
from typing import List
from pydantic import BaseModel


def test_rest_info_subaccount_balances(rc, sid):
    balances = rc.get_subaccount_balances(subaccount_id=sid)
    assert isinstance(balances, List)
    assert all(isinstance(sb, BaseModel) for sb in balances)


def test_rest_info_orders(rc, sid):
    orders = rc.list_orders(subaccount_id=sid)
    assert isinstance(orders, List)
    assert all(isinstance(o, BaseModel) for o in orders)


def test_rest_info_fills(rc, sid):
    fills = rc.list_fills(subaccount_id=sid)
    assert isinstance(fills, List)
    assert all(isinstance(f, BaseModel) for f in fills)


def test_rest_info_fills_paginated(rc, sid):
    fills = rc._get_pages(
        endpoint="order/fill",
        request_model=rc._models.V1OrderFillGetParametersQuery,
        response_model=rc._models.PageOfOrderFillDtos,
        subaccount_id=sid,
        limit=200,
        paginate=True,
        max_pages=5,
    )
    assert isinstance(fills, List)
    assert all(isinstance(f, BaseModel) for f in fills)


def test_rest_info_trades(rc, sid):
    products = rc.list_products()
    params = {"product_id": products[0].id, "order": "desc", "limit": 100}
    trades = rc.list_trades(**params)
    assert isinstance(trades, List)
    assert all(isinstance(t, BaseModel) for t in trades)


def test_rest_info_positions(rc, sid):
    positions = rc.list_positions(subaccount_id=sid)
    assert isinstance(positions, List)
    assert all(isinstance(p, BaseModel) for p in positions)


def test_rest_info_maintenance_margin(rc, sid):
    mm = rc.get_maintenance_margin(subaccount_id=sid)
    assert isinstance(mm, Decimal)

    # specify product id
    pid = rc.products_by_ticker["BTCUSD"].id
    btc_mm = rc.get_maintenance_margin(subaccount_id=sid, product_ids=[pid])
    assert isinstance(btc_mm, Decimal)

    # specify products
    products = [
        rc.products_by_ticker["BTCUSD"],
        rc.products_by_ticker["ETHUSD"],
    ]
    eth_btc_mm = rc.get_maintenance_margin(subaccount_id=sid, products=products)
    assert isinstance(eth_btc_mm, Decimal)

    # specify product dicts
    product_dicts = [
        {
            "id": rc.products_by_ticker["BTCUSD"].id,
            "max_leverage": 5,
            "taker_fee": "0.001",
        },
        {
            "id": rc.products_by_ticker["ETHUSD"].id,
            "max_leverage": 5,
            "taker_fee": "0.001",
        },
    ]
    eth_btc_mm = rc.get_maintenance_margin(subaccount_id=sid, products=product_dicts)
    assert isinstance(eth_btc_mm, Decimal)
