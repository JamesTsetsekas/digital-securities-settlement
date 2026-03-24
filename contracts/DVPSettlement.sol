// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title DVPSettlement
 * @author James Tsetsekas
 * @notice Atomic Delivery vs. Payment (DvP) settlement engine for tokenized securities.
 *
 *         Implements the core settlement mechanic of DTCC's Continuous Net Settlement (CNS)
 *         system: buyer locks payment (stablecoin), seller locks securities, and a Central
 *         Counterparty (CCP) approves atomic settlement — ensuring both legs complete or
 *         neither does. This eliminates principal risk in securities settlement.
 *
 *         Key design decisions aligned with DTCC Project Ion:
 *         - Settlement finality: once CCP-approved, settlement is irrevocable
 *         - Netting: trade IDs can represent netted positions (future extension)
 *         - Fail management: timeout windows allow position unwinding
 *         - Audit trail: all state transitions emit indexed events
 *
 * @dev Settlement lifecycle:
 *      1. CREATED — Trade matched, awaiting leg deposits
 *      2. LEGS_LOCKED — Both buyer and seller have deposited
 *      3. PENDING_CCP — Awaiting CCP approval
 *      4. SETTLED — Atomic swap completed, settlement final
 *      5. CANCELLED — Failed/expired/rejected, deposits returned
 *
 * Role hierarchy:
 *      - DEFAULT_ADMIN_ROLE: system admin
 *      - CCP_ROLE: Central Counterparty (approves/rejects settlements)
 *      - SETTLEMENT_AGENT_ROLE: can create and manage settlement instructions
 */
