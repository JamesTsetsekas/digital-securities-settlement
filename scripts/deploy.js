/**
 * deploy.js
 * Deploys the full Digital Securities Settlement suite to a local Hardhat node.
 *
 * Deployment order:
 *  1. ComplianceRegistry
 *  2. SecurityToken (references ComplianceRegistry)
 *  3. DVPSettlement
 *  4. MockERC20 (USDC stand-in for local testing)
 *
 * Usage:
 *   npx hardhat node                                   # Start local node
 *   npx hardhat run scripts/deploy.js --network localhost
 */

const { ethers } = require("hardhat");

async function main() {
  const [deployer, admin, issuer, complianceOfficer, transferAgent, ccp, settlementAgent] =
    await ethers.getSigners();

  console.log("=".repeat(70));
  console.log("  Digital Securities Settlement Suite — Deployment");
  console.log("=".repeat(70));
  console.log(`\nDeployer:          ${deployer.address}`);
  console.log(`Admin (multi-sig): ${admin.address}`);
  console.log(`Issuer:            ${issuer.address}`);
  console.log(`Compliance Officer:${complianceOfficer.address}`);
  console.log(`Transfer Agent:    ${transferAgent.address}`);
  console.log(`CCP:               ${ccp.address}`);
  console.log(`Settlement Agent:  ${settlementAgent.address}\n`);

  // -------------------------------------------------------------------------
  // 1. ComplianceRegistry
  // -------------------------------------------------------------------------
  console.log("Deploying ComplianceRegistry...");
  const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry");
  const registry = await ComplianceRegistry.deploy(admin.address, complianceOfficer.address);
  await registry.waitForDeployment();
  console.log(`  ✓ ComplianceRegistry: ${await registry.getAddress()}`);

  // -------------------------------------------------------------------------
  // 2. SecurityToken
  // -------------------------------------------------------------------------
  console.log("Deploying SecurityToken...");
  const SecurityToken = await ethers.getContractFactory("SecurityToken");
  const securityToken = await SecurityToken.deploy(
    "Acme Corp Series A Preferred",  // name
    "ACME-A",                         // symbol
    "037833100",                      // CUSIP (Apple Inc — for demo)
    "EQUITY",                         // security type
    ethers.parseUnits("10000000", 18), // 10M max supply
    await registry.getAddress(),
    admin.address,
    issuer.address,
    complianceOfficer.address,
    transferAgent.address
  );
  await securityToken.waitForDeployment();
  console.log(`  ✓ SecurityToken:     ${await securityToken.getAddress()}`);

  // -------------------------------------------------------------------------
  // 3. MockERC20 (USDC stand-in)
  // -------------------------------------------------------------------------
  console.log("Deploying MockUSDC...");
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
  await usdc.waitForDeployment();
  console.log(`  ✓ MockUSDC:          ${await usdc.getAddress()}`);

  // -------------------------------------------------------------------------
  // 4. DVPSettlement
  // -------------------------------------------------------------------------
  console.log("Deploying DVPSettlement...");
  const DVPSettlement = await ethers.getContractFactory("DVPSettlement");
  const dvp = await DVPSettlement.deploy(
    admin.address,
    ccp.address,
    settlementAgent.address,
    86400 // T+1 (24-hour settlement window)
  );
  await dvp.waitForDeployment();
  console.log(`  ✓ DVPSettlement:     ${await dvp.getAddress()}\n`);

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log("=".repeat(70));
  console.log("  Deployment Complete");
  console.log("=".repeat(70));
  console.log("\nContract Addresses:");
  console.log(`  ComplianceRegistry : ${await registry.getAddress()}`);
  console.log(`  SecurityToken      : ${await securityToken.getAddress()}`);
  console.log(`  MockUSDC           : ${await usdc.getAddress()}`);
  console.log(`  DVPSettlement      : ${await dvp.getAddress()}\n`);
  console.log("Run the demo with:");
  console.log("  npx hardhat run scripts/demo.js --network localhost\n");

  return {
    registry: await registry.getAddress(),
    securityToken: await securityToken.getAddress(),
    usdc: await usdc.getAddress(),
    dvp: await dvp.getAddress(),
  };
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
