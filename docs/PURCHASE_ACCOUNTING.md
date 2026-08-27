# How a receipt and its bill are booked

**Status: fixed by migration 068 on 2026-08-27.** This page records what was
wrong, what replaced it, and what a mill with older books still has to do.

## What was wrong

Two independent paths credited the supplier for the same delivery, and nothing
linked or reconciled them.

| Event | Posting |
|---|---|
| Grey inward | Dr Grey Stock **30,500** / Cr Weaver **30,500** |
| Purchase invoice, kind `grey` | Dr Trading Purchase **30,500** + Dr GST Input **1,525** / Cr Weaver **32,025** |

One delivery of 1,000 mtr at ₹30.50 left the weaver credited **₹62,525**
against goods worth ₹32,025 including GST, and the same cost sat in **Grey
Stock (an asset)** and **Trading Purchase (Direct Expenses)** at once.

The trial balance still balanced, because both sides doubled. That is exactly
why nothing caught it.

The same fault ran through job work, and had not been noticed at all: a dyeing
receipt credited the process house for the processing, and the process house's
bill credited it again.

Underneath both was a missing link — the purchase invoice API accepted no
reference to the delivery it settled, so the system could not have told the
difference between a bill for goods already received and a fresh purchase.

## What it does now

The receipt accrues to a clearing liability; the bill clears it and credits
the supplier.

| Event | Posting |
|---|---|
| Grey inward | Dr Grey Stock / Cr **Grey Received — Not Yet Billed** (991) |
| Bill against that inward | Dr **991** + Dr GST Input / Cr Weaver |
| Dyeing receipt | Dr Finish Stock / Cr Grey Stock / Cr **Job Work Done — Not Yet Billed** (992) |
| Bill against that receipt | Dr **992** + Dr GST Input / Cr Process House |
| Bill with no receipt behind it | Dr Trading Purchase / Dr GST Input / Cr Supplier — unchanged |

Stock is still valued the day it arrives. A supplier's ledger now shows only
what he has actually billed, which is what bill-wise outstanding and a ledger
confirmation both need.

`sourceDoc` and `sourceId` on a purchase invoice carry the link. They are
verified, not trusted: the document must exist, still be live, and belong to
the supplier being billed. A bill pointing at another supplier's delivery is
refused, because it would clear an accrual that supplier never raised.

## What it gives the mill

**Received But Not Billed** — a report of what is in the godown that nobody
has invoiced yet, party-wise, with the age of each delivery. The clearing
ledgers are control totals with no party dimension, so the detail is derived
from the documents. It is a number an owner wants weekly, and it did not exist
before.

## Books written before the fix

Vouchers already posted under the old scheme are **not rewritten**. A posted
document is reversed, never silently edited, and quietly restating history
would be worse than the original defect.

**Bills Booked Twice (Before The Fix)** lists every bill raised against a
receipt before migration 068 applied. Take it to your accountant: each row is
a journal entry to pass, debiting the supplier and crediting Trading Purchase
or Dyeing & Processing Charges by the taxable value shown. The report is
empty for a mill that starts on 068 or later.

## Held by

`server/test/purchase-double-count.test.ts` — six tests covering the accrual,
the bill that clears it, the bill that stands alone, the bill pinned to the
wrong supplier, and the unbilled report. It was a skipped reproduction of the
defect; it is now the thing that stops it coming back.
