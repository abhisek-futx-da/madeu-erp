-- Approval limits for the demo tenant. Figures a Bhiwandi trader would
-- recognise: an ordinary invoice goes straight out, a large one waits.

begin;
set local app.tenant_id = '11111111-1111-1111-1111-111111111111';

-- Maker–checker needs two people. The seed had an owner, a store keeper and a
-- viewer, so there was nobody a held document could be handed to — the feature
-- was untestable and undemonstrable with the demo data as it stood.
-- Password is the same 'changeme' as every other seeded user.
insert into app_user (id, email, full_name, password_hash) values
  ('aaaaaaaa-0000-0000-0000-000000000004','accounts@neelkamal.test','Accountant',
   '$2b$12$pVYUY.crMfi1qCpWJH3w0.JrJxP31zsFGFjCwQNKc9jQFFxRK7C1S'),
  ('aaaaaaaa-0000-0000-0000-000000000005','sales@neelkamal.test','Sales Desk',
   '$2b$12$pVYUY.crMfi1qCpWJH3w0.JrJxP31zsFGFjCwQNKc9jQFFxRK7C1S')
on conflict (email) do nothing;

insert into membership (tenant_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000004','accounts'),
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000005','sales')
on conflict do nothing;

insert into approval_rule (tenant_id, doc_type, min_amount, approver_role) values
  ('11111111-1111-1111-1111-111111111111', 'sales_invoice',    500000, 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'purchase_invoice', 300000, 'owner'),
  -- Money leaving the business is the entry a mill most wants two people on.
  ('11111111-1111-1111-1111-111111111111', 'payment',          100000, 'owner')
on conflict (tenant_id, doc_type) do update
  set min_amount = excluded.min_amount, approver_role = excluded.approver_role;

commit;