contract DVPSettlement is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // =========================================================================
    // Roles
    // =========================================================================

    bytes32 public constant CCP_ROLE = keccak256("CCP_ROLE");
    bytes32 public constant SETTLEMENT_AGENT_ROLE = keccak256("SETTLEMENT_AGENT_ROLE");

    // =========================================================================
    // Enums & Structs
    // =========================================================================

    enum SettlementStatus {
        CREATED,       // Instruction created, awaiting deposits
        BUYER_LOCKED,  // Buyer (payment) leg deposited
        SELLER_LOCKED, // Seller (securities) leg deposited
        LEGS_LOCKED,   // Both legs locked, pending CCP approval
        SETTLED,       // Atomic swap executed, settlement final
        CANCELLED      // Failed, rejected, or expired — deposits returned
    }

    struct SettlementInstruction {
        bytes32 tradeId;            // Unique trade identifier (from trade capture)
        address buyer;              // Buyer address (receives securities)
        address seller;             // Seller address (receives payment)
        address securityToken;      // ERC-20 security token contract
        address paymentToken;       // ERC-20 payment token (e.g., USDC)
        uint256 securityAmount;     // Number of security tokens to deliver
        uint256 paymentAmount;      // Payment amount in stablecoin units
        uint256 settlementDeadline; // Unix timestamp — settlement must complete by
        SettlementStatus status;
        bool buyerDeposited;        // Payment leg locked
        bool sellerDeposited;       // Securities leg locked
        uint256 createdAt;
        uint256 settledAt;
        string cancellationReason;  // Set on cancellation
    }

    // =========================================================================
    // State
    // =========================================================================

    /// @notice Settlement instructions indexed by instruction ID
    mapping(bytes32 => SettlementInstruction) public settlements;

    /// @notice All instruction IDs (for enumeration)
    bytes32[] public settlementIds;

    /// @notice Default settlement window duration (T+1 = 86400 seconds)
    uint256 public defaultSettlementWindow;

    /// @notice Settlement statistics
    uint256 public totalSettled;
    uint256 public totalCancelled;
    uint256 public totalValueSettled; // In payment token units

    // =========================================================================
    // Events
    // =========================================================================

    event SettlementCreated(
        bytes32 indexed instructionId,
        bytes32 indexed tradeId,
        address indexed buyer,
        address seller,
        address securityToken,
        address paymentToken,
        uint256 securityAmount,
        uint256 paymentAmount,
        uint256 deadline
    );

    event PaymentLocked(
        bytes32 indexed instructionId,
        address indexed buyer,
        uint256 amount
    );

    event SecuritiesLocked(
        bytes32 indexed instructionId,
        address indexed seller,
        uint256 amount
    );

    event SettlementApproved(
        bytes32 indexed instructionId,
        bytes32 indexed tradeId,
        address indexed ccp,
        uint256 timestamp
    );

    event SettlementCompleted(
        bytes32 indexed instructionId,
        bytes32 indexed tradeId,
        address buyer,
        address seller,
        uint256 securityAmount,
        uint256 paymentAmount,
        uint256 timestamp
    );

    event SettlementCancelled(
        bytes32 indexed instructionId,
        bytes32 indexed tradeId,
        string reason,
        address cancelledBy
    );

    event SettlementWindowUpdated(uint256 oldWindow, uint256 newWindow);

    // =========================================================================
    // Constructor
    // =========================================================================

    /**
     * @notice Deploy the DVP settlement engine
     * @param admin Admin address (multi-sig recommended)
     * @param ccp Central Counterparty address
     * @param settlementAgent Settlement agent address
     * @param _defaultSettlementWindow Default window in seconds (86400 = T+1)
     */
    constructor(
        address admin,
        address ccp,
        address settlementAgent,
        uint256 _defaultSettlementWindow
    ) {
        require(admin != address(0), "DVP: zero admin");
        require(ccp != address(0), "DVP: zero CCP");
        require(_defaultSettlementWindow > 0, "DVP: zero window");

        defaultSettlementWindow = _defaultSettlementWindow;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CCP_ROLE, ccp);
        if (settlementAgent != address(0)) {
            _grantRole(SETTLEMENT_AGENT_ROLE, settlementAgent);
        }
    }

    // =========================================================================
    // Settlement Agent Functions
    // =========================================================================

    /**
     * @notice Create a new settlement instruction from a matched trade
     * @dev Called after trade matching — creates the settlement obligation
     * @param tradeId Unique trade identifier from trade capture system
     * @param buyer Buyer's wallet address
     * @param seller Seller's wallet address
     * @param securityToken Address of the security token contract
     * @param paymentToken Address of the payment token (stablecoin)
     * @param securityAmount Quantity of security tokens to be delivered
     * @param paymentAmount Payment amount in stablecoin base units
     * @param customDeadline Custom settlement deadline (0 = use default window)
     * @return instructionId Unique identifier for this settlement instruction
     */
    function createSettlement(
        bytes32 tradeId,
        address buyer,
        address seller,
        address securityToken,
        address paymentToken,
        uint256 securityAmount,
        uint256 paymentAmount,
        uint256 customDeadline
    ) external onlyRole(SETTLEMENT_AGENT_ROLE) whenNotPaused returns (bytes32 instructionId) {
        require(buyer != address(0), "DVP: zero buyer");
        require(seller != address(0), "DVP: zero seller");
        require(buyer != seller, "DVP: buyer equals seller");
        require(securityToken != address(0), "DVP: zero security token");
        require(paymentToken != address(0), "DVP: zero payment token");
        require(securityAmount > 0, "DVP: zero security amount");
        require(paymentAmount > 0, "DVP: zero payment amount");

        uint256 deadline = customDeadline > 0
            ? customDeadline
            : block.timestamp + defaultSettlementWindow;

        require(deadline > block.timestamp, "DVP: deadline in past");

        // Generate deterministic instruction ID from trade parameters
        instructionId = keccak256(
            abi.encodePacked(tradeId, buyer, seller, securityToken, block.timestamp)
        );
        require(settlements[instructionId].createdAt == 0, "DVP: duplicate instruction");

        settlements[instructionId] = SettlementInstruction({
            tradeId: tradeId,
            buyer: buyer,
            seller: seller,
            securityToken: securityToken,
            paymentToken: paymentToken,
            securityAmount: securityAmount,
            paymentAmount: paymentAmount,
            settlementDeadline: deadline,
            status: SettlementStatus.CREATED,
            buyerDeposited: false,
            sellerDeposited: false,
            createdAt: block.timestamp,
            settledAt: 0,
            cancellationReason: ""
        });

        settlementIds.push(instructionId);

        emit SettlementCreated(
            instructionId,
            tradeId,
            buyer,
            seller,
            securityToken,
            paymentToken,
            securityAmount,
            paymentAmount,
            deadline
        );
    }

    // =========================================================================
    // Participant Functions (Buyer / Seller)
    // =========================================================================

    /**
     * @notice Buyer deposits payment tokens to lock the payment leg
     * @dev Buyer must pre-approve this contract to transfer paymentAmount
     * @param instructionId Settlement instruction identifier
     */
    function depositPayment(
        bytes32 instructionId
    ) external nonReentrant whenNotPaused {
        SettlementInstruction storage s = settlements[instructionId];

        require(s.createdAt > 0, "DVP: unknown instruction");
        require(msg.sender == s.buyer, "DVP: not buyer");
        require(!s.buyerDeposited, "DVP: payment already deposited");
        require(
            s.status == SettlementStatus.CREATED || s.status == SettlementStatus.SELLER_LOCKED,
            "DVP: invalid status for payment deposit"
        );
        require(block.timestamp <= s.settlementDeadline, "DVP: settlement expired");

        IERC20(s.paymentToken).safeTransferFrom(msg.sender, address(this), s.paymentAmount);
        s.buyerDeposited = true;

        if (s.sellerDeposited) {
            s.status = SettlementStatus.LEGS_LOCKED;
        } else {
            s.status = SettlementStatus.BUYER_LOCKED;
        }

        emit PaymentLocked(instructionId, msg.sender, s.paymentAmount);
    }

    /**
     * @notice Seller deposits security tokens to lock the delivery leg
     * @dev Seller must pre-approve this contract to transfer securityAmount
     * @param instructionId Settlement instruction identifier
     */
    function depositSecurities(
        bytes32 instructionId
    ) external nonReentrant whenNotPaused {
        SettlementInstruction storage s = settlements[instructionId];

        require(s.createdAt > 0, "DVP: unknown instruction");
        require(msg.sender == s.seller, "DVP: not seller");
        require(!s.sellerDeposited, "DVP: securities already deposited");
        require(
            s.status == SettlementStatus.CREATED || s.status == SettlementStatus.BUYER_LOCKED,
            "DVP: invalid status for securities deposit"
        );
        require(block.timestamp <= s.settlementDeadline, "DVP: settlement expired");

        IERC20(s.securityToken).safeTransferFrom(msg.sender, address(this), s.securityAmount);
        s.sellerDeposited = true;

        if (s.buyerDeposited) {
            s.status = SettlementStatus.LEGS_LOCKED;
        } else {
            s.status = SettlementStatus.SELLER_LOCKED;
        }

        emit SecuritiesLocked(instructionId, msg.sender, s.securityAmount);
    }

    // =========================================================================
    // CCP Functions
    // =========================================================================

    /**
     * @notice CCP approves and executes the atomic settlement
     * @dev This is the critical operation: atomically transfers both legs.
     *      If either transfer fails, the entire transaction reverts (no partial settlement).
     *      Settlement is final and irrevocable once this succeeds.
     * @param instructionId Settlement instruction to settle
     */
    function approveAndSettle(
        bytes32 instructionId
    ) external onlyRole(CCP_ROLE) nonReentrant whenNotPaused {
        SettlementInstruction storage s = settlements[instructionId];

        require(s.createdAt > 0, "DVP: unknown instruction");
        require(s.status == SettlementStatus.LEGS_LOCKED, "DVP: legs not locked");
        require(block.timestamp <= s.settlementDeadline, "DVP: settlement expired");

        // Mark settled BEFORE transfers to prevent reentrancy exploits
        s.status = SettlementStatus.SETTLED;
        s.settledAt = block.timestamp;

        emit SettlementApproved(instructionId, s.tradeId, msg.sender, block.timestamp);

        // ---------------------------------------------------------------
        // ATOMIC SWAP: both legs execute in a single transaction.
        // If either reverts (e.g., compliance check fails on security token),
        // the entire tx rolls back — principal risk is eliminated.
        // ---------------------------------------------------------------

        // Deliver securities to buyer
        IERC20(s.securityToken).safeTransfer(s.buyer, s.securityAmount);

        // Deliver payment to seller
        IERC20(s.paymentToken).safeTransfer(s.seller, s.paymentAmount);

        // Update statistics
        totalSettled++;
        totalValueSettled += s.paymentAmount;

        emit SettlementCompleted(
            instructionId,
            s.tradeId,
            s.buyer,
            s.seller,
            s.securityAmount,
            s.paymentAmount,
            block.timestamp
        );
    }

    /**
     * @notice CCP rejects a settlement (compliance failure, counterparty default, etc.)
     * @dev Returns all deposited assets to their respective owners
     * @param instructionId Settlement instruction to reject
     * @param reason Human-readable rejection reason
     */
    function rejectSettlement(
        bytes32 instructionId,
        string calldata reason
    ) external onlyRole(CCP_ROLE) nonReentrant {
        SettlementInstruction storage s = settlements[instructionId];

        require(s.createdAt > 0, "DVP: unknown instruction");
        require(
            s.status != SettlementStatus.SETTLED &&
            s.status != SettlementStatus.CANCELLED,
            "DVP: terminal status"
        );
        require(bytes(reason).length > 0, "DVP: reason required");

        _cancelSettlement(instructionId, reason, msg.sender);
    }

    // =========================================================================
    // Timeout / Cancellation Functions
    // =========================================================================

    /**
     * @notice Cancel an expired settlement and return deposited assets
     * @dev Anyone can trigger expiry cleanup — incentivizes timely settlement
     * @param instructionId Expired settlement instruction
     */
    function expireSettlement(bytes32 instructionId) external nonReentrant {
        SettlementInstruction storage s = settlements[instructionId];

        require(s.createdAt > 0, "DVP: unknown instruction");
        require(
            s.status != SettlementStatus.SETTLED &&
            s.status != SettlementStatus.CANCELLED,
            "DVP: terminal status"
        );
        require(block.timestamp > s.settlementDeadline, "DVP: not yet expired");

        _cancelSettlement(instructionId, "SETTLEMENT_WINDOW_EXPIRED", msg.sender);
    }

    /**
     * @notice Buyer or seller withdraws from an unmatched settlement
     * @dev Only allowed before both legs are locked (CREATED status)
     * @param instructionId Settlement instruction to cancel
     */
    function withdrawFromSettlement(bytes32 instructionId) external nonReentrant {
        SettlementInstruction storage s = settlements[instructionId];

        require(s.createdAt > 0, "DVP: unknown instruction");
        require(msg.sender == s.buyer || msg.sender == s.seller, "DVP: not a party");
        require(
            s.status == SettlementStatus.CREATED ||
            s.status == SettlementStatus.BUYER_LOCKED ||
            s.status == SettlementStatus.SELLER_LOCKED,
            "DVP: cannot withdraw - both legs locked or terminal"
        );

        _cancelSettlement(instructionId, "PARTICIPANT_WITHDRAWAL", msg.sender);
    }

    // =========================================================================
    // Internal Helpers
    // =========================================================================

    /**
     * @notice Internal cancellation logic — returns deposits and updates state
     * @param instructionId Instruction to cancel
     * @param reason Cancellation reason
     * @param cancelledBy Address triggering the cancellation
     */
    function _cancelSettlement(
        bytes32 instructionId,
        string memory reason,
        address cancelledBy
    ) internal {
        SettlementInstruction storage s = settlements[instructionId];

        s.status = SettlementStatus.CANCELLED;
        s.cancellationReason = reason;
        totalCancelled++;

        // Return payment to buyer if deposited
        if (s.buyerDeposited) {
            s.buyerDeposited = false;
            IERC20(s.paymentToken).safeTransfer(s.buyer, s.paymentAmount);
        }

        // Return securities to seller if deposited
        if (s.sellerDeposited) {
            s.sellerDeposited = false;
            IERC20(s.securityToken).safeTransfer(s.seller, s.securityAmount);
        }

        emit SettlementCancelled(instructionId, s.tradeId, reason, cancelledBy);
    }

    // =========================================================================
    // Admin Functions
    // =========================================================================

    /**
     * @notice Update the default settlement window
     * @param newWindow New default window in seconds
     */
    function setDefaultSettlementWindow(
        uint256 newWindow
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newWindow > 0, "DVP: zero window");
        emit SettlementWindowUpdated(defaultSettlementWindow, newWindow);
        defaultSettlementWindow = newWindow;
    }

    /// @notice Pause the settlement engine (emergency halt)
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /// @notice Resume the settlement engine
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // =========================================================================
    // View Functions
    // =========================================================================

    /**
     * @notice Get the status of a settlement instruction
     * @param instructionId Settlement instruction identifier
     */
    function getStatus(bytes32 instructionId) external view returns (SettlementStatus) {
        return settlements[instructionId].status;
    }

    /**
     * @notice Get full settlement instruction details
     * @param instructionId Settlement instruction identifier
     */
    function getSettlement(
        bytes32 instructionId
    ) external view returns (SettlementInstruction memory) {
        return settlements[instructionId];
    }

    /**
     * @notice Get total number of settlement instructions
     */
    function getSettlementCount() external view returns (uint256) {
        return settlementIds.length;
    }

    /**
     * @notice Check if a settlement has expired
     * @param instructionId Settlement instruction identifier
     */
    function isExpired(bytes32 instructionId) external view returns (bool) {
        SettlementInstruction storage s = settlements[instructionId];
        return s.createdAt > 0 && block.timestamp > s.settlementDeadline;
    }
}
