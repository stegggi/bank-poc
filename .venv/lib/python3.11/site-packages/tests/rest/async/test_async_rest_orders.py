"""Pure async REST API tests for submitting and managing orders."""

import asyncio
import time
from decimal import Decimal
from typing import List
import uuid
import pytest
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
async def test_rest_limit_order_floats_submit_cancel(
    async_rc, async_subaccount, network
):
    subaccount = async_subaccount
    pid = (await async_rc.list_products())[0].id
    tick_size = float((await async_rc.products_by_id())[pid].tick_size)
    prices = (await async_rc.list_market_prices(product_ids=[pid]))[0]
    best_bid_price = float(prices.best_bid_price)
    bid_price = safe_round_price(best_bid_price * 0.90, tick_size)
    order = await async_rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=0,
        price=bid_price,
        quantity=0.003,
        time_in_force="GTD",
        post_only=False,
        sender=async_rc.chain.address,
        subaccount=subaccount.name,
    )
    assert isinstance(order, async_rc._models.SubmitOrderCreatedDto)
    cancelled = await async_rc.cancel_orders(
        sender=async_rc.chain.address, subaccount=subaccount.name, order_ids=[order.id]
    )
    assert isinstance(cancelled, List)
    assert all(isinstance(o, async_rc._models.CancelOrderResultDto) for o in cancelled)
    rate_limit(2)


@pytest.mark.asyncio
async def test_rest_limit_order_decimal_submit_cancel(
    async_rc, async_subaccount, network
):
    subaccount = async_subaccount
    products = await async_rc.list_products()
    pid = next(p.id for p in products if getattr(p, "ticker", None) == "ETHUSD")
    tick_size = float((await async_rc.products_by_id())[pid].tick_size)
    prices = (await async_rc.list_market_prices(product_ids=[pid]))[0]
    best_bid_price = float(prices.best_bid_price)
    bid_price = safe_round_price(best_bid_price * 0.90, tick_size)
    expires_at = int(time.time()) + 3600
    order = await async_rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=0,
        price=Decimal(str(bid_price)),
        quantity=Decimal("0.003"),
        time_in_force="GTD",
        expires_at=expires_at,
        post_only=False,
        sender=async_rc.chain.address,
        subaccount=subaccount.name,
    )
    assert isinstance(order, async_rc._models.SubmitOrderCreatedDto)
    await asyncio.sleep(2)
    fetched = await async_rc.get_order(order.id)
    assert isinstance(fetched, async_rc._models.OrderDto)
    assert fetched.id == order.id and int(fetched.expires_at) == expires_at
    cancelled = await async_rc.cancel_orders(
        sender=async_rc.chain.address, subaccount=subaccount.name, order_ids=[order.id]
    )
    assert isinstance(cancelled, List)
    assert all(isinstance(o, async_rc._models.CancelOrderResultDto) for o in cancelled)
    rate_limit(2)


@pytest.mark.asyncio
async def test_async_limit_order_with_client_order_id_uuid(async_rc, async_subaccount):
    """Create an order with a clientOrderId, fetch it, and verify filtering by client id."""
    client = async_rc
    sub = async_subaccount

    products = await client.list_products()
    pid = products[0].id
    products_by_id = {p.id: p for p in products}
    tick_size = float(products_by_id[pid].tick_size)
    prices = (await client.list_market_prices(product_ids=[pid]))[0]
    best_bid = float(prices.best_bid_price)
    price = float(Decimal(str(best_bid)) * Decimal("0.90"))
    if tick_size:
        q = Decimal(str(price)) / Decimal(str(tick_size))
        price = float((q.quantize(Decimal("1"))) * Decimal(str(tick_size)))

    coid = str(uuid.uuid4())
    created = await client.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=0,
        price=Decimal(str(price)),
        quantity=Decimal("0.003"),
        time_in_force="GTD",
        post_only=False,
        client_order_id=coid,
        sender=client.chain.address,
        subaccount=sub.name,
    )
    assert created.client_order_id == coid

    await asyncio.sleep(2)
    fetched = await client.get_order(created.id)
    assert fetched.id == created.id
    orders = await client.list_orders(subaccount_id=sub.id, client_order_id=coid)
    assert any(o.id == created.id for o in orders)

    await client.cancel_orders(
        sender=client.chain.address,
        subaccount=sub.name,
        order_ids=[],
        client_order_ids=[coid],
    )
    await asyncio.sleep(2)
    fetched_cancel = await client.get_order(created.id)
    assert fetched_cancel.status.value == "CANCELED"
    rate_limit(2)


