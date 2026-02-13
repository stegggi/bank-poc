import time
from decimal import Decimal
from typing import List, Optional
from enum import Enum
from uuid import UUID

from ethereal.constants import API_PREFIX
from ethereal.models.rest import (
    TokenDto,
    WithdrawDto,
    TransferDto,
    InitiateWithdrawDto,
)
from ethereal.rest.util import ensure_bytes32_hex, generate_nonce


class LayerZeroEndpointId(Enum):
    NONE = 0
    ETHEREAL_TESTNET = 40422
    ARBITRUM_SEPOLIA = 40231


async def list_tokens(
    self,
    **kwargs,
) -> List[TokenDto]:
    """Lists all supported tokens.

    Other Parameters:
        deposit_enabled (bool, optional): Filter tokens with deposits enabled. Optional.
        withdraw_enabled (bool, optional): Filter tokens with withdrawals enabled. Optional.
        order (str, optional): Sort order, 'asc' or 'desc'. Optional.
        limit (float, optional): Maximum number of results to return. Optional.
        cursor (str, optional): Pagination cursor for fetching the next page. Optional.
        order_by (str, optional): Field to order by (e.g., 'createdAt'). Optional.
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        List[TokenDto]: Token metadata.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/token",
        request_model=self._models.V1TokenGetParametersQuery,
        response_model=self._models.PageOfTokensDtos,
        **kwargs,
    )
    data = [
        self._models.TokenDto(**model.model_dump(by_alias=True)) for model in res.data
    ]
    return data


async def get_token(
    self,
    id: UUID,
    **kwargs,
) -> TokenDto:
    """Gets a specific token by ID.

    Args:
        id (str): UUID for the token. Required.

    Other Parameters:
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        TokenDto: Token metadata.
    """
    endpoint = f"{API_PREFIX}/token/{id}"
    res = await self.get(endpoint, **kwargs)
    return self._models.TokenDto(**res)


async def list_token_withdraws(
    self,
    **kwargs,
) -> List[WithdrawDto]:
    """Lists token withdrawals for a subaccount.

    Args:
        subaccount_id (str): UUID of the subaccount. Required.

    Other Parameters:
        is_active (bool, optional): Filter active withdrawals. Optional.
        order (str, optional): Sort order, 'asc' or 'desc'. Optional.
        limit (float, optional): Maximum number of results to return. Optional.
        cursor (str, optional): Pagination cursor for fetching the next page. Optional.
        order_by (str, optional): Field to order by (e.g., 'createdAt'). Optional.
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        List[WithdrawDto]: Withdrawal records for the subaccount.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/token/withdraw",
        request_model=self._models.V1TokenWithdrawGetParametersQuery,
        response_model=self._models.PageOfWithdrawDtos,
        **kwargs,
    )
    data = [
        self._models.WithdrawDto(**model.model_dump(by_alias=True))
        for model in res.data
    ]
    return data


