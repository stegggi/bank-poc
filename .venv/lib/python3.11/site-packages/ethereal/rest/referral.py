from typing import List, TYPE_CHECKING
from ethereal.constants import API_PREFIX

if TYPE_CHECKING:
    from ethereal.models.rest import ReferralDto, ReferralCodeUsageDto


async def get_referral_summary(self, **kwargs) -> "ReferralCodeUsageDto":
    """Gets the referral summary for a subaccount.

    Args:
        subaccount (str, optional): Bytes32 encoded subaccount name (0x prefix, zero padded).

    Other Parameters:
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        ReferralCodeUsageDto: Referral code and usage information.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/referral/summary",
        request_model=self._models.V1ReferralSummaryGetParametersQuery,
        response_model=self._models.ReferralCodeUsageDto,
        **kwargs,
    )
    return res


async def list_referrals(self, **kwargs) -> List["ReferralDto"]:
    """Lists referrals for a subaccount.

    Args:
        subaccount (str, optional): Bytes32 encoded subaccount name (0x prefix, zero padded).

    Other Parameters:
        order (str, optional): Sort order, 'desc'. Optional.
        limit (float, optional): Maximum number of results to return. Optional.
        cursor (str, optional): Pagination cursor for fetching the next page. Optional.
        order_by (str, optional): Field to order by, e.g., 'createdAt'. Optional.
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        List[ReferralDto]: Referral objects for the subaccount.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/referral",
        request_model=self._models.V1ReferralGetParametersQuery,
        response_model=self._models.PageOfReferralDtos,
        **kwargs,
    )
    data = [
        self._models.ReferralDto(**model.model_dump(by_alias=True))
        for model in res.data
    ]
    return data
