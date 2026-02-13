from typing import Union, Dict, Any, Optional, List, Callable
import asyncio
import socketio

from ethereal.models.config import WSBaseConfig
from ethereal.base_client import BaseClient


class AsyncWSBase(BaseClient):
    """Async websocket client base class.

    Args:
        config (Union[Dict[str, Any], WSBaseConfig]): Configuration dictionary or WSBaseConfig object.
            Required fields include:
            - base_url (str): Base URL for websocket requests
            Optional fields include:
            - verbose (bool): Enables debug logging, defaults to False
    """

    def __init__(self, config: Union[Dict[str, Any], WSBaseConfig]):
        super().__init__(config)
        self.config = WSBaseConfig.model_validate(config)
        self.base_url = f"{self.config.base_url}"
        self.sio: Optional[socketio.AsyncClient] = None
        self.callbacks: dict[str, List[Callable]] = {}

    async def open(self, namespaces: Optional[List[str]] = None) -> None:
        """Open the websocket client connection."""
        if self.sio is None:
            self.sio = socketio.AsyncClient(
                logger=self.config.verbose, engineio_logger=self.config.verbose
            )

            @self.sio.event
            async def connect():
                self.logger.info("Connected to server")

            @self.sio.event
            async def disconnect():
                self.logger.info("Disconnected from server")

            @self.sio.on("*", namespace="*")
            async def catch_all(event, namespace, data):
                self.logger.debug(
                    f"Received event: {event} in namespace {namespace} with data: {data}"
                )
                if event in self.callbacks:
                    for callback in self.callbacks[event]:
                        try:
                            if asyncio.iscoroutinefunction(callback):
                                await callback(data)
                            else:
                                callback(data)
                        except Exception as e:
                            self.logger.error(
                                f"Error in callback for event {event}: {e}"
                            )

        await self.sio.connect(
            self.base_url,
            transports=["websocket"],
            namespaces=namespaces,
        )

    async def close(self) -> None:
        """Close the websocket client connection."""
        if self.sio is not None:
            await self.sio.disconnect()

    async def wait(self) -> None:
        """Wait for the connection to be established and maintained."""
        if self.sio is not None:
            await self.sio.wait()

    async def _emit(
        self, event: str, data: Dict[str, Any], namespace: Optional[str] = None
    ) -> Any:
        """Emit an event to the server.

        Args:
            event (str): Event name
            data (Dict[str, Any]): Event data
            namespace (Optional[str]): Namespace to emit to

        Returns:
            Any: Response from the server
        """
        if self.sio is None:
            raise RuntimeError("WebSocket is not connected")

        return await self.sio.emit(event, data, callback=True, namespace=namespace)
