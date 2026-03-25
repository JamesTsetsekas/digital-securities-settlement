# Digital Securities Settlement

**Atomic Delivery vs. Payment (DvP) settlement infrastructure for tokenized securities**

> A production-quality Solidity implementation demonstrating on-chain settlement mechanics aligned with DTCC's [Project Ion](https://www.dtcc.com/dtcc-connection/articles/2021/september/08/dtcc-accelerates-settlement-cycle-initiative) and the industry's move toward T+1 (and eventually T+0) settlement cycles.

**Author:** James Tsetsekas  
**Stack:** Solidity 0.8.20 · Hardhat · OpenZeppelin v5 · ethers.js v6

---

## Overview

Traditional securities settlement (DTCC CNS) settles trades T+2, with principal risk exposure during the window between trade execution and final settlement. DTCC's Project Ion explores blockchain-based settlement to compress this cycle.

This repository implements the three core smart-contract primitives required for on-chain settlement:

| Contract | Role |
|---|---|
| `ComplianceRegistry` | On-chain KYC/AML/sanctions registry — addresses eligibility for securities transfer |
| `SecurityToken` | ERC-20 security token with transfer restrictions, whitelist, freeze, and role-based access |
| `DVPSettlement` | Atomic Delivery vs. Payment engine — eliminates principal risk through atomic swap |

The key insight: by wrapping both legs (securities + payment) in a single atomic transaction, **the system enforces that both sides settle or neither does** — the same guarantee CNS provides today, but without the T+2 delay.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     PARTICIPANTS                                    │
│                                                                     │
│  ┌──────────┐    ┌──────────┐    ┌───────────────┐                  │
│  │  Buyer   │    │  Seller  │    │  Compliance   │                  │
│  │ (USDC)   │    │ (Tokens) │    │   Officer     │                  │
│  └────┬─────┘    └────┬─────┘    └───────┬───────┘                  │
│       │               │                  │                          │
│       ▼               ▼                  ▼                          │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                DVPSettlement.sol                               │ │
│  │  ┌────────────────┐  ┌─────────────────┐  ┌───────────────────┐│ │
│  │  │  depositPayment│  │depositSecurities│  │approveAndSettle   ││ │
│  │  │  (USDC lock)   │  │ (Token lock)    │  │  (CCP only)       ││ │
│  │  └────────────────┘  └─────────────────┘  └───────────────────┘│ │
│  │                                                                │ │
│  │  Settlement Lifecycle:                                         │ │
│  │  CREATED → BUYER_LOCKED / SELLER_LOCKED → LEGS_LOCKED          │ │
│  │         → SETTLED (atomic) or CANCELLED (returned)             │ │
│  └────────────────────────┬───────────────────────────────────────┘ │
│                           │                                         │
│               ┌───────────┴─────────────┐                           │
│               ▼                         ▼                           │
│  ┌─────────────────────┐    ┌────────────────────────┐              │
│  │  SecurityToken.sol  │    │  ComplianceRegistry.sol │             │
│  │                     │    │                         │             │
│  │  ERC-20 + Controls  │───▶│  KYC · AML · Sanctions  │            │
│  │  ─ Whitelist        │    │  ─ KYCStatus (5 states) │             │
│  │  ─ Freeze/Unfreeze  │    │  ─ Accreditation (Reg D)│             │
│  │  ─ Pause (halt)     │    │  ─ Jurisdiction blocks  │             │
│  │  ─ Forced transfer  │    │  ─ OFAC/SDN sanctions   │             │
│  │  ─ Role-based ACL   │    │  ─ KYC expiry tracking  │             │
│  └─────────────────────┘    └────────────────────────┘              │
└─────────────────────────────────────────────────────────────────────┘

Roles:
  DEFAULT_ADMIN_ROLE  — Multi-sig system admin
  ISSUER_ROLE         — Authorized to mint/burn security tokens
  COMPLIANCE_OFFICER_ROLE — KYC/whitelist/freeze management
  TRANSFER_AGENT_ROLE — Forced transfers (court orders, corporate actions)
  CCP_ROLE            — Central Counterparty (approves/rejects settlements)
  SETTLEMENT_AGENT_ROLE — Creates settlement instructions from matched trades
