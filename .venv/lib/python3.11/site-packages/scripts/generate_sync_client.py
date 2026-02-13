#!/usr/bin/env python3
"""
Generates a synchronous REST client from the async client.

This script introspects the AsyncRESTClient and automatically generates
a synchronous wrapper. The wrapper runs a dedicated asyncio event loop in a
background thread and schedules coroutines via run_coroutine_threadsafe.
This avoids conflicts in environments with a running loop (e.g. marimo/Jupyter).
"""

import inspect
import re
from pathlib import Path
from typing import ForwardRef, get_args, get_origin, get_type_hints, Union
from ethereal.async_rest_client import AsyncRESTClient

SKIP_IMPORT_NAMES = {
    "Any",
    "Dict",
    "List",
    "Optional",
    "Tuple",
    "Union",
    "UUID",
    "Decimal",
}


def format_type_hint(type_obj) -> str:
    """Format a type hint for the generated code."""
    if type_obj is None or type_obj is type(None):
        return "None"

    # Handle None type
    if type_obj is type(None):
        return "None"

    # Basic types
    if type_obj in (int, str, bool, float):
        return type_obj.__name__

    # Handle forward references and string annotations early
    if isinstance(type_obj, ForwardRef):
        return type_obj.__forward_arg__
    if isinstance(type_obj, str):
        return _clean_type_string(type_obj)

    # Handle typing module types
    if hasattr(type_obj, "__module__"):
        if type_obj.__module__ == "typing":
            origin = get_origin(type_obj)
            args = get_args(type_obj)

            if origin is None:
                # Handle typing objects without origin (e.g., Any)
                return str(type_obj).replace("typing.", "")
            elif origin is list:
                if args:
                    return f"List[{format_type_hint(args[0])}]"
                return "List"
            elif origin is dict:
                if len(args) == 2:
                    return f"Dict[{format_type_hint(args[0])}, {format_type_hint(args[1])}]"
                return "Dict"
            elif origin is tuple:
                if args:
                    formatted_args = ", ".join(format_type_hint(arg) for arg in args)
                    return f"Tuple[{formatted_args}]"
                return "Tuple"
            elif origin is Union:
                formatted_args = ", ".join(format_type_hint(arg) for arg in args)
                return f"Union[{formatted_args}]"
            else:
                # Generic typing construct
                return str(type_obj).replace("typing.", "")

        # Handle model types
        elif "ethereal.models" in type_obj.__module__:
            return type_obj.__name__

        # Handle other module types
        elif type_obj.__module__ not in ("builtins", "__main__"):
            return type_obj.__name__

    # Handle class types
    if hasattr(type_obj, "__name__"):
        return type_obj.__name__

    # Fallback to string representation
    type_str = _clean_type_string(str(type_obj))
    return type_str


def _clean_type_string(type_str: str) -> str:
    """Normalize a type string by stripping module prefixes and ForwardRefs."""
    # Clean up common patterns
    type_str = re.sub(r"<class '([^']+)'>", r"\1", type_str)
    type_str = type_str.replace("typing.", "")
    type_str = type_str.replace("ethereal.models.rest.", "")
    type_str = type_str.replace("NoneType", "None")
    type_str = re.sub(r"""ForwardRef\((?:'|")([^'"]+)(?:'|")\)""", r"\1", type_str)
    return type_str.replace("'", "").replace('"', "")


def get_method_signature(method):
    """Get the signature and call arguments for a method."""
    try:
        sig = inspect.signature(method)
        # Try to get type hints, fall back to raw annotations if forward references fail
        module = inspect.getmodule(method)
        globalns = vars(module) if module else {}
        try:
            type_hints = get_type_hints(method, globalns=globalns, localns=globalns)
        except (NameError, AttributeError, TypeError):
            type_hints = getattr(method, "__annotations__", {})
    except (TypeError, ValueError) as e:
        print(
            f"Warning: Could not introspect {getattr(method, '__name__', 'unknown')}: {e}"
        )
        return "(self, *args, **kwargs)", "*args, **kwargs", "Any"

    params = []
    call_args = []

    for param_name, param in sig.parameters.items():
        if param_name == "self":
            params.append(param_name)
            continue

        # Get type hint
        type_hint = type_hints.get(param_name, param.annotation)
        if type_hint is inspect.Parameter.empty:
            type_hint = "Any"
        formatted_type = format_type_hint(type_hint)

        # Clean up type hint formatting for known issues
        if "pydantic.main.BaseModel" in formatted_type:
            formatted_type = formatted_type.replace(
                "pydantic.main.BaseModel", "BaseModel"
            )

        # Build parameter string
        if param.kind == inspect.Parameter.VAR_POSITIONAL:
            params.append(f"*{param_name}")
            call_args.append(f"*{param_name}")
        elif param.kind == inspect.Parameter.VAR_KEYWORD:
            params.append(f"**{param_name}")
            call_args.append(f"**{param_name}")
        else:
            if param.default is inspect.Parameter.empty:
                param_str = f"{param_name}: {formatted_type}"
            else:
                default_val = repr(param.default)
                # Handle special cases for default values
                if default_val.startswith("<") and default_val.endswith(">"):
                    default_val = "..."
                param_str = f"{param_name}: {formatted_type} = {default_val}"
            params.append(param_str)
            call_args.append(param_name)

    # Get return type
    return_annotation = sig.return_annotation
    if return_annotation is inspect.Signature.empty:
        return_type = type_hints.get("return", "Any")
    else:
        return_type = return_annotation
    return_type_str = format_type_hint(return_type)

    signature = f"({', '.join(params)}) -> {return_type_str}"
    call_args_str = ", ".join(call_args)

    return signature, call_args_str, return_type_str


