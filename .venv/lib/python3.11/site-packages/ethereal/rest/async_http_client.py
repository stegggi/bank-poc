from typing import Any, Dict, Optional, Union, TypedDict, Type
from pydantic import BaseModel, ValidationError
import logging

import httpx

from ethereal.base_client import BaseClient
from ethereal.models.config import HTTPConfig
from ethereal.constants import RATE_LIMIT_HEADERS, USER_AGENT, REST_COMMON_FIELDS


class ValidationException(Exception):
    def __init__(self, stage: str, url_path: str, model: Type[BaseModel], errors: list):
        def alias_to_name(alias: str) -> str:
            for name, field in model.model_fields.items():
                if field.alias == alias:
                    return name
            return alias

        def get_field_name(loc: tuple) -> str:
            if not loc:
                return "unknown"
            return alias_to_name(loc[0]) if isinstance(loc[0], str) else str(loc[0])

        error_messages = "\n".join(
            f" - {get_field_name(e['loc'])}: {e['msg']}" for e in errors
        )
        message = (
            f"{stage} validation failed for endpoint `{url_path}`:\n{error_messages}"
        )
        super().__init__(message)
        self.errors = errors


class BaseResponse(TypedDict, total=False):
    rate_limit_limit: Optional[str]
    rate_limit_remaining: Optional[str]
    retry_after: Optional[str]


