# NearNet

> **Confidential Multilateral Debt Netting with NEAR Intents & Anchored Receipts**  
> Built for the **NEAR HACKATHON 2026**.

[![NEAR Testnet](https://img.shields.io/badge/NEAR-Testnet-blue?logo=near)](https://testnet.nearblocks.io/address/netter.testnet)
[![Phala Network](https://img.shields.io/badge/TEE-Intel%20TDX%20(Phala%20dstack)-purple)](https://phala.network)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Tracks

* **Privacy & Private AI (`privacy`)** — *Primary*: Uses Phala Network's dstack Intel TDX Confidential VM (CVM) with remote hardware attestation. All invoice data is encrypted client-side in the browser using Curve25519 (`crypto_box_seal`) before transmission; plaintext only exists in enclave cache/memory.
* **Real-World Money (`realworld`)**: B2B invoice clearing and debt cancellation for commercial supply chains, eliminating trapped working capital through stablecoin rails.
* **Autonomous Business (`business`)**: Autonomous, trustless debt settlement with cross-chain payment routing via **NEAR Intents (1Click)**.
* **Unstoppable DeFi (`defi`)**: Non-custodial clearing engine that nets multi-party obligations down to minimal bilateral settlements.

---

## The Problem

In modern supply chains and inter-company commerce, circular debts are ubiquitous:
* **Company A** owes **Company B** \$100,000.
* **Company B** owes **Company C** \$80,000.
* **Company C** owes **Company A** \$70,000.

Rather than moving \$250,000 across banking rails (incurring wire fees, liquidity locks, and foreign exchange friction), multilateral netting can mathematically cancel circular debts down to a tiny net difference (\$30,000).

**The Blocker:** To net invoices, companies must reveal their raw books—who they buy from, who they sell to, pricing margins, and payment terms. Businesses refuse to share this proprietary data with counterparties or third-party centralized clearing houses.

---

## The Solution

**NearNet** solves this deadlock through confidential computing and verifiable on-chain settlement:

1. **Hardware Enclave (Phala dstack Intel TDX):** The netting engine runs inside a hardware-isolated Confidential VM. No server operator, cloud provider, or coordinator can access memory.
2. **Client-Side Encryption:** Each company generates a Curve25519 keypair in browser memory. Invoices are encrypted client-side using the enclave's attested public key before sending.
3. **Confidential Netting Engine:** The enclave decrypts payloads, matches cross-claims where reference numbers and amounts agree, exempts fraudulent/mismatched invoices, and calculates the minimum net cash transfers needed to settle all accounts.
4. **Private Results:** Each company decrypts **only** their own net balance.
5. **NEAR Intents (1Click) Settlement:** Debtors can quote and execute cross-chain stablecoin payouts directly to the creditor's designated NEAR address.
6. **Immutable On-Chain Verification (NEAR Smart Contract):** The enclave signs a SHA-256 Merkle root of the netting receipt with its hardware-bound Ed25519 key. This receipt is anchored to `netter.testnet`, allowing any participant to prove the mathematical integrity of the netting cycle on-chain.

---

## Live Deployments & Testnet Infrastructure

| Component | Identifier / URL | Details |
| :--- | :--- | :--- |
| **NEAR Contract (Testnet)** | [`netter.testnet`](https://testnet.nearblocks.io/address/netter.testnet) | Registry for authorized TEE engine keys and anchored receipts |
| **Phala Intel TDX Enclave** | `https://6adc4169c7edd4ee726842816341df6257022bfd-8000.dstack-pha1-prod5.phala.network` | Live `tdx.small` CVM running `dstack-0.5.12` |
| **Attestation Platform** | `dstack-tdx` | Genuine Intel TDX remote attestation with quote & event log |
| **Engine Ed25519 Public Key** | `9fee328a6a0766a736cc89c151ccd0187879c56dc04f92866011860c3762af17` | Hardware-bound signing key registered in `netter.testnet` |

---

## System Architecture

```
[ Browser / Company A ]         [ Browser / Company B ]
       |                                |
       | 1. Generate Curve25519 keys    | 1. Generate Curve25519 keys
       | 2. Fetch & verify TDX Quote    | 2. Fetch & verify TDX Quote
       | 3. Seal invoices (NaCl Box)    | 3. Seal invoices (NaCl Box)
       \_________________   ____________/
                         \ /
                          v
         +---------------------------------+
         |    Coordinator (Untrusted Relay)|
         |       (Port 8001 / REST API)    |
         +---------------------------------+
                          |
                          v (Forward Ciphertext)
       +---------------------------------------+
       |   Phala Network Intel TDX Enclave     |
       |  (dstack CVM / Hardware Attested)     |
       |                                       |
       |  - Decrypt payloads in secure RAM     |
       |  - Validate matching invoice pairs    |
       |  - Multi-party cycle debt netting     |
       |  - Compute SHA-256 Merkle Tree        |
       |  - Sign receipt with Ed25519          |
       +---------------------------------------+
                          |
              +-----------+-----------+
              |                       |
              v                       v
      [ Sealed Results ]       [ Anchor Receipt ]
              |                       |
              v                       v
     Decrypted in Browser    +-------------------+
     1Click NEAR Intents     |  NEAR Blockchain  |
     Cross-Chain Payout      |  (netter.testnet) |
                             +-------------------+
```

---

## Step-by-Step Verification Guide for Judges ("Do X — See Y")

Follow these steps to run the web application, interact with the live Phala Intel TDX enclave, and verify on-chain receipts on NEAR.

### Prerequisites

* Node.js v18+ & npm
* Python 3.11+
* Git

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/<your-username>/nearnet.git
cd nearnet

# Install Dashboard dependencies
cd dashboards
npm install
cd ..

# Install Engine/Coordinator dependencies
pip install fastapi uvicorn httpx pynacl pydantic python-dotenv
```

### 2. Configure Environment

Confirm `engine/.env` points to the live Phala CVM:
```env
ENGINE_URL=https://6adc4169c7edd4ee726842816341df6257022bfd-8000.dstack-pha1-prod5.phala.network
```

Confirm `dashboards/.env.local`:
```env
NEAR_RPC=https://test.rpc.fastnear.com
NEAR_CONTRACT=netter.testnet
NEXT_PUBLIC_NEAR_CONTRACT=netter.testnet
COORDINATOR_URL=http://127.0.0.1:8001
```

### 3. Start the Coordinator & Dashboard

Open two terminal windows:

**Terminal 1 (Coordinator Relay):**
```bash
uvicorn app.coordinator:app_from_env --port 8001
```

**Terminal 2 (Next.js Dashboard):**
```bash
cd dashboards
npm run dev
```

Open your browser to `http://localhost:3000`.

---

### 4. Step-by-Step Walkthrough ("Do X — See Y")

#### Step 4.1: Inspect the Hardware Attestation
* **Do:** Open `http://localhost:3000` and look at the top header badge.
* **See:** The badge displays **`dstack-tdx verified`** with a green shield. Clicking it shows the Intel TDX report data and public encryption keys bound to the physical hardware enclave.

#### Step 4.2: Create a Netting Cycle
* **Do:** Under **"Create Netting Cycle"**:
  * Set Currency: `USD`
  * Add Expected Participants: `Acme`, `Beta`
  * Click **"Create Cycle"**.
* **See:** The UI creates the cycle and displays the **Active Cycle Banner** with a unique `Cycle ID` (e.g. `cycle-xyz...`) and status `open`.

#### Step 4.3: Join and Register Browser Keys
* **Do:** Under **"Cycle Participants & Slots"**, click **"Claim as Acme"**.
* **See:** The browser generates an ephemeral Curve25519 keypair and registers Acme's slot.

#### Step 4.4: Enter & Encrypt Invoices
* **Do:** In the invoice form for Acme:
  * Reference: `INV-101`
  * Counterparty: `Beta`
  * Direction: `They owe me`
  * Amount: `50000`
  * Enter a test payout address (e.g. `acme.near`).
  * Click **"Encrypt & Submit"**.
* **See:** The browser seals the payload using `tweetnacl.box` against the Phala enclave's public key. The submission is acknowledged by the enclave (`Acknowledged seq 1`).

#### Step 4.5: Simulate Second Participant (Beta)
* **Do:** Open an Incognito/Private browser window or switch company selector to `Beta`. Claim slot for `Beta`, enter counter-invoice:
  * Reference: `INV-101`
  * Counterparty: `Acme`
  * Direction: `I owe them`
  * Amount: `50000`
  * Click **"Encrypt & Submit"**.
* **See:** Beta's invoice is submitted and acknowledged.

#### Step 4.6: Close and Net Cycle
* **Do:** Click **"Close & Net Cycle"**.
* **See:** The enclave executes the netting algorithm inside Intel TDX. Cycle status transitions to `settled`.

#### Step 4.7: View Confidential Results & NEAR Intents
* **Do:** Scroll to **"Cycle Results"**.
* **See:** 
  * Only Acme's own decrypted net position is shown (\$0 net after perfect netting).
  * If an imbalance exists, debtors see a **"Settle via NEAR Intents"** button with a live cross-chain dry-run quote.

#### Step 4.8: Verify Receipt on NEAR
* **Do:** Click **"Verify Receipt on NEAR"**.
* **See:** The application calls NEAR RPC (`test.rpc.fastnear.com`) against `netter.testnet`, validating:
  * Anchor status: `Anchored on-chain`
  * Engine Key: `Registered & Valid`
  * Cryptographic Signature: `Ed25519 Signature Verified`
  * Merkle Root Match: `Exact Match`

---

## CLI On-Chain Verification

Judges can independently verify anchored receipts without using the browser UI via our CLI script:

```bash
cd contracts
node tools/verify.mjs \
  --rpc https://test.rpc.fastnear.com \
  --contract netter.testnet \
  --cycle <cycle_id>
```

**Expected output:**
```text
OK: receipt for cycle <cycle_id> is anchored and correctly signed
  root:         d189d36be585...
  participants: 2
  anchored by:  netter.testnet at block 184920192
  engine key:   9fee328a6a0766a736cc89c151ccd0187879c56dc04f92866011860c3762af17
```

---

## Smart Contract Details (`contracts/`)

The contract is written with `near-sdk-js` and deployed to `netter.testnet`:

* `init({ owner })`: Initializes the registry and designates the admin account.
* `register_engine({ signing_public_key, report_data })`: Authorizes an Intel TDX engine by registering its hardware-bound Ed25519 signing key and TDX report data.
* `anchor_receipt({ cycle_id, root, participants, engine_key, signature })`: Verifies and immutably records the engine's signed Merkle root of a settled netting cycle.
* `get_receipt({ cycle_id })`: View call returning the anchored receipt.
* `get_engine({ signing_public_key })`: View call verifying engine registration status.

---

## Third-Party Libraries & Disclosures (Q-005)

* **Blockchain:** `near-sdk-js` (NEAR smart contract framework).
* **Cryptography:** `tweetnacl` (browser Curve25519 Box / Ed25519), Python `pynacl`, `hashlib`.
* **Confidential Computing:** `dstack-sdk` (Phala Network Intel TDX guest agent integration).
* **Web & API:** `next.js` 16, `react` 19, `fastapi`, `pydantic`, `httpx`.
* **Cross-Chain Intents:** `1Click` API (`1click.chaindefuser.com`).

---

## License

This project is licensed under the [MIT License](LICENSE).
