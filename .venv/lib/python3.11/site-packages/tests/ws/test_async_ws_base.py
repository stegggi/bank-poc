import pytest
import asyncio


@pytest.mark.asyncio
async def test_async_ws_open(async_ws_base):
    """Test opening an async websocket connection."""
    assert async_ws_base.sio is not None


@pytest.mark.asyncio
async def test_async_ws_emit(async_ws_base):
    """Test emitting an event to the server."""

    def log_callback(data):
        async_ws_base.logger.info(f"Received data: {data}")

    async_ws_base.callbacks["BookDepth"] = [log_callback]
    await async_ws_base._emit(
        "subscribe",
        {"type": "BookDepth", "productId": "4368f737-eeed-40bc-bb1b-7b9bfd88a057"},
        namespace="/v1/stream",
    )

    await asyncio.sleep(2)
    assert async_ws_base.sio is not None
