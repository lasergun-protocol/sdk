/**
 * Contract ABIs for the LaserGun v2 stack, fixed against
 * contracts/src/interfaces (11.2). Human-readable ABI fragments.
 */
import { Interface } from 'ethers';

export const CORE_ABI = [
  'function mintNotes(uint256 assetId, uint256 deposited, uint256[] di, bytes[] E, bytes[] X) external',
  'function spend(tuple(uint256 assetId,uint256 di,address recipient,bytes[] ring,bytes[] hp,bytes I,bytes32 c1,uint256[] s,tuple(uint256[] di,bytes[] E,bytes[] X) change,tuple(bytes32 id,uint256 assetId,uint256[] di,uint256 expiry,bool permitRequired,bytes E_r,bytes X_r,bytes E_s,bytes X_s) env,tuple(uint256[] di,bytes[] E,bytes[] X) payee) args) external',
  'function claimEnvelope(bytes32 id, bytes sig) external',
  'function refundEnvelope(bytes32 id) external',
  'function registerReceiver(address receiver) external',
  'function registerPayoutReceiver(address receiver) external',
  'function commitmentExists(uint256 assetId, uint256 di, bytes X) external view returns (bool)',
  'function isSpent(bytes32 nullifier) external view returns (bool)',
  'function spentInfo(bytes32 nullifier) external view returns (bytes32 payloadHash, address recipient, uint256 amount)',
  'function denomOf(uint256 assetId, uint256 di) external view returns (uint256)',
  'function feesOf(uint256 assetId) external view returns (uint256 bpsIn, uint256 bpsTransfer, uint256 bpsOut)',
  'function feesAccrued(uint256 assetId) external view returns (uint256)',
  'function envelope(bytes32 id) external view returns (tuple(uint256 assetId, uint256[] di, uint256 openAt, uint256 expiry, bool open, bool claimed, bool permitRequired, bytes E_r, bytes X_r, bytes E_s, bytes X_s))',
  'function receiverRegistered(address a) external view returns (bool)',
  'function payoutReceiverRegistered(address a) external view returns (bool)',
  'function factory() external view returns (address)',
  'function executor() external view returns (address)',
  'function totalNotes() external view returns (uint256)',
  'event Minted(uint256 indexed assetId, uint256 indexed di, bytes E, bytes X)',
  'event Spent(uint256 indexed assetId, uint256 indexed di, address indexed recipient, bytes32 nullifier, uint256 ringSize, bytes32 envelopeId)',
  'event DuplicateSpend(bytes32 indexed nullifier, bytes32 payloadHash)',
  'event EnvelopeOpened(bytes32 indexed id, uint256 assetId, uint256[] di, bool permitRequired, bytes E_r, bytes X_r, bytes E_s, bytes X_s, uint256 expiry)',
  'event EnvelopeClaimed(bytes32 indexed id, bytes X_r)',
  'event EnvelopeRefunded(bytes32 indexed id, bytes X_s)',
  'event ReceiverRegistered(address indexed receiver)',
  'event PayoutReceiverRegistered(address indexed receiver)',
];

export const EXECUTOR_ABI = [
  'function execute(bytes spendCalldata) external',
  'function sweepFees(uint256 assetId, address to, uint256 amount) external',
  'function feesWithdrawn(uint256 assetId) external view returns (uint256)',
  'function core() external view returns (address)',
  'event FeesWithdrawn(uint256 indexed assetId, address indexed to, uint256 amount)',
];

export const FACTORY_ABI = [
  'function create2(bytes32 salt, bytes initcode, bool payout) external returns (address receiver)',
  'function predictAddress(bytes32 salt, bytes initcode) external view returns (address)',
  'function core() external view returns (address)',
  'function owner() external view returns (address)',
  'function receiverTemplateHash() external view returns (bytes32)',
  'function receiverTemplateLen() external view returns (uint256)',
  'function outputReceiverTemplateHash() external view returns (bytes32)',
  'function outputReceiverTemplateLen() external view returns (uint256)',
  'function setTemplateHashes(bytes32 receiverHash, uint256 receiverLen, bytes32 outputHash, uint256 outputLen) external',
  'function transferOwnership(address newOwner) external',
  'event ReceiverDeployed(address indexed receiver, bytes32 indexed salt, bool payout)',
  'event TemplateHashesSet(bytes32 receiverTemplateHash, bytes32 outputReceiverTemplateHash)',
  'event OwnerTransferred(address indexed previousOwner, address indexed newOwner)',
];

export const RECEIVER_ABI = [
  'function pull(address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external',
  'function settle() external',
  'function depositAmount() external view returns (uint256)',
  'function assetId() external view returns (uint256)',
  'function settled() external view returns (bool)',
  'function denomIndicesLength() external view returns (uint256)',
  'function denomIndices(uint256 j) external view returns (uint256)',
  'function ephemeralsLength() external view returns (uint256)',
  'function ephemerals(uint256 j) external view returns (bytes)',
  'function commitmentsLength() external view returns (uint256)',
  'function commitments(uint256 j) external view returns (bytes)',
];

export const OUTPUT_RECEIVER_ABI = [
  'function sweep(uint256 assetId, address to) external',
  'function core() external view returns (address)',
  'function balances(uint256 assetId) external view returns (uint256)',
];

export const ERC20_ABI = [
  'function balanceOf(address) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
  'function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external',
  'function authorizationState(address authorizer, bytes32 nonce) external view returns (bool)',
];

export const WETH_ABI = [
  'function deposit() external payable',
  'function withdraw(uint256 wad) external',
  'function balanceOf(address) external view returns (uint256)',
];

export const CORE = new Interface(CORE_ABI);
export const EXECUTOR = new Interface(EXECUTOR_ABI);
export const FACTORY = new Interface(FACTORY_ABI);
export const RECEIVER = new Interface(RECEIVER_ABI);
export const OUTPUT_RECEIVER = new Interface(OUTPUT_RECEIVER_ABI);
export const ERC20 = new Interface(ERC20_ABI);
export const WETH = new Interface(WETH_ABI);

/** assetId → (name, decimals) for display layers. */
export const ASSETS: Record<number, { name: string; decimals: number }> = {
  1: { name: 'USDC', decimals: 6 },
  2: { name: 'ETH', decimals: 18 },
};
