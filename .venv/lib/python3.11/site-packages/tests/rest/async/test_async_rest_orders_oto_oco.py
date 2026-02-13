"""Pure async tests for OTO/OCO order patterns."""

import uuid
import asyncio
import pytest
import time
from tests.helpers import rate_limit


def safe_round_price(price, tick_size):
    """Round price to valid tick size using decimal precision."""
    from decimal import Decimal as D, ROUND_HALF_UP

    if tick_size == 0:
        return float(price)

    price_decimal = D(str(price))
    tick_size_decimal = D(str(tick_size))
    return float(
        (price_decimal / tick_size_decimal).quantize(D("1"), rounding=ROUND_HALF_UP)
        * tick_size_decimal
    )


@pytest.mark.asyncio
async def test_rest_pure_oto_pattern(async_rc, network):
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]
    products = await async_rc.list_products()
    pid = products[0].id
    tick_size = float((await async_rc.products_by_id())[pid].tick_size)
    prices = (await async_rc.list_market_prices(product_ids=[pid]))[0]
    best_bid = float(prices.best_bid_price)
    group_id = uuid.uuid4()

    entry_price = safe_round_price(best_bid * 0.95, tick_size)
    primary = await async_rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=0,
        price=entry_price,
        quantity=0.001,
        time_in_force="GTD",
        group_id=group_id,
        group_contingency_type=0,
        sender=async_rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(primary, async_rc._models.SubmitOrderCreatedDto)

    latest = (await async_rc.list_market_prices(product_ids=[pid]))[0]
    exit_price = safe_round_price(float(latest.best_bid_price) * 1.05, tick_size)
    secondary = await async_rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=1,
        price=exit_price,
        quantity=0.001,
        time_in_force="GTD",
        group_id=group_id,
        sender=async_rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(secondary, async_rc._models.SubmitOrderCreatedDto)

    await asyncio.sleep(2)
    p = await async_rc.get_order(id=primary.id)
    s = await async_rc.get_order(id=secondary.id)
    assert p.group_id == group_id and p.group_contingency_type.value == 0
    assert s.group_id == group_id

    await async_rc.cancel_orders(
        sender=async_rc.chain.address,
        subaccount=sub.name,
        order_ids=[primary.id, secondary.id],
    )
    rate_limit(4)


@pytest.mark.asyncio
async def test_rest_pure_oco_pattern(async_rc, network):
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]
    products = await async_rc.list_products()
    pid = products[0].id
    tick = float((await async_rc.products_by_id())[pid].tick_size)
    prices = (await async_rc.list_market_prices(product_ids=[pid]))[0]
    best_bid = float(prices.best_bid_price)
    best_ask = float(prices.best_ask_price)
    group_id = uuid.uuid4()

    market = await async_rc.create_order(
        order_type="MARKET",
        product_id=pid,
        side=0,
        quantity=0.001,
        time_in_force="GTD",
        sender=async_rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(market, async_rc._models.SubmitOrderCreatedDto)

    sl_price = safe_round_price(best_bid * 0.90, tick)
    sl = await async_rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=1,
        price=sl_price,
        quantity=0.001,
        time_in_force="GTD",
        reduce_only=True,
        group_id=group_id,
        group_contingency_type=1,
        stop_type=1,
        stop_price=sl_price,
        sender=async_rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(sl, async_rc._models.SubmitOrderCreatedDto)

    tp_price = safe_round_price(best_ask * 1.10, tick)
    tp = await async_rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=1,
        price=tp_price,
        quantity=0.001,
        time_in_force="GTD",
        reduce_only=True,
        group_id=group_id,
        group_contingency_type=1,
        stop_type=0,
        stop_price=tp_price,
        sender=async_rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(tp, async_rc._models.SubmitOrderCreatedDto)

    await asyncio.sleep(2)
    sl_o = await async_rc.get_order(id=sl.id)
    tp_o = await async_rc.get_order(id=tp.id)
    assert sl_o.group_id == group_id and sl_o.group_contingency_type.value == 1
    assert tp_o.group_id == group_id and tp_o.group_contingency_type.value == 1
    assert sl_o.status.value in [
        "NEW",
        "PENDING",
        "CANCELED",
    ] and tp_o.status.value in ["NEW", "PENDING", "CANCELED"]

    await async_rc.cancel_orders(
        sender=async_rc.chain.address, subaccount=sub.name, order_ids=[sl.id, tp.id]
    )
    close = await async_rc.create_order(
        order_type="MARKET",
        product_id=pid,
        quantity=0,
        side=1,
        time_in_force="GTD",
        reduce_only=True,
        close=True,
        sender=async_rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(close, async_rc._models.SubmitOrderCreatedDto)
    rate_limit(6)


@pytest.mark.asyncio
async def test_rest_otoco_pattern_complete(async_rc, network):
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]
    products = await async_rc.list_products()
    pid = products[0].id
    tick = float((await async_rc.products_by_id())[pid].tick_size)
    prices = (await async_rc.list_market_prices(product_ids=[pid]))[0]
    best_bid = float(prices.best_bid_price)
    best_ask = float(prices.best_ask_price)
    group_id = uuid.uuid4()

    entry_price = safe_round_price(best_bid * 0.95, tick)
    entry = await async_rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=0,
        price=entry_price,
        quantity=0.002,
        time_in_force="GTD",
        group_id=group_id,
        group_contingency_type=0,
        sender=async_rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(entry, async_rc._models.SubmitOrderCreatedDto)

    tp_price = safe_round_price(best_ask * 1.10, tick)
    tp = await async_rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=1,
        price=tp_price,
        quantity=0.002,
        time_in_force="GTD",
        reduce_only=True,
        group_id=group_id,
        sender=async_rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(tp, async_rc._models.SubmitOrderCreatedDto)

    sl_price = safe_round_price(best_bid * 0.90, tick)
    sl = await async_rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=1,
        price=sl_price,
        quantity=0.002,
        time_in_force="GTD",
        reduce_only=True,
        group_id=group_id,
        sender=async_rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(sl, async_rc._models.SubmitOrderCreatedDto)

    await asyncio.sleep(2)
    e = await async_rc.get_order(id=entry.id)
    assert e.group_id == group_id and e.group_contingency_type.value == 0
    await async_rc.cancel_orders(
        sender=async_rc.chain.address,
        subaccount=sub.name,
        order_ids=[entry.id, tp.id, sl.id],
    )
    rate_limit(6)


@pytest.mark.asyncio
async def test_rest_stop_orders_with_oco(async_rc, network):
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]
    products = await async_rc.list_products()
    pid = products[0].id
    tick = float((await async_rc.products_by_id())[pid].tick_size)
    prices = (await async_rc.list_market_prices(product_ids=[pid]))[0]
    best_bid = float(prices.best_bid_price)
    best_ask = float(prices.best_ask_price)
    group_id = uuid.uuid4()

    sl_trigger = safe_round_price(best_bid * 0.90, tick)
    sl = await async_rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=1,
        price=sl_trigger,
        quantity=0.001,
        time_in_force="GTD",
        reduce_only=True,
        group_id=group_id,
        group_contingency_type=1,
        stop_type=1,
        stop_price=sl_trigger,
        sender=async_rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(sl, async_rc._models.SubmitOrderCreatedDto)

    tp_trigger = safe_round_price(best_ask * 1.10, tick)
    tp = await async_rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=1,
        price=tp_trigger,
        quantity=0.001,
        time_in_force="GTD",
        reduce_only=True,
        group_id=group_id,
        group_contingency_type=1,
        stop_type=0,
        stop_price=tp_trigger,
        sender=async_rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(tp, async_rc._models.SubmitOrderCreatedDto)

    await asyncio.sleep(2)
    tp_o = await async_rc.get_order(id=tp.id)
    sl_o = await async_rc.get_order(id=sl.id)
    assert (
        tp_o.reduce_only
        and tp_o.group_id == group_id
        and tp_o.group_contingency_type.value == 1
    )
    assert (
        sl_o.reduce_only
        and sl_o.group_id == group_id
        and sl_o.group_contingency_type.value == 1
    )
    await async_rc.cancel_orders(
        sender=async_rc.chain.address, subaccount=sub.name, order_ids=[tp.id, sl.id]
    )
    rate_limit(4)


