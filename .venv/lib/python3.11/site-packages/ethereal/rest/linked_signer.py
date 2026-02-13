from typing import List, Optional
from uuid import UUID
from ethereal.constants import API_PREFIX
from ethereal.rest.util import generate_nonce
from ethereal.models.rest import (
    SignerDto,
    AccountSignerQuotaDto,
    LinkSignerDto,
    RevokeLinkedSignerDto,
    RefreshLinkedSignerDto,
)
import time


async def list_signers(
    self,
    **kwargs,
) -> List[SignerDto]:
    """Lists linked signers for a subaccount.

    Args:
        subaccount_id (str): UUID of the subaccount. Required.

    Other Parameters:
        order (str, optional): Sort order, 'asc' or 'desc'. Optional.
        limit (float, optional): Maximum number of results to return. Optional.
        cursor (str, optional): Pagination cursor for fetching the next page. Optional.
        order_by (str, optional): Field to order by (e.g., 'createdAt'). Optional.
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        List[SignerDto]: Linked signer records.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/linked-signer",
        request_model=self._models.V1LinkedSignerGetParametersQuery,
        response_model=self._models.PageOfSignersDto,
        **kwargs,
    )
    data = [
        self._models.SignerDto(**model.model_dump(by_alias=True)) for model in res.data
    ]
    return data


async def get_signer(
    self,
    id: UUID,
    **kwargs,
) -> SignerDto:
    """Gets a specific linked signer by ID.

    Args:
        id (str): UUID of the linked signer. Required.

    Other Parameters:
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        SignerDto: Linked signer details.
    """
    endpoint = f"{API_PREFIX}/linked-signer/{id}"
    res = await self.get(endpoint, **kwargs)
    return self._models.SignerDto.model_validate(res)


async def get_signer_quota(
    self,
    **kwargs,
) -> AccountSignerQuotaDto:
    """Gets the signer quota for a subaccount.

    Args:
        subaccount_id (str): UUID of the subaccount. Required.

    Other Parameters:
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        AccountSignerQuotaDto: Remaining quota information for the subaccount.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/linked-signer/quota",
        request_model=self._models.V1LinkedSignerQuotaGetParametersQuery,
        response_model=self._models.AccountSignerQuotaDto,
        **kwargs,
    )
    return res


async def prepare_linked_signer(
    self,
    sender: str,
    signer: str,
    subaccount: str,
    subaccount_id: UUID,
    signer_signature: str = "",
    include_signature: bool = False,
    **kwargs,
) -> LinkSignerDto:
    """Prepares the payload for linking a signer, optionally including a signature.

    Args:
        sender (str): Owner address initiating the link. Required.
        signer (str): Address of the signer being linked. Required.
        subaccount (str): Hex-encoded subaccount name. Required.
        subaccount_id (str): UUID of the subaccount. Required.
        signer_signature (str): Signature from the signer address. Optional.
        include_signature (bool): If True, sign with the owner's key as well. Optional.

    Other Parameters:
        nonce (str, optional): Custom nonce for signing. Optional.
        signed_at (int, optional): Seconds since epoch for the signature timestamp. Optional.
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        LinkSignerDto: Prepared (and optionally signed) link payload.
    """
    nonce = kwargs.get("nonce") or generate_nonce()
    signed_at = kwargs.get("signed_at") or int(time.time())
    data = {
        "sender": sender,
        "signer": signer,
        "subaccount": subaccount,
        "subaccountId": subaccount_id,
        "nonce": nonce,
        "signedAt": signed_at,
    }
    data_model = self._models.LinkSignerDtoData.model_validate(data)

    # Prepare dto
    dto_data = {
        "data": data_model.model_dump(mode="json", by_alias=True),
        "signature": "",
        "signerSignature": signer_signature,
    }
    dto = self._models.LinkSignerDto.model_validate(dto_data, by_alias=True)
    if include_signature:
        dto = await self.sign_linked_signer(dto, private_key=self.chain.private_key)
    return dto