class AsyncHTTPClient(BaseClient):
    """Asynchronous HTTP client for making API requests.

    Maintainer notes:
    - We use a single `httpx.AsyncClient` per instance; call `await close()`
      when done to free sockets. The higher-level REST client wires this up.
    - `get_validated` validates both request params and responses using
      pydantic models, raising `ValidationException` with human-friendly field
      names. Endpoint modules rely on this for type safety at boundaries.
    - Auth: extend `set_headers()` to inject auth headers or request signing
      when needed; keeping it centralized avoids per-endpoint duplication.
    - Future: consider passing `base_url` to `AsyncClient` and using relative
      paths to simplify URL construction. Current approach is explicit.
    """

    def __init__(self, config: Union[Dict[str, Any], HTTPConfig]):
        super().__init__(config)
        self.config = HTTPConfig.model_validate(config)
        self.base_url = self.config.base_url
        # Normalize base URL once to avoid double slashes when joining paths.
        self._base_url_str = str(self.base_url).rstrip("/") if self.base_url else ""
        self.timeout = self.config.timeout

        # Configure httpx logging - suppress INFO logs unless verbose mode is enabled
        if not getattr(self.config, "verbose", False):
            httpx_logger = logging.getLogger("httpx")
            httpx_logger.setLevel(logging.WARNING)

        self.session = httpx.AsyncClient()
        self.rate_limit_headers = self.config.rate_limit_headers

    async def close(self):
        """Closes the HTTP session."""
        if hasattr(self, "session") and not self.session.is_closed:
            await self.session.aclose()

    def _handle_exception(self, response: httpx.Response):
        """Handles HTTP exceptions."""
        http_error_msg = ""
        reason = response.reason_phrase

        if 400 <= response.status_code < 500:
            if (
                response.status_code == 403
                and "'error_details':'Missing required scopes'" in response.text
            ):
                http_error_msg = f"{response.status_code} Client Error: Missing Required Scopes. Please verify your API keys include the necessary permissions."
            else:
                http_error_msg = (
                    f"{response.status_code} Client Error: {reason} {response.text}"
                )
        elif 500 <= response.status_code < 600:
            http_error_msg = (
                f"{response.status_code} Server Error: {reason} {response.text}"
            )

        if http_error_msg:
            self.logger.error(f"HTTP Error: {http_error_msg}")
            raise httpx.HTTPStatusError(
                http_error_msg, request=response.request, response=response
            )

    async def get(
        self,
        url_path,
        params: Optional[dict] = None,
        *,
        base_url_override: Optional[str] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """Sends a GET request."""
        params = params or {}
        if kwargs:
            params.update(kwargs)
        return await self.prepare_and_send_request(
            "GET",
            url_path,
            params,
            data=None,
            base_url_override=base_url_override,
        )

    async def get_validated(
        self,
        url_path,
        request_model: Type[BaseModel],
        response_model: Type[BaseModel],
        *,
        base_url_override: Optional[str] = None,
        **kwargs,
    ) -> BaseModel:
        """Sends a GET request with type validation."""
        try:
            validated_params = request_model.model_validate(kwargs, by_name=True)
        except ValidationError as e:
            raise ValidationException(
                "Request", url_path, request_model, e.errors()
            ) from None
        params = validated_params.model_dump(
            mode="json", exclude_none=True, by_alias=True
        )

        response_data = await self.prepare_and_send_request(
            "GET",
            url_path,
            params,
            data=None,
            base_url_override=base_url_override,
        )
        validated_response = response_model.model_validate(response_data)
        return validated_response

    async def post(
        self,
        url_path,
        params: Optional[dict] = None,
        data: Optional[dict] = None,
        *,
        base_url_override: Optional[str] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """Sends a POST request."""
        data = data or {}
        if kwargs:
            data.update(kwargs)
        return await self.prepare_and_send_request(
            "POST",
            url_path,
            params,
            data,
            base_url_override=base_url_override,
        )

    async def put(
        self,
        url_path,
        params: Optional[dict] = None,
        data: Optional[dict] = None,
        *,
        base_url_override: Optional[str] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """Sends a PUT request."""
        data = data or {}
        if kwargs:
            data.update(kwargs)
        return await self.prepare_and_send_request(
            "PUT",
            url_path,
            params,
            data,
            base_url_override=base_url_override,
        )

    async def delete(
        self,
        url_path,
        params: Optional[dict] = None,
        data: Optional[dict] = None,
        *,
        base_url_override: Optional[str] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """Sends a DELETE request."""
        data = data or {}
        if kwargs:
            data.update(kwargs)
        return await self.prepare_and_send_request(
            "DELETE",
            url_path,
            params,
            data,
            base_url_override=base_url_override,
        )

    async def prepare_and_send_request(
        self,
        http_method,
        url_path,
        params: Optional[dict] = None,
        data: Optional[dict] = None,
        *,
        base_url_override: Optional[str] = None,
    ):
        """Prepares and sends an HTTP request."""
        headers = self.set_headers(http_method, url_path)

        if params is not None:
            params = {
                key: str(value).lower() if isinstance(value, bool) else value
                for key, value in params.items()
                if value is not None
            }

        if data is not None:
            data = {key: value for key, value in data.items() if value is not None}

        return await self.send_request(
            http_method,
            url_path,
            params,
            headers,
            data=data,
            base_url_override=base_url_override,
        )

    async def send_request(
        self,
        http_method,
        url_path,
        params,
        headers,
        data=None,
        *,
        base_url_override: Optional[str] = None,
    ):
        """Sends an HTTP request."""
        if data is None:
            data = {}

        # Build URL with exactly one slash between base and path.
        path = url_path if str(url_path).startswith("/") else f"/{url_path}"
        base = base_url_override or self._base_url_str
        url = f"{base}{path}"
        self.logger.debug(f"Sending {http_method} request to {url}")

        response = await self.session.request(
            http_method,
            url,
            params=params,
            json=data,
            headers=headers,
            timeout=self.timeout,
        )
        self._handle_exception(response)

        self.logger.debug(f"Raw response: {response.json()}")
        response_data = response.json()

        if self.rate_limit_headers:
            response_headers = dict(response.headers)
            specific_headers = {
                REST_COMMON_FIELDS.get(key, key): response_headers.get(key, None)
                for key in RATE_LIMIT_HEADERS
            }
            response_data = {**response_data, **specific_headers}

        return response_data

    def set_headers(self, method, path):
        """Sets the request headers.

        This is the extension point for auth. If the API introduces API keys or
        request signing, add them here to keep all endpoints consistent.
        """
        return {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
        }
