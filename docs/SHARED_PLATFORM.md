# Shared customization, reporting and integration platform

The owner workbench is **Home → Customization & Integration Studio**. The
platform is tenant-scoped, permission-checked, and covered by migration `060`.

## Custom fields

Owners can define text, number, date, yes/no, single-choice, and multi-choice
fields for ledgers, pieces, purchase/sales orders, invoices, payments, godown
transfers, documents, and resources from all five parallel editions. A field has a
permanent API key, label, help text, display order, allowed choices, and active
state. Values are validated both by the API and PostgreSQL and can only be
attached to an existing record of the declared type.

Invoice, purchase-invoice, payment, and godown-transfer lists expose a custom
field control. Integrations use:

- `GET /api/platform/custom-fields?entityType=sales_invoice`
- `GET /api/platform/custom-values?entityType=sales_invoice&entityId=<uuid>`
- `POST /api/platform/custom-values`

Definitions should be deactivated, not deleted. Existing business values and
the append-only platform change history remain available for audit.

## Report builder

The builder exposes nine governed sources for receivables, payables, cloth
stock, cash book, trial balance, party balances, edition operations, edition
resource stock, and edition job costing. Users select
columns, bound filters, and ordering; owners may share a definition with the
company. Saved reports can be run and exported from the studio.

The server maps every source and column to a fixed SQL expression. Supported
operators are `eq`, `contains`, `gte`, and `lte`; values are query parameters,
never SQL fragments. Arbitrary table names, expressions, joins, or SQL are not
accepted. A run is capped at 5,000 rows.

## Integration feeds

An owner creates a connection and chooses subscribed event types. The secret is
returned once and stored by the ERP only as a SHA-256 hash. Store it in the
adapter's secret manager; do not put it in source control or screenshots.

The ERP automatically publishes create/status events for sales invoices,
purchase invoices, payments, godown transfers, opening-stock batches, edition
resources, and all 46 edition workflows. Edition event names follow
`<edition>.<workflow>.<created|status>`, for example
`garments.style.created` or `dyeing.batch_card.completed`. A connection can
also receive a deliberately queued custom event. Each event has one delivery
per connection and is not removed by credential rotation.

Poll pending deliveries:

```text
GET /api/integrations/feed?after=0&limit=100
X-ERP-Integration-Key: <one-time key>
```

The response contains `rows` and `nextAfter`. After committing the event in the
downstream system, acknowledge it:

```text
POST /api/integrations/feed/<delivery-id>/ack
X-ERP-Integration-Key: <one-time key>
Content-Type: application/json

{"status":"delivered"}
```

Use `{"status":"failed","error":"..."}` for a retryable adapter failure.
Delivered rows cannot be acknowledged twice. Pausing a connection disables its
credential and new subscription deliveries; rotating its key invalidates the
old key immediately while preserving the backlog for the replacement key.

This pull contract is deliberate: the ERP never follows user-configured URLs,
so a connector cannot turn the application server into an internal-network
request proxy. Provider-specific adapters remain separate processes with only
the network access and credentials they need.
