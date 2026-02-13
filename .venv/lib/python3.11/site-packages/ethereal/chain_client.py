import os
import json

from typing import Optional, Dict, Any, Union, List
from pydantic import BaseModel
from ethereal.base_client import BaseClient
from ethereal.models.config import ChainConfig
from ethereal.models.rest import RpcConfigDto, TokenDto
from ethereal.rest.util import encode_account_name, ensure_bytes32_hex
from web3 import Web3
from web3.exceptions import Web3Exception, ContractCustomError
from web3.types import TxParams, Nonce
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import encode_hex
from eth_utils.abi import function_abi_to_4byte_selector


def read_contract(
    chain_id: int, contract_name: str, common: bool = False
) -> Dict[str, Any]:
    if common:
        contract_dir = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "contracts",
            "common",
            f"{contract_name}.json",
        )
    else:
        contract_dir = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "contracts",
            f"{chain_id}",
            f"{contract_name}.json",
        )
    with open(contract_dir) as f:
        return json.load(f)


class ChainClient(BaseClient):
    """Client for interacting with the blockchain using Web3 functionality.

    Args:
        config (Union[Dict[str, Any], ChainConfig]): Chain configuration
        rpc_config (RpcConfigDto, optional): RPC configuration. Defaults to None.

    Raises:
        Exception: If RPC URL or private key is not specified in the configuration
    """

    def __init__(
        self,
        config: Union[Dict[str, Any], ChainConfig],
        rpc_config: Optional[RpcConfigDto] = None,
        tokens: Optional[List[TokenDto]] = None,
    ):
        super().__init__(config)
        self.config = ChainConfig.model_validate(config)
        self.provider = self._setup_provider()
        self.account = self._setup_account()
        if self.account:
            self.address = self.account.address
            self.private_key = self.config.private_key
        else:
            self.address = self.config.address
            self.private_key = None

        self.chain_id = self.provider.eth.chain_id

        if tokens is not None:
            usde_token = next((t for t in tokens if t.name == "USD"), None)
            if usde_token is None:
                self.logger.warning("USD token not found in the provided tokens list.")
            else:
                usde_address = self.provider.to_checksum_address(usde_token.address)
                usde_abi = (
                    read_contract(self.chain_id, "WUSDe", common=True)
                    if usde_token.erc20_name and "Wrapped" in usde_token.erc20_name
                    else read_contract(self.chain_id, "ERC20", common=True)
                )

                self.usde = self.provider.eth.contract(
                    address=usde_address,
                    abi=usde_abi,
                )
        self.rpc_config = rpc_config

    @property
    def exchange_contract(self):
        return self.provider.eth.contract(
            address=self.rpc_config.domain.verifying_contract,
            abi=read_contract(self.chain_id, "ExchangeGateway"),
        )

    def _setup_provider(self):
        """Set up the Web3 provider.

        Returns:
            Web3: The Web3 provider instance

        Raises:
            Exception: If RPC URL is not specified in the configuration
        """
        # TODO: Support other provider types (e.g. WebSocket)
        if self.config.rpc_url is None:
            raise Exception("RPC URL must be specified in the configuration")
        return Web3(Web3.HTTPProvider(self.config.rpc_url))

    def _setup_account(self):
        """Set up the account.

        Returns:
            Account: The Web3 account instance

        Raises:
            Exception: If private key is not specified in the configuration
        """
        if self.config.private_key is None:
            self.logger.debug("Private key not specified in the configuration")
            return None

        account = self.provider.eth.account.from_key(self.config.private_key)
        if not account:
            raise Exception("Failed to create account from private key")
        if self.config.address and account.address != self.config.address:
            raise Exception(
                f"Private key does not match address specified in the config: {self.config.address}"
            )
        return account

    def _get_tx(self, value=0, to=None) -> TxParams:
        """Get default transaction parameters.

        Args:
            value (int, optional): The value to send. Defaults to 0.
            to (str, optional): The recipient address. Defaults to None.

        Returns:
            TxParams: The transaction parameters
        """
        params: TxParams = {
            "from": self.address,
            "chainId": self.chain_id,
            "value": value,
            "nonce": Nonce(self.get_nonce(self.address)),
        }
        if to is not None:
            params["to"] = to
        return params

    def _decode_error(self, error: ContractCustomError) -> str:
        abi_errors = {
            self.provider.to_hex(function_abi_to_4byte_selector(f)): f.get("name")
            for f in self.exchange_contract.abi
            if f.get("type") == "error"
        }
        data = error.data
        error_signature = data
        return abi_errors.get(error_signature, "Unknown error")

    def _get_by_alias(self, model: BaseModel, alias: str):
        """
        Get a field value by its alias from a Pydantic model.

        Args:
            model (BaseModel): The Pydantic model instance to extract the field from.
            alias (str): The alias of the field to retrieve.

        Returns:
            Any: The value of the field with the specified alias.

        Raises:
            KeyError: If the alias is not found in the model.
        """
        for field_name, field in model.__class__.model_fields.items():
            if field.alias == alias:
                return getattr(model, field_name)
        raise KeyError(f"Alias '{alias}' not found in model {model.__class__.__name__}")

    def get_signature_types(self, rpc_config: RpcConfigDto, primary_type: str):
        """Gets EIP-712 signature types.

        Args:
            rpc_config (RpcConfigDto): RPC configuration.
            primary_type (str): Primary type for the signature.

        Returns:
            dict: Dictionary containing signature type definitions.
        """
        return {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            primary_type: self.convert_types(
                self._get_by_alias(rpc_config.signature_types, primary_type),
            ),
        }

    def convert_types(self, type_string: str) -> List[Dict[str, str]]:
        """Converts type string into EIP-712 field format.

        Args:
            type_string (str): String containing type definitions.

        Returns:
            List[Dict[str, str]]: List of field definitions.
        """
        fields = [comp.strip() for comp in type_string.split(",")]
        type_fields = []
        for field in fields:
            field_type, field_name = field.rsplit(" ", 1)
            type_fields.append({"name": field_name, "type": field_type})
        return type_fields

    def add_gas_fees(self, tx: TxParams) -> TxParams:
        """Add gas fee parameters to a transaction.

        Args:
            tx (TxParams): The transaction parameters

        Returns:
            TxParams: The transaction parameters with gas fee parameters added
        """
        if "maxFeePerGas" in tx and "maxPriorityFeePerGas" in tx:
            return tx
        try:
            gas_price = self.provider.eth.gas_price
            max_priority_fee = self.provider.eth.max_priority_fee
            tx["maxFeePerGas"] = gas_price
            tx["maxPriorityFeePerGas"] = max_priority_fee
            return tx
        except Web3Exception as e:
            self.logger.error(f"Failed to add gas: {e}")
            return tx

    def add_gas_limit(self, tx: TxParams) -> TxParams:
        """Add gas limit to a transaction.

        Args:
            tx (TxParams): The transaction parameters

        Returns:
            TxParams: The transaction parameters with gas limit added
        """
        if "gas" in tx:
            return tx
        try:
            gas = self.provider.eth.estimate_gas(tx)
            tx["gas"] = gas
            return tx
        except Web3Exception as e:
            self.logger.error(
                f"Failed to add gas limit: {self._decode_error(e) if isinstance(e, ContractCustomError) else e}"
            )
            raise e

    def submit_tx(self, tx: TxParams) -> str:
        """Submit a transaction.

        Args:
            tx (TxParams): The transaction parameters

        Returns:
            str: The transaction hash
        """
        tx = self.add_gas_fees(tx)
        tx = self.add_gas_limit(tx)
        try:
            signed_tx = self.provider.eth.account.sign_transaction(
                tx, private_key=self.private_key
            )
            tx_hash = self.provider.eth.send_raw_transaction(signed_tx.raw_transaction)
            return encode_hex(tx_hash)
        except Web3Exception as e:
            self.logger.error(f"Failed to submit transaction: {e}")
            raise e

    def get_nonce(self, address: str) -> int:
        """Get the nonce for a given address.

        Args:
            address (str): The address to get the nonce for

        Returns:
            int: The nonce, or -1 if failed
        """
        try:
            return self.provider.eth.get_transaction_count(address)
        except Web3Exception as e:
            self.logger.error(f"Failed to get nonce: {e}")
            return -1

    def get_balance(self, address: str) -> int:
        """Get the balance for a given address.

        Args:
            address (str): The address to get the balance for

        Returns:
            int: The balance, or -1 if failed
        """
        try:
            return self.provider.eth.get_balance(address)
        except Web3Exception as e:
            self.logger.error(f"Failed to get balance: {e}")
            return -1

    def get_token_balance(self, address: str, token_address: str) -> int:
        """Get the token balance for a given address.

        Args:
            address (str): The address to get the token balance for
            token_address (str): The token address

        Returns:
            int: The token balance, or -1 if failed
        """
        try:
            contract = self.provider.eth.contract(
                address=token_address,
                abi=read_contract(self.chain_id, "ERC20", common=True),
            )
            return contract.functions.balanceOf(address).call()
        except Web3Exception as e:
            self.logger.error(f"Failed to get token balance: {e}")
            return -1

    def sign_message(
        self,
        private_key: str,
        domain: dict,
        types: dict,
        primary_type: str,
        message: dict,
    ):
        """Sign an EIP-712 typed data message.

        Args:
            private_key (str): private key to sign the message with
            domain (dict): domain parameters including name, version, chainId, and verifyingContract
            types (dict): type definitions for the structured data
            primary_type (str): primary type for the signature
            message (dict): message data to be signed

        Returns:
            str: the hexadecimal signature string prefixed with '0x'
        """
        # A type fix for the domain
        domain["chainId"] = int(domain["chainId"])

        # Preparing the full message as per EIP-712
        full_message = {
            "types": types,
            "primaryType": primary_type,
            "domain": domain,
            "message": message,
        }

        encoded_message = encode_typed_data(full_message=full_message)

        # Signing the message
        signed_message = Account.sign_message(encoded_message, private_key)
        return "0x" + signed_message.signature.hex()

    def deposit_usde(
        self,
        amount: float,
        account_name: str = "primary",
        address: Optional[str] = None,
        submit: bool = False,
        account_name_bytes: Optional[str] = None,
    ) -> Union[TxParams, str]:
        """Submit a deposit transaction.

        Args:
            amount (float): The amount to deposit
            address (str, optional): The address to deposit to. Defaults to None.
            submit (bool, optional): Whether to submit the transaction. Defaults to False.
            account_name (str, optional): The account name. Defaults to "primary".
            account_name_bytes (str, optional): The account name as a hex string (bytes32). Defaults to None.

        Returns:
            Union[TxParams, str]: The transaction parameters or transaction hash if submit=True

        Raises:
            ValueError: If both account_name and account_name_bytes are provided
        """
        if address is None:
            address = self.address

        if account_name is None and account_name_bytes is None:
            account_name = "primary"

        # Validate inputs
        if account_name is not None and account_name_bytes is not None:
            raise ValueError("Cannot provide both account_name and account_name_bytes")

        try:
            # params
            if account_name_bytes is not None:
                subaccount = ensure_bytes32_hex(account_name_bytes)
            else:
                subaccount = self.provider.to_hex(text=account_name).ljust(66, "0")
            amount = self.provider.to_wei(amount, "ether")
            referral_code = self.provider.to_hex(0).ljust(66, "0")

            # prepare the tx
            tx = self._get_tx(to=self.exchange_contract.address, value=amount)
            tx["data"] = self.exchange_contract.encode_abi(
                "depositUsd", args=[subaccount, referral_code]
            )

            if submit:
                return self.submit_tx(tx)
            else:
                return tx

        except Web3Exception as e:
            self.logger.error(
                f"Failed to prepare deposit transaction: {self._decode_error(e) if isinstance(e, ContractCustomError) else e}"
            )
            raise e

    def finalize_withdraw(
        self,
        account_name: str = "primary",
        address: Optional[str] = None,
        submit: Optional[bool] = False,
    ) -> Union[TxParams, str]:
        """Finalize a withdrawal.

        Args:
            address (str, optional): The address to deposit to. Defaults to None.
            submit (bool, optional): Whether to submit the transaction. Defaults to False.
            account_name (str, optional): The name of the account. Defaults to "primary".

        Returns:
            Union[TxParams, str]: The transaction parameters or transaction hash if submit=True
        """
        if address is None:
            address = self.address
        try:
            # params
            subaccount = encode_account_name(account_name)

            # prepare the tx
            tx = self._get_tx(to=self.exchange_contract.address)
            tx["data"] = self.exchange_contract.encode_abi(
                "finalizeWithdraw", args=[address, subaccount]
            )

            if submit:
                return self.submit_tx(tx)
            else:
                return tx

        except Web3Exception as e:
            self.logger.error(
                f"Failed to prepare finalizeWithdraw transaction: {self._decode_error(e) if isinstance(e, ContractCustomError) else e}"
            )
            raise e
