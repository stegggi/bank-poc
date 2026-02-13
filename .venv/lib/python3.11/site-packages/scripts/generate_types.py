import os
import sys
import json
import copy
import argparse
import requests
import subprocess
from pathlib import Path
from typing import Any, Dict, List

# Network configuration mapping
NETWORK_CONFIGS = {
    "mainnet": {
        "openapi_urls": {
            "primary": "https://api.ethereal.trade/openapi.json",
            "archive": "https://archive.ethereal.trade/openapi.json",
        },
        "output_dir": "ethereal/models/testnet",
        "output_file": "rest.py",
    },
    "testnet": {
        "openapi_urls": {
            "primary": "https://api.etherealtest.net/openapi.json",
            "archive": "https://archive.etherealtest.net/openapi.json",
        },
        "output_dir": "ethereal/models/testnet",
        "output_file": "rest.py",
    },
    "devnet": {
        "openapi_urls": {
            "primary": "https://api.etherealdev.net/openapi.json",
            "archive": "https://archive.etherealdev.net/openapi.json",
        },
        "output_dir": "ethereal/models/devnet",
        "output_file": "rest.py",
    },
}


def parse_args():
    parser = argparse.ArgumentParser(
        description="Generate Pydantic types from OpenAPI spec"
    )
    parser.add_argument(
        "--network",
        type=str,
        choices=list(NETWORK_CONFIGS.keys()),
        default="testnet",
        help="Network to generate types for (default: testnet)",
    )
    parser.add_argument(
        "--url", type=str, help="Custom OpenAPI spec URL (overrides network default)"
    )
    return parser.parse_args()


def get_config(args) -> Dict[str, Any]:
    """Get configuration based on arguments"""
    config = copy.deepcopy(NETWORK_CONFIGS[args.network])

    if args.url:
        config["openapi_urls"] = {"custom": args.url}

    # Generate network-specific file names
    config["output_dir"] = f"ethereal/models/{args.network}"
    config["output_file"] = "rest.py"

    return config


def _merge_dict(target: Dict[str, Any], source: Dict[str, Any], context: str) -> None:
    """Merge source dict into target dict, raising if duplicate keys differ."""
    for key, value in source.items():
        if key in target:
            if target[key] != value:
                raise ValueError(f"Conflict merging OpenAPI specs at {context}.{key}")
        else:
            target[key] = copy.deepcopy(value)


def merge_openapi_specs(specs: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Combine multiple OpenAPI specs into a single spec."""
    if not specs:
        raise ValueError("No OpenAPI specs provided for merging")

    merged = copy.deepcopy(specs[0])

    for spec in specs[1:]:
        if "paths" in spec:
            merged.setdefault("paths", {})
            _merge_dict(merged["paths"], spec["paths"], "paths")

        if "components" in spec:
            merged.setdefault("components", {})
            for section_name, section_value in spec["components"].items():
                merged["components"].setdefault(section_name, {})
                if not isinstance(section_value, dict):
                    merged["components"][section_name] = copy.deepcopy(section_value)
                else:
                    _merge_dict(
                        merged["components"][section_name],
                        section_value,
                        f"components.{section_name}",
                    )

        if "tags" in spec:
            merged.setdefault("tags", [])
            existing_named_tags = {
                tag.get("name")
                for tag in merged["tags"]
                if isinstance(tag, dict) and "name" in tag
            }
            for tag in spec["tags"]:
                if isinstance(tag, dict) and "name" in tag:
                    if tag["name"] not in existing_named_tags:
                        merged["tags"].append(copy.deepcopy(tag))
                        existing_named_tags.add(tag["name"])
                elif tag not in merged["tags"]:
                    merged["tags"].append(copy.deepcopy(tag))

    return merged


def fetch_openapi_spec(url: str) -> Dict[str, Any]:
    """Fetch and parse an OpenAPI spec from the provided URL."""
    response = requests.get(url)
    response.raise_for_status()

    try:
        return response.json()
    except ValueError as exc:
        raise ValueError(f"Invalid JSON received from {url}") from exc


def prepare_spec(spec: Dict[str, Any], alias: str) -> Dict[str, Any]:
    """Apply alias-specific transformations before merging."""
    prepared = copy.deepcopy(spec)

    if alias != "primary" and "paths" in prepared:
        transformed_paths: Dict[str, Any] = {}
        for path_key, path_value in prepared["paths"].items():
            new_key = (
                f"/{alias}{path_key}"
                if not path_key.startswith(f"/{alias}")
                else path_key
            )
            if (
                new_key in transformed_paths
                and transformed_paths[new_key] != path_value
            ):
                raise ValueError(
                    f"Conflict transforming paths for alias '{alias}' at '{new_key}'"
                )
            transformed_paths[new_key] = path_value
        prepared["paths"] = transformed_paths

    return prepared


def generate_types(network: str, config: Dict[str, Any]):
    """Generate types for a specific network by combining all configured specs."""
    print(f"Generating types for {network}...")

    urls = config.get("openapi_urls")
    if not urls:
        print("No OpenAPI URLs configured; nothing to generate.")
        sys.exit(1)

    specs: List[Dict[str, Any]] = []
    for alias, url in urls.items():
        print(f"Fetching {alias} OpenAPI spec from: {url}")
        try:
            spec = fetch_openapi_spec(url)
        except Exception as exc:
            print(f"Error fetching OpenAPI spec ({alias}): {exc}")
            sys.exit(1)
        try:
            prepared = prepare_spec(spec, alias)
        except ValueError as exc:
            print(f"Error preparing OpenAPI spec ({alias}): {exc}")
            sys.exit(1)
        specs.append(prepared)

    try:
        combined_spec = merge_openapi_specs(specs)
    except ValueError as exc:
        print(f"Error merging OpenAPI specs: {exc}")
        sys.exit(1)

    # Create output directory if it doesn't exist
    output_dir = Path(config["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)

    # Write the combined spec to a temporary file
    temp_spec_file = f"openapi_{network}.json"
    with open(temp_spec_file, "w") as f:
        json.dump(combined_spec, f)

    # Construct output path
    output_path = output_dir / config["output_file"]

    # Run datamodel-codegen
    result = subprocess.run(
        [
            "uv",
            "run",
            "datamodel-codegen",
            "--input",
            temp_spec_file,
            "--output",
            str(output_path),
            "--input-file-type",
            "openapi",
            "--openapi-scopes",
            "paths",
            "schemas",
            "parameters",
            "--output-model-type",
            "pydantic_v2.BaseModel",
            "--snake-case-field",
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        print(f"Error generating types: {result.stderr}")
        os.remove(temp_spec_file)
        sys.exit(1)
    else:
        print(f"Generated types successfully at: {output_path}")

    # Post-process the generated file
    with open(output_path, "r") as f:
        content = f.read()

    # Replace all instances of '0', or "0", with Decimal("0"),
    content = content.replace("'0',", 'Decimal("0"),')
    content = content.replace('"0",', 'Decimal("0"),')

    with open(output_path, "w") as f:
        f.write(content)

    # Remove the temporary openapi.json file
    os.remove(temp_spec_file)


def main():
    args = parse_args()
    config = get_config(args)
    generate_types(args.network, config)


if __name__ == "__main__":
    main()
