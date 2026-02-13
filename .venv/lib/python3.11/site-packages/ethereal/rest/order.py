import time
from typing import List, Optional, Union
from decimal import Decimal
from uuid import UUID
from ethereal.constants import API_PREFIX
from ethereal.rest.util import (
    generate_nonce,
    uuid_to_bytes32,
    client_order_id_to_bytes32,
)
from ethereal.models.rest import (
    OrderDto,
    OrderFillDto,
    TradeDto,
    SubmitOrderDto,
    SubmitOrderLimitDtoData,
    SubmitOrderMarketDtoData,
    CancelOrderDto,
    CancelOrderResultDto,
    DryRunOrderCreatedDto,
    SubmitOrderCreatedDto,
)


async def list_orders(self, **kwargs) -> List[OrderDto]:
    """Lists orders for a subaccount.

    Args:
        subaccount_id (str): UUID of the subaccount. Required.

    Other Parameters:
        product_ids (List[str], optional): Filter by one or more product IDs. Optional.
        client_order_id (str, optional): Filter by a client-generated order id. Optional.
        statuses (List[str], optional): Filter by status values. Optional.
        created_after (float, optional): Filter orders created after this timestamp. Optional.
        created_before (float, optional): Filter orders created before this timestamp. Optional.
        side (int, optional): Filter by order side (0 for buy, 1 for sell). Optional.
        close (bool, optional): Filter by close flag. Optional.
        stop_types (List[int], optional): Filter by stop types (0 for GAIN, 1 for LOSS). Optional.
        is_working (bool, optional): Filter working orders. Optional.
        is_pending (bool, optional): Filter pending orders. Optional.
        order (str, optional): Sort order, 'asc' or 'desc'. Optional.
        limit (float, optional): Maximum number of results to return. Optional.
        cursor (str, optional): Pagination cursor for fetching the next page. Optional.
        order_by (str, optional): Field to order by (e.g., 'createdAt'). Optional.
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        List[OrderDto]: Order records for the subaccount.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/order",
        request_model=self._models.V1OrderGetParametersQuery,
        response_model=self._models.PageOfOrderDtos,
        **kwargs,
    )
    data = [
        self._models.OrderDto(**model.model_dump(by_alias=True)) for model in res.data
    ]
    return data


async def list_fills(self, **kwargs) -> List[OrderFillDto]:
    """Lists order fills for a subaccount.

    Args:
        subaccount_id (str): UUID of the subaccount. Required.

    Other Parameters:
        product_ids (List[str], optional): Filter by one or more product IDs. Optional.
        created_after (float, optional): Filter fills created after this timestamp. Optional.
        created_before (float, optional): Filter fills created before this timestamp. Optional.
        side (int, optional): Filter by order side (0 for buy, 1 for sell). Optional.
        include_self_trades (bool, optional): Include self trades in results. Defaults to False. Optional.
        order (str, optional): Sort order, 'asc' or 'desc'. Optional.
        limit (float, optional): Maximum number of results to return. Optional.
        cursor (str, optional): Pagination cursor for fetching the next page. Optional.
        order_by (str, optional): Field to order by (e.g., 'createdAt', 'productId'). Optional.
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        List[OrderFillDto]: Fill records for the subaccount.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/order/fill",
        request_model=self._models.V1OrderFillGetParametersQuery,
        response_model=self._models.PageOfOrderFillDtos,
        **kwargs,
    )
    data = [
        self._models.OrderFillDto(**model.model_dump(by_alias=True))
        for model in res.data
    ]
    return data


