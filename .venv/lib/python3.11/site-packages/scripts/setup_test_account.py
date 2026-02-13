#!/usr/bin/env python3
"""
Set up test account for CI testing.
"""

import os
import sys
from dotenv import load_dotenv
from ethereal import RESTClient
from ethereal.rest.util import decode_account_name

REQUIRED_AMOUNT = 500
DEPOSIT_AMOUNT = 750


def setup_test_account():
    """Set up test subaccount and deposit funds."""

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

        # Check if test subaccount already exists
        test_account = None
        print("Available subaccounts:")
        for sub in rc.subaccounts:
            decoded_name = decode_account_name(sub.name)
            print(f"  {decoded_name} (ID: {sub.id})")
            if decoded_name == "test":
                test_account = sub

        # Check current ETH balance
        usde_balance = chain.get_balance(chain.address) / 1e18
        print(f"Current USDe balance in wallet: {usde_balance:.6f} USDe")

        if usde_balance < 100:
            print(
                f"Need to fund account with at least {100 - usde_balance:.6f} more USDe"
            )
            print(f"Send USDe to: {chain.address}")
            return False

        if not test_account:
            print("Test subaccount not found - one will be created")
            amount_needed = DEPOSIT_AMOUNT
        else:
            print(f"Test subaccount already exists: {test_account.id}")

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
            if usd_balance.amount < REQUIRED_AMOUNT:
                amount_needed = DEPOSIT_AMOUNT - usd_balance.amount
                print(
                    f"Need to fund test subaccount with at least {amount_needed:.6f} more USDe"
                )
            else:
                print("Test subaccount has sufficient USDe balance")
                return True

        # Try to deposit some USDe to ensure the account is ready for trading
        try:
            print("Attempting test USDe deposit...")

            # Create deposit transaction (don't submit yet)
            deposit_tx = chain.deposit_usde(amount_needed, account_name="test")
            print(f"Deposit transaction prepared for {amount_needed} USDe")

            # Submit the transaction
            print("Submitting deposit transaction...")
            tx_hash = chain.submit_tx(deposit_tx)
            print(f"Deposit submitted: {tx_hash}")

        except Exception as e:
            print(f"USDe deposit failed: {e}")
            return False

        print("Test account setup complete")
        return True

    except Exception as e:
        print(f"Error: {e}")
        return False


def main():
    """Main function."""

    success = setup_test_account()

    if success:
        print("\nSetup successful - run check script to verify")
        sys.exit(0)
    else:
        print("\nSetup failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
