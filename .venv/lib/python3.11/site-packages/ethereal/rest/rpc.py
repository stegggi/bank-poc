from ethereal.constants import API_PREFIX
from ethereal.models.rest import RpcConfigDto


async def get_rpc_config(self, **kwargs) -> RpcConfigDto:
    """Gets RPC configuration for EIP-712 signing and contract info.

    Other Parameters:
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        RpcConfigDto: Domain and signature type definitions for signing.
    """
    endpoint = f"{API_PREFIX}/rpc/config"

    res = await self.get(endpoint, **kwargs)
    domain = self._models.DomainTypeDto(**res["domain"])
    signature_types = self._models.SignatureTypesDto(**res["signatureTypes"])
    return self._models.RpcConfigDto(domain=domain, signatureTypes=signature_types)
