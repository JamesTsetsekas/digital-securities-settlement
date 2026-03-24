const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

/**
 * ComplianceRegistry Tests
 * Covers: KYC lifecycle, accreditation, jurisdiction blocking, sanctions, access control
 */
describe("ComplianceRegistry", function () {
  // =========================================================================
  // Fixtures
  // =========================================================================

  async function deployRegistryFixture() {
    const [deployer, admin, complianceOfficer, auditor, alice, bob, carol] =
      await ethers.getSigners();

    const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry");
    const registry = await ComplianceRegistry.deploy(admin.address, complianceOfficer.address);
    await registry.waitForDeployment();

    return { registry, deployer, admin, complianceOfficer, auditor, alice, bob, carol };
  }

  // =========================================================================
  // Deployment
  // =========================================================================

  describe("Deployment", function () {
    it("should deploy with correct roles assigned", async function () {
      const { registry, admin, complianceOfficer } = await loadFixture(deployRegistryFixture);

      const ADMIN_ROLE = await registry.DEFAULT_ADMIN_ROLE();
      const CO_ROLE = await registry.COMPLIANCE_OFFICER_ROLE();

      expect(await registry.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
      expect(await registry.hasRole(CO_ROLE, complianceOfficer.address)).to.be.true;
    });

    it("should revert with zero admin address", async function () {
      const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry");
      const [, , complianceOfficer] = await ethers.getSigners();
      await expect(
        ComplianceRegistry.deploy(ethers.ZeroAddress, complianceOfficer.address)
      ).to.be.revertedWith("ComplianceRegistry: zero admin");
    });

    it("should revert with zero compliance officer address", async function () {
      const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry");
      const [, admin] = await ethers.getSigners();
      await expect(
        ComplianceRegistry.deploy(admin.address, ethers.ZeroAddress)
      ).to.be.revertedWith("ComplianceRegistry: zero officer");
    });
  });

  // =========================================================================
  // KYC Status Management
  // =========================================================================

  describe("KYC Status", function () {
    it("should allow compliance officer to set KYC status", async function () {
      const { registry, complianceOfficer, alice } = await loadFixture(deployRegistryFixture);

      const KYC_APPROVED = 2; // KYCStatus.APPROVED
      await registry.connect(complianceOfficer).setKYCStatus(alice.address, KYC_APPROVED, 0);

      expect(await registry.getKYCStatus(alice.address)).to.equal(KYC_APPROVED);
    });

    it("should emit KYCStatusUpdated event", async function () {
      const { registry, complianceOfficer, alice } = await loadFixture(deployRegistryFixture);

      await expect(
        registry.connect(complianceOfficer).setKYCStatus(alice.address, 2, 0)
      )
        .to.emit(registry, "KYCStatusUpdated")
        .withArgs(alice.address, 0, 2, complianceOfficer.address);
    });

    it("should track approved participant count", async function () {
      const { registry, complianceOfficer, alice, bob } = await loadFixture(deployRegistryFixture);

      expect(await registry.approvedParticipantCount()).to.equal(0);

      await registry.connect(complianceOfficer).setKYCStatus(alice.address, 2, 0); // APPROVED
      expect(await registry.approvedParticipantCount()).to.equal(1);

      await registry.connect(complianceOfficer).setKYCStatus(bob.address, 2, 0); // APPROVED
      expect(await registry.approvedParticipantCount()).to.equal(2);

      await registry.connect(complianceOfficer).setKYCStatus(alice.address, 4, 0); // EXPIRED
      expect(await registry.approvedParticipantCount()).to.equal(1);
    });

    it("should reject KYC with expiry in past", async function () {
      const { registry, complianceOfficer, alice } = await loadFixture(deployRegistryFixture);
      const pastTimestamp = Math.floor(Date.now() / 1000) - 1000;

      await expect(
        registry.connect(complianceOfficer).setKYCStatus(alice.address, 2, pastTimestamp)
      ).to.be.revertedWith("ComplianceRegistry: expiry in past");
    });

    it("should reject updates from unauthorized accounts", async function () {
      const { registry, alice, bob } = await loadFixture(deployRegistryFixture);

      await expect(
        registry.connect(alice).setKYCStatus(bob.address, 2, 0)
      ).to.be.reverted;
    });
  });

  // =========================================================================
  // Accreditation
  // =========================================================================

  describe("Accreditation", function () {
    it("should set accredited investor status", async function () {
      const { registry, complianceOfficer, alice } = await loadFixture(deployRegistryFixture);

      await registry.connect(complianceOfficer).setAccreditation(alice.address, true, false);
      expect(await registry.isAccreditedInvestor(alice.address)).to.be.true;
      expect(await registry.isQualifiedInstitutional(alice.address)).to.be.false;
    });

    it("should set QIB status", async function () {
      const { registry, complianceOfficer, alice } = await loadFixture(deployRegistryFixture);

      await registry.connect(complianceOfficer).setAccreditation(alice.address, true, true);
      expect(await registry.isQualifiedInstitutional(alice.address)).to.be.true;
    });

    it("should emit AccreditationUpdated event", async function () {
      const { registry, complianceOfficer, alice } = await loadFixture(deployRegistryFixture);

      await expect(
        registry.connect(complianceOfficer).setAccreditation(alice.address, true, false)
      )
        .to.emit(registry, "AccreditationUpdated")
        .withArgs(alice.address, true, false, complianceOfficer.address);
    });
  });

  // =========================================================================
  // Jurisdiction Management
  // =========================================================================

  describe("Jurisdiction", function () {
    it("should set participant jurisdiction", async function () {
      const { registry, complianceOfficer, alice } = await loadFixture(deployRegistryFixture);

      await registry.connect(complianceOfficer).setJurisdiction(alice.address, "US");
      const record = await registry.getRecord(alice.address);
      expect(record.jurisdiction).to.equal("US");
    });

    it("should block a jurisdiction", async function () {
      const { registry, complianceOfficer } = await loadFixture(deployRegistryFixture);

      await registry.connect(complianceOfficer).blockJurisdiction("KP"); // North Korea
      expect(await registry.isJurisdictionBlocked("KP")).to.be.true;
    });

    it("should unblock a jurisdiction", async function () {
      const { registry, complianceOfficer } = await loadFixture(deployRegistryFixture);

      await registry.connect(complianceOfficer).blockJurisdiction("KP");
      await registry.connect(complianceOfficer).unblockJurisdiction("KP");
      expect(await registry.isJurisdictionBlocked("KP")).to.be.false;
    });

    it("should reject jurisdiction codes that are not 2 characters", async function () {
      const { registry, complianceOfficer } = await loadFixture(deployRegistryFixture);

      await expect(
        registry.connect(complianceOfficer).blockJurisdiction("USA")
      ).to.be.revertedWith("ComplianceRegistry: invalid jurisdiction code");
    });
  });

  // =========================================================================
  // Sanctions
  // =========================================================================

  describe("Sanctions", function () {
    it("should sanction a participant", async function () {
      const { registry, complianceOfficer, alice } = await loadFixture(deployRegistryFixture);

      await registry.connect(complianceOfficer).sanctionParticipant(alice.address);
      const record = await registry.getRecord(alice.address);
      expect(record.isSanctioned).to.be.true;
    });

    it("should unsanction a participant", async function () {
      const { registry, complianceOfficer, alice } = await loadFixture(deployRegistryFixture);

      await registry.connect(complianceOfficer).sanctionParticipant(alice.address);
      await registry.connect(complianceOfficer).unsanctionParticipant(alice.address);
      const record = await registry.getRecord(alice.address);
      expect(record.isSanctioned).to.be.false;
    });
  });

  // =========================================================================
  // Eligibility Checks
  // =========================================================================

  describe("Eligibility", function () {
    async function approvedParticipantFixture() {
      const base = await loadFixture(deployRegistryFixture);
      const { registry, complianceOfficer, alice } = base;

      await registry.connect(complianceOfficer).setKYCStatus(alice.address, 2, 0); // APPROVED
      await registry.connect(complianceOfficer).setJurisdiction(alice.address, "US");

      return base;
    }

    it("should return eligible for approved participant", async function () {
      const { registry, alice } = await loadFixture(approvedParticipantFixture);

      const [eligible, reason] = await registry.isEligible(alice.address);
      expect(eligible).to.be.true;
      expect(reason).to.equal("");
    });

    it("should return ineligible if KYC not approved", async function () {
      const { registry, bob } = await loadFixture(approvedParticipantFixture);

      const [eligible, reason] = await registry.isEligible(bob.address);
      expect(eligible).to.be.false;
      expect(reason).to.equal("KYC_NOT_APPROVED");
    });

    it("should return ineligible if sanctioned", async function () {
      const { registry, complianceOfficer, alice } = await loadFixture(approvedParticipantFixture);

      await registry.connect(complianceOfficer).sanctionParticipant(alice.address);
      const [eligible, reason] = await registry.isEligible(alice.address);
      expect(eligible).to.be.false;
      expect(reason).to.equal("SANCTIONED");
    });

    it("should return ineligible for blocked jurisdiction", async function () {
      const { registry, complianceOfficer, alice } = await loadFixture(approvedParticipantFixture);

      await registry.connect(complianceOfficer).blockJurisdiction("US");
      const [eligible, reason] = await registry.isEligible(alice.address);
      expect(eligible).to.be.false;
      expect(reason).to.equal("JURISDICTION_BLOCKED");
    });
  });

  // =========================================================================
  // Pause Functionality
  // =========================================================================

  describe("Pause", function () {
    it("should allow admin to pause and block updates", async function () {
      const { registry, admin, complianceOfficer, alice } = await loadFixture(deployRegistryFixture);

      await registry.connect(admin).pause();
      await expect(
        registry.connect(complianceOfficer).setKYCStatus(alice.address, 2, 0)
      ).to.be.reverted;
    });

    it("should allow admin to unpause", async function () {
      const { registry, admin, complianceOfficer, alice } = await loadFixture(deployRegistryFixture);

      await registry.connect(admin).pause();
      await registry.connect(admin).unpause();
      await expect(
        registry.connect(complianceOfficer).setKYCStatus(alice.address, 2, 0)
      ).to.not.be.reverted;
    });
  });
});