async def list_token_transfers(
    self,
    **kwargs,
) -> List[TransferDto]:
    """Lists token transfers for a subaccount.

    Args:
        subaccount_id (str): UUID of the subaccount. Required.

    Other Parameters:
        statuses (List[str], optional): Filter by transfer status (e.g., 'COMPLETED'). Optional.
        types (List[str], optional): Filter by transfer type (e.g., 'WITHDRAW'). Optional.
        created_after (float, optional): Filter transfers created after this timestamp. Optional.
        created_before (float, optional): Filter transfers created before this timestamp. Optional.
        order (str, optional): Sort order, 'asc' or 'desc'. Optional.
        limit (float, optional): Maximum number of results to return. Optional.
        cursor (str, optional): Pagination cursor for fetching the next page. Optional.
        order_by (str, optional): Field to order by (e.g., 'createdAt'). Optional.
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        List[TransferDto]: Transfer records for the subaccount.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/token/transfer",
        request_model=self._models.V1TokenTransferGetParametersQuery,
        response_model=self._models.PageOfTransfersDtos,
        **kwargs,
    )
    data = [
        self._models.TransferDto(**model.model_dump(by_alias=True))
        for model in res.data
    ]
    return data


async def prepare_withdraw_token(
    self,
    subaccount: str,
    token: str,
    amount: int,
    account: str,
    destination_address: str,
    destination_endpoint: int,
    include_signature: bool = False,
    nonce: Optional[str] = None,
    signed_at: Optional[int] = None,
) -> InitiateWithdrawDto:
    """Prepares a token withdrawal payload for signing and submission.

    Constructs an InitiateWithdrawDto containing all the data required for a
    withdrawal request. The payload can optionally be signed immediately if
    ``include_signature=True``.

    For most use cases, prefer the higher-level ``withdraw_token()`` method
    on AsyncRESTClient which handles preparation, signing, and submission
    in a single call.

    Args:
        subaccount: Hex-encoded (bytes32) subaccount name from which to withdraw.
        token: Token contract address on the source chain.
        amount: Amount to withdraw in the token's base units.
        account: Wallet address that owns the subaccount.
        destination_address: LayerZero destination address where funds will be
            sent. Can be a hex string or bytes; automatically left-padded to
            bytes32 format.
        destination_endpoint: LayerZero endpoint ID for the destination chain.
            Use 0 for same-chain withdrawals.
        include_signature: If True, signs the payload immediately using the
            client's configured private key. Defaults to False.
        nonce: Custom nonce for the EIP-712 signature. If not provided, a
            random nonce is generated.
        signed_at: Unix timestamp (seconds) for the signature. If not provided,
            defaults to the current time.

    Returns:
        A prepared withdrawal payload. If ``include_signature=True``, the
        signature field will be populated; otherwise it will be empty.
    """
    nonce = nonce or generate_nonce()
    signed_at = signed_at or int(time.time())
    lz_destination_id = self._models.LzDestinationEid(destination_endpoint)

    data = {
        "account": account,
        "subaccount": subaccount,
        "token": token,
        "amount": amount,
        "nonce": nonce,
        "signedAt": signed_at,
        "lzDestinationAddress": ensure_bytes32_hex(destination_address),
        "lzDestinationEid": lz_destination_id,
    }
    data_model = self._models.InitiateWithdrawDtoData.model_validate(data)
    dto = self._models.InitiateWithdrawDto.model_validate(
        {"data": data_model.model_dump(mode="json", by_alias=True), "signature": ""}
    )
    if include_signature:
        dto = await self.sign_withdraw_token(dto)
    return dto


async def sign_withdraw_token(
    self,
    withdraw_dto: InitiateWithdrawDto,
    private_key: Optional[str] = None,
) -> InitiateWithdrawDto:
    """Signs a token withdrawal payload using EIP-712 typed data signing.

    Generates an EIP-712 signature for the withdrawal payload using either
    the provided private key or the client's configured chain key.

    Args:
        withdraw_dto: A prepared withdrawal payload (from ``prepare_withdraw_token``).
            The signature field will be populated in-place.
        private_key: Optional private key to use for signing. If not provided,
            uses the private key from the client's chain configuration.

    Returns:
        The same InitiateWithdrawDto with the signature field populated.

    Raises:
        ValueError: If no chain client is configured on the client.
        ValueError: If no private key is available (neither provided nor configured).
    """
    if not hasattr(self, "chain") or not self.chain:
        raise ValueError("No chain client available for signing")
    if not private_key and not self.chain.private_key:
        raise ValueError("No private key available for signing")
    elif not private_key:
        private_key = self.chain.private_key

    # Prepare the message for signing
    message = withdraw_dto.data.model_dump(by_alias=True, mode="json")
    message["amount"] = int(Decimal(str(message["amount"])) * Decimal(1e9))
    message["signedAt"] = int(message["signedAt"])

    destination_address = message["lzDestinationAddress"]
    destination_eid = int(message["lzDestinationEid"])

    message["destinationAddress"] = destination_address
    message["destinationEndpointId"] = destination_eid

    primary_type = "InitiateWithdraw"
    domain = self.rpc_config.domain.model_dump(mode="json", by_alias=True)
    types = self.chain.get_signature_types(self.rpc_config, primary_type)
    withdraw_dto.signature = self.chain.sign_message(
        private_key, domain, types, primary_type, message
    )
    return withdraw_dto


async def submit_withdraw_token(
    self,
    dto: InitiateWithdrawDto,
    token_id: UUID,
    **kwargs,
) -> WithdrawDto:
    """Submits a prepared and signed token withdrawal request to the API.

    This is the low-level submission function that sends a pre-constructed
    InitiateWithdrawDto to the withdrawal endpoint. For most use cases,
    prefer the higher-level ``withdraw_token()`` method on AsyncRESTClient
    which handles preparation, signing, and submission in a single call.

    Args:
        dto: A prepared and signed withdrawal payload containing the withdrawal
            details and EIP-712 signature.
        token_id: UUID of the token being withdrawn. Used to construct the
            API endpoint path.

    Other Parameters:
        **kwargs: Additional request parameters passed to the underlying
            HTTP client.

    Returns:
        The withdrawal record created by the API, containing transaction
        details and status information.
    """
    endpoint = f"{API_PREFIX}/token/{token_id}/withdraw"
    res = await self.post(
        endpoint,
        data=dto.model_dump(mode="json", by_alias=True, exclude_none=True),
        **kwargs,
    )
    return self._models.WithdrawDto.model_validate(res)