async def list_trades(self, **kwargs) -> List[TradeDto]:
    """Lists trades for a specific product.

    Args:
        product_id (str): Product ID to query trades for. Required.

    Other Parameters:
        order (str, optional): Sort order, 'asc' or 'desc'. Optional.
        limit (float, optional): Maximum number of results to return. Optional.
        cursor (str, optional): Pagination cursor for fetching the next page. Optional.
        order_by (str, optional): Field to order by (e.g., 'createdAt'). Optional.
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        List[TradeDto]: Trade records.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/order/trade",
        request_model=self._models.V1OrderTradeGetParametersQuery,
        response_model=self._models.PageOfTradeDtos,
        **kwargs,
    )
    data = [
        self._models.TradeDto(**model.model_dump(by_alias=True)) for model in res.data
    ]
    return data


async def get_order(self, id: UUID, **kwargs) -> OrderDto:
    """Gets a specific order by ID.

    Args:
        id (str): UUID of the order. Required.

    Other Parameters:
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        OrderDto: Order details.
    """
    endpoint = f"{API_PREFIX}/order/{id}"
    response = await self.get(endpoint, **kwargs)
    return self._models.OrderDto(**response)


async def prepare_order(
    self,
    sender: str,
    price: Optional[Union[str, float, Decimal]] = None,
    quantity: Optional[Union[str, float, Decimal]] = None,
    side: Optional[int] = None,
    subaccount: Optional[str] = None,
    onchain_id: Optional[float] = None,
    order_type: Optional[str] = None,
    client_order_id: Optional[str] = None,
    time_in_force: Optional[str] = None,
    post_only: Optional[bool] = False,
    reduce_only: Optional[bool] = False,
    close: Optional[bool] = None,
    stop_price: Optional[Union[str, float, Decimal]] = None,
    stop_type: Optional[int] = None,
    group_id: Optional[str] = None,
    group_contingency_type: Optional[int] = None,
    expires_at: Optional[int] = None,
    include_signature: bool = False,
    **kwargs,
) -> SubmitOrderDto:
    """Prepares the payload for an order, optionally including a signature.

    Args:
        sender (str): Address placing the order. Required.
        price (Union[str, float, Decimal], optional): Limit price for LIMIT orders.
        quantity (Union[str, float, Decimal], optional): Order size.
        side (int, optional): 0 for buy, 1 for sell.
        subaccount (str, optional): Hex-encoded subaccount name.
        onchain_id (float, optional): Product onchain ID.
        order_type (str, optional): 'LIMIT' or 'MARKET'.
        client_order_id (str, optional): Subaccount-scoped client-generated id (UUID or <=32 alphanumeric).
        time_in_force (str, optional): For LIMIT orders (e.g., 'GTC', 'GTD').
        post_only (bool, optional): For LIMIT orders; rejects if crossing.
        reduce_only (bool, optional): If True, order only reduces position.
        close (bool, optional): If True, closes the position.
        stop_price (Union[str, float, Decimal], optional): Stop trigger price.
        stop_type (int, optional): Stop type enum value.
        group_id (str, optional): Contingency group id.
        group_contingency_type (int, optional): Group contingency type.
        expires_at (int, optional): Expiry timestamp for GTD.
        include_signature (bool): If True, sign the payload immediately.

    Other Parameters:
        nonce (str, optional): Custom nonce for signing.
        signed_at (int, optional): Seconds since epoch for signature timestamp.
        **kwargs: Additional request parameters accepted by the API.

    Returns:
        SubmitOrderDto: Prepared (and optionally signed) order payload.
    """
    # Generate nonce and signed_at timestamp
    nonce = kwargs.get("nonce", None) or generate_nonce()
    signed_at = kwargs.get("signed_at", None) or int(time.time())

    # Prepare order data with common fields
    order_data = {
        "sender": sender,
        "subaccount": subaccount,
        "quantity": quantity,
        "price": price,
        "side": side,
        "engineType": 0,
        "onchainId": onchain_id,
        "nonce": nonce,
        "type": order_type,
        "clientOrderId": client_order_id,
        "reduceOnly": reduce_only,
        "signedAt": signed_at,
        "close": close,
        "stopPrice": stop_price,
        "stopType": stop_type,
        "groupId": group_id,
        "groupContingencyType": group_contingency_type,
        "expiresAt": expires_at,
    }

    # Declare data_model type
    data_model: Union[SubmitOrderLimitDtoData, SubmitOrderMarketDtoData]

    # Create specific order data based on type
    if order_type == "LIMIT":
        order_data.update(
            {
                "timeInForce": time_in_force,
                "postOnly": post_only,
            }
        )
        data_model = self._models.SubmitOrderLimitDtoData.model_validate(order_data)
    elif order_type == "MARKET":
        data_model = self._models.SubmitOrderMarketDtoData.model_validate(order_data)
    else:
        raise ValueError(f"Invalid order type: {order_type}")

    result = self._models.SubmitOrderDto.model_validate(
        {
            "data": data_model.model_dump(
                mode="json", by_alias=True, exclude_unset=True, exclude_none=True
            ),
            "signature": "",
        }
    )

    if include_signature:
        result = await self.sign_order(result)

    return result


async def sign_order(
    self, order: SubmitOrderDto, private_key: Optional[str] = None
) -> SubmitOrderDto:
    """Signs an order payload using EIP-712.

    Args:
        order (SubmitOrderDto): Prepared order to sign. Required.
        private_key (str, optional): Private key override. Defaults to client's key.

    Returns:
        SubmitOrderDto: The same DTO with signature populated.

    Raises:
        ValueError: If no chain client or private key is available.
    """
    if not hasattr(self, "chain") or not self.chain:
        raise ValueError("No chain client available for signing")
    if not private_key and not self.chain.private_key:
        raise ValueError("No private key available for signing")
    elif not private_key:
        private_key = self.chain.private_key

    # Update message signedAt
    order.data.signed_at = int(time.time())

    # Prepare message for signing
    message = order.data.model_dump(mode="json", by_alias=True)

    # Make some adjustments to the message
    message["quantity"] = int(Decimal(message["quantity"]) * Decimal("1e9"))
    message["price"] = int(Decimal(message.get("price", 0)) * Decimal("1e9"))
    message["productId"] = int(message["onchainId"])
    message["signedAt"] = int(message["signedAt"])
    if message.get("clientOrderId"):
        message["clientOrderId"] = client_order_id_to_bytes32(message["clientOrderId"])

    # Get domain and types for signing
    primary_type = "TradeOrder"
    domain = self.rpc_config.domain.model_dump(mode="json", by_alias=True)
    types = self.chain.get_signature_types(self.rpc_config, primary_type)

    # Sign the message
    order.signature = self.chain.sign_message(
        private_key, domain, types, primary_type, message
    )
    return order


async def submit_order(
    self,
    order: SubmitOrderDto,
    **kwargs,
) -> SubmitOrderCreatedDto:
    """Submits a prepared and signed order.

    Args:
        order (SubmitOrderDto): Prepared and signed order payload. Required.

    Other Parameters:
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        SubmitOrderCreatedDto: Created order response.
    """
    endpoint = f"{API_PREFIX}/order"
    res = await self.post(
        endpoint,
        data=order.model_dump(
            mode="json", by_alias=True, exclude_unset=True, exclude_none=True
        ),
        **kwargs,
    )
    return self._models.SubmitOrderCreatedDto.model_validate(res)


async def dry_run_order(
    self,
    order: SubmitOrderDto,
    **kwargs,
) -> DryRunOrderCreatedDto:
    """Submits a prepared order for validation without execution.

    Args:
        order (SubmitOrderDto): Prepared order payload. Required.

    Other Parameters:
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        DryRunOrderCreatedDto: Dry-run validation result.
    """
    submit_payload = self._models.SubmitDryOrderDto.model_validate(
        {"data": order.data.model_dump(mode="json", by_alias=True, exclude_unset=True)}
    )
    endpoint = f"{API_PREFIX}/order/dry-run"
    res = await self.post(
        endpoint,
        data=submit_payload.model_dump(
            mode="json", by_alias=True, exclude_unset=True, exclude_none=True
        ),
        **kwargs,
    )
    return self._models.DryRunOrderCreatedDto.model_validate(res)


async def prepare_cancel_order(
    self,
    sender: str,
    subaccount: str,
    order_ids: List[UUID] = [],
    client_order_ids: List[str] = [],
    include_signature: bool = False,
    **kwargs,
) -> CancelOrderDto:
    """Prepares the payload for canceling one or more orders.

    Args:
        sender (str): Address initiating the cancellation. Required.
        subaccount (str): Hex-encoded subaccount name. Required.
        order_ids (List[str]): Order UUIDs to cancel. Optional.
        client_order_ids (List[str]): Client-generated IDs to cancel. Optional.
        include_signature (bool): If True, sign the payload immediately. Optional.

    Other Parameters:
        nonce (str, optional): Custom nonce for signing.
        **kwargs: Additional request parameters accepted by the API.

    Returns:
        CancelOrderDto: Prepared (and optionally signed) cancel payload.
    """
    nonce = kwargs.get("nonce", None) or generate_nonce()
    uuid_order_ids = [
        UUID(order_id) if isinstance(order_id, str) else order_id
        for order_id in order_ids
    ]
    data_model = self._models.CancelOrderDtoData(
        sender=sender,
        subaccount=subaccount,
        nonce=nonce,
        orderIds=uuid_order_ids,
        clientOrderIds=client_order_ids,
    )
    result = self._models.CancelOrderDto.model_validate(
        {"data": data_model.model_dump(mode="json", by_alias=True), "signature": ""}
    )
    if include_signature:
        return await self.sign_cancel_order(result)
    return result


async def sign_cancel_order(
    self,
    order_to_cancel: CancelOrderDto,
    private_key: Optional[str] = None,
) -> CancelOrderDto:
    """Signs a cancel order payload using EIP-712.

    Args:
        order_to_cancel (CancelOrderDto): Prepared cancel payload. Required.
        private_key (str, optional): Private key override. Defaults to client's key.

    Returns:
        CancelOrderDto: The same DTO with signature populated.

    Raises:
        ValueError: If no chain client or private key is available.
    """
    if not hasattr(self, "chain") or not self.chain:
        raise ValueError("No chain client available for signing")
    if not private_key and not self.chain.private_key:
        raise ValueError("No private key available for signing")
    elif not private_key:
        private_key = self.chain.private_key

    # Prepare message for signing
    message = order_to_cancel.data.model_dump(mode="json", by_alias=True)

    # For cancel orders, orderIds need to be converted to bytes32 format
    order_ids = (
        [uuid_to_bytes32(str(order_id)) for order_id in order_to_cancel.data.order_ids]
        if order_to_cancel.data.order_ids
        else []
    )
    message["orderIds"] = order_ids

    client_order_ids = (
        [client_order_id_to_bytes32(id) for id in order_to_cancel.data.client_order_ids]
        if order_to_cancel.data.client_order_ids
        else []
    )
    message["clientOrderIds"] = client_order_ids

    # Get domain and types for signing
    primary_type = "CancelOrder"
    domain = self.rpc_config.domain.model_dump(mode="json", by_alias=True)
    types = self.chain.get_signature_types(self.rpc_config, primary_type)

    # Sign the message
    order_to_cancel.signature = self.chain.sign_message(
        private_key, domain, types, primary_type, message
    )
    return order_to_cancel


async def cancel_order(
    self,
    order_to_cancel: CancelOrderDto,
    **kwargs,
) -> List[CancelOrderResultDto]:
    """Submits a prepared and signed cancel order request.

    Args:
        order_to_cancel (CancelOrderDto): Prepared and signed cancel payload. Required.

    Other Parameters:
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        List[CancelOrderResultDto]: Cancellation results per order id.
    """
    endpoint = f"{API_PREFIX}/order/cancel"
    res = await self.post(
        endpoint,
        data=order_to_cancel.model_dump(mode="json", by_alias=True, exclude_none=True),
        **kwargs,
    )
    return [
        self._models.CancelOrderResultDto.model_validate(item)
        for item in res.get("data", [])
    ]
