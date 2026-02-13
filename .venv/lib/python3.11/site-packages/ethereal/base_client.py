import logging
from typing import Union, Dict, Any
from ethereal.models.config import BaseConfig


def get_logger(name):
    """Get a configured logger instance.

    Args:
        name (str): Name for the logger

    Returns:
        Logger: Configured logging instance
    """
    logger = logging.getLogger(name)

    # Check if the logger already has handlers
    if not logger.handlers and logger.propagate:
        logger.setLevel(logging.INFO)
        return logger

    # If no handlers are set, configure a default handler
    if not logger.handlers and not logger.propagate:
        logger.setLevel(logging.INFO)
        handler = logging.StreamHandler()
        formatter = logging.Formatter(
            "%(asctime)s - %(name)s - %(levelname)s - %(message)s", "%Y-%m-%d %H:%M:%S"
        )
        handler.setFormatter(formatter)
        logger.addHandler(handler)

    return logger


class BaseClient:
    """Base client with common functionality.

    Args:
        config (Union[Dict[str, Any], BaseConfig]): Base configuration
    """

    def __init__(self, config: Union[Dict[str, Any], BaseConfig]):
        self.config = BaseConfig.model_validate(config)
        self._setup_logging()

    def _setup_logging(self):
        """Set up logging for the client."""
        self.logger = get_logger(self.__class__.__name__)
        if self.config.verbose:
            self.logger.setLevel(logging.DEBUG)
        pass
