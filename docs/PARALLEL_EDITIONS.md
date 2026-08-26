# Parallel textile editions

Link ERP exposes five operational editions beside the shared cloth ERP. They
are not separate copies of the application: a company keeps one tenant, chart
of accounts, financial year, user directory, permission model, location tree,
audit history, evidence store, report builder, search index, and integration
feed. Owners can enable or pause each edition independently.

## Included workflows

| Edition | Operational workflows |
|---|---|
| Weaving (9) | Yarn receipt; warping order; sizing batch; loom plan; beam and yarn issue; loom production entry; fabric inspection; job-work settlement; loom maintenance |
| Dyeing (9) | Lab dip; recipe card; chemical receipt; dyeing batch card; machine schedule; process stage entry; quality release; reprocess order; batch costing |
| Exports (9) | Export order; letter of credit; pre-shipment check; export shipment; commercial document pack; compliance pack; duty-benefit claim; forex realisation; bank closure |
| Logistics (8) | Route plan; consignment/LR; vehicle trip; fuel/toll expense; proof of delivery; vehicle maintenance; freight invoice; transporter settlement |
| Garments (11) | Garment style; sample; BOM; size-colour order; marker plan; cutting order; bundle; production batch; subcontract; quality inspection; final costing |

Every workflow has a strict server-side data contract. Quantities and weights
are range-checked; controlled facts such as shifts, process stages, incoterms,
currencies, shipment status, garment operations, and delivery condition use
allowed values rather than free text. Export shipment net weight cannot exceed
gross weight, percentages cannot exceed 100, and logistics mobile numbers are
shape-validated.

## Shared controls

- Independent financial-year document series and edition/workflow prefixes.
- Draft → in progress → held/completed, with resume and reasoned cancellation.
  PostgreSQL rejects skipped or terminal-state transitions even if the UI is
  bypassed.
- Append-only create/edit/status evidence with actor and timestamp.
- Tenant row-level security and edition-appropriate store/sales permissions.
- Searchable registers, exact CSV export, attachments, and custom fields.
- Typed edition resources for materials, machines, routes, vehicles, recipes,
  packaging, fabric, trims, bundles, and finished goods. Resources can be
  maintained or deactivated without deleting their retained activity.
- Material receipt/production/return and issue/consumption lines post exactly
  once on completion to an append-only average-cost subledger. Negative stock
  and changing a line after processing starts are database-refused.
- Labour, machine, freight, duty, overhead, subcontract, and other lines feed a
  job-cost view with separate material and conversion-cost totals.
- Parent-document links retain the operational chain across workflows.
- Owners can require independent maker-checker approval per workflow. A maker
  cannot approve their own document, and an unapproved document cannot complete.
- Governed `Edition operations`, `Edition stock`, and `Edition job cost` report
  sources for reusable company/private reports.
- Tenant-wide global search linked back to the correct edition workspace.
- Automatic integration events such as `weaving.loom_plan.created`,
  `exports.shipment.completed`, and `logistics.consignment.held`.
- Owner pause/enable control. Pausing blocks new documents but retains and
  exposes every existing record.

## API surface

- `GET /api/editions/catalog` — five editions, workflow fields, options, units.
- `GET /api/editions` — enabled state and document/active counts.
- `POST /api/editions/config` — owner enable/pause and edition configuration.
- `GET|POST /api/editions/:edition/resources` — resource maintenance and stock.
- `GET|POST /api/editions/:edition/documents` — register/export and create.
- `GET|POST /api/editions/:edition/documents/:id` — evidence and draft editing.
- `GET|POST /api/editions/:edition/documents/:id/lines` — material/cost lines.
- `POST /api/editions/:edition/documents/:id/approval/submit` — submit approval.
- `POST /api/editions/:edition/documents/:id/approval/decision` — owner decision.
- `POST /api/editions/:edition/documents/:id/status` — guarded lifecycle.

## Production boundary

The edition engine is production-grade software for controlled operational
capture: validation, access, numbering, audit, lifecycle, resources, stock,
costing, approvals, evidence, reporting, search, export, and integrations are
implemented and tested. A real rollout
still requires the company to agree terminology, mandatory fields, roles,
approval points, number prefixes, documents, and reports through a pilot.

The exports edition records export order/shipment/compliance facts; it does not
claim customs, DGFT, ICEGATE, bank-realisation, carrier, or port-provider filing
acceptance. Those external contracts require selected providers, credentials,
sandbox tests, and statutory sign-off before production use.
