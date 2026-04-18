const CONTEXT_PASSPORT_ABI = [
  "error ModuleAlreadyExists()",
  "error ModuleInactive()",
  "error ModuleNotFound()",
  "error NotOperator()",
  "error NotOwner()",

  "event ModuleRegistered(bytes32 indexed moduleId,address indexed owner,bytes32 contentHash,bytes32 policyHash,string label,string uri)",
  "event ModuleUpdated(bytes32 indexed moduleId,bytes32 contentHash,bytes32 policyHash,string uri)",
  "event ModuleDeactivated(bytes32 indexed moduleId)",
  "event AccessRequested(bytes32 indexed moduleId,address indexed requester,bytes32 purposeHash)",
  "event AccessGranted(bytes32 indexed moduleId,address indexed grantee,uint64 expiry,bytes32 encryptedKeyCommit)",
  "event AccessRevoked(bytes32 indexed moduleId,address indexed grantee)",
  "event OperatorChanged(address indexed oldOperator,address indexed newOperator)",

  "function claimOperatorRole()",
  "function registerModule(bytes32 moduleId,bytes32 contentHash,bytes32 policyHash,string label,string uri)",
  "function updateModule(bytes32 moduleId,bytes32 newContentHash,bytes32 newPolicyHash,string newUri)",
  "function deactivateModule(bytes32 moduleId)",
  "function requestAccess(bytes32 moduleId,bytes32 purposeHash)",
  "function operatorRequestAccess(bytes32 moduleId,bytes32 purposeHash,address onBehalfOf)",
  "function grantAccess(bytes32 moduleId,address grantee,uint64 expiry,bytes32 encryptedKeyCommit)",
  "function revokeAccess(bytes32 moduleId,address grantee)",

  "function operator() view returns (address)",
  "function getModule(bytes32 moduleId) view returns (tuple(address owner,bytes32 contentHash,bytes32 policyHash,uint64 createdAt,uint64 updatedAt,bool active,string label,string uri))",
  "function getOwnerModules(address owner) view returns (bytes32[] moduleIds)",
  "function getGrant(bytes32 moduleId,address grantee) view returns (tuple(bool allowed,uint64 expiry,bytes32 encryptedKeyCommit))",
  "function hasAccess(bytes32 moduleId,address grantee) view returns (bool)",
  "function wasRequested(bytes32 moduleId,address requester) view returns (bool)",
] as const;

export default CONTEXT_PASSPORT_ABI;
