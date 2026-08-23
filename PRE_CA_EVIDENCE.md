# Link ERP: Pre-Pilot Evidence Package

**Target Status:** Evidence draft — not a CA opinion and not a pilot approval.
**Code Readiness Score:** Superseded by the current verified release result and
the gated handover in `docs/CA_REVIEW_AND_MILL_PILOT.md`.

This document serves as the definitive baseline evidence that Link ERP is mathematically sound, securely architected, and operationally safe for a controlled mill pilot with a real Indian textile converter.

## What is Proven in Code

### 1. Ironclad Double-Entry Core
No inventory moves without a corresponding accounting ledger posting.
- **Inwards/Outwards:** Dispatching fabric issues a `stock_loss` to inventory and a `sales_finish` to the ledger.
- **Write-offs & Damage:** Missing pieces do not just vanish; they are explicitly credited out of `inventory_finish` and debited to a dedicated write-off expense ledger (`ledger_account`).
- **Trial Balance Integrity:** CI tests repeatedly subject the system to 200+ piece bulk movements, returns, and multi-tenant isolation scenarios. The trial balance mathematically balances to `0.00` with strict floating-point/decimal boundaries.

### 2. Maker-Checker Operations
Destructive or financially impactful workflows cannot be single-handedly executed.
- **Pending Approvals Layer:** Actions like Write-offs, Stock Counts, Customer Returns, and Credit/Debit Notes go into `deferred_voucher`.
- **Role Enforcement:** The `approveDocument` engine enforces that the user who initiated the action cannot approve it. Master configuration (`approval_rule`) governs who has authority.

### 3. Godown / Mill Floor Resilience
The UI assumes a hostile physical environment.
- **Offline Queues:** Scanning pieces on `LiveGreyInwardView`, `DyeingReceiptView`, and `ScanDocumentView` intercepts dropped HTTP requests (`TypeError: Failed to fetch`). Un-synced scans are routed to `IndexedDB` and flushed automatically when Wi-Fi returns.
- **Scale Bounds:** Stock lists are server-paged, and the volume gate measures
  150,000 pieces plus 465,000 movements without loading an entire warehouse
  into one browser response.

### 4. Security & Hardening
- **Authentication:** Token revocations and brute-force IP throttling (600 RPM)
  are backed by the database. Signing keys carry IDs and support a bounded
  previous-key rotation window.
- **Role Scoping:** Every destructive API endpoint is protected by role-based Express middleware (e.g., `requireWrite('store')`, `requireWrite('accounts')`).
- **Data Isolation (RLS Pattern):** Test suites aggressively ensure that tokens forged with an alternate `tenantId` cannot fetch rows from competing companies.

## What Remains Externally Unproven

The following claims **are explicitly excluded** from this software release and require independent validation:

### A. Statutory Compliance (Chartered Accountant Review)
- Do the structural alignments of `GSTR-1` and `GSTR-3B` JSON payloads perfectly map to the Indian statutory portal for edge-case taxation (e.g., reverse charge mechanisms on unregistered job workers, cross-state SGST/CGST split logic)?
- Are `ITC-04` tracking limits (1 year / 3 year return mandates for job workers) alerting correctly under live CA audit standards?
*Requires CA signature on pilot data.*

### B. Live E-Invoice / E-Way Bill Interfacing
- The codebase structures the payloads for the IRP (Invoice Registration Portal) and NIC portals, but it is unproven against live government server latency, downtime, and schema version changes.
*Requires Sandbox/Production GSP token validation.*

### C. True Concurrency at Massive Scale
- The CI verifies 200-piece loads without triggering Postgres N+1 queries. However, it does not guarantee how lock contention behaves if 50 warehouse workers dispatch 10,000 pieces simultaneously across 5 distinct process houses.
*Requires a real mill pilot.*

---
**Verdict:** Code evidence may support a controlled-pilot evaluation only after
the CA review, mill setup, and pilot gates in `docs/CA_REVIEW_AND_MILL_PILOT.md`
are completed. Do not treat this document as a statutory or production approval.
