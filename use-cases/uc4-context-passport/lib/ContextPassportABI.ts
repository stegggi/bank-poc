const CONTEXT_PASSPORT_ABI = [
  { type: "error", name: "ModuleAlreadyExists", inputs: [] },
  { type: "error", name: "ModuleInactive",      inputs: [] },
  { type: "error", name: "ModuleNotFound",      inputs: [] },
  { type: "error", name: "NotOperator",         inputs: [] },
  { type: "error", name: "NotOwner",            inputs: [] },

  {
    type: "event", name: "ModuleRegistered", anonymous: false,
    inputs: [
      { indexed: true,  name: "moduleId",    type: "bytes32" },
      { indexed: true,  name: "owner",       type: "address" },
      { indexed: false, name: "contentHash", type: "bytes32" },
      { indexed: false, name: "policyHash",  type: "bytes32" },
      { indexed: false, name: "label",       type: "string"  },
      { indexed: false, name: "uri",         type: "string"  },
    ],
  },
  {
    type: "event", name: "ModuleUpdated", anonymous: false,
    inputs: [
      { indexed: true,  name: "moduleId",    type: "bytes32" },
      { indexed: false, name: "contentHash", type: "bytes32" },
      { indexed: false, name: "policyHash",  type: "bytes32" },
      { indexed: false, name: "uri",         type: "string"  },
    ],
  },
  {
    type: "event", name: "ModuleDeactivated", anonymous: false,
    inputs: [{ indexed: true, name: "moduleId", type: "bytes32" }],
  },
  {
    type: "event", name: "AccessRequested", anonymous: false,
    inputs: [
      { indexed: true,  name: "moduleId",    type: "bytes32" },
      { indexed: true,  name: "requester",   type: "address" },
      { indexed: false, name: "purposeHash", type: "bytes32" },
    ],
  },
  {
    type: "event", name: "AccessGranted", anonymous: false,
    inputs: [
      { indexed: true,  name: "moduleId",           type: "bytes32" },
      { indexed: true,  name: "grantee",            type: "address" },
      { indexed: false, name: "expiry",             type: "uint64"  },
      { indexed: false, name: "encryptedKeyCommit", type: "bytes32" },
    ],
  },
  {
    type: "event", name: "AccessRevoked", anonymous: false,
    inputs: [
      { indexed: true, name: "moduleId", type: "bytes32" },
      { indexed: true, name: "grantee",  type: "address" },
    ],
  },
  {
    type: "event", name: "OperatorChanged", anonymous: false,
    inputs: [
      { indexed: true, name: "oldOperator", type: "address" },
      { indexed: true, name: "newOperator", type: "address" },
    ],
  },

  { type: "function", name: "claimOperatorRole", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function", name: "registerModule", stateMutability: "nonpayable",
    inputs: [
      { name: "moduleId",    type: "bytes32" },
      { name: "contentHash", type: "bytes32" },
      { name: "policyHash",  type: "bytes32" },
      { name: "label",       type: "string"  },
      { name: "uri",         type: "string"  },
    ],
    outputs: [],
  },
  {
    type: "function", name: "updateModule", stateMutability: "nonpayable",
    inputs: [
      { name: "moduleId",       type: "bytes32" },
      { name: "newContentHash", type: "bytes32" },
      { name: "newPolicyHash",  type: "bytes32" },
      { name: "newUri",         type: "string"  },
    ],
    outputs: [],
  },
  {
    type: "function", name: "deactivateModule", stateMutability: "nonpayable",
    inputs: [{ name: "moduleId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function", name: "requestAccess", stateMutability: "nonpayable",
    inputs: [
      { name: "moduleId",    type: "bytes32" },
      { name: "purposeHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function", name: "operatorRequestAccess", stateMutability: "nonpayable",
    inputs: [
      { name: "moduleId",    type: "bytes32" },
      { name: "purposeHash", type: "bytes32" },
      { name: "onBehalfOf",  type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function", name: "grantAccess", stateMutability: "nonpayable",
    inputs: [
      { name: "moduleId",           type: "bytes32" },
      { name: "grantee",            type: "address" },
      { name: "expiry",             type: "uint64"  },
      { name: "encryptedKeyCommit", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function", name: "revokeAccess", stateMutability: "nonpayable",
    inputs: [
      { name: "moduleId", type: "bytes32" },
      { name: "grantee",  type: "address" },
    ],
    outputs: [],
  },

  { type: "function", name: "operator", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "function", name: "getModule", stateMutability: "view",
    inputs: [{ name: "moduleId", type: "bytes32" }],
    outputs: [{
      type: "tuple",
      components: [
        { name: "owner",       type: "address" },
        { name: "contentHash", type: "bytes32" },
        { name: "policyHash",  type: "bytes32" },
        { name: "createdAt",   type: "uint64"  },
        { name: "updatedAt",   type: "uint64"  },
        { name: "active",      type: "bool"    },
        { name: "label",       type: "string"  },
        { name: "uri",         type: "string"  },
      ],
    }],
  },
  {
    type: "function", name: "getOwnerModules", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "moduleIds", type: "bytes32[]" }],
  },
  {
    type: "function", name: "getGrant", stateMutability: "view",
    inputs: [
      { name: "moduleId", type: "bytes32" },
      { name: "grantee",  type: "address" },
    ],
    outputs: [{
      type: "tuple",
      components: [
        { name: "allowed",            type: "bool"    },
        { name: "expiry",             type: "uint64"  },
        { name: "encryptedKeyCommit", type: "bytes32" },
      ],
    }],
  },
  {
    type: "function", name: "hasAccess", stateMutability: "view",
    inputs: [
      { name: "moduleId", type: "bytes32" },
      { name: "grantee",  type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function", name: "wasRequested", stateMutability: "view",
    inputs: [
      { name: "moduleId",  type: "bytes32" },
      { name: "requester", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export default CONTEXT_PASSPORT_ABI;