@pytest.mark.asyncio
async def test_rest_time_in_force_with_oto_oco(async_rc, network):
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]
    products = await async_rc.list_products()
    pid = products[0].id
    tick = float((await async_rc.products_by_id())[pid].tick_size)
    prices = (await async_rc.list_market_prices(product_ids=[pid]))[0]
    best_bid = float(prices.best_bid_price)
    best_ask = float(prices.best_ask_price)
    group_id = uuid.uuid4()

    expires_at = int(time.time()) + 3600

    entry_price = safe_round_price(best_bid * 0.95, tick)
    entry = await async_rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=0,
        price=entry_price,
        quantity=0.001,
        time_in_force="GTD",
        expires_at=expires_at,
        group_id=group_id,
        group_contingency_type=0,
        sender=async_rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(entry, async_rc._models.SubmitOrderCreatedDto)

    exit_price = safe_round_price(best_ask * 1.05, tick)
    exit_o = await async_rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=1,
        price=exit_price,
        quantity=0.001,
        time_in_force="GTD",
        group_id=group_id,
        sender=async_rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(exit_o, async_rc._models.SubmitOrderCreatedDto)

    await asyncio.sleep(2)
    e = await async_rc.get_order(id=entry.id)
    x = await async_rc.get_order(id=exit_o.id)
    assert e.time_in_force.value == "GTD" and e.expires_at is not None
    assert x.time_in_force.value == "GTD"
    await async_rc.cancel_orders(
        sender=async_rc.chain.address,
        subaccount=sub.name,
        order_ids=[entry.id, exit_o.id],
    )
    rate_limit(4)


@pytest.mark.asyncio
async def test_rest_post_only_with_oco(async_rc, network):
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]
    products = await async_rc.list_products()
    pid = products[0].id
    tick = float((await async_rc.products_by_id())[pid].tick_size)
    prices = (await async_rc.list_market_prices(product_ids=[pid]))[0]
    best_bid = float(prices.best_bid_price)
    best_ask = float(prices.best_ask_price)
    group_id = uuid.uuid4()

    buy_price = safe_round_price(best_bid * 0.99, tick)
    buy = await async_rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=0,
        price=buy_price,
        quantity=0.001,
        time_in_force="GTD",
        post_only=True,
        group_id=group_id,
        group_contingency_type=1,
        sender=async_rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(buy, async_rc._models.SubmitOrderCreatedDto)

    sell_price = safe_round_price(best_ask * 1.01, tick)
    sell = await async_rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=1,
        price=sell_price,
        quantity=0.001,
        time_in_force="GTD",
        post_only=True,
        group_id=group_id,
        group_contingency_type=1,
        sender=async_rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(sell, async_rc._models.SubmitOrderCreatedDto)

    await asyncio.sleep(2)
    b = await async_rc.get_order(id=buy.id)
    s = await async_rc.get_order(id=sell.id)
    assert b.post_only and b.group_id == group_id
    assert s.post_only and s.group_id == group_id
    await async_rc.cancel_orders(
        sender=async_rc.chain.address, subaccount=sub.name, order_ids=[buy.id, sell.id]
    )
    rate_limit(4)