```

---

## Security Token Design

The `SecurityToken` enforces SEC regulatory requirements at the smart-contract layer:

- **Transfer restrictions** — all transfers validated against a whitelist (transfer agent-maintained)
- **KYC/AML** — integrates with `ComplianceRegistry` for real-time eligibility checks
- **Freeze** — individual accounts can be frozen (OFAC match, court order, regulatory hold)
- **Pause** — system-wide halt for market emergencies or regulatory suspension
- **Forced transfer** — transfer agent can execute involuntary transfers (legal orders, error correction)
- **Burn** — issuer can redeem/seize tokens

---

## DVP Settlement Lifecycle

```
Trade matched (off-chain order book / DTCC matching engine)
      │
      ▼
createSettlement()        ← Settlement Agent creates on-chain obligation
      │                     Status: CREATED
      ├──────────────────────────────────────────────────┐
      ▼                                                  ▼
depositPayment()          ←  Buyer locks USDC      depositSecurities()  ← Seller locks tokens
      │                       Status: BUYER_LOCKED        Status: SELLER_LOCKED
      └──────────────────────────────────────────────────┘
                                    │
                          Both legs locked: LEGS_LOCKED
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
             approveAndSettle()             rejectSettlement()
             (CCP approves)                (CCP rejects / compliance fail)
                    │                               │
                    ▼                               ▼
               SETTLED                         CANCELLED
        Securities → Buyer              USDC returned → Buyer
        USDC → Seller                   Tokens returned → Seller
```

If the settlement window expires before completion, anyone can call `expireSettlement()` to return deposits.

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm 8+

### Install

```bash
npm install
```

### Compile

```bash
npx hardhat compile
```

### Run Tests

```bash
npx hardhat test
```

With gas reporting:
```bash
REPORT_GAS=true npx hardhat test
```

### Run Demo (Full Lifecycle)

Start a local Hardhat node in one terminal:
```bash
npx hardhat node
```

In another terminal:
```bash
npx hardhat run scripts/demo.js --network localhost
```

Expected output:
```
======================================================================
  DTCC Digital Securities Settlement — End-to-End Demo
  Simulating T+1 DvP Settlement (Project Ion prototype)
======================================================================

Step 2: Compliance Onboarding (KYC / AML / Accreditation)
  Buyer KYC Status:            APPROVED
  Buyer Accredited Investor:   YES
  ...

Step 6: CCP Approval → Atomic Settlement
  Buyer ACME-A (before):       0.0
  Buyer ACME-A (after):        500.0 ✓
  Seller USDC (after):         $125000.0 ✓

  ✅  DvP Settlement Successful — Principal Risk Eliminated
```

---

## Project Structure

```
digital-securities-settlement/
├── contracts/
│   ├── ComplianceRegistry.sol   # KYC/AML/sanctions registry
│   ├── SecurityToken.sol        # ERC-20 security token
│   ├── DVPSettlement.sol        # Atomic DvP settlement engine
│   └── mocks/
│       └── MockERC20.sol        # Test helper
├── test/
│   ├── ComplianceRegistry.test.js
│   ├── SecurityToken.test.js
│   └── DVPSettlement.test.js
├── scripts/
│   ├── deploy.js                # Contract deployment
│   └── demo.js                  # End-to-end workflow demo
├── hardhat.config.js
└── package.json
```

---

## Key Design Decisions

**Why ERC-20 + AccessControl vs. ERC-1400/ERC-3643?**  
ERC-1400 (security token standard) adds significant complexity. For this prototype I opted for ERC-20 + OpenZeppelin AccessControl to keep the logic explicit and auditable — easier for hiring managers to read. Production deployment would likely use ERC-3643 (T-REX protocol) or ERC-1400.

**Why on-chain compliance registry?**  
Provides a single source of truth for KYC/sanctions status. All smart contracts reference the same registry — no need to re-verify compliance in each token contract. Mirrors how DTCC maintains a central participant database.

**Settlement atomicity guarantee:**  
Both token transfers (securities → buyer, payment → seller) execute in a single EVM transaction. Either both succeed or the entire tx reverts. This is the on-chain equivalent of CNS's guaranteed delivery against payment.

**T+1 default window:**  
`defaultSettlementWindow = 86400` seconds (24 hours). Configurable per-instruction for same-day or T+2 settlement as needed.

---

## Alignment with DTCC Project Ion

| Project Ion Feature | This Implementation |
|---|---|
| Blockchain-based settlement | Hardhat/EVM — deployable to any EVM chain |
| T+1 settlement cycle | Configurable settlement window (default 24h) |
| CCP guarantee | `CCP_ROLE` approves/rejects settlements |
| Principal risk elimination | Atomic swap — both legs or neither |
| Compliance integration | On-chain KYC/AML via `ComplianceRegistry` |
| Audit trail | Full event log on all state transitions |
| Fail management | Settlement expiry with automatic deposit return |

---

## License

MIT
