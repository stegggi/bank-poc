import pytest
import asyncio


def test_ws_open(ws_base):
    """Test opening a websocket connection."""
    assert ws_base.sio is not None


@pytest.mark.asyncio
async def test_ws_emit(ws_base):
    """Test emitting an event to the server."""

    def log_callback(data):
        ws_base.logger.info(f"Received data: {data}")

    ws_base.callbacks["BookDepth"] = [log_callback]
    ws_base._emit(
        "subscribe",
        {"type": "BookDepth", "productId": "4368f737-eeed-40bc-bb1b-7b9bfd88a057"},
        namespace="/v1/stream",
    )

    # await until a log appears
    await asyncio.sleep(2)
    assert ws_base.sio is not None
