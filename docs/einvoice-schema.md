# E-invoice schema — where the field definitions came from

`server/src/einvoice.ts` builds the NIC **INV-1, schema version 1.1** Generate-IRN
payload. The field names, casing, lengths and mandatory flags below were read
from these sources on **2026-08-21**, not from memory.

| Source | Used for |
|---|---|
| [JSON Schema of Generate IRN — Tax Pro user guide](https://gsthelp.charteredinfo.com/e-Invoice/json_schema_of_generate_irn.htm) | Top-level objects, `TranDtls`, `DocDtls`, `ItemList`, `ValDtls` |
| [E-Invoice Object — ClearTax API docs](https://docs.cleartax.in/cleartax-docs/e-invoicing-api/e-invoicing-api-reference/resources-and-master/e-invoice-object) | `SellerDtls`, `BuyerDtls`, `EwbDtls` field lists |
| [Generate IRN — ClearTax API docs](https://docs.cleartax.in/cleartax-docs/e-invoicing-api/e-invoicing-api-reference/govt-compatible-apis/generate-irn) | Request envelope |
| [e-Invoice JSON format — ClearTax](https://cleartax.in/s/gst-e-invoice-json) | Schema identity (INV-1 v1.1) and common rejection causes |

## Things that were easy to get wrong

- The pincode field is **`Pin`** (a *number*), not `Pcd`.
- `SlNo` is a **string**, while every amount is a **number**.
- `IsServc` is `"Y"`/`"N"`, not a boolean.
- `Dt` and `TransDocDt` are **DD/MM/YYYY**, not ISO.
- `ItemList` is capped at **1000 lines** per document.
- `Distance` is mandatory once `EwbDtls` is present, and is capped at 4000 km.
- `SupTyp` is an enum: `B2B`, `SEZWP`, `SEZWOP`, `EXPWP`, `EXPWOP`, `DEXP`.

## Not yet verified

- **The document-number character rule.** `validateEinvoice` restricts
  `DocDtls.No` to `A-Z a-z 0-9 / -` within 16 characters. The length is from the
  schema; the character set is the widely documented IRP rule but was not
  confirmed against a primary GSTN source. Confirm before going live.
- **Production behaviour.** Nothing here has been submitted to the IRP. Only
  the payload shape and our own arithmetic are tested. Sandbox credentials and
  a real round-trip are the next step, and production credentials after that.
- `IgstOnIntra` (used for the rare intra-state supply charged IGST) is not
  implemented.