async def sign_linked_signer(
    self,
    link_to_sign: LinkSignerDto,
    signer_private_key: Optional[str] = None,
    private_key: Optional[str] = None,
) -> LinkSignerDto:
    """Signs the link-signer payload with the signer and/or owner key.

    Args:
        link_to_sign (LinkSignerDto): Prepared link payload. Required.
        signer_private_key (str, optional): Signer's private key for cosigning. Optional.
        private_key (str, optional): Owner's private key override. Optional.

    Returns:
        LinkSignerDto: DTO with signature fields populated.

    Raises:
        ValueError: If no chain client or private key is available.
    """
    if not hasattr(self, "chain") or not self.chain:
        raise ValueError("No chain client available for signing")
    if not private_key and not self.chain.private_key and not signer_private_key:
        raise ValueError("No private key available for signing")
    elif not private_key:
        private_key = self.chain.private_key

    # Prepare message for signing
    message = link_to_sign.data.model_dump(mode="json", by_alias=True)
    message["signedAt"] = int(message["signedAt"])

    primary_type = "LinkSigner"
    domain = self.rpc_config.domain.model_dump(mode="json", by_alias=True)
    types = self.chain.get_signature_types(self.rpc_config, primary_type)

    if signer_private_key:
        signer_signature = self.chain.sign_message(
            signer_private_key, domain, types, primary_type, message
        )
        link_to_sign.signer_signature = signer_signature
    if private_key:
        signature = self.chain.sign_message(
            private_key, domain, types, primary_type, message
        )
        link_to_sign.signature = signature
    return link_to_sign


async def link_linked_signer(
    self,
    dto: LinkSignerDto,
    **kwargs,
) -> SignerDto:
    """Submits a prepared and signed link-signer payload.

    Args:
        dto (LinkSignerDto): Prepared and signed link payload. Required.

    Other Parameters:
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        SignerDto: Linked signer record after submission.
    """
    endpoint = f"{API_PREFIX}/linked-signer/link"
    res = await self.post(
        endpoint,
        data=dto.model_dump(mode="json", by_alias=True, exclude_none=True),
        **kwargs,
    )
    return self._models.SignerDto.model_validate(res)


async def prepare_revoke_linked_signer(
    self,
    sender: str,
    signer: str,
    subaccount: str,
    subaccount_id: UUID,
    include_signature: bool = False,
    **kwargs,
) -> RevokeLinkedSignerDto:
    """Prepares the payload for revoking a linked signer, optionally signing it.

    Args:
        sender (str): Owner address initiating the revoke. Required.
        signer (str): Signer address being revoked. Required.
        subaccount (str): Hex-encoded subaccount name. Required.
        subaccount_id (str): UUID of the subaccount. Required.
        include_signature (bool): If True, sign with the owner's key. Optional.

    Other Parameters:
        nonce (str, optional): Custom nonce for signing. Optional.
        signed_at (int, optional): Seconds since epoch for the signature timestamp. Optional.
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        RevokeLinkedSignerDto: Prepared (and optionally signed) revoke payload.
    """
    nonce = kwargs.get("nonce") or generate_nonce()
    signed_at = kwargs.get("signed_at") or int(time.time())
    data = {
        "sender": sender,
        "signer": signer,
        "subaccount": subaccount,
        "subaccountId": subaccount_id,
        "nonce": nonce,
        "signedAt": signed_at,
    }
    data_model = self._models.RevokeLinkedSignerDtoData.model_validate(data)
    dto = self._models.RevokeLinkedSignerDto.model_validate(
        {"data": data_model.model_dump(mode="json", by_alias=True), "signature": ""}
    )
    if include_signature:
        dto = await self.sign_revoke_linked_signer(dto)
    return dto


async def sign_revoke_linked_signer(
    self,
    revoke_to_sign: RevokeLinkedSignerDto,
    private_key: Optional[str] = None,
) -> RevokeLinkedSignerDto:
    """Signs the revoke-linked-signer payload with the owner's key.

    Args:
        revoke_to_sign (RevokeLinkedSignerDto): Prepared revoke payload. Required.
        private_key (str, optional): Private key override. Defaults to client's key.

    Returns:
        RevokeLinkedSignerDto: DTO with signature populated.

    Raises:
        ValueError: If no chain client or private key is available.
    """
    if not hasattr(self, "chain") or not self.chain:
        raise ValueError("No chain client available for signing")
    if not private_key:
        if not self.chain.private_key:
            raise ValueError("No private key available for signing")
        private_key = self.chain.private_key

    # Prepare message for signing
    message = revoke_to_sign.data.model_dump(mode="json", by_alias=True)
    message["signedAt"] = int(message["signedAt"])

    primary_type = "RevokeLinkedSigner"
    domain = self.rpc_config.domain.model_dump(mode="json", by_alias=True)
    types = self.chain.get_signature_types(self.rpc_config, primary_type)
    revoke_to_sign.signature = self.chain.sign_message(
        private_key, domain, types, primary_type, message
    )
    return revoke_to_sign


