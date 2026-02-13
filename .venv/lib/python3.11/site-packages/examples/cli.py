import argparse
import os
from dotenv import load_dotenv
import ethereal

# Default RPC URLs for each network
DEFAULT_RPC_URLS = {
    "mainnet": "https://rpc.ethereal.trade",
    "testnet": "https://rpc.etherealtest.net",
    "devnet": "https://rpc.etherealdev.net",
}


def main():
    parser = argparse.ArgumentParser(description="Ethereal SDK CLI Example")
    parser.add_argument(
        "--network",
        choices=["mainnet", "testnet", "devnet"],
        default="testnet",
        help="Network to connect to (default: testnet)",
    )
    args = parser.parse_args()

    # Load environment variables
    # Optionally set PRIVATE_KEY for signing transactions
    # Optionally set RPC_URL to override the default RPC URL
    load_dotenv(override=True)

    # Use default RPC URL for the network, or override from environment
    rpc_url = os.getenv("RPC_URL") or DEFAULT_RPC_URLS[args.network]

    print(f"Connecting to {args.network} (RPC: {rpc_url})")

    # Initialize the client - network parameter automatically sets the base_url
    client = ethereal.RESTClient(
        {
            "network": args.network,
            "chain_config": {
                "private_key": os.getenv("PRIVATE_KEY"),
                "rpc_url": rpc_url,
            },
        }
    )

    print(f"Client ready! Use 'client' to interact with {args.network}")
    return client


if __name__ == "__main__":
    client = main()
