#!/usr/bin/env python3
"""
Monitor test account for CI testing.
"""

import os
import sys
from dotenv import load_dotenv
from ethereal import RESTClient
from ethereal.rest.util import decode_account_name

REQUIRED_USDE_BALANCE = 1
REQUIRED_ACCOUNT_BALANCE = 500


def check_test_account():
    """Check for 'test' subaccount and its balance."""

    load_dotenv()

    required_vars = ["RPC_URL", "PRIVATE_KEY", "BASE_URL"]
    missing_vars = [var for var in required_vars if not os.getenv(var)]

    if missing_vars:
        print(f"Missing environment variables: {', '.join(missing_vars)}")
        return False

    try:
        config = {
            "base_url": os.getenv("BASE_URL"),
            "chain_config": {
                "rpc_url": os.getenv("RPC_URL"),
                "private_key": os.getenv("PRIVATE_KEY"),
            },
        }

        rc = RESTClient(config)

        if rc.chain is None:
            print("Failed to connect to chain")
            return False

        chain = rc.chain
        assert chain is not None

        print(f"Connected to address: {chain.address}")
        print(f"Chain ID: {chain.chain_id}")

        # Find test subaccount
        test_account = None
        print("Available subaccounts:")
        for sub in rc.subaccounts:
            decoded_name = decode_account_name(sub.name)
            print(f"  {decoded_name} (ID: {sub.id})")
            if decoded_name == "test":
                test_account = sub

        if test_account is None:
            print("Test subaccount not found")
            return False

        print(f"Found test subaccount: {test_account.id}")

        # Check USDe balance
        usde_balance = chain.get_balance(chain.address)
        usde_balance /= 1e18
        print(f"USDe balance: {usde_balance:.6f} USDe")

        if usde_balance < REQUIRED_USDE_BALANCE:
            print(
                f"Balance too low: {usde_balance:.6f} USDe (minimum: {REQUIRED_USDE_BALANCE} USDe)"
            )
            return False

        # Check the subaccount balance
        subaccount_balances = rc.get_subaccount_balances(
            subaccount_id=test_account.id,
        )
        usd_balance = next(
            (b for b in subaccount_balances if b.token_name == "USD"), None
        )
        if not usd_balance:
            print("No USD balance found in test subaccount")
            return False

        print(
            f"Current USDe balance for test subaccount: {usd_balance.amount:.6f} USDe"
        )
        if usd_balance.amount < REQUIRED_ACCOUNT_BALANCE:
            amount_needed = REQUIRED_ACCOUNT_BALANCE - usd_balance.amount
            print(
                f"Need to fund test subaccount with at least {amount_needed:.6f} more USDe"
            )
            return False

        print("Test account ready")
        return True

    except Exception as e:
        print(f"Error: {e}")
        return False


def main():
    """Main function."""

    success = check_test_account()

    if success:
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
