from typing import List
from uuid import UUID

from ethereal.constants import API_PREFIX
from ethereal.models.rest import PositionDto, PositionLiquidationDto


async def list_positions(
    self,
    **kwargs,
) -> List[PositionDto]:
    """Lists positions for a subaccount.

    Args:
        subaccount_id (str): UUID of the subaccount. Required.

    Other Parameters:
        product_ids (List[str], optional): UUIDs of products to filter by. Optional.
        open (bool, optional): Filter for open positions. Optional.
        created_after (float, optional): Filter positions created after this timestamp. Optional.
        created_before (float, optional): Filter positions created before this timestamp. Optional.
        side (int, optional): Filter by position side (0 for buy, 1 for sell). Optional.
        is_liquidated (bool, optional): Filter liquidated positions. Optional.
        order (str, optional): Sort order, 'asc' or 'desc'. Optional.
        limit (float, optional): Maximum number of results to return. Optional.
        cursor (str, optional): Pagination cursor for fetching the next page. Optional.
        order_by (str, optional): Field to order by, e.g., 'size', 'createdAt', 'updatedAt', or 'realizedPnl'. Optional.
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        List[PositionDto]: List of position information for the subaccount.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/position",
        request_model=self._models.V1PositionGetParametersQuery,
        response_model=self._models.PageOfPositionDtos,
        **kwargs,
    )
    data = [
        self._models.PositionDto(**model.model_dump(by_alias=True))
        for model in res.data
    ]
    return data


async def get_position(
    self,
    id: UUID,
    **kwargs,
) -> PositionDto:
    """Gets a specific position by ID.

    Args:
        id (str): UUID of the position. Required.

    Other Parameters:
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        PositionDto: Position information for the specified ID.
    """
    endpoint = f"{API_PREFIX}/position/{id}"
    res = await self.get(endpoint, **kwargs)
    return self._models.PositionDto(**res)


async def list_position_liquidations(
    self,
    **kwargs,
) -> List[PositionLiquidationDto]:
    """Lists position liquidations.

    Other Parameters:
        order (str, optional): Sort order, 'asc' or 'desc'. Optional.
        limit (float, optional): Maximum number of results to return. Optional.
        cursor (str, optional): Pagination cursor for fetching the next page. Optional.
        order_by (str, optional): Field to order by (e.g., 'createdAt'). Optional.
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        List[PositionLiquidationDto]: List of position liquidation records.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/position/liquidation",
        request_model=self._models.V1PositionLiquidationGetParametersQuery,
        response_model=self._models.PageOfPositionLiquidationsDto,
        **kwargs,
    )
    data = [
        self._models.PositionLiquidationDto(**model.model_dump(by_alias=True))
        for model in res.data
    ]
    return data
