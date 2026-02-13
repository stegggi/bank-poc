from __future__ import annotations
import importlib
import warnings
from decimal import Decimal
from pydantic import BaseModel, AnyHttpUrl
from typing import (
    TYPE_CHECKING,
    Union,
    Dict,
    Any,
    Optional,
    Set,
    List,
    Tuple,
)
from uuid import UUID
from ethereal.constants import API_PREFIX, ARCHIVE_NETWORK_URLS, NETWORK_URLS
from ethereal.rest.async_http_client import AsyncHTTPClient
from ethereal.chain_client import ChainClient
from ethereal.models.config import RESTConfig, ChainConfig

from ethereal.rest.funding import (
    list_funding,
    get_projected_funding,
    list_projected_funding,
)
from ethereal.rest.order import (
    get_order,
    list_fills,
    list_orders,
    list_trades,
    prepare_order,
    sign_order,
    submit_order,
    dry_run_order,
    prepare_cancel_order,
    sign_cancel_order,
    cancel_order,
)
from ethereal.rest.linked_signer import (
    get_signer,
    get_signer_quota,
    list_signers,
    prepare_linked_signer,
    sign_linked_signer,
    link_linked_signer,
    prepare_revoke_linked_signer,
    sign_revoke_linked_signer,
    revoke_linked_signer,
    prepare_refresh_linked_signer,
    sign_refresh_linked_signer,
    refresh_linked_signer,
)
from ethereal.rest.position import (
    list_positions,
    get_position,
    list_position_liquidations,
)
from ethereal.rest.product import (
    get_market_liquidity,
    list_market_prices,
    list_products,
)
from ethereal.rest.rpc import get_rpc_config
from ethereal.rest.subaccount import (
    list_subaccounts,
    get_subaccount,
    get_subaccount_balances,
    get_subaccount_balance_history,
    get_subaccount_unrealized_pnl_history,
    get_subaccount_volume_history,
    get_subaccount_funding_history,
    get_subaccount_total_volume,
)
from ethereal.rest.referral import get_referral_summary, list_referrals
from ethereal.rest.token import (
    get_token,
    list_token_withdraws,
    list_tokens,
    list_token_transfers,
    prepare_withdraw_token,
    sign_withdraw_token,
    submit_withdraw_token,
)

_MODEL_PATHS = {
    "default": "ethereal.models.rest",
    "mainnet": "ethereal.models.mainnet.rest",
    "testnet": "ethereal.models.testnet.rest",
    "devnet": "ethereal.models.devnet.rest",
}

if TYPE_CHECKING:
    from ethereal.models.rest import *  # noqa: F403


class PaginatedResponse(BaseModel):
    data: Any
    has_next: bool
    next_cursor: Optional[str]