def generate_sync_client():
    """Generate a .pyi type stub for the sync REST client.

    - Introspects AsyncRESTClient to collect method signatures and types.
    - Dynamically derives DTO imports used in signatures to avoid drift.
    """

    # Template for the generated stub
    template = """# This file is auto-generated by scripts/generate_sync_client.py
# Type stub for the synchronous REST client.

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple, Type, Union
from pydantic import BaseModel
from decimal import Decimal
from ethereal.models.config import RESTConfig
from ethereal.chain_client import ChainClient
from uuid import UUID
{dto_imports}


class RESTClient:
    def __init__(self, config: Union[Dict[str, Any], RESTConfig] = ...) -> None: ...
    def close(self) -> None: ...
    def __enter__(self) -> RESTClient: ...
    def __exit__(self, exc_type, exc_val, exc_tb) -> None: ...

{methods}

    # Exposed internals
    @property
    def chain(self) -> Optional[ChainClient]: ...
    @property
    def logger(self) -> Any: ...
    @property
    def provider(self) -> Any: ...
    @property
    def private_key(self) -> Optional[str]: ...
    @property
    def _models(self) -> Any: ...
"""

    # Generate methods
    methods = []
    dto_names = set()

    # Get all async methods from AsyncRESTClient
    for method_name, member in inspect.getmembers(AsyncRESTClient):
        # Skip private methods, special methods, and non-coroutine functions
        if (
            method_name.startswith("_")
            or method_name in ["create", "close"]
            or not inspect.iscoroutinefunction(member)
        ):
            continue

        # Generate method wrapper
        sig, call_args, return_type = get_method_signature(member)
        # Collect DTOs referenced in type hints dynamically
        try:
            hints = get_type_hints(member)
        except Exception:
            hints = getattr(member, "__annotations__", {})
        for t in list(hints.values()):
            origin = get_origin(t)
            args = get_args(t) if origin else ()
            to_check = args or (t,)
            for cand in to_check:
                if isinstance(cand, str):
                    for match in re.findall(r"[A-Z][A-Za-z0-9_]+", cand):
                        if match not in SKIP_IMPORT_NAMES:
                            dto_names.add(match)
                    continue

                if isinstance(cand, ForwardRef):
                    forward_name = cand.__forward_arg__
                    if (
                        forward_name
                        and forward_name[0].isupper()
                        and forward_name not in SKIP_IMPORT_NAMES
                    ):
                        dto_names.add(forward_name)
                    continue

                mod = getattr(cand, "__module__", "")
                dto_name = getattr(cand, "__name__", None)
                if (
                    mod.startswith("ethereal.models")
                    and dto_name
                    and dto_name[0].isupper()
                    and dto_name not in SKIP_IMPORT_NAMES
                ):
                    dto_names.add(dto_name)

        method_code = f"""
    def {method_name}{sig}: ..."""
        methods.append(method_code)

    # Add _get_pages method
    methods.append("""
    def _get_pages(
        self,
        endpoint: str,
        request_model: Type[BaseModel],
        response_model: Type[BaseModel],
        paginate: bool = False,
        **kwargs
    ) -> Any:
        ...""")

    # Build dynamic DTO imports block
    if dto_names:
        names_sorted = ",\n    ".join(sorted(dto_names))
        dto_imports = f"from ethereal.models.rest import (\n    {names_sorted},\n)"
    else:
        dto_imports = "# No DTOs referenced"

    # Generate the final code
    generated_code = template.replace("{methods}", "\n".join(methods)).replace(
        "{dto_imports}", dto_imports
    )

    # Determine project root (two levels up from this script file)
    project_root = Path(__file__).resolve().parents[1]
    # Write to stub file
    output_path = project_root / "ethereal" / "rest_client.pyi"
    with open(output_path, "w") as f:
        f.write(generated_code)

    print(f"Successfully generated {output_path}")


if __name__ == "__main__":
    generate_sync_client()