async def revoke_linked_signer(
    self,
    dto: RevokeLinkedSignerDto,
    **kwargs,
) -> SignerDto:
    """Submits a prepared and signed revoke-linked-signer payload.

    Args:
        dto (RevokeLinkedSignerDto): Prepared and signed revoke payload. Required.

    Other Parameters:
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        SignerDto: Signer record reflecting revocation.
    """
    endpoint = f"{API_PREFIX}/linked-signer/revoke"
    res = await self.delete(
        endpoint,
        data=dto.model_dump(mode="json", by_alias=True, exclude_none=True),
        **kwargs,
    )
    return self._models.SignerDto.model_validate(res)


async def prepare_refresh_linked_signer(
    self,
    sender: str,
    signer: str,
    subaccount: str,
    subaccount_id: UUID,
    include_signature: bool = False,
    **kwargs,
) -> RefreshLinkedSignerDto:
    """Prepares the payload for refreshing a linked signer, optionally signing it.

    Args:
        sender (str): Owner address initiating the refresh. Required.
        signer (str): Signer address being refreshed. Required.
        subaccount (str): Hex-encoded subaccount name. Required.
        subaccount_id (str): UUID of the subaccount. Required.
        include_signature (bool): If True, sign with the owner's key. Optional.

    Other Parameters:
        nonce (str, optional): Custom nonce for signing. Optional.
        signed_at (int, optional): Seconds since epoch for the signature timestamp. Optional.
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        RefreshLinkedSignerDto: Prepared (and optionally signed) refresh payload.
    """
    nonce = kwargs.get("nonce") or generate_nonce()
    signed_at = kwargs.get("signed_at") or int(time.time())
    data = {
        "sender": sender,
        "signer": signer,
        "subaccount": subaccount,
        "subaccountId": subaccount_id,
        "nonce": nonce,
        "signedAt": signed_at,
    }
    data_model = self._models.RefreshLinkedSignerDtoData.model_validate(data)
    dto = self._models.RefreshLinkedSignerDto.model_validate(
        {"data": data_model.model_dump(mode="json", by_alias=True), "signature": ""}
    )
    if include_signature:
        dto = await self.sign_refresh_linked_signer(dto)
    return dto


async def sign_refresh_linked_signer(
    self,
    refresh_to_sign: RefreshLinkedSignerDto,
    private_key: Optional[str] = None,
) -> RefreshLinkedSignerDto:
    """Signs the refresh-linked-signer payload with the owner's key.

    Args:
        refresh_to_sign (RefreshLinkedSignerDto): Prepared refresh payload. Required.
        private_key (str, optional): Private key override. Defaults to client's key.

    Returns:
        RefreshLinkedSignerDto: DTO with signature populated.

    Raises:
        ValueError: If no chain client or private key is available.
    """
    if not hasattr(self, "chain") or not self.chain:
        raise ValueError("No chain client available for signing")
    if not private_key:
        if not self.chain.private_key:
            raise ValueError("No private key available for signing")
        private_key = self.chain.private_key

    # Prepare message for signing
    message = refresh_to_sign.data.model_dump(mode="json", by_alias=True)
    message["signedAt"] = int(message["signedAt"])

    primary_type = "RefreshLinkedSigner"
    domain = self.rpc_config.domain.model_dump(mode="json", by_alias=True)
    types = self.chain.get_signature_types(self.rpc_config, primary_type)
    refresh_to_sign.signature = self.chain.sign_message(
        private_key, domain, types, primary_type, message
    )
    return refresh_to_sign


async def refresh_linked_signer(
    self,
    dto: RefreshLinkedSignerDto,
    **kwargs,
) -> SignerDto:
    """Submits a prepared and signed refresh-linked-signer payload.

    Args:
        dto (RefreshLinkedSignerDto): Prepared and signed refresh payload. Required.

    Other Parameters:
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        SignerDto: Signer record reflecting the refreshed expiry.
    """
    endpoint = f"{API_PREFIX}/linked-signer/refresh"
    res = await self.post(
        endpoint,
        data=dto.model_dump(mode="json", by_alias=True, exclude_none=True),
        **kwargs,
    )
    return self._models.SignerDto.model_validate(res)
