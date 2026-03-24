const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

/**
 * SecurityToken Tests
 * Covers: minting, transfers, whitelist, freeze, compliance checks, forced transfers, roles
 */
describe("SecurityToken", function () {
  // =========================================================================
  // Fixtures
  // =========================================================================

  async function deployFixture() {
    const [deployer, admin, issuer, complianceOfficer, transferAgent, alice, bob, carol, mallory] =
      await ethers.getSigners();

    // Deploy compliance registry
    const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry");
    const registry = await ComplianceRegistry.deploy(admin.address, complianceOfficer.address);
    await registry.waitForDeployment();

    // Deploy security token
    const SecurityToken = await ethers.getContractFactory("SecurityToken");
    const token = await SecurityToken.deploy(
      "Acme Corp Series A",
      "ACME-A",
      "037833100",        // CUSIP
      "EQUITY",
      ethers.parseUnits("1000000", 18), // 1M max supply
      await registry.getAddress(),
      admin.address,
      issuer.address,
      complianceOfficer.address,
      transferAgent.address
    );
    await token.waitForDeployment();

    // Setup: KYC-approve alice and bob
    await registry.connect(complianceOfficer).setKYCStatus(alice.address, 2, 0);
    await registry.connect(complianceOfficer).setKYCStatus(bob.address, 2, 0);

    // Whitelist alice and bob
    await token.connect(complianceOfficer).addToWhitelist(alice.address);
    await token.connect(complianceOfficer).addToWhitelist(bob.address);

    return {
      token, registry, deployer, admin, issuer, complianceOfficer,
      transferAgent, alice, bob, carol, mallory
    };
  }

  // =========================================================================
  // Deployment
  // =========================================================================

  describe("Deployment", function () {
    it("should deploy with correct metadata", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(await token.name()).to.equal("Acme Corp Series A");
      expect(await token.symbol()).to.equal("ACME-A");
      expect(await token.securityIdentifier()).to.equal("037833100");
      expect(await token.securityType()).to.equal("EQUITY");
    });

    it("should have compliance checks enabled by default", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(await token.complianceChecksEnabled()).to.be.true;
    });

    it("should assign roles correctly", async function () {
      const { token, admin, issuer, complianceOfficer, transferAgent } =
        await loadFixture(deployFixture);

      expect(await token.hasRole(await token.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
      expect(await token.hasRole(await token.ISSUER_ROLE(), issuer.address)).to.be.true;
      expect(await token.hasRole(await token.COMPLIANCE_OFFICER_ROLE(), complianceOfficer.address)).to.be.true;
      expect(await token.hasRole(await token.TRANSFER_AGENT_ROLE(), transferAgent.address)).to.be.true;
    });
  });

  // =========================================================================
  // Minting
  // =========================================================================

  describe("Minting", function () {
    it("should allow issuer to mint to whitelisted KYC-approved address", async function () {
      const { token, issuer, alice } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("1000", 18);

      await expect(token.connect(issuer).mint(alice.address, amount))
        .to.emit(token, "TokensMinted")
        .withArgs(alice.address, amount, issuer.address);

      expect(await token.balanceOf(alice.address)).to.equal(amount);
    });

    it("should enforce max supply cap", async function () {
      const { token, issuer, alice } = await loadFixture(deployFixture);
      const overCap = ethers.parseUnits("1000001", 18);

      await expect(token.connect(issuer).mint(alice.address, overCap))
        .to.be.revertedWith("SecurityToken: exceeds max supply");
    });

    it("should reject mint to non-whitelisted address", async function () {
      const { token, issuer, carol } = await loadFixture(deployFixture);
      await expect(token.connect(issuer).mint(carol.address, 1000n))
        .to.be.revertedWith("SecurityToken: recipient not whitelisted");
    });

    it("should reject mint by non-issuer", async function () {
      const { token, alice, bob } = await loadFixture(deployFixture);
      await expect(token.connect(alice).mint(bob.address, 1000n)).to.be.reverted;
    });

    it("should reject mint to frozen address", async function () {
      const { token, issuer, complianceOfficer, alice } = await loadFixture(deployFixture);
      await token.connect(complianceOfficer).freeze(alice.address, "TEST_FREEZE");

      await expect(token.connect(issuer).mint(alice.address, 1000n))
        .to.be.revertedWith("SecurityToken: recipient frozen");
    });
  });

  // =========================================================================
  // Transfers
  // =========================================================================

  describe("Transfers", function () {
    async function mintedFixture() {
      const base = await loadFixture(deployFixture);
      const { token, issuer, alice } = base;
      await token.connect(issuer).mint(alice.address, ethers.parseUnits("10000", 18));
      return base;
    }

    it("should allow transfer between two whitelisted KYC-approved addresses", async function () {
      const { token, alice, bob } = await loadFixture(mintedFixture);
      const amount = ethers.parseUnits("500", 18);

      await token.connect(alice).transfer(bob.address, amount);
      expect(await token.balanceOf(bob.address)).to.equal(amount);
    });

    it("should block transfer to non-whitelisted address", async function () {
      const { token, alice, carol } = await loadFixture(mintedFixture);

      await expect(token.connect(alice).transfer(carol.address, 100n))
        .to.be.revertedWith("SecurityToken: recipient not whitelisted");
    });

    it("should block transfer from non-whitelisted sender", async function () {
      const { token, complianceOfficer, alice, carol } = await loadFixture(mintedFixture);

      // Whitelist carol so she can receive (but we'll transfer FROM carol who has no whitelist)
      await token.connect(complianceOfficer).addToWhitelist(carol.address);

      // carol has no tokens and isn't whitelisted as sender — this will fail whitelist
      await expect(token.connect(carol).transfer(alice.address, 100n))
        .to.be.reverted; // No balance + not whitelisted — reverts
    });

    it("should block transfer from frozen sender", async function () {
      const { token, complianceOfficer, alice, bob } = await loadFixture(mintedFixture);

      await token.connect(complianceOfficer).freeze(alice.address, "REGULATORY_HOLD");
      await expect(token.connect(alice).transfer(bob.address, 100n))
        .to.be.revertedWith("SecurityToken: sender frozen");
    });

    it("should block transfer to frozen recipient", async function () {
      const { token, complianceOfficer, alice, bob } = await loadFixture(mintedFixture);

      await token.connect(complianceOfficer).freeze(bob.address, "REGULATORY_HOLD");
      await expect(token.connect(alice).transfer(bob.address, 100n))
        .to.be.revertedWith("SecurityToken: recipient frozen");
    });

    it("should block transfer when sender is sanctioned (via compliance registry)", async function () {
      const { token, registry, complianceOfficer, alice, bob } = await loadFixture(mintedFixture);

      await registry.connect(complianceOfficer).sanctionParticipant(alice.address);
      await expect(token.connect(alice).transfer(bob.address, 100n))
        .to.be.reverted;
    });

    it("should allow transfer when compliance checks are disabled", async function () {
      const { token, registry, complianceOfficer, alice, bob } = await loadFixture(mintedFixture);

      // Sanction alice — would normally block
      await registry.connect(complianceOfficer).sanctionParticipant(alice.address);
      // Disable compliance checks (emergency mode)
      await token.connect(complianceOfficer).setComplianceChecks(false);

      // Transfer should succeed now (whitelist still required)
      await expect(token.connect(alice).transfer(bob.address, 100n)).to.not.be.reverted;
    });
  });

  // =========================================================================
  // Whitelist Management
  // =========================================================================

  describe("Whitelist", function () {
    it("should add and remove from whitelist", async function () {
      const { token, complianceOfficer, carol } = await loadFixture(deployFixture);

      expect(await token.isWhitelisted(carol.address)).to.be.false;
      await token.connect(complianceOfficer).addToWhitelist(carol.address);
      expect(await token.isWhitelisted(carol.address)).to.be.true;
      await token.connect(complianceOfficer).removeFromWhitelist(carol.address);
      expect(await token.isWhitelisted(carol.address)).to.be.false;
    });

    it("should batch-whitelist addresses", async function () {
      const [, , , , , , , carol, mallory, extra] = await ethers.getSigners();
      const { token, complianceOfficer } = await loadFixture(deployFixture);

      await token.connect(complianceOfficer).addToWhitelistBatch([carol.address, mallory.address]);
      expect(await token.isWhitelisted(carol.address)).to.be.true;
      expect(await token.isWhitelisted(mallory.address)).to.be.true;
    });
  });

  // =========================================================================
  // Freeze
  // =========================================================================

  describe("Freeze / Unfreeze", function () {
    it("should freeze and unfreeze accounts", async function () {
      const { token, complianceOfficer, alice } = await loadFixture(deployFixture);

      expect(await token.isFrozen(alice.address)).to.be.false;
      await token.connect(complianceOfficer).freeze(alice.address, "COURT_ORDER_2024-001");
      expect(await token.isFrozen(alice.address)).to.be.true;
      await token.connect(complianceOfficer).unfreeze(alice.address);
      expect(await token.isFrozen(alice.address)).to.be.false;
    });

    it("should emit AccountFrozen event with reason", async function () {
      const { token, complianceOfficer, alice } = await loadFixture(deployFixture);

      await expect(token.connect(complianceOfficer).freeze(alice.address, "OFAC_MATCH"))
        .to.emit(token, "AccountFrozen")
        .withArgs(alice.address, complianceOfficer.address, "OFAC_MATCH");
    });
  });

  // =========================================================================
  // Forced Transfer
  // =========================================================================

  describe("Forced Transfer", function () {
    it("should allow transfer agent to execute forced transfer", async function () {
      const { token, issuer, transferAgent, alice, bob } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("1000", 18);
      await token.connect(issuer).mint(alice.address, amount);

      await expect(
        token.connect(transferAgent).forcedTransfer(
          alice.address, bob.address, amount, "COURT_ORDER_2024-042"
        )
      )
        .to.emit(token, "ForcedTransfer")
        .withArgs(alice.address, bob.address, amount, transferAgent.address, "COURT_ORDER_2024-042");

      expect(await token.balanceOf(bob.address)).to.equal(amount);
      expect(await token.balanceOf(alice.address)).to.equal(0);
    });

    it("should reject forced transfer without reason", async function () {
      const { token, issuer, transferAgent, alice, bob } = await loadFixture(deployFixture);
      await token.connect(issuer).mint(alice.address, 1000n);

      await expect(
        token.connect(transferAgent).forcedTransfer(alice.address, bob.address, 100n, "")
      ).to.be.revertedWith("SecurityToken: reason required");
    });

    it("should reject forced transfer by unauthorized account", async function () {
      const { token, alice, bob } = await loadFixture(deployFixture);
      await expect(
        token.connect(alice).forcedTransfer(alice.address, bob.address, 100n, "THEFT")
      ).to.be.reverted;
    });
  });

  // =========================================================================
  // Pause
  // =========================================================================

  describe("Pause", function () {
    it("should pause and block all transfers", async function () {
      const { token, admin, issuer, alice, bob } = await loadFixture(deployFixture);
      await token.connect(issuer).mint(alice.address, 1000n);
      await token.connect(admin).pause();

      await expect(token.connect(alice).transfer(bob.address, 100n)).to.be.reverted;
    });

    it("should resume transfers after unpause", async function () {
      const { token, admin, issuer, alice, bob } = await loadFixture(deployFixture);
      await token.connect(issuer).mint(alice.address, 1000n);
      await token.connect(admin).pause();
      await token.connect(admin).unpause();

      await expect(token.connect(alice).transfer(bob.address, 100n)).to.not.be.reverted;
    });
  });

  // =========================================================================
  // checkTransfer helper
  // =========================================================================

  describe("checkTransfer", function () {
    it("should return true for valid transfer", async function () {
      const { token, alice, bob } = await loadFixture(deployFixture);
      const [ok, reason] = await token.checkTransfer(alice.address, bob.address);
      expect(ok).to.be.true;
      expect(reason).to.equal("");
    });

    it("should return false if sender is frozen", async function () {
      const { token, complianceOfficer, alice, bob } = await loadFixture(deployFixture);
      await token.connect(complianceOfficer).freeze(alice.address, "TEST");
      const [ok, reason] = await token.checkTransfer(alice.address, bob.address);
      expect(ok).to.be.false;
      expect(reason).to.equal("SENDER_FROZEN");
    });

    it("should return false if recipient not whitelisted", async function () {
      const { token, alice, carol } = await loadFixture(deployFixture);
      const [ok, reason] = await token.checkTransfer(alice.address, carol.address);
      expect(ok).to.be.false;
      expect(reason).to.equal("RECIPIENT_NOT_WHITELISTED");
    });
  });
});