@pytest.mark.asyncio
async def test_async_limit_order_with_client_order_id_string(
    async_rc, async_subaccount
):
    """Create an order with a clientOrderId specified as a non-UUID string."""
    client = async_rc
    sub = async_subaccount

    products = await client.list_products()
    pid = products[0].id
    products_by_id = {p.id: p for p in products}
    tick_size = float(products_by_id[pid].tick_size)
    prices = (await client.list_market_prices(product_ids=[pid]))[0]
    best_bid = float(prices.best_bid_price)
    price = float(Decimal(str(best_bid)) * Decimal("0.90"))
    if tick_size:
        q = Decimal(str(price)) / Decimal(str(tick_size))
        price = float((q.quantize(Decimal("1"))) * Decimal(str(tick_size)))

    coid = str(uuid.uuid4()).replace("-", "")
    created = await client.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=0,
        price=Decimal(str(price)),
        quantity=Decimal("0.003"),
        time_in_force="GTD",
        post_only=False,
        client_order_id=coid,
        sender=client.chain.address,
        subaccount=sub.name,
    )
    assert created.client_order_id == coid

    await asyncio.sleep(2)
    fetched = await client.get_order(created.id)
    assert fetched.id == created.id
    orders = await client.list_orders(subaccount_id=sub.id, client_order_id=coid)
    assert any(o.id == created.id for o in orders)

    await client.cancel_orders(
        sender=client.chain.address,
        subaccount=sub.name,
        order_ids=[],
        client_order_ids=[coid],
    )
    await asyncio.sleep(2)
    fetched_cancel = await client.get_order(created.id)
    assert fetched_cancel.status.value == "CANCELED"
    rate_limit(2)


@pytest.mark.asyncio
async def test_async_limit_order_with_client_order_id_string_short(
    async_rc, async_subaccount
):
    """Create an order with a clientOrderId under 32 characters."""
    client = async_rc
    sub = async_subaccount

    products = await client.list_products()
    pid = products[0].id
    products_by_id = {p.id: p for p in products}
    tick_size = float(products_by_id[pid].tick_size)
    prices = (await client.list_market_prices(product_ids=[pid]))[0]
    best_bid = float(prices.best_bid_price)
    price = float(Decimal(str(best_bid)) * Decimal("0.90"))
    if tick_size:
        q = Decimal(str(price)) / Decimal(str(tick_size))
        price = float((q.quantize(Decimal("1"))) * Decimal(str(tick_size)))

    coid = str(uuid.uuid4()).replace("-", "")[:20] + "ZZZZ"
    created = await client.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=0,
        price=Decimal(str(price)),
        quantity=Decimal("0.003"),
        time_in_force="GTD",
        post_only=False,
        client_order_id=coid,
        sender=client.chain.address,
        subaccount=sub.name,
    )
    assert created.client_order_id == coid

    await asyncio.sleep(2)
    fetched = await client.get_order(created.id)
    assert fetched.id == created.id
    orders = await client.list_orders(subaccount_id=sub.id, client_order_id=coid)
    assert any(o.id == created.id for o in orders)

    await client.cancel_orders(
        sender=client.chain.address,
        subaccount=sub.name,
        order_ids=[],
        client_order_ids=[coid],
    )
    await asyncio.sleep(2)
    fetched_cancel = await client.get_order(created.id)
    assert fetched_cancel.status.value == "CANCELED"
    rate_limit(2)


@pytest.mark.asyncio
async def test_rest_limit_order_submit_cancel_multiple(
    async_rc, async_subaccount, network
):
    subaccount = async_subaccount
    pid = (await async_rc.list_products())[0].id
    tick_size = float((await async_rc.products_by_id())[pid].tick_size)
    prices = (await async_rc.list_market_prices(product_ids=[pid]))[0]
    best_bid_price = float(prices.best_bid_price)
    bid_price = safe_round_price(best_bid_price * 0.90, tick_size)
    ids = []
    for _ in range(2):
        o = await async_rc.create_order(
            order_type="LIMIT",
            product_id=pid,
            side=0,
            price=bid_price,
            quantity=0.003,
            time_in_force="GTD",
            post_only=False,
            sender=async_rc.chain.address,
            subaccount=subaccount.name,
        )
        assert isinstance(o, async_rc._models.SubmitOrderCreatedDto)
        ids.append(o.id)
    cancelled = await async_rc.cancel_orders(
        sender=async_rc.chain.address, subaccount=subaccount.name, order_ids=ids
    )
    assert isinstance(cancelled, List)
    assert all(isinstance(o, async_rc._models.CancelOrderResultDto) for o in cancelled)
    rate_limit(4)


