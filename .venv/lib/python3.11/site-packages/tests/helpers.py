"""Shared test helpers."""

import time

OPS_PER_SECOND = 2


def rate_limit(ops: int):
    """Rate limit helper - sleeps based on ops count."""
    time.sleep(ops / OPS_PER_SECOND)
