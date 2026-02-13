import time
import uuid
from eth_utils import add_0x_prefix, decode_hex, encode_hex


class Bytes32Error(ValueError):
    pass


def ensure_bytes32(value):
    """Return a 32-byte representation of ``value`` (zero-padded on the left)."""
    if isinstance(value, (bytes, bytearray)):
        data = bytes(value)
    elif isinstance(value, str):
        raw = value[2:] if value.startswith("0x") else value
        raw = raw if len(raw) % 2 == 0 else "0" + raw
        try:
            data = decode_hex(add_0x_prefix(raw))
        except ValueError as exc:
            raise Bytes32Error(f"Invalid hex string: {value!r}") from exc
    else:
        raise Bytes32Error(f"Unsupported type: {type(value).__name__}")
    if len(data) > 32:
        raise Bytes32Error(f"Expected at most 32 bytes, got {len(data)} bytes")
    return data.rjust(32, b"\x00")


def ensure_bytes32_hex(value):
    """Return ``value`` as a 0x-prefixed 64-hex-digit string."""
    return encode_hex(ensure_bytes32(value))


def uuid_to_bytes32(uuid_str: str) -> str:
    """Converts UUID string to bytes32 hex format.

    Args:
        uuid_str (str): UUID string to convert.

    Returns:
        str: Bytes32 hex string prefixed with '0x'.
    """
    uuid_obj = uuid.UUID(uuid_str)

    # remove hyphens and convert to hex
    uuid_hex = uuid_obj.hex

    # pad the hex to make it 32 bytes
    padded_hex = uuid_hex.rjust(64, "0")

    return "0x" + padded_hex


def is_uuid(value: str) -> bool:
    """Checks if a string is a valid UUID.

    Args:
        value (str): String to check.

    Returns:
        bool: True if string is a valid UUID, False otherwise.
    """
    try:
        return value == str(uuid.UUID(value))
    except ValueError:
        return False


def client_order_id_to_bytes32(client_order_id: str) -> str:
    """Converts client_order_id to appropriate bytes32 format.

    Args:
        client_order_id (str): Client order ID to convert.

    Returns:
        str: Converted client order ID in bytes32 hex format.

    Raises:
        ValueError: If string is longer than 32 characters and not a UUID, or if input is None/empty.
    """
    if client_order_id is None:
        raise ValueError("Client order ID cannot be None")

    if not client_order_id:
        raise ValueError("Client order ID cannot be empty")

    if is_uuid(client_order_id):
        return uuid_to_bytes32(client_order_id)

    if len(client_order_id) > 32:
        raise ValueError(
            f"Client order ID cannot be longer than 32 characters, got {len(client_order_id)}"
        )

    # Convert string to bytes32 hex format
    client_order_bytes = client_order_id.encode("utf-8")
    padded_bytes = client_order_bytes.ljust(32, b"\0")
    return "0x" + padded_bytes.hex()


def generate_nonce() -> str:
    """Generates a timestamp-based nonce.

    Returns:
        str: Current timestamp in nanoseconds as string.
    """
    return str(time.time_ns())


def encode_account_name(text: str) -> str:
    """Converts text to hex-encoded subaccount name format.

    Args:
        text (str): Text to convert to hex name.

    Returns:
        str: Hex-encoded name with '0x' prefix, padded to 32 bytes.
    """
    hex_encoded = text.encode("utf-8").hex()
    # Pad to 64 characters (32 bytes) with zeros on the right
    padded_hex = hex_encoded.ljust(64, "0")
    return "0x" + padded_hex


def decode_account_name(hex_name: str) -> str:
    """Converts hex-encoded subaccount name back to text.

    Args:
        hex_name (str): Hex-encoded name with '0x' prefix.

    Returns:
        str: Decoded text string with null bytes stripped.
    """
    try:
        if hex_name.startswith("0x"):
            return bytes.fromhex(hex_name[2:]).decode("utf-8").rstrip("\x00")
        else:
            return bytes.fromhex(hex_name).decode("utf-8").rstrip("\x00")
    except (ValueError, UnicodeDecodeError):
        # Return original if decoding fails
        return hex_name
