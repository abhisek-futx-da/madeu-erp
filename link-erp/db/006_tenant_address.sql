-- The seller block of an e-invoice needs the tenant's own registered address.
-- It was previously read from ledger_address, whose ledger_id is NOT NULL, so
-- the lookup never matched and the payload carried placeholder text.

alter table tenant add column if not exists address1 text;
alter table tenant add column if not exists address2 text;
alter table tenant add column if not exists city     text;
alter table tenant add column if not exists pincode  char(6);
alter table tenant add column if not exists phone    text;
alter table tenant add column if not exists email    text;

alter table tenant add constraint tenant_pincode_shape
  check (pincode is null or pincode ~ '^[0-9]{6}$');
