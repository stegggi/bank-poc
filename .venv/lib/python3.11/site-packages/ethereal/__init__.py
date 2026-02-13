from importlib.metadata import version

from ethereal.rest_client import RESTClient
from ethereal.async_rest_client import AsyncRESTClient
from ethereal.ws_client import WSClient
from ethereal.async_ws_client import AsyncWSClient

__version__ = version("ethereal-sdk")
__all__ = ["RESTClient", "AsyncRESTClient", "WSClient", "AsyncWSClient", "__version__"]
