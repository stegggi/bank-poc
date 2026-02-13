"""Pure sync tests for OTO/OCO order patterns."""

import uuid
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


def test_rest_pure_oto_pattern(rc, sid):
    sub = next(s for s in rc.list_subaccounts(sender=rc.chain.address) if s.id == sid)
    products = rc.list_products()
    pid = products[0].id
    tick_size = float(rc.products_by_id[pid].tick_size)
    prices = rc.list_market_prices(product_ids=[pid])[0]
    best_bid = float(prices.best_bid_price)
    group_id = uuid.uuid4()

    entry_price = safe_round_price(best_bid * 0.95, tick_size)
    primary = rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=0,
        price=entry_price,
        quantity=0.001,
        time_in_force="GTD",
        group_id=group_id,
        group_contingency_type=0,
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(primary, rc._models.SubmitOrderCreatedDto)

    latest = rc.list_market_prices(product_ids=[pid])[0]
    exit_price = safe_round_price(float(latest.best_bid_price) * 1.05, tick_size)
    secondary = rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=1,
        price=exit_price,
        quantity=0.001,
        time_in_force="GTD",
        group_id=group_id,
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(secondary, rc._models.SubmitOrderCreatedDto)

    time.sleep(2)
    p = rc.get_order(id=primary.id)
    s = rc.get_order(id=secondary.id)
    assert p.group_id == group_id and p.group_contingency_type.value == 0
    assert s.group_id == group_id

    rc.cancel_orders(
        sender=rc.chain.address,
        subaccount=sub.name,
        order_ids=[primary.id, secondary.id],
    )
    rate_limit(4)


