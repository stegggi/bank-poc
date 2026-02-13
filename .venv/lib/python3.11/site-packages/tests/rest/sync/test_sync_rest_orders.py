"""Pure sync REST API tests for submitting and managing orders."""

import time
from decimal import Decimal
from typing import List
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


def test_rest_limit_order_floats_submit_cancel(rc, sid):
    subaccount = next(
        s for s in rc.list_subaccounts(sender=rc.chain.address) if s.id == sid
    )
    pid = rc.list_products()[0].id
    tick_size = float(rc.products_by_id[pid].tick_size)
    prices = rc.list_market_prices(product_ids=[pid])[0]
    best_bid_price = float(prices.best_bid_price)
    bid_price = safe_round_price(best_bid_price * 0.90, tick_size)
    order = rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=0,
        price=bid_price,
        quantity=0.001,
        time_in_force="GTD",
        post_only=False,
        sender=rc.chain.address,
        subaccount=subaccount.name,
    )
    assert isinstance(order, rc._models.SubmitOrderCreatedDto)
    cancelled = rc.cancel_orders(
        sender=rc.chain.address, subaccount=subaccount.name, order_ids=[order.id]
    )
    assert isinstance(cancelled, List)
    assert all(isinstance(o, rc._models.CancelOrderResultDto) for o in cancelled)
    rate_limit(2)


def test_rest_limit_order_decimal_submit_cancel(rc, sid):
    subaccount = next(
        s for s in rc.list_subaccounts(sender=rc.chain.address) if s.id == sid
    )
    products = rc.list_products()
    pid = next(p.id for p in products if getattr(p, "ticker", None) == "ETHUSD")
    tick_size = float(rc.products_by_id[pid].tick_size)
    prices = rc.list_market_prices(product_ids=[pid])[0]
    best_bid_price = float(prices.best_bid_price)
    bid_price = safe_round_price(best_bid_price * 0.90, tick_size)
    expires_at = int(time.time()) + 3600
    order = rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=0,
        price=Decimal(str(bid_price)),
        quantity=Decimal("0.003"),
        time_in_force="GTD",
        expires_at=expires_at,
        post_only=False,
        sender=rc.chain.address,
        subaccount=subaccount.name,
    )
    assert isinstance(order, rc._models.SubmitOrderCreatedDto)
    time.sleep(2)
    fetched = rc.get_order(order.id)
    assert isinstance(fetched, rc._models.OrderDto)
    assert fetched.id == order.id and int(fetched.expires_at) == expires_at
    cancelled = rc.cancel_orders(
        sender=rc.chain.address, subaccount=subaccount.name, order_ids=[order.id]
    )
    assert isinstance(cancelled, List)
    assert all(isinstance(o, rc._models.CancelOrderResultDto) for o in cancelled)
    rate_limit(2)


def test_rest_limit_order_submit_cancel_multiple(rc, sid):
    subaccount = next(
        s for s in rc.list_subaccounts(sender=rc.chain.address) if s.id == sid
    )
    pid = rc.list_products()[0].id
    tick_size = float(rc.products_by_id[pid].tick_size)
    prices = rc.list_market_prices(product_ids=[pid])[0]
    best_bid_price = float(prices.best_bid_price)
    bid_price = safe_round_price(best_bid_price * 0.90, tick_size)
    ids = []
    for _ in range(2):
        o = rc.create_order(
            order_type="LIMIT",
            product_id=pid,
            side=0,
            price=bid_price,
            quantity=0.003,
            time_in_force="GTD",
            post_only=False,
            sender=rc.chain.address,
            subaccount=subaccount.name,
        )
        assert isinstance(o, rc._models.SubmitOrderCreatedDto)
        ids.append(o.id)
    cancelled = rc.cancel_orders(
        sender=rc.chain.address, subaccount=subaccount.name, order_ids=ids
    )
    assert isinstance(cancelled, List)
    assert all(isinstance(o, rc._models.CancelOrderResultDto) for o in cancelled)
    rate_limit(4)


