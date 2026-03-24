const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  loadFixture,
  time,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

/**
 * DVPSettlement Tests
 * Covers: full settlement lifecycle, atomic swap, timeout/expiry, cancellation, edge cases
 */
describe("DVPSettlement", function () {
  const ONE_DAY = 86400;
  const TRADE_ID = ethers.keccak256(ethers.toUtf8Bytes("TRADE-2024-001"));

  // =========================================================================
  // Fixtures
  // =========================================================================

  async function deployDVPFixture() {
    const [deployer, admin, ccp, settlementAgent, buyer, seller, attacker] =
      await ethers.getSigners();

    // Deploy mock ERC-20 payment token (USDC stand-in)
    const MockToken = await ethers.getContractFactory("MockERC20");
    const paymentToken = await MockToken.deploy("USD Coin", "USDC", 6);
    await paymentToken.waitForDeployment();

    // Deploy compliance registry
    const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry");
    const registry = await ComplianceRegistry.deploy(admin.address, admin.address);
    await registry.waitForDeployment();

    // Deploy security token
    const SecurityToken = await ethers.getContractFactory("SecurityToken");
    const securityToken = await SecurityToken.deploy(
      "Acme Corp Series A",
      "ACME-A",
      "037833100",
      "EQUITY",
      0, // no cap
      await registry.getAddress(),
      admin.address,
      admin.address,   // issuer
      admin.address,   // compliance officer
      admin.address    // transfer agent
    );
    await securityToken.waitForDeployment();

    // Setup security token participants
    await registry.connect(admin).setKYCStatus(buyer.address, 2, 0);
    await registry.connect(admin).setKYCStatus(seller.address, 2, 0);
    // DVP contract also needs to be whitelisted to hold tokens during escrow
    // (whitelist check is on from/to for normal transfers, but for safeTransfer out
    //  we need the DVP contract as a whitelisted intermediary)
    await securityToken.connect(admin).addToWhitelist(buyer.address);
    await securityToken.connect(admin).addToWhitelist(seller.address);

    // Deploy DVP settlement engine
    const DVPSettlement = await ethers.getContractFactory("DVPSettlement");
    const dvp = await DVPSettlement.deploy(
      admin.address,
      ccp.address,
      settlementAgent.address,
      ONE_DAY
    );
    await dvp.waitForDeployment();

    // Whitelist DVP contract (acts as escrow intermediary)
    await securityToken.connect(admin).addToWhitelist(await dvp.getAddress());
    // DVP also needs KYC eligibility for transfers through it — disable compliance checks for DVP contract
    // In production this would be a special "custodian" KYC status
    await securityToken.connect(admin).setComplianceChecks(false);

    // Fund buyer with payment tokens and seller with security tokens
    const PAYMENT_AMOUNT = ethers.parseUnits("50000", 6); // 50,000 USDC
    const SECURITY_AMOUNT = ethers.parseUnits("1000", 18); // 1,000 tokens

    await paymentToken.mint(buyer.address, PAYMENT_AMOUNT * 10n);
    await securityToken.connect(admin).mint(seller.address, SECURITY_AMOUNT * 10n);

    return {
      dvp, securityToken, paymentToken, registry,
      admin, ccp, settlementAgent, buyer, seller, attacker,
      PAYMENT_AMOUNT, SECURITY_AMOUNT,
    };
  }

  async function createdSettlementFixture() {
    const base = await loadFixture(deployDVPFixture);
    const { dvp, securityToken, paymentToken, settlementAgent, buyer, seller, PAYMENT_AMOUNT, SECURITY_AMOUNT } = base;

    const tx = await dvp.connect(settlementAgent).createSettlement(
      TRADE_ID,
      buyer.address,
      seller.address,
      await securityToken.getAddress(),
      await paymentToken.getAddress(),
      SECURITY_AMOUNT,
      PAYMENT_AMOUNT,
      0 // default window
    );
    const receipt = await tx.wait();

    // Extract instructionId from event
    const event = receipt.logs.find(log => {
      try {
        return dvp.interface.parseLog(log)?.name === "SettlementCreated";
      } catch { return false; }
    });
    const parsed = dvp.interface.parseLog(event);
    const instructionId = parsed.args.instructionId;

    return { ...base, instructionId };
  }

  async function legsLockedFixture() {
    const base = await loadFixture(createdSettlementFixture);
    const { dvp, securityToken, paymentToken, buyer, seller, instructionId, PAYMENT_AMOUNT, SECURITY_AMOUNT } = base;

    await paymentToken.connect(buyer).approve(await dvp.getAddress(), PAYMENT_AMOUNT);
    await dvp.connect(buyer).depositPayment(instructionId);

    await securityToken.connect(seller).approve(await dvp.getAddress(), SECURITY_AMOUNT);
    await dvp.connect(seller).depositSecurities(instructionId);

    return base;
  }

  // =========================================================================
  // Deployment
  // =========================================================================

  describe("Deployment", function () {
    it("should deploy with correct configuration", async function () {
      const { dvp } = await loadFixture(deployDVPFixture);
      expect(await dvp.defaultSettlementWindow()).to.equal(ONE_DAY);
    });

    it("should assign roles correctly", async function () {
      const { dvp, admin, ccp, settlementAgent } = await loadFixture(deployDVPFixture);

      expect(await dvp.hasRole(await dvp.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
      expect(await dvp.hasRole(await dvp.CCP_ROLE(), ccp.address)).to.be.true;
      expect(await dvp.hasRole(await dvp.SETTLEMENT_AGENT_ROLE(), settlementAgent.address)).to.be.true;
    });
  });

  // =========================================================================
  // Create Settlement
  // =========================================================================

  describe("Create Settlement", function () {
    it("should create a settlement instruction", async function () {
      const { dvp, securityToken, paymentToken, settlementAgent, buyer, seller, PAYMENT_AMOUNT, SECURITY_AMOUNT } =
        await loadFixture(deployDVPFixture);

      await expect(
        dvp.connect(settlementAgent).createSettlement(
          TRADE_ID,
          buyer.address,
          seller.address,
          await securityToken.getAddress(),
          await paymentToken.getAddress(),
          SECURITY_AMOUNT,
          PAYMENT_AMOUNT,
          0
        )
      ).to.emit(dvp, "SettlementCreated");
    });

    it("should revert if buyer equals seller", async function () {
      const { dvp, securityToken, paymentToken, settlementAgent, buyer, PAYMENT_AMOUNT, SECURITY_AMOUNT } =
        await loadFixture(deployDVPFixture);

      await expect(
        dvp.connect(settlementAgent).createSettlement(
          TRADE_ID, buyer.address, buyer.address,
          await securityToken.getAddress(), await paymentToken.getAddress(),
          SECURITY_AMOUNT, PAYMENT_AMOUNT, 0
        )
      ).to.be.revertedWith("DVP: buyer equals seller");
    });

    it("should revert if called by non-settlement-agent", async function () {
      const { dvp, securityToken, paymentToken, attacker, buyer, seller, PAYMENT_AMOUNT, SECURITY_AMOUNT } =
        await loadFixture(deployDVPFixture);

      await expect(
        dvp.connect(attacker).createSettlement(
          TRADE_ID, buyer.address, seller.address,
          await securityToken.getAddress(), await paymentToken.getAddress(),
          SECURITY_AMOUNT, PAYMENT_AMOUNT, 0
        )
      ).to.be.reverted;
    });
  });

  // =========================================================================
  // Leg Deposits
  // =========================================================================

  describe("Deposit Payment (Buyer Leg)", function () {
    it("should lock buyer payment", async function () {
      const { dvp, paymentToken, buyer, instructionId, PAYMENT_AMOUNT } =
        await loadFixture(createdSettlementFixture);

      await paymentToken.connect(buyer).approve(await dvp.getAddress(), PAYMENT_AMOUNT);

      await expect(dvp.connect(buyer).depositPayment(instructionId))
        .to.emit(dvp, "PaymentLocked")
        .withArgs(instructionId, buyer.address, PAYMENT_AMOUNT);

      const settlement = await dvp.getSettlement(instructionId);
      expect(settlement.buyerDeposited).to.be.true;
    });

    it("should reject payment from non-buyer", async function () {
      const { dvp, paymentToken, seller, instructionId, PAYMENT_AMOUNT } =
        await loadFixture(createdSettlementFixture);

      await paymentToken.connect(seller).approve(await dvp.getAddress(), PAYMENT_AMOUNT);
      await expect(dvp.connect(seller).depositPayment(instructionId))
        .to.be.revertedWith("DVP: not buyer");
    });

    it("should reject duplicate payment deposit", async function () {
      const { dvp, paymentToken, buyer, instructionId, PAYMENT_AMOUNT } =
        await loadFixture(createdSettlementFixture);

      await paymentToken.connect(buyer).approve(await dvp.getAddress(), PAYMENT_AMOUNT * 2n);
      await dvp.connect(buyer).depositPayment(instructionId);

      await expect(dvp.connect(buyer).depositPayment(instructionId))
        .to.be.revertedWith("DVP: payment already deposited");
    });
  });

  describe("Deposit Securities (Seller Leg)", function () {
    it("should lock seller securities", async function () {
      const { dvp, securityToken, seller, instructionId, SECURITY_AMOUNT } =
        await loadFixture(createdSettlementFixture);

      await securityToken.connect(seller).approve(await dvp.getAddress(), SECURITY_AMOUNT);

      await expect(dvp.connect(seller).depositSecurities(instructionId))
        .to.emit(dvp, "SecuritiesLocked")
        .withArgs(instructionId, seller.address, SECURITY_AMOUNT);
    });

    it("should reject securities deposit from non-seller", async function () {
      const { dvp, securityToken, buyer, instructionId, SECURITY_AMOUNT } =
        await loadFixture(createdSettlementFixture);

      await securityToken.connect(buyer).approve(await dvp.getAddress(), SECURITY_AMOUNT);
      await expect(dvp.connect(buyer).depositSecurities(instructionId))
        .to.be.revertedWith("DVP: not seller");
    });

    it("should transition to LEGS_LOCKED when both legs deposited", async function () {
      const { dvp, instructionId } = await loadFixture(legsLockedFixture);
      const settlement = await dvp.getSettlement(instructionId);
      expect(settlement.status).to.equal(3); // LEGS_LOCKED
    });
  });

  // =========================================================================
  // Atomic Settlement (Happy Path)
  // =========================================================================

  describe("Atomic Settlement — Happy Path", function () {
    it("should execute atomic DvP and deliver assets to correct parties", async function () {
      const { dvp, securityToken, paymentToken, ccp, buyer, seller, instructionId, PAYMENT_AMOUNT, SECURITY_AMOUNT } =
        await loadFixture(legsLockedFixture);

      const buyerPayBefore = await paymentToken.balanceOf(buyer.address);
      const buyerSecBefore = await securityToken.balanceOf(buyer.address);
      const sellerPayBefore = await paymentToken.balanceOf(seller.address);
      const sellerSecBefore = await securityToken.balanceOf(seller.address);

      await expect(dvp.connect(ccp).approveAndSettle(instructionId))
        .to.emit(dvp, "SettlementCompleted")
        .withArgs(
          instructionId,
          TRADE_ID,
          buyer.address,
          seller.address,
          SECURITY_AMOUNT,
          PAYMENT_AMOUNT,
          anyValue
        );

      // Verify final balances
      expect(await securityToken.balanceOf(buyer.address)).to.equal(buyerSecBefore + SECURITY_AMOUNT);
      expect(await paymentToken.balanceOf(seller.address)).to.equal(sellerPayBefore + PAYMENT_AMOUNT);
    });

    it("should update settlement statistics after completion", async function () {
      const { dvp, ccp, instructionId, PAYMENT_AMOUNT } = await loadFixture(legsLockedFixture);

      await dvp.connect(ccp).approveAndSettle(instructionId);

      expect(await dvp.totalSettled()).to.equal(1);
      expect(await dvp.totalValueSettled()).to.equal(PAYMENT_AMOUNT);
    });

    it("should mark settlement as SETTLED", async function () {
      const { dvp, ccp, instructionId } = await loadFixture(legsLockedFixture);

      await dvp.connect(ccp).approveAndSettle(instructionId);

      const settlement = await dvp.getSettlement(instructionId);
      expect(settlement.status).to.equal(4); // SETTLED
      expect(settlement.settledAt).to.be.gt(0);
    });
  });

  // =========================================================================
  // CCP Rejection
  // =========================================================================

  describe("CCP Rejection", function () {
    it("should allow CCP to reject and return deposits", async function () {
      const { dvp, securityToken, paymentToken, ccp, buyer, seller, instructionId, PAYMENT_AMOUNT, SECURITY_AMOUNT } =
        await loadFixture(legsLockedFixture);

      const buyerBalBefore = await paymentToken.balanceOf(buyer.address);
      const sellerBalBefore = await securityToken.balanceOf(seller.address);

      await expect(dvp.connect(ccp).rejectSettlement(instructionId, "COUNTERPARTY_DEFAULT"))
        .to.emit(dvp, "SettlementCancelled")
        .withArgs(instructionId, TRADE_ID, "COUNTERPARTY_DEFAULT", ccp.address);

      // Deposits returned
      expect(await paymentToken.balanceOf(buyer.address)).to.equal(buyerBalBefore + PAYMENT_AMOUNT);
      expect(await securityToken.balanceOf(seller.address)).to.equal(sellerBalBefore + SECURITY_AMOUNT);
    });

    it("should reject settlement by non-CCP", async function () {
      const { dvp, attacker, instructionId } = await loadFixture(legsLockedFixture);

      await expect(dvp.connect(attacker).rejectSettlement(instructionId, "ATTACK"))
        .to.be.reverted;
    });

    it("should require a reason for rejection", async function () {
      const { dvp, ccp, instructionId } = await loadFixture(legsLockedFixture);

      await expect(dvp.connect(ccp).rejectSettlement(instructionId, ""))
        .to.be.revertedWith("DVP: reason required");
    });
  });

  // =========================================================================
  // Timeout / Expiry
  // =========================================================================

  describe("Settlement Expiry", function () {
    it("should expire a settlement past the deadline", async function () {
      const { dvp, paymentToken, buyer, seller, instructionId, PAYMENT_AMOUNT, SECURITY_AMOUNT } =
        await loadFixture(legsLockedFixture);

      // Advance time past deadline
      await time.increase(ONE_DAY + 1);

      const buyerBalBefore = await paymentToken.balanceOf(buyer.address);
      await dvp.connect(buyer).expireSettlement(instructionId); // anyone can trigger

      // Funds returned
      expect(await paymentToken.balanceOf(buyer.address)).to.equal(buyerBalBefore + PAYMENT_AMOUNT);
    });

    it("should block CCP settlement of expired instruction", async function () {
      const { dvp, ccp, instructionId } = await loadFixture(legsLockedFixture);

      await time.increase(ONE_DAY + 1);

      await expect(dvp.connect(ccp).approveAndSettle(instructionId))
        .to.be.revertedWith("DVP: settlement expired");
    });

    it("should reject expiry call before deadline", async function () {
      const { dvp, buyer, instructionId } = await loadFixture(legsLockedFixture);

      await expect(dvp.connect(buyer).expireSettlement(instructionId))
        .to.be.revertedWith("DVP: not yet expired");
    });
  });

  // =========================================================================
  // Participant Withdrawal
  // =========================================================================

  describe("Participant Withdrawal", function () {
    it("should allow buyer to withdraw before both legs locked", async function () {
      const { dvp, paymentToken, buyer, instructionId, PAYMENT_AMOUNT } =
        await loadFixture(createdSettlementFixture);

      await paymentToken.connect(buyer).approve(await dvp.getAddress(), PAYMENT_AMOUNT);
      await dvp.connect(buyer).depositPayment(instructionId);

      const balBefore = await paymentToken.balanceOf(buyer.address);
      await dvp.connect(buyer).withdrawFromSettlement(instructionId);
      expect(await paymentToken.balanceOf(buyer.address)).to.equal(balBefore + PAYMENT_AMOUNT);
    });

    it("should reject withdrawal after both legs locked", async function () {
      const { dvp, buyer, instructionId } = await loadFixture(legsLockedFixture);

      await expect(dvp.connect(buyer).withdrawFromSettlement(instructionId))
        .to.be.revertedWith("DVP: cannot withdraw - both legs locked or terminal");
    });

    it("should reject withdrawal by non-party", async function () {
      const { dvp, attacker, instructionId } = await loadFixture(createdSettlementFixture);

      await expect(dvp.connect(attacker).withdrawFromSettlement(instructionId))
        .to.be.revertedWith("DVP: not a party");
    });
  });

  // =========================================================================
  // Double-Settle Prevention
  // =========================================================================

  describe("Double-Settle Prevention", function () {
    it("should prevent settling an already-settled instruction", async function () {
      const { dvp, ccp, instructionId } = await loadFixture(legsLockedFixture);

      await dvp.connect(ccp).approveAndSettle(instructionId);
      await expect(dvp.connect(ccp).approveAndSettle(instructionId))
        .to.be.revertedWith("DVP: legs not locked");
    });

    it("should prevent settling a cancelled instruction", async function () {
      const { dvp, ccp, instructionId } = await loadFixture(legsLockedFixture);

      await dvp.connect(ccp).rejectSettlement(instructionId, "TEST");
      await expect(dvp.connect(ccp).approveAndSettle(instructionId))
        .to.be.revertedWith("DVP: legs not locked");
    });
  });

  // =========================================================================
  // Pause
  // =========================================================================

  describe("Pause", function () {
    it("should block deposits when paused", async function () {
      const { dvp, admin, paymentToken, buyer, instructionId, PAYMENT_AMOUNT } =
        await loadFixture(createdSettlementFixture);

      await dvp.connect(admin).pause();
      await paymentToken.connect(buyer).approve(await dvp.getAddress(), PAYMENT_AMOUNT);

      await expect(dvp.connect(buyer).depositPayment(instructionId))
        .to.be.reverted;
    });
  });
});