def test_rest_pure_oco_pattern(rc, sid):
    sub = next(s for s in rc.list_subaccounts(sender=rc.chain.address) if s.id == sid)
    products = rc.list_products()
    pid = products[0].id
    tick = float(rc.products_by_id[pid].tick_size)
    prices = rc.list_market_prices(product_ids=[pid])[0]
    best_bid = float(prices.best_bid_price)
    best_ask = float(prices.best_ask_price)
    group_id = uuid.uuid4()

    market = rc.create_order(
        order_type="MARKET",
        product_id=pid,
        side=0,
        quantity=0.001,
        time_in_force="GTD",
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(market, rc._models.SubmitOrderCreatedDto)

    sl_price = safe_round_price(best_bid * 0.90, tick)
    sl = rc.create_order(
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
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(sl, rc._models.SubmitOrderCreatedDto)

    tp_price = safe_round_price(best_ask * 1.10, tick)
    tp = rc.create_order(
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
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(tp, rc._models.SubmitOrderCreatedDto)

    time.sleep(2)
    sl_o = rc.get_order(id=sl.id)
    tp_o = rc.get_order(id=tp.id)
    assert sl_o.group_id == group_id and sl_o.group_contingency_type.value == 1
    assert tp_o.group_id == group_id and tp_o.group_contingency_type.value == 1
    assert sl_o.status.value in [
        "NEW",
        "PENDING",
        "CANCELED",
    ] and tp_o.status.value in ["NEW", "PENDING", "CANCELED"]

    rc.cancel_orders(
        sender=rc.chain.address,
        subaccount=sub.name,
        order_ids=[sl.id, tp.id],
    )
    close = rc.create_order(
        order_type="MARKET",
        product_id=pid,
        quantity=0,
        side=1,
        time_in_force="GTD",
        reduce_only=True,
        close=True,
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(close, rc._models.SubmitOrderCreatedDto)
    rate_limit(6)


def test_rest_otoco_pattern_complete(rc, sid):
    sub = next(s for s in rc.list_subaccounts(sender=rc.chain.address) if s.id == sid)
    products = rc.list_products()
    pid = products[0].id
    tick = float(rc.products_by_id[pid].tick_size)
    prices = rc.list_market_prices(product_ids=[pid])[0]
    best_bid = float(prices.best_bid_price)
    best_ask = float(prices.best_ask_price)
    group_id = uuid.uuid4()

    entry_price = safe_round_price(best_bid * 0.95, tick)
    entry = rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=0,
        price=entry_price,
        quantity=0.002,
        time_in_force="GTD",
        group_id=group_id,
        group_contingency_type=0,
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(entry, rc._models.SubmitOrderCreatedDto)

    tp_price = safe_round_price(best_ask * 1.10, tick)
    tp = rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=1,
        price=tp_price,
        quantity=0.002,
        time_in_force="GTD",
        reduce_only=True,
        group_id=group_id,
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(tp, rc._models.SubmitOrderCreatedDto)

    sl_price = safe_round_price(best_bid * 0.90, tick)
    sl = rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=1,
        price=sl_price,
        quantity=0.002,
        time_in_force="GTD",
        reduce_only=True,
        group_id=group_id,
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(sl, rc._models.SubmitOrderCreatedDto)

    time.sleep(2)
    e = rc.get_order(id=entry.id)
    assert e.group_id == group_id and e.group_contingency_type.value == 0
    rc.cancel_orders(
        sender=rc.chain.address,
        subaccount=sub.name,
        order_ids=[entry.id, tp.id, sl.id],
    )
    rate_limit(6)


def test_rest_stop_orders_with_oco(rc, sid):
    sub = next(s for s in rc.list_subaccounts(sender=rc.chain.address) if s.id == sid)
    products = rc.list_products()
    pid = products[0].id
    tick = float(rc.products_by_id[pid].tick_size)
    prices = rc.list_market_prices(product_ids=[pid])[0]
    best_bid = float(prices.best_bid_price)
    best_ask = float(prices.best_ask_price)
    group_id = uuid.uuid4()

    sl_trigger = safe_round_price(best_bid * 0.90, tick)
    sl = rc.create_order(
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
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(sl, rc._models.SubmitOrderCreatedDto)

    tp_trigger = safe_round_price(best_ask * 1.10, tick)
    tp = rc.create_order(
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
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(tp, rc._models.SubmitOrderCreatedDto)

    time.sleep(2)
    tp_o = rc.get_order(id=tp.id)
    sl_o = rc.get_order(id=sl.id)
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
    rc.cancel_orders(
        sender=rc.chain.address,
        subaccount=sub.name,
        order_ids=[tp.id, sl.id],
    )
    rate_limit(4)


def test_rest_time_in_force_with_oto_oco(rc, sid):
    sub = next(s for s in rc.list_subaccounts(sender=rc.chain.address) if s.id == sid)
    products = rc.list_products()
    pid = products[0].id
    tick = float(rc.products_by_id[pid].tick_size)
    prices = rc.list_market_prices(product_ids=[pid])[0]
    best_bid = float(prices.best_bid_price)
    best_ask = float(prices.best_ask_price)
    group_id = uuid.uuid4()

    expires_at = int(time.time()) + 3600

    entry_price = safe_round_price(best_bid * 0.95, tick)
    entry = rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=0,
        price=entry_price,
        quantity=0.001,
        time_in_force="GTD",
        expires_at=expires_at,
        group_id=group_id,
        group_contingency_type=0,
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(entry, rc._models.SubmitOrderCreatedDto)

    exit_price = safe_round_price(best_ask * 1.05, tick)
    exit_o = rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=1,
        price=exit_price,
        quantity=0.001,
        time_in_force="GTD",
        group_id=group_id,
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(exit_o, rc._models.SubmitOrderCreatedDto)

    time.sleep(2)
    e = rc.get_order(id=entry.id)
    x = rc.get_order(id=exit_o.id)
    assert e.time_in_force.value == "GTD" and e.expires_at is not None
    assert x.time_in_force.value == "GTD"
    rc.cancel_orders(
        sender=rc.chain.address,
        subaccount=sub.name,
        order_ids=[entry.id, exit_o.id],
    )
    rate_limit(4)


def test_rest_post_only_with_oco(rc, sid):
    sub = next(s for s in rc.list_subaccounts(sender=rc.chain.address) if s.id == sid)
    products = rc.list_products()
    pid = products[0].id
    tick = float(rc.products_by_id[pid].tick_size)
    prices = rc.list_market_prices(product_ids=[pid])[0]
    best_bid = float(prices.best_bid_price)
    best_ask = float(prices.best_ask_price)
    group_id = uuid.uuid4()

    buy_price = safe_round_price(best_bid * 0.99, tick)
    buy = rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=0,
        price=buy_price,
        quantity=0.001,
        time_in_force="GTD",
        post_only=True,
        group_id=group_id,
        group_contingency_type=1,
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(buy, rc._models.SubmitOrderCreatedDto)

    sell_price = safe_round_price(best_ask * 1.01, tick)
    sell = rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=1,
        price=sell_price,
        quantity=0.001,
        time_in_force="GTD",
        post_only=True,
        group_id=group_id,
        group_contingency_type=1,
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(sell, rc._models.SubmitOrderCreatedDto)

    time.sleep(2)
    b = rc.get_order(id=buy.id)
    s = rc.get_order(id=sell.id)
    assert b.post_only and b.group_id == group_id
    assert s.post_only and s.group_id == group_id
    rc.cancel_orders(
        sender=rc.chain.address,
        subaccount=sub.name,
        order_ids=[buy.id, sell.id],
    )
    rate_limit(4)