def test_rest_limit_order_submit_cancel_all(rc, sid):
    sub = next(s for s in rc.list_subaccounts(sender=rc.chain.address) if s.id == sid)
    pid = rc.list_products()[0].id
    try:
        rc.cancel_all_orders(
            sender=rc.chain.address, subaccount_id=sub.id, product_ids=[pid]
        )
    except Exception:
        pass
    tick_size = float(rc.products_by_id[pid].tick_size)
    prices = rc.list_market_prices(product_ids=[pid])[0]
    best = float(prices.best_bid_price)
    ids = []
    for i in range(3):
        price = safe_round_price(best * (0.90 + i * 0.01), tick_size)
        o = rc.create_order(
            order_type="LIMIT",
            product_id=pid,
            side=0,
            price=price,
            quantity=0.001,
            sender=rc.chain.address,
            subaccount=sub.name,
        )
        ids.append(o.id)
    cancelled = rc.cancel_all_orders(
        sender=rc.chain.address, subaccount_id=sub.id, product_ids=[pid]
    )
    assert isinstance(cancelled, List)
    assert len(cancelled) > 0
    time.sleep(2)
    for c in cancelled:
        ord = rc.get_order(id=c.id)
        assert ord.status.value == "CANCELED"
    rate_limit(10)


def test_rest_limit_order_submit_cancel_all_specify_products(rc, sid):
    sub = next(s for s in rc.list_subaccounts(sender=rc.chain.address) if s.id == sid)
    products = rc.list_products()
    order_ids = {}
    for i in range(2):
        pid = products[i].id
        info = rc.products_by_id[pid]
        tick = Decimal(str(info.tick_size))
        min_quantity = Decimal(str(info.min_quantity))
        prices = rc.list_market_prices(product_ids=[pid])[0]
        best = Decimal(str(prices.best_bid_price))
        order_ids[pid] = []
        for j in range(2):
            price = safe_round_price(best * Decimal(str(0.90 + j * 0.01)), tick)
            o = rc.create_order(
                order_type="LIMIT",
                product_id=pid,
                side=0,
                price=price,
                quantity=min_quantity,
                time_in_force="GTD",
                post_only=False,
                sender=rc.chain.address,
                subaccount=sub.name,
            )
            order_ids[pid].append(o.id)
    cancelled = rc.cancel_all_orders(
        sender=rc.chain.address, subaccount_id=sub.id, product_ids=[products[0].id]
    )
    assert len(cancelled) > 0
    time.sleep(2)
    for c in cancelled:
        ord = rc.get_order(id=c.id)
        assert ord.status.value == "CANCELED"
    for oid in order_ids[products[1].id]:
        ord = rc.get_order(id=oid)
        assert ord.status.value == "NEW"
    cancelled2 = rc.cancel_all_orders(
        sender=rc.chain.address, subaccount_id=sub.id, product_ids=[products[1].id]
    )
    assert len(cancelled2) > 0
    time.sleep(2)
    for c in cancelled2:
        ord = rc.get_order(id=c.id)
        assert ord.status.value == "CANCELED"
    rate_limit(16)


def test_rest_limit_order_submit_cancel_all_multiple_products(rc, sid):
    sub = next(s for s in rc.list_subaccounts(sender=rc.chain.address) if s.id == sid)
    products = rc.list_products()
    ids = []
    for i in range(2):
        pid = products[i].id
        info = rc.products_by_id[pid]
        tick = Decimal(str(info.tick_size))
        min_quantity = Decimal(str(info.min_quantity))
        prices = rc.list_market_prices(product_ids=[pid])[0]
        best = Decimal(str(prices.best_bid_price))
        for j in range(2):
            price = safe_round_price(best * Decimal(str(0.90 + j * 0.01)), tick)
            o = rc.create_order(
                order_type="LIMIT",
                product_id=pid,
                side=0,
                price=price,
                quantity=min_quantity,
                time_in_force="GTD",
                post_only=False,
                sender=rc.chain.address,
                subaccount=sub.name,
            )
            ids.append(o.id)
    cancelled = rc.cancel_all_orders(sender=rc.chain.address, subaccount_id=sub.id)
    assert isinstance(cancelled, List) and len(cancelled) > 0
    time.sleep(2)
    for c in cancelled:
        ord = rc.get_order(id=c.id)
        assert ord.status.value == "CANCELED"
    rate_limit(13)


