from typing import Union, Dict, Any, Optional, List, Callable
import asyncio
import threading
import socketio

from ethereal.models.config import WSBaseConfig
from ethereal.base_client import BaseClient

try:
    import uvloop  # type: ignore

    uvloop_enabled = True
except Exception:
    uvloop_enabled = False


def _create_event_loop() -> asyncio.AbstractEventLoop:
    if uvloop_enabled:
        try:
            asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())
        except Exception:
            pass
    return asyncio.new_event_loop()


class WSBase(BaseClient):
    """Websocket client base class.

    Args:
        config (Union[Dict[str, Any], WSConfig]): Configuration dictionary or WSConfig object.
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
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.thread: Optional[threading.Thread] = None
        self.callbacks: dict[str, List[Callable]] = {}
        self._loop_ready = threading.Event()

    def _run_loop(self) -> None:
        """Run the event loop in the background thread."""
        assert self.loop is not None
        asyncio.set_event_loop(self.loop)
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
                        callback(data)
                    except Exception as e:
                        self.logger.error(f"Error in callback for event {event}: {e}")

        self._loop_ready.set()
        self.loop.run_forever()

    def open(self, namespaces: Optional[List[str]] = None) -> None:
        """Open the websocket client connection."""
        if not self.loop or self.loop.is_closed():
            self._loop_ready.clear()
            self.loop = _create_event_loop()
            self.thread = threading.Thread(target=self._run_loop, daemon=True)
            self.thread.start()
            self._loop_ready.wait()

        assert self.sio is not None
        future = asyncio.run_coroutine_threadsafe(
            self.sio.connect(
                self.base_url,
                transports=["websocket"],
                namespaces=namespaces,
            ),
            self.loop,
        )
        future.result()

    def close(self) -> None:
        """Close the websocket client connection."""
        if self.thread and self.loop and not self.loop.is_closed():
            assert self.sio is not None
            asyncio.run_coroutine_threadsafe(self.sio.disconnect(), self.loop).result()
            self.loop.call_soon_threadsafe(self.loop.stop)
            self.thread.join()
            self.loop.close()
            self.loop = None
            self.thread = None
            self.sio = None

    def _emit(
        self, event: str, data: Dict[str, Any], namespace: Optional[str] = None
    ) -> Any:
        """Emit an event to the server.

        Args:
            event (str): Event name
            data (Dict[str, Any]): Event data

        Returns:
            Any: Response from the server
        """
        if not self.loop or self.loop.is_closed() or not self.sio:
            raise RuntimeError("WebSocket is not connected")

        future = asyncio.run_coroutine_threadsafe(
            self.sio.emit(event, data, callback=True, namespace=namespace), self.loop
        )
        return future.result()
