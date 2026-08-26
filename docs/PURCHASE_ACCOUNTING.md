# How a grey purchase is booked — an open decision

**Status: a defect is reproduced and unfixed. Read this before trusting any
purchase figure, creditor balance, or gross margin.**

## What happens today

Two independent paths credit the supplier for the same goods, and nothing links
or reconciles them.

| Event | Posting |
|---|---|
| Grey inward (`capitaliseGrey`) | Dr Grey Stock **30,500** / Cr Weaver **30,500** |
| Purchase invoice, kind `grey` | Dr Trading Purchase **30,500** + Dr GST Input **1,525** / Cr Weaver **32,025** |

For one delivery of 1,000 mtr at ₹30.50 the weaver ends up credited
**₹62,525** against goods worth ₹32,025 including GST, and the same cost sits
in **Grey Stock (an asset)** and **Trading Purchase (Direct Expenses)** at the
same time.

The trial balance still balances, because both sides doubled. That is exactly
why nothing catches it.

Reproduced by `server/test/purchase-double-count.test.ts`, which is skipped
rather than deleted: it is the evidence, and it should start passing the day
this is settled.

It is reachable through the ordinary interface. Purchase Invoices offers
"Grey purchase" as its default kind and has no field for linking a bill to an
inward, so an operator entering the weaver's bill for grey already taken into
stock will do this without any warning.

## Why this is a decision and not a bug fix

Three coherent designs exist and only the mill can say which matches how it
actually works.

### A. Goods Received Not Billed — recommended

The inward accrues to a clearing liability instead of the supplier; the bill
clears it and credits the supplier.

| Event | Posting |
|---|---|
| Grey inward | Dr Grey Stock / Cr **Goods Received Not Billed** |
| Purchase invoice against it | Dr **Goods Received Not Billed** + Dr GST Input / Cr Weaver |

*For:* standard practice, values stock the day it arrives, and the supplier
ledger shows only what has actually been billed — which is what bill-wise
outstanding and a ledger confirmation both need. It also yields a genuinely
useful control: **goods received but not yet billed**, a number a mill owner
wants every week.

*Against:* the supplier's balance no longer moves at inward time, so anyone who
today reconciles payables from the inward will see a different figure. That is
a workflow change the accountant must agree to.

### B. The bill is the only accounting event

The inward records stock movement with no voucher; the purchase invoice does
all the accounting.

*Against:* stock has no value until the bill arrives. For a mill whose weavers
bill late, the balance sheet understates inventory for weeks. Not recommended.

### C. Never bill an inward

Grey inward *is* the purchase; purchase invoices are only for jobwork and
expenses.

*Against:* contradicts the interface, which offers "Grey purchase" first. If
this is genuinely the intent, the fix is to remove that option and block a
`kind: 'grey'` bill against a party who has open inwards — not to leave both
paths open and hope.

## What is blocked until this is settled

- **Trading Account and Gross Profit.** Building them now would compute a
  confident, precise, wrong number: purchases appear twice, once as an asset
  and once as a direct expense.
- Any creditor ageing, ledger confirmation or supplier reconciliation.
- Any margin figure that a CA would sign.

## The question for the mill

> When your weaver's bill arrives for grey you have already taken into stock
> and barcoded, do you enter it as a purchase invoice as well — and if so, what
> does your current system do to the weaver's balance?

The answer decides A or C in one sentence.
