from typing import Any, Dict, Optional, Union, TypedDict, Type
from pydantic import BaseModel, ValidationError

import requests
from requests.exceptions import HTTPError

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


class HTTPClient(BaseClient):
    """HTTP client for making API requests.

    Args:
        config (Union[Dict[str, Any], HTTPConfig]): Client configuration.
    """

    def __init__(self, config: Union[Dict[str, Any], HTTPConfig]):
        super().__init__(config)
        self.config = HTTPConfig.model_validate(config)
        self.base_url = self.config.base_url
        self.timeout = self.config.timeout
        self.session = self._setup_session()
        self.rate_limit_headers = self.config.rate_limit_headers

    def _setup_session(self):
        """Sets up an HTTP session.

        Returns:
            requests.Session: Configured session object.
        """
        return requests.Session()

    def _handle_exception(self, response):
        """Handles HTTP exceptions.

        Args:
            response (Response): The HTTP response object.

        Raises:
            HTTPError: If response indicates an error occurred.
        """
        http_error_msg = ""
        reason = response.reason

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
            raise HTTPError(http_error_msg, response=response)

    def get(self, url_path, params: Optional[dict] = None, **kwargs) -> Dict[str, Any]:
        """Sends a GET request.

        Args:
            url_path (str): The URL path. Required.
            params (dict, optional): The query parameters. Optional.
            **kwargs: Additional arguments to pass to the request. Optional.

        Returns:
            Dict[str, Any]: The response data.
        """
        params = params or {}

        if kwargs:
            params.update(kwargs)

        return self.prepare_and_send_request("GET", url_path, params, data=None)

    def get_validated(
        self,
        url_path,
        request_model: Type[BaseModel],
        response_model: Type[BaseModel],
        **kwargs,
    ) -> BaseModel:
        """Sends a GET request including type validation of both the input and output from provided models.

        Args:
            url_path (str): The URL path. Required.
            request_model (Type[BaseModel]): Pydantic model for request validation. Required.
            response_model (Type[BaseModel]): Pydantic model for response validation. Required.
            **kwargs: Includes all arguments to pass to the request. Optional.

        Returns:
            BaseModel: The response data, validated against the response_model.
        """
        try:
            validated_params = request_model.model_validate(kwargs, by_name=True)
        except ValidationError as e:
            raise ValidationException(
                "Request", url_path, request_model, e.errors()
            ) from None
        params = validated_params.model_dump(
            mode="json", exclude_none=True, by_alias=True
        )

        response_data = self.prepare_and_send_request(
            "GET", url_path, params, data=None
        )
        validated_response = response_model.model_validate(response_data)
        return validated_response

    def post(
        self,
        url_path,
        params: Optional[dict] = None,
        data: Optional[dict] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """Sends a POST request.

        Args:
            url_path (str): The URL path. Required.
            params (dict, optional): The query parameters. Optional.
            data (dict, optional): The request body. Optional.
            **kwargs: Additional arguments to pass to the request. Optional.

        Returns:
            Dict[str, Any]: The response data.
        """
        data = data or {}

        if kwargs:
            data.update(kwargs)

        return self.prepare_and_send_request("POST", url_path, params, data)

    def put(
        self,
        url_path,
        params: Optional[dict] = None,
        data: Optional[dict] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """Sends a PUT request.

        Args:
            url_path (str): The URL path. Required.
            params (dict, optional): The query parameters. Optional.
            data (dict, optional): The request body. Optional.
            **kwargs: Additional arguments to pass to the request. Optional.

        Returns:
            Dict[str, Any]: The response data.
        """
        data = data or {}

        if kwargs:
            data.update(kwargs)

        return self.prepare_and_send_request("PUT", url_path, params, data)

    def delete(
        self,
        url_path,
        params: Optional[dict] = None,
        data: Optional[dict] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """Sends a DELETE request.

        Args:
            url_path (str): The URL path. Required.
            params (dict, optional): The query parameters. Optional.
            data (dict, optional): The request body. Optional.
            **kwargs: Additional arguments to pass to the request. Optional.

        Returns:
            Dict[str, Any]: The response data.
        """
        data = data or {}

        if kwargs:
            data.update(kwargs)

        return self.prepare_and_send_request("DELETE", url_path, params, data)

    def prepare_and_send_request(
        self,
        http_method,
        url_path,
        params: Optional[dict] = None,
        data: Optional[dict] = None,
    ):
        """Prepares and sends an HTTP request.

        Args:
            http_method (str): The HTTP method. Required.
            url_path (str): The URL path. Required.
            params (dict, optional): The query parameters. Optional.
            data (dict, optional): The request body. Optional.

        Returns:
            Dict[str, Any]: The response data.
        """
        headers = self.set_headers(http_method, url_path)

        if params is not None:
            params = {
                key: str(value).lower() if isinstance(value, bool) else value
                for key, value in params.items()
                if value is not None
            }

        if data is not None:
            data = {key: value for key, value in data.items() if value is not None}

        return self.send_request(http_method, url_path, params, headers, data=data)

    def send_request(self, http_method, url_path, params, headers, data=None):
        """Sends an HTTP request.

        Args:
            http_method (str): The HTTP method. Required.
            url_path (str): The URL path. Required.
            params (dict): The query parameters. Required.
            headers (dict): The request headers. Required.
            data (dict, optional): The request body. Optional.

        Returns:
            Dict[str, Any]: The response data.

        Raises:
            HTTPError: If the request fails.
        """
        if data is None:
            data = {}

        url = f"{self.base_url}{url_path}"

        self.logger.debug(f"Sending {http_method} request to {url}")

        response = self.session.request(
            http_method,
            url,
            params=params,
            json=data,
            headers=headers,
            timeout=self.timeout,
        )
        self._handle_exception(response)  # Raise an HTTPError for bad responses

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

        Args:
            method (str): The HTTP method. Required.
            path (str): The URL path. Required.

        Returns:
            dict: The request headers.
        """

        return {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
        }
