/**
 * demo.js
 * End-to-end demonstration of the DVP settlement workflow.
 *
 * Simulates a full T+1 settlement lifecycle:
 *  - Compliance onboarding (KYC, accreditation)
 *  - Security token issuance
 *  - Trade matching (off-chain) → settlement instruction creation (on-chain)
 *  - Buyer deposits USDC (payment leg)
 *  - Seller deposits security tokens (delivery leg)
 *  - CCP approves atomic settlement
 *  - Final balance verification
 *
 * Usage:
 *   npx hardhat node (in a separate terminal)
 *   npx hardhat run scripts/demo.js --network localhost
 */

const { ethers } = require("hardhat");

// Formatting helpers
const fmt = (label, value) => console.log(`  ${label.padEnd(32)} ${value}`);
const section = (title) => {
  console.log("\n" + "─".repeat(70));
  console.log(`  ${title}`);
  console.log("─".repeat(70));
};

async function main() {
  const signers = await ethers.getSigners();
  const [deployer, admin, issuer, complianceOfficer, transferAgent, ccp, settlementAgent, buyer, seller] =
    signers;

  console.log("\n" + "=".repeat(70));
  console.log("  DTCC Digital Securities Settlement — End-to-End Demo");
  console.log("  Simulating T+1 DvP Settlement (Project Ion prototype)");
  console.log("=".repeat(70));

  // =========================================================================
  // STEP 1: Deploy contracts
  // =========================================================================
  section("Step 1: Deploying Contracts");

  const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry");
  const registry = await ComplianceRegistry.deploy(admin.address, complianceOfficer.address);
  await registry.waitForDeployment();
  fmt("ComplianceRegistry:", await registry.getAddress());

  const SecurityToken = await ethers.getContractFactory("SecurityToken");
  const securityToken = await SecurityToken.deploy(
    "Acme Corp Series A Preferred", "ACME-A", "037833100", "EQUITY",
    ethers.parseUnits("1000000", 18),
    await registry.getAddress(),
    admin.address, issuer.address, complianceOfficer.address, transferAgent.address
  );
  await securityToken.waitForDeployment();
  fmt("SecurityToken (ACME-A):", await securityToken.getAddress());

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
  await usdc.waitForDeployment();
  fmt("MockUSDC:", await usdc.getAddress());

  const DVPSettlement = await ethers.getContractFactory("DVPSettlement");
  const dvp = await DVPSettlement.deploy(
    admin.address, ccp.address, settlementAgent.address, 86400
  );
  await dvp.waitForDeployment();
  fmt("DVPSettlement:", await dvp.getAddress());

  // =========================================================================
  // STEP 2: Compliance Onboarding
  // =========================================================================
  section("Step 2: Compliance Onboarding (KYC / AML / Accreditation)");

  console.log("\n  Onboarding Buyer...");
  await registry.connect(complianceOfficer).setKYCStatus(buyer.address, 2, 0); // APPROVED
  await registry.connect(complianceOfficer).setAccreditation(buyer.address, true, false);
  await registry.connect(complianceOfficer).setJurisdiction(buyer.address, "US");
  fmt("Buyer KYC Status:", "APPROVED");
  fmt("Buyer Accredited Investor:", "YES");
  fmt("Buyer Jurisdiction:", "US");

  console.log("\n  Onboarding Seller...");
  await registry.connect(complianceOfficer).setKYCStatus(seller.address, 2, 0); // APPROVED
  await registry.connect(complianceOfficer).setAccreditation(seller.address, true, false);
  await registry.connect(complianceOfficer).setJurisdiction(seller.address, "US");
  fmt("Seller KYC Status:", "APPROVED");
  fmt("Seller Accredited Investor:", "YES");
  fmt("Seller Jurisdiction:", "US");

  // Whitelist participants
  await securityToken.connect(complianceOfficer).addToWhitelist(buyer.address);
  await securityToken.connect(complianceOfficer).addToWhitelist(seller.address);
  await securityToken.connect(complianceOfficer).addToWhitelist(await dvp.getAddress());
  // Disable registry checks for DVP escrow contract (custodian exemption)
  await securityToken.connect(complianceOfficer).setComplianceChecks(false);
  fmt("\nWhitelist:", "Buyer, Seller, DVP Contract ✓");

  // =========================================================================
  // STEP 3: Security Issuance
  // =========================================================================
  section("Step 3: Security Token Issuance");

  const SECURITY_AMOUNT = ethers.parseUnits("500", 18); // 500 shares
  const PAYMENT_AMOUNT = ethers.parseUnits("125000", 6); // $125,000 USDC ($250/share)

  await securityToken.connect(issuer).mint(seller.address, SECURITY_AMOUNT);
  await usdc.mint(buyer.address, PAYMENT_AMOUNT);

  fmt("Issued to Seller:", `${ethers.formatUnits(SECURITY_AMOUNT, 18)} ACME-A shares`);
  fmt("Funded to Buyer:", `$${ethers.formatUnits(PAYMENT_AMOUNT, 6)} USDC`);
  fmt("Implied Price:", `$${250} per share`);

  // =========================================================================
  // STEP 4: Trade Matching → Settlement Instruction
  // =========================================================================
  section("Step 4: Trade Match → Settlement Instruction Creation");

  const tradeId = ethers.keccak256(ethers.toUtf8Bytes("ACME-A/2024-03-15/BUY/500@250"));
  console.log(`\n  Trade ID: ${tradeId}`);

  const tx = await dvp.connect(settlementAgent).createSettlement(
    tradeId,
    buyer.address,
    seller.address,
    await securityToken.getAddress(),
    await usdc.getAddress(),
    SECURITY_AMOUNT,
    PAYMENT_AMOUNT,
    0 // default T+1 window
  );
  const receipt = await tx.wait();

  const event = receipt.logs.find(log => {
    try { return dvp.interface.parseLog(log)?.name === "SettlementCreated"; }
    catch { return false; }
  });
  const parsed = dvp.interface.parseLog(event);
  const instructionId = parsed.args.instructionId;

  fmt("Instruction ID:", instructionId.slice(0, 18) + "...");
  fmt("Status:", "CREATED");
  fmt("Settlement Window:", "T+1 (24 hours)");

  // =========================================================================
  // STEP 5: Leg Deposits
  // =========================================================================
  section("Step 5: Leg Deposits (Escrow Lock)");

  console.log("\n  Buyer deposits $125,000 USDC (payment leg)...");
  await usdc.connect(buyer).approve(await dvp.getAddress(), PAYMENT_AMOUNT);
  await dvp.connect(buyer).depositPayment(instructionId);
  fmt("Payment Leg:", "LOCKED ✓");
  fmt("DVP USDC Balance:", `$${ethers.formatUnits(await usdc.balanceOf(await dvp.getAddress()), 6)}`);

  console.log("\n  Seller deposits 500 ACME-A shares (delivery leg)...");
  await securityToken.connect(seller).approve(await dvp.getAddress(), SECURITY_AMOUNT);
  await dvp.connect(seller).depositSecurities(instructionId);
  fmt("Delivery Leg:", "LOCKED ✓");
  fmt("DVP Token Balance:", `${ethers.formatUnits(await securityToken.balanceOf(await dvp.getAddress()), 18)} ACME-A`);
  fmt("Status:", "LEGS_LOCKED");

  // =========================================================================
  // STEP 6: CCP Approval & Atomic Settlement
  // =========================================================================
  section("Step 6: CCP Approval → Atomic Settlement");

  console.log("\n  Pre-settlement balances:");
  fmt("  Buyer ACME-A:", ethers.formatUnits(await securityToken.balanceOf(buyer.address), 18));
  fmt("  Seller USDC:", `$${ethers.formatUnits(await usdc.balanceOf(seller.address), 6)}`);

  console.log("\n  CCP reviewing settlement instruction...");
  console.log("  CCP approving and executing atomic DvP swap...");
  await dvp.connect(ccp).approveAndSettle(instructionId);

  console.log("\n  Post-settlement balances:");
  fmt("  Buyer ACME-A:", ethers.formatUnits(await securityToken.balanceOf(buyer.address), 18) + " ✓");
  fmt("  Seller USDC:", `$${ethers.formatUnits(await usdc.balanceOf(seller.address), 6)} ✓`);
  fmt("  DVP USDC:", `$${ethers.formatUnits(await usdc.balanceOf(await dvp.getAddress()), 6)}`);
  fmt("  DVP ACME-A:", ethers.formatUnits(await securityToken.balanceOf(await dvp.getAddress()), 18));

  // =========================================================================
  // STEP 7: Summary
  // =========================================================================
  section("Settlement Complete — Final Summary");

  const settlement = await dvp.getSettlement(instructionId);
  const statusNames = ["CREATED", "BUYER_LOCKED", "SELLER_LOCKED", "LEGS_LOCKED", "SETTLED", "CANCELLED"];

  console.log("");
  fmt("Status:", statusNames[Number(settlement.status)] + " 🎯");
  fmt("Total Settled (count):", (await dvp.totalSettled()).toString());
  fmt("Total Value Settled:", `$${ethers.formatUnits(await dvp.totalValueSettled(), 6)} USDC`);

  console.log("\n" + "=".repeat(70));
  console.log("  ✅  DvP Settlement Successful — Principal Risk Eliminated");
  console.log("  Both legs settled atomically. No partial settlement possible.");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ Demo failed:", err.message);
    process.exit(1);
  });
