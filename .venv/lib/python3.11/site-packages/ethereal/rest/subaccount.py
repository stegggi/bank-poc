from typing import TYPE_CHECKING, List
from uuid import UUID
from ethereal.constants import API_PREFIX
from ethereal.models.rest import SubaccountBalanceDto, SubaccountDto

if TYPE_CHECKING:
    from ethereal.models.rest import (
        BalanceHistoryDto,
        PositionFundingHistoryDto,
        SubaccountVolumeHistoryDto,
        TotalSubaccountVolumeDto,
        UnrealizedPnlHistoryDto,
    )


async def list_subaccounts(self, **kwargs) -> List[SubaccountDto]:
    """Lists subaccounts for a given sender (address).

    Args:
        sender (str): Wallet address to query subaccounts for. Required.

    Other Parameters:
        name (str, optional): Filter by subaccount name. Optional.
        order (str, optional): Sort order, 'asc' or 'desc'. Optional.
        limit (float, optional): Maximum number of results to return. Optional.
        cursor (str, optional): Pagination cursor for fetching the next page. Optional.
        order_by (str, optional): Field to order by (e.g., 'createdAt'). Optional.
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        List[SubaccountDto]: Subaccount records for the sender.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/subaccount/",
        request_model=self._models.V1SubaccountGetParametersQuery,
        response_model=self._models.PageOfSubaccountDtos,
        **kwargs,
    )
    data = [
        self._models.SubaccountDto(**model.model_dump(by_alias=True))
        for model in res.data
    ]
    return data


async def get_subaccount(self, id: UUID, **kwargs) -> SubaccountDto:
    """Gets a specific subaccount by ID.

    Args:
        id (str): UUID of the subaccount. Required.

    Other Parameters:
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        SubaccountDto: Subaccount details.
    """
    endpoint = f"{API_PREFIX}/subaccount/{id}"
    res = await self.get(endpoint, **kwargs)
    return self._models.SubaccountDto(**res)


async def get_subaccount_balances(self, **kwargs) -> List[SubaccountBalanceDto]:
    """Gets token balances for a subaccount.

    Args:
        subaccount_id (str): UUID of the subaccount. Required.

    Other Parameters:
        order (str, optional): Sort order, 'asc' or 'desc'. Optional.
        limit (float, optional): Maximum number of results to return. Optional.
        cursor (str, optional): Pagination cursor for fetching the next page. Optional.
        order_by (str, optional): Field to order by (e.g., 'tokenName', 'updatedAt', 'amount'). Optional.
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        List[SubaccountBalanceDto]: Balances for the subaccount.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/subaccount/balance",
        request_model=self._models.V1SubaccountBalanceGetParametersQuery,
        response_model=self._models.PageOfSubaccountBalanceDtos,
        **kwargs,
    )
    data = [
        self._models.SubaccountBalanceDto(**model.model_dump(by_alias=True))
        for model in res.data
    ]
    return data


async def get_subaccount_balance_history(self, **kwargs) -> List["BalanceHistoryDto"]:
    """Gets historical subaccount balances from the archive API.

    Args:
        subaccount_id (str): UUID of the subaccount. Required.

    Other Parameters:
        start_time (float): Range start time in milliseconds since Unix epoch. Required.
        end_time (float, optional): Range end time in milliseconds since Unix epoch. Optional.
        resolution (str): Data resolution (e.g., 'hour1', 'day1'). Required.
        order (str, optional): Sort order, 'asc' or 'desc'. Optional.
        limit (float, optional): Maximum number of results to return. Optional.
        cursor (str, optional): Pagination cursor for fetching the next page. Optional.
        order_by (str, optional): Field to order by (defaults to 'time'). Optional.
        **kwargs: Additional query parameters supported by the API.

    Returns:
        List[BalanceHistoryDto]: Historical balance records ordered per request parameters.
    """

    res = await self.get_validated(
        url_path=f"{API_PREFIX}/subaccount/balance",
        request_model=self._models.ArchiveV1SubaccountBalanceGetParametersQuery,
        response_model=self._models.PageOfBalanceHistoryDtos,
        base_url_override=self._archive_base_url,
        **kwargs,
    )

    data = [
        self._models.BalanceHistoryDto(**model.model_dump(by_alias=True))
        for model in res.data
    ]
    return data


