from __future__ import annotations

import asyncio
import inspect
import threading
from concurrent.futures import Future
from typing import Any, Callable, Dict, Optional, Union

from ethereal.async_rest_client import AsyncRESTClient
from ethereal.models.config import RESTConfig

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


class RESTClient:
    """Synchronous wrapper around AsyncRESTClient.

    Reuses a single async client on a background event loop thread and keeps
    backward compatibility (e.g., exposes `_async_client`). Use
    `AsyncRESTClient` directly in async code.
    """

    def __init__(self, config: Union[Dict[str, Any], RESTConfig] = {}):
        try:
            asyncio.get_running_loop()
            raise RuntimeError(
                "RESTClient cannot be used in async context. Use AsyncRESTClient instead."
            )
        except RuntimeError as e:
            if "RESTClient cannot be used in async context" in str(e):
                raise

        self._config = config
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._closed = False
        self._start_loop_thread()
        self._async_client: AsyncRESTClient = self._run_sync(
            lambda: AsyncRESTClient.create(self._config)
        )

    def _start_loop_thread(self):
        if self._thread is not None:
            return

        loop_ready = threading.Event()

        def _run_loop():
            self._loop = _create_event_loop()
            asyncio.set_event_loop(self._loop)
            loop_ready.set()
            self._loop.run_forever()

        self._thread = threading.Thread(
            target=_run_loop, name="EtherealRESTClientLoop", daemon=True
        )
        self._thread.start()
        loop_ready.wait()

    def _submit(self, coro_fn: Callable[[], Any]) -> Future:
        if self._closed:
            raise RuntimeError("RESTClient is closed")
        if self._loop is None:
            raise RuntimeError("Event loop not initialized")
        result = coro_fn()
        if not inspect.iscoroutine(result):

            async def _wrap(v):
                return v

            result = _wrap(result)
        return asyncio.run_coroutine_threadsafe(result, self._loop)

    def _run_sync(self, coro_factory: Callable[[], Any]):
        fut = self._submit(coro_factory)
        return fut.result()

    def __getattr__(self, name: str):
        attr = getattr(self._async_client, name, None)
        if attr is None:
            raise AttributeError(name)

        auto_call_methods = {
            "subaccounts",
            "products",
            "tokens",
            "products_by_id",
            "products_by_ticker",
        }

        if name in auto_call_methods and inspect.iscoroutinefunction(attr):
            return self._run_sync(lambda: attr())

        if inspect.iscoroutinefunction(attr):

            def _sync_wrapper(*args, **kwargs):
                return self._run_sync(lambda: attr(*args, **kwargs))

            return _sync_wrapper

        if callable(attr):

            def _callable_wrapper(*args, **kwargs):
                return self._run_sync(lambda: attr(*args, **kwargs))

            return _callable_wrapper

        return self._run_sync(lambda: getattr(self._async_client, name))

    def close(self):
        if self._closed:
            return
        self._closed = True

        try:
            if self._loop is not None:
                try:
                    self._run_sync(lambda: self._async_client.close())
                except Exception:
                    pass

                self._loop.call_soon_threadsafe(self._loop.stop)
        finally:
            if self._thread is not None:
                self._thread.join(timeout=5)
            self._thread = None
            self._loop = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
