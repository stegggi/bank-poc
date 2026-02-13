import pytest
import asyncio


@pytest.mark.asyncio
async def test_async_ws_open(async_ws):
    """Test opening an async websocket connection."""
    assert async_ws.sio is not None


@pytest.mark.asyncio
async def test_async_ws_emit(async_ws):
    """Test emitting an event to the server."""

    def log_callback(data):
        async_ws.logger.info(f"Received data: {data}")

    # Set callbacks on the client
    async_ws.callbacks["BookDepth"] = [log_callback]
    async_ws.callbacks["OrderFill"] = [log_callback]

    await async_ws.subscribe(
        stream_type="BookDepth",
        product_id="4368f737-eeed-40bc-bb1b-7b9bfd88a057",
    )

    await async_ws.subscribe(
        stream_type="OrderFill",
        product_id="4368f737-eeed-40bc-bb1b-7b9bfd88a057",
        subaccount_id="f051803c-a388-4ae5-815c-ad69338ead86",
    )

    await asyncio.sleep(2)
    assert async_ws.sio is not None
