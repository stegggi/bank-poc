from typing import List, TYPE_CHECKING
from ethereal.constants import API_PREFIX

if TYPE_CHECKING:
    from ethereal.models.rest import FundingDto, ProjectedFundingDto


async def list_funding(self, **kwargs) -> List["FundingDto"]:
    """Lists historical funding rates for a product over a specified time range.

    Args:
        product_id (str): Id representing the registered product. Required.
        range (str): Time window to query. One of 'DAY', 'WEEK', or 'MONTH'. Required.

    Other Parameters:
        order (str, optional): Sort order, 'asc' or 'desc'. Optional.
        limit (float, optional): Maximum number of results to return. Optional.
        cursor (str, optional): Pagination cursor for fetching the next page. Optional.
        order_by (str, optional): Field to order by, e.g., 'createdAt'. Optional.
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        List[FundingDto]: Funding rate history objects for the product.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/funding",
        request_model=self._models.V1FundingGetParametersQuery,
        response_model=self._models.PageOfFundingDtos,
        **kwargs,
    )
    data = [
        self._models.FundingDto(**model.model_dump(by_alias=True)) for model in res.data
    ]
    return data


async def get_projected_funding(self, **kwargs) -> "ProjectedFundingDto":
    """Gets the projected funding rate for the next period.

    Args:
        product_id (str): Id representing the registered product. Required.

    Other Parameters:
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        ProjectedFundingDto: Projected funding information for the product.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/funding/projected",
        request_model=self._models.V1FundingProjectedGetParametersQuery,
        response_model=self._models.ProjectedFundingDto,
        **kwargs,
    )
    return res


async def list_projected_funding(self, **kwargs) -> List["ProjectedFundingDto"]:
    """Lists projected funding rates for multiple products.

    Args:
        product_ids (List[UUID]): List of product IDs (1-10). Required.

    Other Parameters:
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        List[ProjectedFundingDto]: Projected funding rate objects for the products.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/funding/projected-rate",
        request_model=self._models.V1FundingProjectedRateGetParametersQuery,
        response_model=self._models.PageOfProjectedFundingDtos,
        **kwargs,
    )
    data = [
        self._models.ProjectedFundingDto(**model.model_dump(by_alias=True))
        for model in res.data
    ]
    return data
