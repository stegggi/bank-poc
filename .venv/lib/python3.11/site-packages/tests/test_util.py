import pytest
from ethereal.rest.util import is_uuid, client_order_id_to_bytes32


def test_is_uuid_valid_with_dashes():
    """Test valid UUID string with dashes."""
    uuid_str = "550e8400-e29b-41d4-a716-446655440000"
    assert is_uuid(uuid_str) is True


def test_is_uuid_valid_without_dashes():
    """Test valid UUID string without dashes."""
    uuid_str = "550e8400e29b41d4a716446655440000"
    assert is_uuid(uuid_str) is False


def test_is_uuid_invalid_too_short():
    """Test invalid UUID - too short."""
    uuid_str = "550e8400-e29b-41d4"
    assert is_uuid(uuid_str) is False


def test_is_uuid_invalid_too_long():
    """Test invalid UUID - too long."""
    uuid_str = "550e8400-e29b-41d4-a716-446655440000-extra"
    assert is_uuid(uuid_str) is False


def test_is_uuid_invalid_bad_format():
    """Test invalid UUID - bad format."""
    uuid_str = "not-a-uuid-at-all"
    assert is_uuid(uuid_str) is False


def test_is_uuid_invalid_wrong_characters():
    """Test invalid UUID - wrong characters."""
    uuid_str = "550g8400-e29b-41d4-a716-446655440000"
    assert is_uuid(uuid_str) is False


def test_client_order_id_none_input_raises_error():
    """Test None input raises ValueError."""
    with pytest.raises(ValueError, match="Client order ID cannot be None"):
        client_order_id_to_bytes32(None)


def test_client_order_id_short_string_conversion():
    """Test short string gets padded to 32 bytes."""
    test_str = "hello"
    result = client_order_id_to_bytes32(test_str)

    # Should be 0x + 64 hex chars (32 bytes)
    assert result.startswith("0x")
    assert len(result) == 66

    # Decode the hex to verify content
    hex_part = result[2:]  # Remove 0x prefix
    decoded_bytes = bytes.fromhex(hex_part)

    # Should start with "hello" and be padded with null bytes
    assert decoded_bytes.startswith(b"hello")
    assert decoded_bytes.rstrip(b"\0") == b"hello"
    assert len(decoded_bytes) == 32


def test_client_order_id_max_length_string():
    """Test 32-character string conversion."""
    test_str = (
        "order_id_with_exactly_32_chars12"  # Exactly 32 characters, clearly not UUID
    )
    result = client_order_id_to_bytes32(test_str)

    assert result.startswith("0x")
    assert len(result) == 66

    # Decode and verify
    hex_part = result[2:]
    decoded_bytes = bytes.fromhex(hex_part)
    assert decoded_bytes == test_str.encode("utf-8")


def test_client_order_id_string_too_long_raises_error():
    """Test string longer than 32 characters raises ValueError."""
    test_str = "a" * 33  # 33 characters - too long

    with pytest.raises(
        ValueError, match="Client order ID cannot be longer than 32 characters, got 33"
    ):
        client_order_id_to_bytes32(test_str)


def test_client_order_id_empty_string_raises_error():
    """Test empty string raises ValueError."""
    with pytest.raises(ValueError, match="Client order ID cannot be empty"):
        client_order_id_to_bytes32("")


def test_client_order_id_alphanumeric_string():
    """Test alphanumeric string conversion."""
    test_str = "order123"
    result = client_order_id_to_bytes32(test_str)

    assert result.startswith("0x")
    assert len(result) == 66

    hex_part = result[2:]
    decoded_bytes = bytes.fromhex(hex_part)
    assert decoded_bytes.startswith(test_str.encode("utf-8"))
    assert decoded_bytes.rstrip(b"\0") == test_str.encode("utf-8")


def test_client_order_id_unicode_string():
    """Test Unicode string conversion."""
    test_str = "hello🚀"  # Contains emoji
    result = client_order_id_to_bytes32(test_str)

    assert result.startswith("0x")
    assert len(result) == 66

    hex_part = result[2:]
    decoded_bytes = bytes.fromhex(hex_part)

    # UTF-8 encoding of emoji takes multiple bytes
    encoded = test_str.encode("utf-8")
    assert len(encoded) <= 32  # Should fit in 32 bytes
    assert decoded_bytes.startswith(encoded)


def test_client_order_id_string_too_long_non_uuid():
    """Test that non-UUID long strings raise error."""
    fake_uuid = "not-a-real-uuid-string-here-fake-and-too-long"  # 43 characters

    # This should be treated as a string (too long, should raise error)
    with pytest.raises(ValueError):
        client_order_id_to_bytes32(fake_uuid)


def test_client_order_id_uuid_formats_same_result():
    """Test edge cases around UUID detection."""
    # Valid UUID without dashes
    uuid_no_dash = "550e8400e29b41d4a716446655440000"
    result1 = client_order_id_to_bytes32(uuid_no_dash)
    assert result1.startswith("0x")

    # Same as UUID with dashes
    uuid_with_dash = "550e8400-e29b-41d4-a716-446655440000"
    result2 = client_order_id_to_bytes32(uuid_with_dash)
    assert result2.startswith("0x")

    # The results are different
    assert result1 != result2
