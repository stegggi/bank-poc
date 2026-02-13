from typing import Union, Dict, Any, Callable, Optional
import warnings
from uuid import UUID

from ethereal.models.config import WSConfig
from ethereal.ws.async_ws_base import AsyncWSBase


class AsyncWSClient(AsyncWSBase):
    """Ethereal async websocket client.

    Args:
        config (Union[Dict[str, Any], WSConfig]): Configuration dictionary or WSConfig object.
            Required fields include:
            - base_url (str): Base URL for websocket requests
            Optional fields include:
            - verbose (bool): Enables debug logging, defaults to False
    """

    def __init__(self, config: Union[Dict[str, Any], WSConfig]):
        super().__init__(config)

    async def subscribe(
        self,
        stream_type: str,
        product_id: Optional[str | UUID] = None,
        subaccount_id: Optional[str | UUID] = None,
        callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        namespace: Optional[str] = "/v1/stream",
    ) -> Dict[str, Any]:
        """Subscribe to a specific stream.

        Args:
            stream_type (str): Type of stream to subscribe to
            product_id (Optional[str]): Product ID to subscribe to
            subaccount_id (Optional[str]): Subaccount ID, optional
            callback (Optional[Callable]): DEPRECATED. Set callbacks directly on the client instead:
                `ws_client.callbacks["BookDepth"] = [my_handler]`
                This parameter will be removed in a future version..
            namespace (Optional[str]): Namespace to subscribe to

        Returns:
            Dict[str, Any]: Subscription response

        Example:
            ```python
            # Correct way (set callbacks on client):
            ws_client.callbacks["BookDepth"] = [my_handler]
            await ws_client.subscribe(stream_type="BookDepth", product_id=product_id)

            # Old way (deprecated):
            await ws_client.subscribe(stream_type="BookDepth", product_id=product_id, callback=my_handler)
            ```
        """
        subscription_data: Dict[str, str] = {"type": stream_type}

        if subaccount_id:
            subscription_data["subaccountId"] = str(subaccount_id)
        if product_id:
            subscription_data["productId"] = str(product_id)

        if callback is not None:
            warnings.warn(
                "Passing 'callback' to subscribe() is deprecated and will be removed in a future version.",
                DeprecationWarning,
                stacklevel=2,
            )
            self.callbacks.setdefault(stream_type, []).append(callback)

        return await self._emit("subscribe", subscription_data, namespace=namespace)

    async def unsubscribe(
        self,
        stream_type: str,
        product_id: Optional[str] = None,
        subaccount_id: Optional[str] = None,
        namespace: Optional[str] = "/v1/stream",
    ) -> Dict[str, Any]:
        """Unsubscribe from a specific stream.

        Args:
            stream_type (str): Type of stream to unsubscribe from
            product_id (Optional[str]): Product ID to unsubscribe from
            subaccount_id (Optional[str]): Subaccount ID, optional
            namespace (Optional[str]): Namespace to unsubscribe from

        Returns:
            Dict[str, Any]: Unsubscription response
        """
        unsubscription_data: Dict[str, Any] = {"type": stream_type}

        if subaccount_id:
            unsubscription_data["subaccountId"] = subaccount_id
        if product_id:
            unsubscription_data["productId"] = product_id

        return await self._emit("unsubscribe", unsubscription_data, namespace=namespace)