@pytest.mark.asyncio
async def test_rest_limit_order_submit_cancel_all(async_rc, async_subaccount, network):
    sub = async_subaccount
    pid = (await async_rc.list_products())[0].id
    try:
        await async_rc.cancel_all_orders(
            sender=async_rc.chain.address, subaccount_id=sub.id, product_ids=[pid]
        )
    except Exception:
        pass
    tick_size = float((await async_rc.products_by_id())[pid].tick_size)
    prices = (await async_rc.list_market_prices(product_ids=[pid]))[0]
    best = float(prices.best_bid_price)
    ids = []
    for i in range(3):
        price = safe_round_price(best * (0.90 + i * 0.01), tick_size)
        o = await async_rc.create_order(
            order_type="LIMIT",
            product_id=pid,
            side=0,
            price=price,
            quantity=0.003,
            sender=async_rc.chain.address,
            subaccount=sub.name,
        )
        ids.append(o.id)
    cancelled = await async_rc.cancel_all_orders(
        sender=async_rc.chain.address, subaccount_id=sub.id, product_ids=[pid]
    )
    assert isinstance(cancelled, List)
    assert len(cancelled) > 0
    await asyncio.sleep(2)
    for c in cancelled:
        ord = await async_rc.get_order(id=c.id)
        assert ord.status.value == "CANCELED"
    rate_limit(10)


@pytest.mark.asyncio
async def test_rest_limit_order_submit_cancel_all_specify_products(async_rc, network):
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]
    products = await async_rc.list_products()
    order_ids = {}
    for i in range(2):
        pid = products[i].id
        info = (await async_rc.products_by_id())[pid]
        tick = Decimal(str(info.tick_size))
        min_quantity = Decimal(str(info.min_quantity))
        prices = (await async_rc.list_market_prices(product_ids=[pid]))[0]
        best = Decimal(str(prices.best_bid_price))
        order_ids[pid] = []
        for j in range(2):
            price = safe_round_price(best * Decimal(str(0.90 + j * 0.01)), tick)
            o = await async_rc.create_order(
                order_type="LIMIT",
                product_id=pid,
                side=0,
                price=price,
                quantity=min_quantity,
                time_in_force="GTD",
                post_only=False,
                sender=async_rc.chain.address,
                subaccount=sub.name,
            )
            order_ids[pid].append(o.id)
    cancelled = await async_rc.cancel_all_orders(
        sender=async_rc.chain.address,
        subaccount_id=sub.id,
        product_ids=[products[0].id],
    )
    assert len(cancelled) > 0
    await asyncio.sleep(2)
    for c in cancelled:
        ord = await async_rc.get_order(id=c.id)
        assert ord.status.value == "CANCELED"
    for oid in order_ids[products[1].id]:
        ord = await async_rc.get_order(id=oid)
        assert ord.status.value == "NEW"
    cancelled2 = await async_rc.cancel_all_orders(
        sender=async_rc.chain.address,
        subaccount_id=sub.id,
        product_ids=[products[1].id],
    )
    assert len(cancelled2) > 0
    await asyncio.sleep(2)
    for c in cancelled2:
        ord = await async_rc.get_order(id=c.id)
        assert ord.status.value == "CANCELED"
    rate_limit(16)


@pytest.mark.asyncio
async def test_rest_limit_order_submit_cancel_all_multiple_products(async_rc, network):
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]
    products = await async_rc.list_products()
    ids = []
    for i in range(2):
        pid = products[i].id
        info = (await async_rc.products_by_id())[pid]
        tick = Decimal(str(info.tick_size))
        min_quantity = Decimal(str(info.min_quantity))
        prices = (await async_rc.list_market_prices(product_ids=[pid]))[0]
        best = Decimal(str(prices.best_bid_price))
        for j in range(2):
            price = safe_round_price(best * Decimal(str(0.90 + j * 0.01)), tick)
            o = await async_rc.create_order(
                order_type="LIMIT",
                product_id=pid,
                side=0,
                price=price,
                quantity=min_quantity,
                time_in_force="GTD",
                post_only=False,
                sender=async_rc.chain.address,
                subaccount=sub.name,
            )
            ids.append(o.id)
    cancelled = await async_rc.cancel_all_orders(
        sender=async_rc.chain.address, subaccount_id=sub.id
    )
    assert isinstance(cancelled, List) and len(cancelled) > 0
    await asyncio.sleep(2)
    for c in cancelled:
        ord = await async_rc.get_order(id=c.id)
        assert ord.status.value == "CANCELED"
    rate_limit(13)


