pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract TimeBankFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchClosed;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event TimeDeposited(address indexed depositor, uint256 indexed batchId, euint32 encryptedHours);
    event TimeWithdrawn(address indexed withdrawer, uint256 indexed batchId, euint32 encryptedHours);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint32 totalDeposited, uint32 totalWithdrawn);

    error NotOwner();
    error NotProvider();
    error PausedError();
    error CooldownActive();
    error BatchClosedError();
    error ReplayError();
    error StateMismatchError();
    error InvalidDecryption();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    modifier checkCooldown(address account, mapping(address => uint256) storage lastTimeMap) {
        if (block.timestamp < lastTimeMap[account] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        emit ProviderAdded(owner);
        currentBatchId = 1;
        emit BatchOpened(currentBatchId);
        cooldownSeconds = 60;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function openNewBatch() external onlyOwner {
        currentBatchId++;
        emit BatchOpened(currentBatchId);
    }

    function closeCurrentBatch() external onlyOwner {
        isBatchClosed[currentBatchId] = true;
        emit BatchClosed(currentBatchId);
    }

    function depositTime(uint32 hours) external onlyProvider whenNotPaused checkCooldown(msg.sender, lastSubmissionTime) {
        if (isBatchClosed[currentBatchId]) revert BatchClosedError();

        euint32 encryptedHours = FHE.asEuint32(hours);
        _initIfNeeded(encryptedHours);

        emit TimeDeposited(msg.sender, currentBatchId, encryptedHours);
        lastSubmissionTime[msg.sender] = block.timestamp;
    }

    function withdrawTime(uint32 hours) external onlyProvider whenNotPaused checkCooldown(msg.sender, lastSubmissionTime) {
        if (isBatchClosed[currentBatchId]) revert BatchClosedError();

        euint32 encryptedHours = FHE.asEuint32(hours);
        _initIfNeeded(encryptedHours);

        emit TimeWithdrawn(msg.sender, currentBatchId, encryptedHours);
        lastSubmissionTime[msg.sender] = block.timestamp;
    }

    function requestBatchSummary(uint256 batchId) external onlyProvider whenNotPaused checkCooldown(msg.sender, lastDecryptionRequestTime) {
        if (!isBatchClosed[batchId]) revert("Batch not closed");

        euint32 totalDeposits;
        euint32 totalWithdrawals;
        bool initialized = false;

        // Placeholder for actual aggregation logic
        // In a real scenario, iterate over deposits/withdrawals for the batch
        // and use FHE.add to sum them up.
        // For this example, we'll assume 0 for uninitialized values.
        if (FHE.isInitialized(totalDeposits)) {
            initialized = true;
        } else {
            totalDeposits = FHE.asEuint32(0);
        }
        if (FHE.isInitialized(totalWithdrawals)) {
            initialized = true;
        } else {
            totalWithdrawals = FHE.asEuint32(0);
        }
        
        if (!initialized) {
            // If no operations were performed, ensure at least one FHE op for context
            totalDeposits = FHE.add(totalDeposits, FHE.asEuint32(0));
        }


        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(totalDeposits);
        cts[1] = FHE.toBytes32(totalWithdrawals);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, batchId);
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayError();

        uint256 batchId = decryptionContexts[requestId].batchId;

        // Rebuild ciphertexts in the exact same order as in requestBatchSummary
        euint32 totalDeposits; // Placeholder, would be fetched from storage
        euint32 totalWithdrawals; // Placeholder, would be fetched from storage
        bool initialized = false;
        if (FHE.isInitialized(totalDeposits)) initialized = true;
        if (FHE.isInitialized(totalWithdrawals)) initialized = true;
        if (!initialized) totalDeposits = FHE.add(totalDeposits, FHE.asEuint32(0)); // Ensure context if all were default

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(totalDeposits);
        cts[1] = FHE.toBytes32(totalWithdrawals);

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatchError();
        }

        FHE.checkSignatures(requestId, cleartexts, proof);

        if (cleartexts.length != 8) revert InvalidDecryption(); // Expecting 2 uint32s

        uint32 totalDepositedCleartext = uint32(bytes4(cleartexts[:4]));
        uint32 totalWithdrawnCleartext = uint32(bytes4(cleartexts[4:8]));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, totalDepositedCleartext, totalWithdrawnCleartext);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 v) internal {
        // Dummy operation to ensure FHE context is initialized if it's the first operation.
        // In a real contract, this would be an actual FHE operation.
        // For this example, we assume FHE.add(v, 0) is a no-op or handled by the FHEVM.
        v.add(FHE.asEuint32(0));
    }

    function _requireInitialized(euint32 v) internal view {
        if (!FHE.isInitialized(v)) revert("FHE value not initialized");
    }
}