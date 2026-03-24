// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title ComplianceRegistry
 * @author James Tsetsekas
 * @notice On-chain compliance registry for securities market participants.
 *         Tracks KYC status, accredited investor verification, and jurisdiction
 *         eligibility. Modeled after DTCC's compliance infrastructure requirements
 *         for regulated securities transfer.
 *
 * @dev Role hierarchy:
 *      - DEFAULT_ADMIN_ROLE: can grant/revoke all roles
 *      - COMPLIANCE_OFFICER_ROLE: can update KYC, accreditation, jurisdiction data
 *      - AUDITOR_ROLE: read-only role for regulatory auditors (enforced off-chain)
 */
contract ComplianceRegistry is AccessControl, Pausable {
    // =========================================================================
    // Roles
    // =========================================================================

    bytes32 public constant COMPLIANCE_OFFICER_ROLE = keccak256("COMPLIANCE_OFFICER_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");

    // =========================================================================
    // Enums & Structs
    // =========================================================================

    /// @notice KYC verification tiers aligned with FinCEN/FINRA standards
    enum KYCStatus {
        NONE,        // Not submitted
        PENDING,     // Under review
        APPROVED,    // Verified
        REJECTED,    // Failed verification
        EXPIRED      // Verification lapsed (requires renewal)
    }

    /// @notice Jurisdiction codes (ISO 3166-1 alpha-2 based)
    /// @dev Extensible — additional jurisdictions added by compliance officer
    struct ParticipantRecord {
        KYCStatus kycStatus;
        bool isAccreditedInvestor;     // SEC Rule 501 / Reg D accredited status
        bool isQualifiedInstitutional; // SEC Rule 144A QIB status
        uint256 kycExpiry;             // Unix timestamp — 0 means no expiry
        string jurisdiction;           // ISO 3166-1 alpha-2 country code
        bool isSanctioned;             // OFAC / SDN list flag
        uint256 lastUpdated;           // Timestamp of last compliance update
    }

    // =========================================================================
    // State
    // =========================================================================

    /// @notice Participant compliance records indexed by wallet address
    mapping(address => ParticipantRecord) private _records;

    /// @notice Jurisdictions that are blocked from trading (OFAC, export controls)
    mapping(string => bool) private _blockedJurisdictions;

    /// @notice Total number of approved participants
    uint256 public approvedParticipantCount;

    // =========================================================================
    // Events
    // =========================================================================

    event KYCStatusUpdated(
        address indexed participant,
        KYCStatus indexed previousStatus,
        KYCStatus indexed newStatus,
        address updatedBy
    );

    event AccreditationUpdated(
        address indexed participant,
        bool isAccredited,
        bool isQIB,
        address updatedBy
    );

    event JurisdictionUpdated(
        address indexed participant,
        string jurisdiction,
        address updatedBy
    );

    event JurisdictionBlocked(string jurisdiction, address blockedBy);
    event JurisdictionUnblocked(string jurisdiction, address unblockedBy);
    event ParticipantSanctioned(address indexed participant, address sanctionedBy);
    event ParticipantUnsanctioned(address indexed participant, address unsanctionedBy);

    // =========================================================================
    // Constructor
    // =========================================================================

    /**
     * @notice Deploy the compliance registry and assign initial admin
     * @param admin Address granted DEFAULT_ADMIN_ROLE (typically a multi-sig)
     * @param complianceOfficer Address granted COMPLIANCE_OFFICER_ROLE
     */
    constructor(address admin, address complianceOfficer) {
        require(admin != address(0), "ComplianceRegistry: zero admin");
        require(complianceOfficer != address(0), "ComplianceRegistry: zero officer");

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(COMPLIANCE_OFFICER_ROLE, complianceOfficer);
    }

    // =========================================================================
    // Compliance Officer Functions
    // =========================================================================

    /**
     * @notice Update KYC verification status for a participant
     * @param participant Wallet address of the participant
     * @param status New KYC status
     * @param expiry Unix timestamp when KYC expires (0 = no expiry)
     */
    function setKYCStatus(
        address participant,
        KYCStatus status,
        uint256 expiry
    ) external onlyRole(COMPLIANCE_OFFICER_ROLE) whenNotPaused {
        require(participant != address(0), "ComplianceRegistry: zero address");
        if (expiry != 0) {
            require(expiry > block.timestamp, "ComplianceRegistry: expiry in past");
        }

        KYCStatus previous = _records[participant].kycStatus;

        // Track approved participant count
        if (previous != KYCStatus.APPROVED && status == KYCStatus.APPROVED) {
            approvedParticipantCount++;
        } else if (previous == KYCStatus.APPROVED && status != KYCStatus.APPROVED) {
            approvedParticipantCount--;
        }

        _records[participant].kycStatus = status;
        _records[participant].kycExpiry = expiry;
        _records[participant].lastUpdated = block.timestamp;

        emit KYCStatusUpdated(participant, previous, status, msg.sender);
    }

    /**
     * @notice Update accreditation status for a participant
     * @param participant Wallet address of the participant
     * @param isAccredited Whether participant meets SEC Reg D accredited investor criteria
     * @param isQIB Whether participant qualifies as a Qualified Institutional Buyer (Rule 144A)
     */
    function setAccreditation(
        address participant,
        bool isAccredited,
        bool isQIB
    ) external onlyRole(COMPLIANCE_OFFICER_ROLE) whenNotPaused {
        require(participant != address(0), "ComplianceRegistry: zero address");

        _records[participant].isAccreditedInvestor = isAccredited;
        _records[participant].isQualifiedInstitutional = isQIB;
        _records[participant].lastUpdated = block.timestamp;

        emit AccreditationUpdated(participant, isAccredited, isQIB, msg.sender);
    }

    /**
     * @notice Update jurisdiction for a participant
     * @param participant Wallet address of the participant
     * @param jurisdiction ISO 3166-1 alpha-2 country code (e.g., "US", "GB")
     */
    function setJurisdiction(
        address participant,
        string calldata jurisdiction
    ) external onlyRole(COMPLIANCE_OFFICER_ROLE) whenNotPaused {
        require(participant != address(0), "ComplianceRegistry: zero address");
        require(bytes(jurisdiction).length == 2, "ComplianceRegistry: invalid jurisdiction code");

        _records[participant].jurisdiction = jurisdiction;
        _records[participant].lastUpdated = block.timestamp;

        emit JurisdictionUpdated(participant, jurisdiction, msg.sender);
    }

    /**
     * @notice Flag a participant as sanctioned (OFAC/SDN)
     * @param participant Wallet address to sanction
     */
    function sanctionParticipant(
        address participant
    ) external onlyRole(COMPLIANCE_OFFICER_ROLE) {
        require(participant != address(0), "ComplianceRegistry: zero address");
        _records[participant].isSanctioned = true;
        _records[participant].lastUpdated = block.timestamp;
        emit ParticipantSanctioned(participant, msg.sender);
    }

    /**
     * @notice Remove sanction from a participant
     * @param participant Wallet address to unsanction
     */
    function unsanctionParticipant(
        address participant
    ) external onlyRole(COMPLIANCE_OFFICER_ROLE) {
        require(participant != address(0), "ComplianceRegistry: zero address");
        _records[participant].isSanctioned = false;
        _records[participant].lastUpdated = block.timestamp;
        emit ParticipantUnsanctioned(participant, msg.sender);
    }

    /**
     * @notice Block an entire jurisdiction from participation
     * @param jurisdiction ISO 3166-1 alpha-2 country code
     */
    function blockJurisdiction(
        string calldata jurisdiction
    ) external onlyRole(COMPLIANCE_OFFICER_ROLE) {
        require(bytes(jurisdiction).length == 2, "ComplianceRegistry: invalid jurisdiction code");
        _blockedJurisdictions[jurisdiction] = true;
        emit JurisdictionBlocked(jurisdiction, msg.sender);
    }

    /**
     * @notice Unblock a jurisdiction
     * @param jurisdiction ISO 3166-1 alpha-2 country code
     */
    function unblockJurisdiction(
        string calldata jurisdiction
    ) external onlyRole(COMPLIANCE_OFFICER_ROLE) {
        require(bytes(jurisdiction).length == 2, "ComplianceRegistry: invalid jurisdiction code");
        _blockedJurisdictions[jurisdiction] = false;
        emit JurisdictionUnblocked(jurisdiction, msg.sender);
    }

    // =========================================================================
    // Admin Functions
    // =========================================================================

    /// @notice Pause compliance updates (emergency circuit breaker)
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /// @notice Resume compliance updates
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // =========================================================================
    // View Functions
    // =========================================================================

    /**
     * @notice Check if a participant is eligible to transfer securities
     * @param participant Wallet address to check
     * @return eligible True if participant passes all compliance checks
     * @return reason Human-readable reason for ineligibility (empty if eligible)
     */
    function isEligible(
        address participant
    ) external view returns (bool eligible, string memory reason) {
        ParticipantRecord storage record = _records[participant];

        if (record.isSanctioned) {
            return (false, "SANCTIONED");
        }

        if (record.kycStatus != KYCStatus.APPROVED) {
            return (false, "KYC_NOT_APPROVED");
        }

        if (record.kycExpiry != 0 && block.timestamp > record.kycExpiry) {
            return (false, "KYC_EXPIRED");
        }

        if (bytes(record.jurisdiction).length > 0 && _blockedJurisdictions[record.jurisdiction]) {
            return (false, "JURISDICTION_BLOCKED");
        }

        return (true, "");
    }

    /**
     * @notice Get the full compliance record for a participant
     * @param participant Wallet address to query
     * @return Full ParticipantRecord struct
     */
    function getRecord(
        address participant
    ) external view returns (ParticipantRecord memory) {
        return _records[participant];
    }

    /**
     * @notice Get KYC status for a participant
     * @param participant Wallet address to query
     */
    function getKYCStatus(address participant) external view returns (KYCStatus) {
        return _records[participant].kycStatus;
    }

    /**
     * @notice Check if a participant is an accredited investor
     * @param participant Wallet address to query
     */
    function isAccreditedInvestor(address participant) external view returns (bool) {
        return _records[participant].isAccreditedInvestor;
    }

    /**
     * @notice Check if a participant qualifies as a Qualified Institutional Buyer
     * @param participant Wallet address to query
     */
    function isQualifiedInstitutional(address participant) external view returns (bool) {
        return _records[participant].isQualifiedInstitutional;
    }

    /**
     * @notice Check if a jurisdiction is blocked
     * @param jurisdiction ISO 3166-1 alpha-2 country code
     */
    function isJurisdictionBlocked(string calldata jurisdiction) external view returns (bool) {
        return _blockedJurisdictions[jurisdiction];
    }
}
