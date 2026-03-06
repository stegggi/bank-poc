[
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "_owner",
				"type": "address"
			}
		],
		"stateMutability": "nonpayable",
		"type": "constructor"
	},
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": true,
				"internalType": "uint256",
				"name": "bankId",
				"type": "uint256"
			},
			{
				"indexed": false,
				"internalType": "bool",
				"name": "active",
				"type": "bool"
			}
		],
		"name": "BankPaused",
		"type": "event"
	},
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": true,
				"internalType": "uint256",
				"name": "bankId",
				"type": "uint256"
			},
			{
				"indexed": false,
				"internalType": "bool",
				"name": "active",
				"type": "bool"
			},
			{
				"indexed": false,
				"internalType": "bytes32",
				"name": "leiHash",
				"type": "bytes32"
			},
			{
				"indexed": false,
				"internalType": "bytes32",
				"name": "domainHash",
				"type": "bytes32"
			},
			{
				"indexed": false,
				"internalType": "address",
				"name": "operator",
				"type": "address"
			}
		],
		"name": "BankUpserted",
		"type": "event"
	},
	{
		"inputs": [
			{
				"internalType": "uint256",
				"name": "bankId",
				"type": "uint256"
			}
		],
		"name": "bankHpkePubKey",
		"outputs": [
			{
				"internalType": "bytes",
				"name": "",
				"type": "bytes"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "uint256",
				"name": "",
				"type": "uint256"
			}
		],
		"name": "banks",
		"outputs": [
			{
				"internalType": "bool",
				"name": "active",
				"type": "bool"
			},
			{
				"internalType": "bytes32",
				"name": "leiHash",
				"type": "bytes32"
			},
			{
				"internalType": "bytes32",
				"name": "domainHash",
				"type": "bytes32"
			},
			{
				"internalType": "address",
				"name": "operator",
				"type": "address"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "owner",
		"outputs": [
			{
				"internalType": "address",
				"name": "",
				"type": "address"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "uint256",
				"name": "bankId",
				"type": "uint256"
			},
			{
				"internalType": "bool",
				"name": "active",
				"type": "bool"
			}
		],
		"name": "pauseBank",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "uint256",
				"name": "bankId",
				"type": "uint256"
			},
			{
				"internalType": "bool",
				"name": "active",
				"type": "bool"
			},
			{
				"internalType": "bytes32",
				"name": "leiHash",
				"type": "bytes32"
			},
			{
				"internalType": "bytes32",
				"name": "domainHash",
				"type": "bytes32"
			},
			{
				"internalType": "address",
				"name": "operator",
				"type": "address"
			},
			{
				"internalType": "bytes",
				"name": "hpkePubKey",
				"type": "bytes"
			}
		],
		"name": "setBank",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	}
]