class AsyncRESTClient(AsyncHTTPClient):
    """Asynchronous REST client for the Ethereal API.

    Notes for maintainers:
    - This client composes endpoint functions from the `ethereal.rest.*` modules
      by assigning them as attributes on the class (see below). Each function
      expects `self` to provide `get`, `post`, and `get_validated` from
      AsyncHTTPClient and to expose `_models` for the active network.
    - Network-specific models are accessed via `self._models` which is set based
      on the configured network. This avoids global mutation and is predictable.
    - Use `AsyncRESTClient.create(...)` to ensure async initialization (RPC
      config, optional chain client) happens before use. Remember to `await
      client.close()` to release the underlying `httpx.AsyncClient`.
    - We intentionally avoid “async properties”. For convenience methods that
      derive indices (e.g., products by ticker/id), use explicit async methods
      like `get_products_by_ticker()` or `get_products_by_id()` that fetch fresh
      data each call to keep behavior lightweight and predictable.
    """

    list_funding = list_funding
    get_projected_funding = get_projected_funding
    list_projected_funding = list_projected_funding
    get_order = get_order
    list_fills = list_fills
    list_orders = list_orders
    list_trades = list_trades
    prepare_order = prepare_order
    sign_order = sign_order
    submit_order = submit_order
    dry_run_order = dry_run_order
    prepare_cancel_order = prepare_cancel_order
    sign_cancel_order = sign_cancel_order
    cancel_order = cancel_order
    get_signer = get_signer
    get_signer_quota = get_signer_quota
    list_signers = list_signers
    prepare_linked_signer = prepare_linked_signer
    sign_linked_signer = sign_linked_signer
    link_linked_signer = link_linked_signer
    prepare_revoke_linked_signer = prepare_revoke_linked_signer
    sign_revoke_linked_signer = sign_revoke_linked_signer
    revoke_linked_signer = revoke_linked_signer
    prepare_refresh_linked_signer = prepare_refresh_linked_signer
    sign_refresh_linked_signer = sign_refresh_linked_signer
    refresh_linked_signer = refresh_linked_signer
    list_positions = list_positions
    get_position = get_position
    list_position_liquidations = list_position_liquidations
    get_market_liquidity = get_market_liquidity
    list_market_prices = list_market_prices
    list_products = list_products
    get_rpc_config = get_rpc_config
    list_subaccounts = list_subaccounts
    get_subaccount = get_subaccount
    get_subaccount_balances = get_subaccount_balances
    get_subaccount_balance_history = get_subaccount_balance_history
    get_subaccount_unrealized_pnl_history = get_subaccount_unrealized_pnl_history
    get_subaccount_volume_history = get_subaccount_volume_history
    get_subaccount_funding_history = get_subaccount_funding_history
    get_subaccount_total_volume = get_subaccount_total_volume
    get_referral_summary = get_referral_summary
    list_referrals = list_referrals
    get_token = get_token
    list_token_withdraws = list_token_withdraws
    list_tokens = list_tokens
    list_token_transfers = list_token_transfers
    prepare_withdraw_token = prepare_withdraw_token
    sign_withdraw_token = sign_withdraw_token
    submit_withdraw_token = submit_withdraw_token

    def __init__(self, config: Union[Dict[str, Any], RESTConfig] = {}):
        self.config = RESTConfig.model_validate(config)
        network = self.config.network or "testnet"

        if not self.config.base_url:
            self.config.base_url = AnyHttpUrl(
                NETWORK_URLS.get(network, NETWORK_URLS["testnet"])
            )

        if not self.config.archive_base_url:
            self.config.archive_base_url = AnyHttpUrl(
                ARCHIVE_NETWORK_URLS.get(network, ARCHIVE_NETWORK_URLS["testnet"])
            )

        self._models = importlib.import_module(
            _MODEL_PATHS.get(network, _MODEL_PATHS["default"])  # type: ignore
        )
        super().__init__(self.config)

        self._archive_base_url = self.config.archive_base_url
        self.chain: Optional[ChainClient] = None
        self.rpc_config: Optional[RpcConfigDto] = None
        self.private_key: Optional[str] = None
        self.provider: Optional[Any] = None
        self.default_time_in_force = self.config.default_time_in_force
        self.default_post_only = self.config.default_post_only
        self._subaccounts: Optional[List[SubaccountDto]] = None
        self._products: Optional[List[ProductDto]] = None
        self._tokens: Optional[List[TokenDto]] = None
        self._products_by_ticker: Optional[Dict[str, ProductDto]] = None
        self._products_by_id: Optional[Dict[UUID, ProductDto]] = None

    @classmethod
    async def create(
        cls, config: Union[Dict[str, Any], RESTConfig] = {}
    ) -> AsyncRESTClient:
        """Factory method to create and asynchronously initialize the client.

        Args:
            config (Union[Dict[str, Any], RESTConfig], optional): Configuration dictionary or RESTConfig object. Optional fields include:
                private_key (str, optional): The private key.
                base_url (str, optional): Base URL for REST requests. Defaults to mainnet.
                timeout (int, optional): Timeout in seconds for REST requests.
                verbose (bool, optional): Enables debug logging. Defaults to False.
                rate_limit_headers (bool, optional): Enables rate limit headers. Defaults to False.
                chain_config (ChainConfig, optional): Chain configuration for signing transactions.

        Returns:
            AsyncRESTClient: Fully initialized async client instance.
        """
        client = cls(config)
        await client._async_init()
        return client

    async def _async_init(self):
        """Asynchronous initialization.

        Loads RPC configuration and (optionally) initializes the chain client if
        `chain_config` is provided. This split constructor pattern keeps
        `__init__` sync, while `create()` ensures the instance is fully ready.
        """
        self.rpc_config = await self.get_rpc_config()
        tokens = await self.list_tokens()
        if self.config.chain_config:
            self._init_chain_client(self.config.chain_config, self.rpc_config, tokens)
        self.private_key = self.chain.private_key if self.chain else None
        self.provider = self.chain.provider if self.chain else None
        # No eager cache priming; caches are populated on first access

    def _init_chain_client(
        self,
        config: Union[Dict[str, Any], ChainConfig],
        rpc_config: Optional[RpcConfigDto] = None,
        tokens: Optional[List[TokenDto]] = None,
    ):
        """Initialize the ChainClient for transaction signing.

        Args:
            config (Union[Dict[str, Any], ChainConfig]): The chain configuration.
            rpc_config (RpcConfigDto, optional): RPC configuration. Defaults to None.
            tokens (List[TokenDto], optional): List of token configurations. Defaults to None.
        """
        config = ChainConfig.model_validate(config)
        try:
            self.chain = ChainClient(config, rpc_config, tokens)
            self.logger.debug("Chain client initialized successfully")
        except Exception as e:
            self.logger.debug(f"Failed to initialize chain client: {e}")

    async def _get_pages(
        self,
        endpoint: str,
        request_model: type[BaseModel],
        response_model: type[BaseModel],
        paginate: bool = False,
        max_pages: int = 10,
        **kwargs,
    ) -> Any:
        """Make a GET request with validated parameters and response, handling pagination.

        Args:
            endpoint (str): API endpoint path (e.g. "order" will be appended to the base URL and prefix to form "/v1/order")
            request_model (type[BaseModel]): Pydantic model for request validation
            response_model (type[BaseModel]): Pydantic model for response validation
            paginate (bool, optional): If True, fetch all pages and return aggregated list. Defaults to False.
            max_pages (int, optional): Maximum number of pages to fetch when paginating. Defaults to 10.

        Other Parameters:
            **kwargs: Parameters to validate and include in the request

        Returns:
            Any: List of validated response objects. Single page if paginate=False, all pages if paginate=True.
        """
        first_page = await self.get_validated(
            url_path=f"{API_PREFIX}/{endpoint}",
            request_model=request_model,
            response_model=response_model,
            **kwargs,
        )
        # `get_validated` already returns an instance of `response_model` with
        # `.data`, `.has_next`, and `.next_cursor`.
        if not paginate:
            return list(getattr(first_page, "data"))

        all_items: List[Any] = list(getattr(first_page, "data"))
        current_cursor = getattr(first_page, "next_cursor", None)
        has_next = getattr(first_page, "has_next", False)

        page_count = 1
        while has_next and current_cursor and page_count <= max_pages:
            page = await self.get_validated(
                url_path=f"{API_PREFIX}/{endpoint}",
                request_model=request_model,
                response_model=response_model,
                cursor=current_cursor,
                **kwargs,
            )
            all_items.extend(getattr(page, "data"))
            has_next = getattr(page, "has_next", False)
            current_cursor = getattr(page, "next_cursor", None)
            page_count += 1

        return all_items

    async def subaccounts(self, refresh: bool = False) -> List[SubaccountDto]:
        """Get the list of subaccounts.

        Args:
            refresh (bool, optional): If True, bypass cache and fetch fresh data. Defaults to False.

        Returns:
            List[SubaccountDto]: List of subaccount objects for the connected wallet address.

        Raises:
            ValueError: If no chain client is configured or address is unavailable.
        """
        if not self.chain or not getattr(self.chain, "address", None):
            raise ValueError("Chain address is required to list subaccounts")
        if refresh or self._subaccounts is None:
            self._subaccounts = await self.list_subaccounts(
                sender=self.chain.address, order_by="createdAt", order="asc"
            )
        return self._subaccounts

    async def products(self, refresh: bool = False) -> List[ProductDto]:
        """Get the list of products.

        Args:
            refresh (bool, optional): If True, bypass cache and fetch fresh data. Defaults to False.

        Returns:
            List[ProductDto]: List of product objects.
        """
        if refresh or self._products is None:
            self._products = await self.list_products()
        return self._products

    async def tokens(self, refresh: bool = False) -> List[TokenDto]:
        """Get the list of tokens.

        Args:
            refresh (bool, optional): If True, bypass cache and fetch fresh data. Defaults to False.

        Returns:
            List[TokenDto]: List of token objects.
        """
        if refresh or self._tokens is None:
            self._tokens = await self.list_tokens()
        return self._tokens

    async def products_by_ticker(self, refresh: bool = False) -> Dict[str, ProductDto]:
        """Get the products indexed by ticker.

        Args:
            refresh (bool, optional): If True, bypass cache and fetch fresh data. Defaults to False.

        Returns:
            Dict[str, ProductDto]: Dictionary of products keyed by ticker.
        """
        if refresh or self._products_by_ticker is None:
            products = await self.products(refresh=refresh)
            self._products_by_ticker = {
                p.ticker: p for p in products if getattr(p, "ticker", None)
            }
        return self._products_by_ticker

    async def products_by_id(self, refresh: bool = False) -> Dict[UUID, ProductDto]:
        """Get the products indexed by ID.

        Args:
            refresh (bool, optional): If True, bypass cache and fetch fresh data. Defaults to False.

        Returns:
            Dict[UUID, ProductDto]: Dictionary of products keyed by ID.
        """
        if refresh or self._products_by_id is None:
            products = await self.products(refresh=refresh)
            self._products_by_id = {p.id: p for p in products}
        return self._products_by_id

    async def get_maintenance_margin(
        self,
        subaccount_id: UUID,
        positions: Optional[List[PositionDto] | List[Dict[str, Any]]] = None,
        products: Optional[List[ProductDto] | List[Dict[str, Any]]] = None,
        product_ids: Optional[List[UUID]] = None,
    ) -> Decimal:
        """Calculate the an account's maintenance margin for specified positions or products.

        Args:
            subaccount_id (str): Fetch positions for this subaccount when ``positions`` is not supplied.
            positions (List[PositionDto] | List[Dict[str, Any]], optional): Pre-fetched positions to use directly.
            products (List[ProductDto] | List[Dict[str, Any]], optional): Pre-fetched products used to filter
                the calculation.
            product_ids (List[str] | List[UUID], optional): Filters the calculation to these product IDs.

        Returns:
            Decimal: Total maintenance margin for the filtered positions.

        Raises:
            ValueError: If neither positions nor subaccount context is provided, or if any
                referenced product cannot be resolved.
        """

        class PartialPosition(BaseModel):
            product_id: UUID
            cost: str

        class PartialProduct(BaseModel):
            id: UUID
            max_leverage: float
            taker_fee: str

        if positions is None:
            positions = await self.list_positions(subaccount_id=subaccount_id)

        if products and product_ids:
            raise ValueError("Can only specify one of products and product_ids")

        if products is not None:
            valid_products = [
                PartialProduct(**p if isinstance(p, dict) else p.model_dump())
                for p in products
            ]
            products_by_id: Dict[UUID, PartialProduct] = {
                product.id: product for product in valid_products
            }
        else:
            raw_products_by_id = await self.products_by_id()
            products_by_id = {
                UUID(str(k)): PartialProduct(
                    **v if isinstance(v, dict) else v.model_dump()
                )
                for k, v in raw_products_by_id.items()
            }

        product_ids_set: Optional[Set[UUID]] = None
        if product_ids is not None:
            product_ids_set = set([UUID(str(pid)) for pid in product_ids])
            products_by_id_keys = set(products_by_id.keys())
            missing_products = product_ids_set - products_by_id_keys
            if missing_products:
                missing = ", ".join(sorted([str(p) for p in missing_products]))
                raise ValueError(f"Products not found for calculation: {missing}")

        valid_positions = [
            PartialPosition(**p if isinstance(p, dict) else p.model_dump())
            for p in positions
        ]
        positions_filtered = [
            position
            for position in valid_positions
            if product_ids_set is None or position.product_id in product_ids_set
        ]

        if not positions_filtered:
            return Decimal("0")

        total_mm = Decimal("0")
        for position in positions_filtered:
            product = products_by_id.get(position.product_id)
            if product is None:
                raise ValueError(
                    f"Product '{position.product_id}' not found for position '{position.product_id}'"
                )

            notional = abs(Decimal(position.cost))
            max_leverage = Decimal(str(product.max_leverage))
            taker_fee_rate = Decimal(product.taker_fee)

            mmr = Decimal("1") / (max_leverage * Decimal("2"))
            total_mm += notional * mmr
            total_mm += notional * taker_fee_rate

        return total_mm

    async def get_tokens(self) -> List[TokenDto]:
        """Return the latest list of tokens (no caching)."""
        return await self.list_tokens()

    async def _resolve_sender_and_subaccount(
        self, sender: Optional[str] = None, subaccount: Optional[str] = None
    ) -> Tuple[str, str]:
        if sender is None and self.chain:
            sender = self.chain.address
            warnings.warn(
                "Automatically resolving 'sender' parameter is deprecated and will be removed in a future version. "
                "Always explicitly pass 'sender' and 'subaccount' to avoid issues while using multiple account. "
                f"Using sender='{sender}'",
                DeprecationWarning,
                stacklevel=3,
            )
        if sender is None:
            raise ValueError(
                "Could not resolve 'sender'. Either pass 'sender' explicitly or initialize the client with a chain configuration."
            )
        if subaccount is None:
            subaccounts = await self.subaccounts()
            if not subaccounts:
                raise ValueError(
                    "No subaccounts found for this account. Please create a subaccount first."
                )
            self.logger.debug(
                f"First subaccount name: '{subaccounts[0].name}', id: '{subaccounts[0].id}'"
            )
            self.logger.debug(f"All subaccount names: {[s.name for s in subaccounts]}")
            subaccount = subaccounts[0].name
            warnings.warn(
                "Automatically resolving 'subaccount' parameter is deprecated and will be removed in a future version. "
                "Always explicitly pass 'subaccount' and 'subaccount' to avoid issues while using multiple account. "
                f"Using subaccount='{subaccount}'",
                DeprecationWarning,
                stacklevel=3,
            )
        return sender, subaccount

    async def link_signer(
        self,
        signer: str,
        subaccount_id: UUID,
        subaccount: Optional[str] = None,
        sender: Optional[str] = None,
        signer_private_key: Optional[str] = None,
        nonce: Optional[str] = None,
        signed_at: Optional[int] = None,
        sign_sender: bool = True,
        sign_signer: bool = True,
        submit: bool = True,
        **kwargs,
    ) -> Union[SignerDto, LinkSignerDto]:
        """Prepare, sign, and optionally submit a linked signer payload.

        Args:
            signer (str): Address being linked as a delegate signer. Required.
            subaccount_id (UUID): Target subaccount id. Required.
            subaccount (str, optional): Bytes32 subaccount name. If omitted, fetched by id.
            sender (str, optional): Owner address. Defaults to the client's chain address.
            signer_private_key (str, optional): Private key for the signer address.
            nonce (str, optional): Custom nonce for the signature.
            signed_at (int, optional): Seconds since epoch for the signature timestamp.
            sign_sender (bool, optional): Sign with the owner key. Defaults to True.
            sign_signer (bool, optional): Sign with the signer key. Defaults to True.
            submit (bool, optional): Submit to the API. If False, return the prepared DTO.

        Returns:
            Union[SignerDto, LinkSignerDto]: Submitted record or the prepared/signable payload.

        Raises:
            ValueError: If the subaccount name cannot be resolved or signer signature is missing.
        """
        sender, subaccount = await self._resolve_sender_and_subaccount(
            sender, subaccount
        )
        # Fetch subaccount bytes name if not provided
        if subaccount is None:
            subaccount = (await self.get_subaccount(id=subaccount_id)).name

        link = await self.prepare_linked_signer(
            sender=sender,
            signer=signer,
            subaccount=subaccount,
            subaccount_id=subaccount_id,
            include_signature=False,
            nonce=nonce,
            signed_at=signed_at,
        )

        if sign_sender:
            link = await self.sign_linked_signer(link)

        if sign_signer:
            if signer_private_key:
                link = await self.sign_linked_signer(
                    link, signer_private_key=signer_private_key
                )
            elif not link.signer_signature:
                raise ValueError(
                    "signer_private_key or signer_signature is required when sign_signer=True"
                )

        return link if not submit else await self.link_linked_signer(link, **kwargs)

    async def revoke_signer(
        self,
        signer: str,
        subaccount_id: UUID,
        subaccount: Optional[str] = None,
        sender: Optional[str] = None,
        sign: bool = True,
        submit: bool = True,
        **kwargs,
    ) -> Union[SignerDto, RevokeLinkedSignerDto]:
        """Prepare, sign, and optionally submit a revoke-linked-signer payload.

        Args:
            signer (str): Address of the delegate to revoke. Required.
            subaccount_id (UUID): Target subaccount id. Required.
            subaccount (str, optional): Bytes32 subaccount name. If omitted, fetched by id.
            sender (str, optional): Owner address. Defaults to the client's chain address.
            sign (bool, optional): Sign with the owner key. Defaults to True.
            submit (bool, optional): Submit to the API. If False, return the prepared DTO.

        Returns:
            Union[SignerDto, RevokeLinkedSignerDto]: Submitted record or the prepared/signable payload.

        Raises:
            ValueError: If the subaccount name cannot be resolved.
        """
        sender, subaccount = await self._resolve_sender_and_subaccount(
            sender, subaccount
        )
        if subaccount is None:
            subaccount = (await self.get_subaccount(id=subaccount_id)).name

        revoke = await self.prepare_revoke_linked_signer(
            sender=sender,
            signer=signer,
            subaccount=subaccount,
            subaccount_id=subaccount_id,
            include_signature=False,
            **kwargs,
        )

        if sign:
            revoke = await self.sign_revoke_linked_signer(revoke)

        return (
            revoke if not submit else await self.revoke_linked_signer(revoke, **kwargs)
        )

    async def withdraw_token(
        self,
        dto: Optional[InitiateWithdrawDto] = None,
        token_id: Optional[UUID] = None,
        amount: Optional[int] = None,
        destination_address: Optional[str] = None,
        destination_endpoint: Optional[int] = None,
        subaccount: Optional[str] = None,
        account: Optional[str] = None,
        nonce: Optional[str] = None,
        signed_at: Optional[int] = None,
        sign: bool = True,
        submit: bool = True,
        **kwargs,
    ) -> Union[WithdrawDto, InitiateWithdrawDto]:
        """Prepares, signs, and optionally submits a token withdrawal.

        This is the primary method for initiating token withdrawals. It handles
        the complete withdrawal flow: preparing the withdrawal payload, signing
        it with EIP-712, and submitting to the API.

        Example:
            Withdraw 100 USD to the connected wallet::

                result = await client.withdraw_token(
                    token_id=usd_token.id,
                    amount=100,
                    destination_address=client.chain.address,
                    destination_endpoint=0,
                )

            Prepare without submitting (for inspection or manual submission)::

                payload = await client.withdraw_token(
                    token_id=usd_token.id,
                    amount=100,
                    destination_address="0x...",
                    destination_endpoint=0,
                    submit=False,
                )

        Args:
            token_id: UUID of the token to withdraw.
            amount: Amount to withdraw in the token's base units.
            destination_address: The LayerZero destination address where funds
                will be sent. Automatically padded to bytes32 format.
            destination_endpoint: LayerZero endpoint ID for the destination chain.
                Use 0 for same-chain withdrawals.
            subaccount: Hex-encoded subaccount name. If not provided, defaults to
                the first subaccount associated with the connected wallet.
            account: Recipient wallet address. If not provided, defaults to the
                connected wallet's address.
            nonce: Custom nonce for the EIP-712 signature. If not provided, a
                random nonce is generated.
            signed_at: Unix timestamp (seconds) for the signature. If not provided,
                defaults to the current time.
            sign: Whether to sign the withdrawal payload. Defaults to True.
            submit: Whether to submit the withdrawal to the API. Set to False to
                receive the prepared payload without submitting. Defaults to True.
            dto: **Deprecated.** A pre-built InitiateWithdrawDto. This parameter
                exists for backward compatibility and will be removed in a future
                version. Use the individual parameters instead.

        Returns:
            If ``submit=True``, returns a WithdrawDto containing the withdrawal
            record created by the API. If ``submit=False``, returns the prepared
            InitiateWithdrawDto payload.

        Raises:
            ValueError: If required parameters (token_id, amount, destination_address,
                destination_endpoint) are not provided.
            ValueError: If required parameters (token_id, amount, destination_address,
        """
        # Detect deprecated dto path
        if dto is not None:
            warnings.warn(
                "Passing 'dto' to withdraw_token() is deprecated. "
                "Pass friendly parameters directly (amount, token_id, destination_address, etc.) instead. "
                "The dto parameter will be removed in a future version.",
                DeprecationWarning,
                stacklevel=2,
            )
            if token_id is None:
                raise ValueError("token_id is required when using dto parameter")
            if not submit:
                if sign and not dto.signature:
                    dto = await self.sign_withdraw_token(dto)
                return dto

        # New friendly parameter path
        if token_id is None:
            raise ValueError("token_id is required")
        if amount is None:
            raise ValueError("amount is required")
        if destination_address is None:
            raise ValueError("destination_address is required")
        if destination_endpoint is None:
            raise ValueError("destination_endpoint is required")

        # Resolve token address from token_id
        token = await self.get_token(id=token_id)
        token_addr = token.address

        # Resolve account/subaccount
        account_addr, subaccount_name = await self._resolve_sender_and_subaccount(
            account, subaccount
        )

        # Prepare
        withdraw_dto = await self.prepare_withdraw_token(
            subaccount=subaccount_name,
            token=token_addr,
            amount=amount,
            account=account_addr,
            destination_address=destination_address,
            destination_endpoint=destination_endpoint,
            include_signature=False,
            nonce=nonce,
            signed_at=signed_at,
        )

        # Sign
        if sign:
            withdraw_dto = await self.sign_withdraw_token(withdraw_dto)

        # Submit or return
        if not submit:
            return withdraw_dto
        return await self.submit_withdraw_token(
            dto=withdraw_dto, token_id=token_id, **kwargs
        )

    async def refresh_signer(
        self,
        signer: str,
        subaccount_id: UUID,
        subaccount: Optional[str] = None,
        sender: Optional[str] = None,
        sign: bool = True,
        submit: bool = True,
        **kwargs,
    ) -> Union[SignerDto, RefreshLinkedSignerDto]:
        """Prepare, sign, and optionally submit a refresh-linked-signer payload.

        Args:
            signer (str): Address of the delegate to refresh. Required.
            subaccount_id (UUID): Target subaccount id. Required.
            subaccount (str, optional): Bytes32 subaccount name. If omitted, fetched by id.
            sender (str, optional): Owner address. Defaults to the client's chain address.
            sign (bool, optional): Sign with the owner key. Defaults to True.
            submit (bool, optional): Submit to the API. If False, return the prepared DTO.

        Returns:
            Union[SignerDto, RefreshLinkedSignerDto]: Submitted record or the prepared/signable payload.

        Raises:
            ValueError: If the subaccount name cannot be resolved.
        """
        sender, subaccount = await self._resolve_sender_and_subaccount(
            sender, subaccount
        )
        if subaccount is None:
            subaccount = (await self.get_subaccount(id=subaccount_id)).name

        refresh = await self.prepare_refresh_linked_signer(
            sender=sender,
            signer=signer,
            subaccount=subaccount,
            subaccount_id=subaccount_id,
            include_signature=False,
            **kwargs,
        )

        if sign:
            refresh = await self.sign_refresh_linked_signer(refresh)

        return (
            refresh
            if not submit
            else await self.refresh_linked_signer(refresh, **kwargs)
        )

    async def create_order(
        self,
        order_type: str,
        quantity: float,
        side: int,
        price: Optional[float] = None,
        ticker: Optional[str] = None,
        product_id: Optional[UUID] = None,
        client_order_id: Optional[str] = None,
        sender: Optional[str] = None,
        subaccount: Optional[str] = None,
        time_in_force: Optional[str] = None,
        post_only: Optional[bool] = None,
        reduce_only: Optional[bool] = False,
        close: Optional[bool] = None,
        stop_price: Optional[float] = None,
        stop_type: Optional[int] = None,
        expires_at: Optional[int] = None,
        group_id: Optional[str] = None,
        group_contingency_type: Optional[int] = None,
        sign: bool = True,
        dry_run: bool = False,
        submit: bool = True,
    ) -> Union[SubmitOrderCreatedDto, DryRunOrderCreatedDto, SubmitOrderDto]:
        """Create and submit an order.

        Args:
            order_type (str): 'LIMIT' or 'MARKET'. Required.
            quantity (float): Order size. Required.
            side (int): 0 for buy, 1 for sell. Required.
            price (float, optional): Limit price for LIMIT orders.
            ticker (str, optional): Ticker of the product.
            product_id (str, optional): UUID of the product.
            client_order_id (str, optional): Subaccount-scoped client-generated id (UUID or <=32 alphanumeric).
            sender (str, optional): Address placing the order. Defaults to chain address.
            subaccount (str, optional): Hex-encoded subaccount name. Defaults to first subaccount.
            time_in_force (str, optional): For LIMIT orders (e.g., 'GTC', 'GTD'). Defaults to 'GTC'.
            post_only (bool, optional): For LIMIT orders; rejects if crossing. Defaults to False.
            reduce_only (bool, optional): If True, order only reduces position. Defaults to False.
            close (bool, optional): For MARKET orders; If True, closes the position.
            stop_price (float, optional): Stop trigger price.
            stop_type (int, optional): Stop type, either 0 (take-profit) or 1 (stop-loss), requires non-zero stopPrice.
            expires_at (int, optional): Expiry timestamp for GTD.
            group_id (str, optional): Group Id (UUID) for linking orders together in OCO/OTO relationships.
            group_contingency_type (int, optional): Contingency type for order groups: 0=OTO (Order-Triggers-Order), 1=OCO (One-Cancels-Other).
            sign (bool, optional): If True, sign the payload immediately. Defaults to True.
            dry_run (bool, optional): If True, validate without execution. Defaults to False.
            submit (bool, optional): If True, submit the order. Defaults to True.

        Returns:
            Union[SubmitOrderCreatedDto, DryRunOrderCreatedDto, SubmitOrderDto]: Created order response, dry-run validation result, or prepared order payload.

        Raises:
            ValueError: If neither product_id nor ticker is provided or if order type is invalid.
        """
        sender, subaccount = await self._resolve_sender_and_subaccount(
            sender, subaccount
        )

        if product_id is not None:
            products_by_id = await self.products_by_id()
            onchain_id = products_by_id[product_id].onchain_id
        elif ticker is not None:
            products_by_ticker = await self.products_by_ticker()
            onchain_id = products_by_ticker[ticker].onchain_id
        else:
            raise ValueError("Either product_id or ticker must be provided")

        order_params: Dict[str, Any] = {
            "subaccount": subaccount,
            "side": side,
            "quantity": quantity,
            "onchain_id": onchain_id,
            "order_type": order_type,
            "client_order_id": client_order_id,
            "reduce_only": reduce_only,
            "close": close,
            "stop_price": stop_price,
            "stop_type": stop_type,
            "group_id": group_id,
            "group_contingency_type": group_contingency_type,
        }

        if order_type == "LIMIT":
            order_params.update(
                {
                    "price": price,
                    "time_in_force": time_in_force or self.default_time_in_force,
                    "post_only": post_only or self.default_post_only,
                    "expires_at": expires_at,
                }
            )
        elif order_type != "MARKET":
            raise ValueError("Invalid order type")

        order = await self.prepare_order(sender, **order_params, include_signature=sign)
        if dry_run:
            return await self.dry_run_order(order)
        elif submit:
            return await self.submit_order(order)
        else:
            return order

    async def cancel_orders(
        self,
        order_ids: List[UUID],
        sender: Optional[str] = None,
        subaccount: Optional[str] = None,
        client_order_ids: List[str] = [],
        sign: bool = True,
        submit: bool = True,
        **kwargs,
    ) -> Union[List[CancelOrderResultDto], CancelOrderDto]:
        """Prepares and optionally submits a request to cancel multiple orders.

        Args:
            order_ids (List[str]): Order UUIDs to cancel. Required.
            sender (str, optional): Address initiating the cancellation. Defaults to chain address.
            subaccount (str, optional): Hex-encoded subaccount name. Defaults to first subaccount.
            client_order_ids (List[str], optional): Client-generated IDs to cancel. Defaults to empty list.
            sign (bool, optional): If True, sign the payload immediately. Defaults to True.
            submit (bool, optional): If True, submit the request to the API. Defaults to True.

        Other Parameters:
            **kwargs: Additional request parameters accepted by the API.

        Returns:
            Union[List[CancelOrderResultDto], CancelOrderDto]: Cancellation results per order id or prepared cancel payload.

        Raises:
            ValueError: If no order IDs or client order IDs provided for cancellation.
        """
        if len(order_ids) == 0 and len(client_order_ids) == 0:
            raise ValueError(
                "No order IDs or client order IDs provided for cancellation"
            )
        sender, subaccount = await self._resolve_sender_and_subaccount(
            sender, subaccount
        )
        try:
            prepared_cancel = await self.prepare_cancel_order(
                order_ids=order_ids,
                client_order_ids=client_order_ids,
                sender=sender,
                subaccount=subaccount,
                include_signature=sign,
                **kwargs,
            )
        except ValueError as e:
            self.logger.warning(f"Could not prepare/sign order cancellation: {e}")
            raise

        if not submit:
            return prepared_cancel

        result = await self.cancel_order(
            prepared_cancel,
            **kwargs,
        )
        return result

    async def cancel_all_orders(
        self,
        subaccount_id: UUID,
        product_ids: Optional[List[UUID]] = None,
        **kwargs,
    ) -> List[CancelOrderResultDto]:
        """Cancel all orders for a given subaccount.

        Args:
            subaccount_id (str): UUID of the subaccount. Required.
            product_ids (List[str], optional): Filter cancellation by product IDs.

        Other Parameters:
            **kwargs: Additional request parameters accepted by the API.

        Returns:
            List[CancelOrderResultDto]: Cancellation results per order id.

        Raises:
            ValueError: If no orders found to cancel or cancellation fails.
        """
        subaccount = await self.get_subaccount(id=subaccount_id)
        query_params = {
            "subaccount_id": subaccount_id,
            "isWorking": True,
            **kwargs,
        }
        if product_ids:
            query_params["product_ids"] = product_ids

        orders = await self._get_pages(
            endpoint="order",
            request_model=self._models.V1OrderGetParametersQuery,
            response_model=self._models.PageOfOrderDtos,
            paginate=True,
            **query_params,
        )
        order_ids = [order.id for order in orders]

        if len(order_ids) == 0:
            raise ValueError("No order IDs provided for cancellation")
        cancel_results = await self.cancel_orders(
            order_ids=order_ids,
            sender=subaccount.account,
            subaccount=subaccount.name,
            sign=True,
            submit=True,
        )
        if not isinstance(cancel_results, list):
            raise ValueError("Failed to cancel orders")
        return cancel_results

    async def replace_order(
        self,
        order: Optional[OrderDto] = None,
        order_id: Optional[UUID] = None,
        quantity: Optional[float] = None,
        price: Optional[float] = None,
        time_in_force: Optional[str] = None,
        post_only: Optional[bool] = None,
        reduce_only: Optional[bool] = False,
    ) -> Tuple[SubmitOrderCreatedDto, bool]:
        """Replace an existing order with new parameters.

        Args:
            order (OrderDto, optional): Existing order object to replace.
            order_id (str, optional): UUID of the order to replace.
            quantity (float, optional): New order size.
            price (float, optional): New limit price.
            time_in_force (str, optional): New time in force.
            post_only (bool, optional): New post-only flag.
            reduce_only (bool, optional): New reduce-only flag. Defaults to False.

        Returns:
            Tuple[SubmitOrderCreatedDto, bool]: Created order response and success flag.

        Raises:
            ValueError: If neither order nor order_id is provided, or both are provided.
        """
        if order is None and order_id is None:
            raise ValueError("Either order or order_id must be provided")
        elif order is not None and order_id is not None:
            raise ValueError("Only one of order or order_id must be provided")
        elif order is not None:
            old_order = order
        elif order_id is not None:
            old_order = await self.get_order(id=order_id)
        subaccount = await self.get_subaccount(id=old_order.subaccount_id)

        quantity = float(old_order.quantity) if quantity is None else quantity
        price = float(old_order.price) if price is None else price
        time_in_force = (
            old_order.time_in_force.value
            if time_in_force is None and old_order.time_in_force
            else time_in_force
        )
        post_only = old_order.post_only if post_only is None else post_only
        reduce_only = old_order.reduce_only if reduce_only is None else reduce_only

        cancel_result = await self.cancel_orders(
            order_ids=[old_order.id],
            sender=old_order.sender,
            subaccount=subaccount.name,
            sign=True,
            submit=True,
        )
        if not isinstance(cancel_result, list) or len(cancel_result) != 1:
            raise ValueError("Failed to cancel order")
        canceled_order = cancel_result[0]

        if not canceled_order.result.value == "Ok":
            raise ValueError(
                f"Failed to cancel order {order_id}: {canceled_order.result.value}"
            )

        new_order = await self.create_order(
            order_type=old_order.type.value,
            quantity=quantity,
            side=old_order.side.value,
            price=price,
            product_id=old_order.product_id,
            sender=old_order.sender,
            subaccount=subaccount.name,
            time_in_force=time_in_force or self.default_time_in_force,
            post_only=post_only or self.default_post_only,
            reduce_only=reduce_only,
            dry_run=False,
        )
        return self._models.SubmitOrderCreatedDto.model_validate(
            new_order
        ), canceled_order.result.value == "Ok"
