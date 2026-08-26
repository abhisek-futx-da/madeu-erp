-- The backlog numbers the monitoring box scrapes.
--
-- These are deliberately installation-wide: the operator watching /metrics is
-- asking "is anything piling up anywhere", not looking at one mill's screen.
-- That cannot be answered under row-level security, and the first version tried
-- to — which failed in two different ways at once. On a fresh connection
-- `current_setting('app.tenant_id', true)` is null, the policies matched no
-- rows, and every gauge read a confident zero. On a pooled connection that had
-- already served a tenant, the setting reverts to the empty string instead of
-- null, the policy cast '' to uuid, and the whole scrape errored.
--
-- A gauge that reports zero when it means "I could not look" is worse than no
-- gauge, so this is an explicit, auditable, aggregate-only definer function
-- rather than a query that quietly depends on session state.

create or replace function operator_backlog()
returns table (
  approvals_pending       bigint,
  declarations_unanswered bigint,
  challans_unacknowledged bigint,
  jobwork_over_a_year     bigint,
  einvoice_backlog        bigint,
  stock_counts_open       bigint,
  revoked_tokens          bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*) from sales_invoice    where status = 'pending_approval')
      + (select count(*) from purchase_invoice where status = 'pending_approval')
      + (select count(*) from payment          where status = 'pending_approval')
      + (select count(*) from stock_count      where status = 'pending_approval'),
    (select count(*) from party_declaration d
      where not exists (select 1 from party_declaration_event e
                         where e.declaration_id = d.id)),
    (select count(*) from dyeing_issue di
      where di.status not in ('closed', 'cancelled')
        and not exists (select 1 from party_declaration d
                         where d.issue_id = di.id and d.kind = 'custody_ack')),
    (select count(*) from piece
      where status = 'issued_to_dyeing'
        and updated_at < now() - interval '12 months'),
    (select count(*) from gst_document
      where filing_status is distinct from 'filed' and irn is null),
    (select count(*) from stock_count where status = 'draft'),
    (select count(*) from revoked_token);
$$;

-- Counts only, never a row of anybody's data, and never callable by a tenant
-- session that has not been given it explicitly.
revoke all on function operator_backlog() from public;
grant execute on function operator_backlog() to link_erp_app;
