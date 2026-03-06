// lib/contracts.ts
import type { Abi } from 'viem';

export const CHAIN_ID = 421614; // Arbitrum Sepolia

// ENV addresses
export const DIRECTORY_ADDR = (process.env.NEXT_PUBLIC_DIRECTORY_ADDRESS || '').trim() as `0x${string}`;
export const PAYMENT_HUB_ADDR = (process.env.NEXT_PUBLIC_PAYMENT_HUB_ADDRESS || '').trim() as `0x${string}`;
export const XBANK_ADDR       = (process.env.NEXT_PUBLIC_XBANK_ADDRESS || '').trim() as `0x${string}`;

export const BANK_A_ID = Number(process.env.NEXT_PUBLIC_BANK_A_ID || '1');
export const BANK_B_ID = Number(process.env.NEXT_PUBLIC_BANK_B_ID || '2');

// Minimal Directory ABI (your Remix ABI shows these)
export const DIRECTORY_ABI: Abi = [
  {
    type: 'function',
    name: 'banks',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [
      { name: 'active', type: 'bool' },
      { name: 'leiHash', type: 'bytes32' },
      { name: 'domainHash', type: 'bytes32' },
      { name: 'operator', type: 'address' },
    ]
  },
  {
    // You shared this in a previous ABI
    type: 'function',
    name: 'bankHpkePubKey',
    stateMutability: 'view',
    inputs: [{ name: 'bankId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes' }]
  }
];

// PaymentHub minimal ABI (matches your Remix "submitPayment" screen)
export const PAYMENT_HUB_ABI: Abi = [
  {
    type: 'function',
    name: 'submitPayment',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'toBankId',  type: 'uint256' },
      { name: 'asset',     type: 'address' },
      { name: 'amount',    type: 'uint256' },
      { name: 'requireAck',type: 'bool'    },
      { name: 'payload',   type: 'bytes'   },
      { name: 'purpose',   type: 'string'  },
      { name: 'txRef',     type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'address' }] // your Remix showed a single address return
  },

  // If your hub emits these, we'll decode. If names differ, UI still works.
  {
    type: 'event',
    name: 'PaymentRequested',
    inputs: [
      { name: 'txRef',    type: 'bytes32', indexed: true },
      { name: 'toBankId', type: 'uint256', indexed: true },
      { name: 'payer',    type: 'address', indexed: true },
      { name: 'payload',  type: 'bytes',   indexed: false },
      { name: 'asset',    type: 'address', indexed: false },
      { name: 'amount',   type: 'uint256', indexed: false },
      { name: 'requireAck', type: 'bool',  indexed: false },
    ]
  },
  {
    type: 'event',
    name: 'PaymentAcknowledged',
    inputs: [
      { name: 'txRef', type: 'bytes32', indexed: true },
      { name: 'by',    type: 'address', indexed: true },
    ]
  },
  {
    type: 'function',
    name: 'acknowledge',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'txRef', type: 'bytes32' }],
    outputs: []
  }
];

export const ERC20_MIN_ABI: Abi = [
  { type:'function', name:'balanceOf', stateMutability:'view', inputs:[{name:'owner',type:'address'}], outputs:[{name:'',type:'uint256'}]},
  { type:'function', name:'decimals',  stateMutability:'view', inputs:[], outputs:[{name:'',type:'uint8'}]},
  { type:'function', name:'symbol',    stateMutability:'view', inputs:[], outputs:[{name:'',type:'string'}]},
  { type:'function', name:'transfer',  stateMutability:'nonpayable', inputs:[{name:'to',type:'address'},{name:'value',type:'uint256'}], outputs:[{name:'',type:'bool'}]},
];