@pytest.mark.asyncio
async def test_rest_limit_order_dry(async_rc, network):
    subaccounts = await async_rc.subaccounts()
    pid = (await async_rc.list_products())[0].id
    tick_size = float((await async_rc.products_by_id())[pid].tick_size)
    prices = (await async_rc.list_market_prices(product_ids=[pid]))[0]
    best = float(prices.best_bid_price)
    price = safe_round_price(best * 0.90, tick_size)
    order = await async_rc.create_order(
        order_type="LIMIT",
        product_id=pid,
        side=0,
        price=price,
        quantity=0.003,
        time_in_force="GTD",
        post_only=False,
        dry_run=True,
        sender=async_rc.chain.address,
        subaccount=subaccounts[0].name,
    )
    assert isinstance(order, async_rc._models.DryRunOrderCreatedDto)


@pytest.mark.asyncio
async def test_rest_market_order_dry(async_rc, network):
    subaccounts = await async_rc.subaccounts()
    pid = (await async_rc.list_products())[0].id
    order = await async_rc.create_order(
        order_type="MARKET",
        product_id=pid,
        side=0,
        quantity=0.003,
        dry_run=True,
        sender=async_rc.chain.address,
        subaccount=subaccounts[0].name,
    )
    assert isinstance(order, async_rc._models.DryRunOrderCreatedDto)


@pytest.mark.asyncio
async def test_rest_market_order_submit(async_rc, network):
    subaccounts = await async_rc.subaccounts()
    pid = (await async_rc.list_products())[0].id
    order = await async_rc.create_order(
        order_type="MARKET",
        product_id=pid,
        side=0,
        quantity=0.003,
        sender=async_rc.chain.address,
        subaccount=subaccounts[0].name,
    )
    assert isinstance(order, async_rc._models.SubmitOrderCreatedDto)
    rate_limit(1)


@pytest.mark.asyncio
async def test_rest_market_order_submit_close(async_rc, network):
    subaccounts = await async_rc.subaccounts()
    pid = (await async_rc.list_products())[0].id
    o1 = await async_rc.create_order(
        order_type="MARKET",
        product_id=pid,
        side=0,
        quantity=0.003,
        sender=async_rc.chain.address,
        subaccount=subaccounts[0].name,
    )
    assert isinstance(o1, async_rc._models.SubmitOrderCreatedDto)
    o2 = await async_rc.create_order(
        order_type="MARKET",
        product_id=pid,
        side=1,
        quantity=0,
        reduce_only=True,
        close=True,
        sender=async_rc.chain.address,
        subaccount=subaccounts[0].name,
    )
    assert isinstance(o2, async_rc._models.SubmitOrderCreatedDto)
    rate_limit(2)


@pytest.mark.asyncio
async def test_rest_prepare_and_sign_limit_order(async_rc, network):
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]
    products = await async_rc.list_products()
    pid = products[0].id
    onchain_id = products[0].onchain_id
    tick_size = float((await async_rc.products_by_id())[pid].tick_size)
    prices = (await async_rc.list_market_prices(product_ids=[pid]))[0]
    best = float(prices.best_bid_price)
    price = safe_round_price(best * 0.90, tick_size)
    order = await async_rc.prepare_order(
        sender=async_rc.chain.address,
        subaccount=sub.name,
        order_type="LIMIT",
        onchain_id=onchain_id,
        side=0,
        price=price,
        quantity=0.003,
        time_in_force="GTD",
        post_only=False,
        include_signature=True,
    )
    assert isinstance(order, async_rc._models.SubmitOrderDto) and order.signature != ""


@pytest.mark.asyncio
async def test_rest_prepare_and_sign_market_order(async_rc, network):
    subaccounts = await async_rc.list_subaccounts(sender=async_rc.chain.address)
    sub = subaccounts[0]
    products = await async_rc.list_products()
    onchain_id = products[0].onchain_id
    order = await async_rc.prepare_order(
        sender=async_rc.chain.address,
        subaccount=sub.name,
        order_type="MARKET",
        onchain_id=onchain_id,
        side=0,
        price="0",
        quantity=0.003,
        include_signature=True,
    )
    assert isinstance(order, async_rc._models.SubmitOrderDto) and order.signature != ""
