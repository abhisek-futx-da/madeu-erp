# GSP / IRP Readiness Checklist

The software creates locally validated payloads. This checklist is the work
required before any live government or GSP call is enabled.

## Obtain before implementation sign-off

- Written provider agreement and supported API/version list.
- Sandbox base URL, credentials, test GSTIN, IP-whitelisting requirements, and
  provider escalation contact.
- Production onboarding requirements, credential rotation procedure, rate
  limits, outage/retry guidance, and signed test evidence.
- CA-approved invoice, credit-note, debit-note, e-way bill, and job-work
  scenarios for this legal entity.

## Security conditions

- Store provider secrets only in server-side deployment secret storage; never
  in source code, browser storage, logs, CSV exports, or screenshots.
- Use a dedicated integration identity with the minimum provider permissions.
- Record which user submitted each statutory document, provider response,
  acknowledgement/IRN/EWB number, timestamp, payload version, and error.
- Test credential rotation and revocation before production cutover.

## Sandbox acceptance cases

For every case, preserve the request, masked response, status, and the printed
document as evidence:

1. Intra-state B2B tax invoice.
2. Inter-state B2B tax invoice.
3. Credit note and debit note against an original invoice.
4. E-way bill for a sale and for job work under a delivery challan.
5. Duplicate submission, validation rejection, timeout, and provider 5xx.
6. Cancellation within the provider's permitted window and the required
   post-window accounting correction.
7. Reconciliation of accepted provider documents with the ERP register and
   GSTR-1/3B output.

## Production enablement rule

Enable live submission only after every sandbox case has a named owner,
expected result, actual result, and CA sign-off. Keep live submission behind a
feature flag and start with one nominated accounts user and a small document
limit. A failed provider call must leave the ERP document visibly pending or
rejected; it must never be silently treated as accepted.

## Known product boundary

The current code has no live provider credentials and no real provider round
trip. The GSTR-1 credit/debit-note report currently covers registered
recipients; CA validation must define any required unregistered/export note
handling before production filing.

WhatsApp Graph credentials and templates are a separate integration boundary;
passing Meta delivery does not prove any GSP, IRP, NIC, or GST filing result.