async def get_subaccount_unrealized_pnl_history(
    self, **kwargs
) -> List["UnrealizedPnlHistoryDto"]:
    """Gets historical unrealized PnL for a subaccount from the archive API."""

    res = await self.get_validated(
        url_path=f"{API_PREFIX}/subaccount/unrealized-pnl",
        request_model=self._models.ArchiveV1SubaccountUnrealizedPnlGetParametersQuery,
        response_model=self._models.PageOfUnrealizedPnlHistoryDtos,
        base_url_override=self._archive_base_url,
        **kwargs,
    )

    data = [
        self._models.UnrealizedPnlHistoryDto(**model.model_dump(by_alias=True))
        for model in res.data
    ]
    return data


async def get_subaccount_volume_history(
    self, **kwargs
) -> List["SubaccountVolumeHistoryDto"]:
    """Gets historical trading volume for a subaccount from the archive API."""

    res = await self.get_validated(
        url_path=f"{API_PREFIX}/subaccount/volume",
        request_model=self._models.ArchiveV1SubaccountVolumeGetParametersQuery,
        response_model=self._models.PageOfSubaccountVolumeHistoryDtos,
        base_url_override=self._archive_base_url,
        **kwargs,
    )

    data = [
        self._models.SubaccountVolumeHistoryDto(**model.model_dump(by_alias=True))
        for model in res.data
    ]
    return data


async def get_subaccount_funding_history(
    self, **kwargs
) -> List["PositionFundingHistoryDto"]:
    """Gets historical funding charges for positions in a subaccount from the archive API.

    Args:
        subaccount_id (str): UUID of the subaccount. Required.
        start_time (float): Range start time in milliseconds since Unix epoch. Required.

    Other Parameters:
        end_time (float, optional): Range end time in milliseconds since Unix epoch. Optional.
        position_ids (List[str], optional): Filter by specific position IDs (max 128). Optional.
        product_ids (List[str], optional): Filter by specific product IDs. Optional.
        order (str, optional): Sort order, 'asc' or 'desc'. Optional.
        limit (float, optional): Maximum number of results to return. Optional.
        cursor (str, optional): Pagination cursor for fetching the next page. Optional.
        order_by (str, optional): Field to order by (defaults to 'time'). Optional.
        **kwargs: Additional query parameters supported by the API.

    Returns:
        List[PositionFundingHistoryDto]: Historical funding charge records for positions in the subaccount.
    """

    res = await self.get_validated(
        url_path=f"{API_PREFIX}/subaccount/funding",
        request_model=self._models.ArchiveV1SubaccountFundingGetParametersQuery,
        response_model=self._models.PageOfPositionFundingHistoryDtos,
        base_url_override=self._archive_base_url,
        **kwargs,
    )

    data = [
        self._models.PositionFundingHistoryDto(**model.model_dump(by_alias=True))
        for model in res.data
    ]
    return data


async def get_subaccount_total_volume(self, **kwargs) -> "TotalSubaccountVolumeDto":
    """Gets the total trading volume for a subaccount from the archive API.

    Args:
        subaccount_id (str): UUID of the subaccount. Required.

    Other Parameters:
        **kwargs: Additional query parameters supported by the API.

    Returns:
        TotalSubaccountVolumeDto: Total volume in USD for the subaccount.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/subaccount/total-volume",
        request_model=self._models.ArchiveV1SubaccountTotalVolumeGetParametersQuery,
        response_model=self._models.TotalSubaccountVolumeDto,
        base_url_override=self._archive_base_url,
        **kwargs,
    )
    return res
