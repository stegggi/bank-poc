from typing import Optional
from pydantic import BaseModel, Field, AnyHttpUrl, AnyWebsocketUrl, field_validator


class BaseConfig(BaseModel):
    """Base client configuration model."""

    verbose: bool = False
    network: str = Field(
        default="default",
        description="Network to connect to (testnet, devnet, mainnet)",
    )

    @field_validator("network")
    @classmethod
    def validate_network(cls, v: str) -> str:
        """Validate network is supported."""
        valid_networks = ["default", "testnet", "devnet", "mainnet", "local"]
        if v not in valid_networks:
            raise ValueError(f"Network must be one of {valid_networks}, got '{v}'")
        return v


class HTTPConfig(BaseConfig):
    """HTTP client configuration model."""

    base_url: Optional[AnyHttpUrl] = Field(
        default=None,
        description="Base API URL (auto-set based on network if not provided)",
    )
    timeout: int = Field(default=30, gt=0, description="Request timeout in seconds")
    rate_limit_headers: bool = Field(
        default=False, description="Include rate limit headers in responses"
    )


class WSBaseConfig(BaseConfig):
    """Base Websocket client configuration model."""

    base_url: AnyWebsocketUrl = Field(
        default=AnyWebsocketUrl("wss://ws.etherealtest.net/"), description="Base WS URL"
    )


class ChainConfig(BaseConfig):
    """Blockchain configuration model."""

    rpc_url: AnyHttpUrl = Field(default=..., description="RPC endpoint URL")
    address: Optional[str] = Field(
        default=None, description="Blockchain address for transactions"
    )
    private_key: Optional[str] = Field(
        default=None, description="Private key for blockchain transactions"
    )


class RESTConfig(HTTPConfig):
    """REST client configuration model."""

    chain_config: Optional[ChainConfig] = Field(
        default=None, description="Blockchain client configuration"
    )
    default_time_in_force: str = Field(
        default="GTD", description="Default time in force for orders"
    )
    default_post_only: bool = Field(
        default=False, description="Default post-only flag for orders"
    )
    archive_base_url: Optional[AnyHttpUrl] = Field(
        default=None,
        description="Base URL for archive REST requests (auto-set if not provided)",
    )


class WSConfig(WSBaseConfig):
    """Websocket client configuration model."""

    pass
