from typing import List

from ethereal.constants import API_PREFIX
from ethereal.models.rest import ProductDto, MarketLiquidityDto, MarketPriceDto


async def list_products(self, **kwargs) -> List[ProductDto]:
    """Lists all products and their configurations.

    Other Parameters:
        order (str, optional): Sort order, 'asc' or 'desc'. Optional.
        limit (float, optional): Maximum number of results to return. Optional.
        cursor (str, optional): Pagination cursor for fetching the next page. Optional.
        order_by (str, optional): Field to order by (e.g., 'createdAt'). Optional.
        ticker (str, optional): Filter by product ticker (e.g., 'ETHUSD'). Optional.
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        List[ProductDto]: Product configuration records.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/product",
        request_model=self._models.V1ProductGetParametersQuery,
        response_model=self._models.PageOfProductDtos,
        **kwargs,
    )
    data = [
        self._models.ProductDto(**model.model_dump(by_alias=True)) for model in res.data
    ]
    return data


async def get_market_liquidity(self, **kwargs) -> MarketLiquidityDto:
    """Gets market liquidity for a product.

    Args:
        product_id (str): Id representing the registered product. Required.

    Other Parameters:
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        MarketLiquidityDto: Top-of-book and depth liquidity metrics.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/product/market-liquidity",
        request_model=self._models.V1ProductMarketLiquidityGetParametersQuery,
        response_model=self._models.MarketLiquidityDto,
        **kwargs,
    )
    return res


async def list_market_prices(self, **kwargs) -> List[MarketPriceDto]:
    """Gets market prices for one or more products.

    Args:
        product_ids (List[str]): List of product IDs to query. Required.

    Other Parameters:
        **kwargs: Additional request parameters accepted by the API. Optional.

    Returns:
        List[MarketPriceDto]: Best bid/ask prices for the requested products.
    """
    res = await self.get_validated(
        url_path=f"{API_PREFIX}/product/market-price",
        request_model=self._models.V1ProductMarketPriceGetParametersQuery,
        response_model=self._models.ListOfMarketPriceDtos,
        **kwargs,
    )
    data = [
        self._models.MarketPriceDto(**model.model_dump(by_alias=True))
        for model in res.data
    ]
    return data
