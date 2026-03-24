// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ComplianceRegistry.sol";

/**
 * @title SecurityToken
 * @author James Tsetsekas
 * @notice ERC-20 security token with full regulatory compliance controls.
 *         Implements transfer restrictions, KYC/AML checks, and freeze capabilities
 *         required for regulated securities under SEC Regulation S, Rule 144A,
 *         and the Exchange Act of 1934.
 *
 *         Architecture mirrors DTCC's Project Ion approach: on-chain settlement
 *         with off-chain compliance data anchored on-chain through the
 *         ComplianceRegistry contract.
 *
 * @dev Role hierarchy:
 *      - DEFAULT_ADMIN_ROLE: system administrator (multi-sig recommended)
 *      - ISSUER_ROLE: can mint/burn tokens (issuer or authorized agent)
 *      - COMPLIANCE_OFFICER_ROLE: can whitelist addresses, freeze accounts
 *      - TRANSFER_AGENT_ROLE: can execute forced transfers (court orders, corporate actions)
 */
contract SecurityToken is ERC20, ERC20Pausable, AccessControl, ReentrancyGuard {
    // =========================================================================
    // Roles
    // =========================================================================

    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant COMPLIANCE_OFFICER_ROLE = keccak256("COMPLIANCE_OFFICER_ROLE");
    bytes32 public constant TRANSFER_AGENT_ROLE = keccak256("TRANSFER_AGENT_ROLE");

    // =========================================================================
    // State
    // =========================================================================

    /// @notice External compliance registry contract
    ComplianceRegistry public immutable complianceRegistry;

    /// @notice Whether this token requires compliance registry checks on transfer
    bool public complianceChecksEnabled;

    /// @notice Addresses approved to send/receive this security (transfer agent whitelist)
    mapping(address => bool) private _whitelist;

    /// @notice Accounts frozen by compliance order (cannot send or receive)
    mapping(address => bool) private _frozen;

    /// @notice Maximum tokens that can be minted (regulatory cap, 0 = no cap)
    uint256 public maxSupply;

    /// @notice Human-readable security identifier (e.g., CUSIP, ISIN)
    string public securityIdentifier;

    /// @notice Security type (e.g., "EQUITY", "BOND", "ABS")
    string public securityType;

    // =========================================================================
    // Events
    // =========================================================================

    event AddressWhitelisted(address indexed account, address indexed by);
    event AddressRemovedFromWhitelist(address indexed account, address indexed by);
    event AccountFrozen(address indexed account, address indexed by, string reason);
    event AccountUnfrozen(address indexed account, address indexed by);
    event ForcedTransfer(
        address indexed from,
        address indexed to,
        uint256 amount,
        address indexed transferAgent,
        string reason
    );
    event ComplianceChecksToggled(bool enabled, address indexed by);
    event TokensMinted(address indexed to, uint256 amount, address indexed by);
    event TokensBurned(address indexed from, uint256 amount, address indexed by);

    // =========================================================================
    // Constructor
    // =========================================================================

    /**
     * @notice Deploy a new security token
     * @param name Token name (e.g., "Acme Corp Series A Preferred")
     * @param symbol Token symbol (e.g., "ACME-A")
     * @param _securityIdentifier CUSIP, ISIN, or internal identifier
     * @param _securityType Security classification (EQUITY, BOND, etc.)
     * @param _maxSupply Maximum mintable supply (0 = unlimited)
     * @param _complianceRegistry Address of the ComplianceRegistry contract
     * @param admin Multi-sig admin address
     * @param issuer Authorized issuer address
     * @param complianceOfficer Compliance officer address
     * @param transferAgent Transfer agent address
     */
    constructor(
        string memory name,
        string memory symbol,
        string memory _securityIdentifier,
        string memory _securityType,
        uint256 _maxSupply,
        address _complianceRegistry,
        address admin,
        address issuer,
        address complianceOfficer,
        address transferAgent
    ) ERC20(name, symbol) {
        require(_complianceRegistry != address(0), "SecurityToken: zero registry");
        require(admin != address(0), "SecurityToken: zero admin");

        complianceRegistry = ComplianceRegistry(_complianceRegistry);
        securityIdentifier = _securityIdentifier;
        securityType = _securityType;
        maxSupply = _maxSupply;
        complianceChecksEnabled = true;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUER_ROLE, issuer);
        _grantRole(COMPLIANCE_OFFICER_ROLE, complianceOfficer);
        _grantRole(TRANSFER_AGENT_ROLE, transferAgent);
    }

    // =========================================================================
    // Issuer Functions
    // =========================================================================

    /**
     * @notice Mint new security tokens to an approved address
     * @param to Recipient address (must be whitelisted and compliance-approved)
     * @param amount Number of tokens to mint (in base units)
     */
    function mint(
        address to,
        uint256 amount
    ) external onlyRole(ISSUER_ROLE) whenNotPaused nonReentrant {
        require(to != address(0), "SecurityToken: mint to zero address");
        require(!_frozen[to], "SecurityToken: recipient frozen");
        require(_whitelist[to], "SecurityToken: recipient not whitelisted");
        if (maxSupply > 0) {
            require(totalSupply() + amount <= maxSupply, "SecurityToken: exceeds max supply");
        }
        _mint(to, amount);
        emit TokensMinted(to, amount, msg.sender);
    }

    /**
     * @notice Burn security tokens from an address (redemption / regulatory seizure)
     * @param from Address to burn from
     * @param amount Number of tokens to burn
     */
    function burn(
        address from,
        uint256 amount
    ) external onlyRole(ISSUER_ROLE) nonReentrant {
        require(from != address(0), "SecurityToken: burn from zero address");
        _burn(from, amount);
        emit TokensBurned(from, amount, msg.sender);
    }

    // =========================================================================
    // Compliance Officer Functions
    // =========================================================================

    /**
     * @notice Add an address to the transfer whitelist
     * @param account Address to approve for transfers
     */
    function addToWhitelist(address account) external onlyRole(COMPLIANCE_OFFICER_ROLE) {
        require(account != address(0), "SecurityToken: zero address");
        _whitelist[account] = true;
        emit AddressWhitelisted(account, msg.sender);
    }

    /**
     * @notice Remove an address from the transfer whitelist
     * @param account Address to remove from whitelist
     */
    function removeFromWhitelist(address account) external onlyRole(COMPLIANCE_OFFICER_ROLE) {
        _whitelist[account] = false;
        emit AddressRemovedFromWhitelist(account, msg.sender);
    }

    /**
     * @notice Batch add addresses to whitelist (gas-efficient for large onboarding)
     * @param accounts Array of addresses to whitelist
     */
    function addToWhitelistBatch(
        address[] calldata accounts
    ) external onlyRole(COMPLIANCE_OFFICER_ROLE) {
        for (uint256 i = 0; i < accounts.length; i++) {
            require(accounts[i] != address(0), "SecurityToken: zero address in batch");
            _whitelist[accounts[i]] = true;
            emit AddressWhitelisted(accounts[i], msg.sender);
        }
    }

    /**
     * @notice Freeze an account — prevents all sends and receives
     * @param account Address to freeze
     * @param reason Human-readable reason (regulatory order reference, etc.)
     */
    function freeze(
        address account,
        string calldata reason
    ) external onlyRole(COMPLIANCE_OFFICER_ROLE) {
        require(account != address(0), "SecurityToken: zero address");
        _frozen[account] = true;
        emit AccountFrozen(account, msg.sender, reason);
    }

    /**
     * @notice Unfreeze an account
     * @param account Address to unfreeze
     */
    function unfreeze(address account) external onlyRole(COMPLIANCE_OFFICER_ROLE) {
        _frozen[account] = false;
        emit AccountUnfrozen(account, msg.sender);
    }

    /**
     * @notice Toggle compliance registry checks on/off
     * @dev Emergency use only — disabling bypasses KYC/sanction checks
     * @param enabled Whether to enforce compliance checks
     */
    function setComplianceChecks(bool enabled) external onlyRole(COMPLIANCE_OFFICER_ROLE) {
        complianceChecksEnabled = enabled;
        emit ComplianceChecksToggled(enabled, msg.sender);
    }

    // =========================================================================
    // Transfer Agent Functions
    // =========================================================================

    /**
     * @notice Execute a forced transfer (court order, corporate action, error correction)
     * @param from Source address
     * @param to Destination address
     * @param amount Number of tokens to transfer
     * @param reason Legal basis for forced transfer
     */
    function forcedTransfer(
        address from,
        address to,
        uint256 amount,
        string calldata reason
    ) external onlyRole(TRANSFER_AGENT_ROLE) nonReentrant {
        require(from != address(0), "SecurityToken: zero from");
        require(to != address(0), "SecurityToken: zero to");
        require(bytes(reason).length > 0, "SecurityToken: reason required");

        _transfer(from, to, amount);
        emit ForcedTransfer(from, to, amount, msg.sender, reason);
    }

    // =========================================================================
    // Admin Functions
    // =========================================================================

    /**
     * @notice Pause all token transfers (market halt, regulatory suspension)
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Resume token transfers
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // =========================================================================
    // Internal Hooks
    // =========================================================================

    /**
     * @notice Pre-transfer compliance hook — called before every ERC-20 transfer
     * @dev Enforces whitelist, freeze, and compliance registry checks
     * @param from Sender address
     * @param to Recipient address
     * @param amount Transfer amount
     */
    function _update(
        address from,
        address to,
        uint256 amount
    ) internal override(ERC20, ERC20Pausable) {
        // Skip checks for mint (from == 0) — handled in mint()
        // Skip checks for burn (to == 0) — intentional
        if (from != address(0) && to != address(0)) {
            // Freeze checks
            require(!_frozen[from], "SecurityToken: sender frozen");
            require(!_frozen[to], "SecurityToken: recipient frozen");

            // Whitelist checks
            require(_whitelist[from], "SecurityToken: sender not whitelisted");
            require(_whitelist[to], "SecurityToken: recipient not whitelisted");

            // Compliance registry checks
            if (complianceChecksEnabled) {
                (bool fromEligible, string memory fromReason) = complianceRegistry.isEligible(from);
                require(fromEligible, string.concat("SecurityToken: sender ", fromReason));

                (bool toEligible, string memory toReason) = complianceRegistry.isEligible(to);
                require(toEligible, string.concat("SecurityToken: recipient ", toReason));
            }
        }

        super._update(from, to, amount);
    }

    // =========================================================================
    // View Functions
    // =========================================================================

    /**
     * @notice Check if an address is on the transfer whitelist
     * @param account Address to check
     */
    function isWhitelisted(address account) external view returns (bool) {
        return _whitelist[account];
    }

    /**
     * @notice Check if an account is frozen
     * @param account Address to check
     */
    function isFrozen(address account) external view returns (bool) {
        return _frozen[account];
    }

    /**
     * @notice Check if a transfer would pass all compliance checks
     * @param from Sender address
     * @param to Recipient address
     * @return canTransfer True if the transfer would succeed
     * @return reason Failure reason if canTransfer is false
     */
    function checkTransfer(
        address from,
        address to
    ) external view returns (bool canTransfer, string memory reason) {
        if (_frozen[from]) return (false, "SENDER_FROZEN");
        if (_frozen[to]) return (false, "RECIPIENT_FROZEN");
        if (!_whitelist[from]) return (false, "SENDER_NOT_WHITELISTED");
        if (!_whitelist[to]) return (false, "RECIPIENT_NOT_WHITELISTED");

        if (complianceChecksEnabled) {
            (bool fromOk, string memory fromReason) = complianceRegistry.isEligible(from);
            if (!fromOk) return (false, string.concat("SENDER_", fromReason));

            (bool toOk, string memory toReason) = complianceRegistry.isEligible(to);
            if (!toOk) return (false, string.concat("RECIPIENT_", toReason));
        }

        return (true, "");
    }
}