def test_rest_limit_order_dry(rc, sid):
    sub = next(s for s in rc.list_subaccounts(sender=rc.chain.address) if s.id == sid)
    pid = rc.list_products()[0].id
    tick_size = float(rc.products_by_id[pid].tick_size)
    prices = rc.list_market_prices(product_ids=[pid])[0]
    best = float(prices.best_bid_price)
    price = safe_round_price(best * 0.90, tick_size)
    order = rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=0,
        price=price,
        quantity=0.001,
        time_in_force="GTD",
        post_only=False,
        dry_run=True,
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(order, rc._models.DryRunOrderCreatedDto)


def test_rest_market_order_dry(rc, sid):
    sub = next(s for s in rc.list_subaccounts(sender=rc.chain.address) if s.id == sid)
    pid = rc.list_products()[0].id
    order = rc.create_order(
        order_type="MARKET",
        product_id=pid,
        side=0,
        quantity=0.001,
        dry_run=True,
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(order, rc._models.DryRunOrderCreatedDto)


def test_rest_market_order_submit(rc, sid):
    sub = next(s for s in rc.list_subaccounts(sender=rc.chain.address) if s.id == sid)
    pid = rc.list_products()[0].id
    order = rc.create_order(
        order_type="MARKET",
        product_id=pid,
        side=0,
        quantity=0.001,
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(order, rc._models.SubmitOrderCreatedDto)
    rate_limit(1)


def test_rest_market_order_submit_close(rc, sid):
    sub = next(s for s in rc.list_subaccounts(sender=rc.chain.address) if s.id == sid)
    pid = rc.list_products()[0].id
    o1 = rc.create_order(
        order_type="MARKET",
        product_id=pid,
        side=0,
        quantity=0.001,
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(o1, rc._models.SubmitOrderCreatedDto)
    o2 = rc.create_order(
        order_type="MARKET",
        product_id=pid,
        side=1,
        quantity=0,
        reduce_only=True,
        close=True,
        sender=rc.chain.address,
        subaccount=sub.name,
    )
    assert isinstance(o2, rc._models.SubmitOrderCreatedDto)
    rate_limit(2)


def test_rest_prepare_and_sign_limit_order(rc, sid):
    sub = next(s for s in rc.list_subaccounts(sender=rc.chain.address) if s.id == sid)
    products = rc.list_products()
    pid = products[0].id
    onchain_id = products[0].onchain_id
    tick_size = float(rc.products_by_id[pid].tick_size)
    prices = rc.list_market_prices(product_ids=[pid])[0]
    best = float(prices.best_bid_price)
    price = safe_round_price(best * 0.90, tick_size)
    order = rc.prepare_order(
        sender=rc.chain.address,
        subaccount=sub.name,
        order_type="LIMIT",
        onchain_id=onchain_id,
        side=0,
        price=price,
        quantity=0.001,
        time_in_force="GTD",
        post_only=False,
        include_signature=True,
    )
    assert isinstance(order, rc._models.SubmitOrderDto) and order.signature != ""


def test_rest_prepare_and_sign_market_order(rc, sid):
    sub = next(s for s in rc.list_subaccounts(sender=rc.chain.address) if s.id == sid)
    products = rc.list_products()
    onchain_id = products[0].onchain_id
    order = rc.prepare_order(
        sender=rc.chain.address,
        subaccount=sub.name,
        order_type="MARKET",
        onchain_id=onchain_id,
        side=0,
        price="0",
        quantity=0.001,
        include_signature=True,
    )
    assert isinstance(order, rc._models.SubmitOrderDto) and order.signature != ""
