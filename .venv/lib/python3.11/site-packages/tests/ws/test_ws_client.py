import pytest
import asyncio


def test_ws_open(ws):
    """Test opening a websocket connection."""
    assert ws.sio is not None


@pytest.mark.asyncio
async def test_ws_emit(ws):
    """Test emitting an event to the server."""

    def log_callback(data):
        ws.logger.info(f"Received data: {data}")

    # Set callbacks on the client
    ws.callbacks["BookDepth"] = [log_callback]
    ws.callbacks["OrderFill"] = [log_callback]

    ws.subscribe(
        stream_type="BookDepth",
        product_id="4368f737-eeed-40bc-bb1b-7b9bfd88a057",
    )

    ws.subscribe(
        stream_type="OrderFill",
        product_id="4368f737-eeed-40bc-bb1b-7b9bfd88a057",
        subaccount_id="f051803c-a388-4ae5-815c-ad69338ead86",
    )

    # await until a log appears
    await asyncio.sleep(2)
    assert ws.sio is not None
