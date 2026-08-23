-- A cancelled process-house receipt must be correctable.  The original global
-- unique constraint made the issue line unusable forever, so keep uniqueness
-- only across live receipt lines and retire the slot atomically on cancel.

alter table dyeing_receipt_line
  add column if not exists active boolean not null default true;

update dyeing_receipt_line line
   set active = false
  from dyeing_receipt receipt
 where receipt.id = line.receipt_id and receipt.status = 'cancelled';

alter table dyeing_receipt_line
  drop constraint if exists dyeing_receipt_line_issue_line_id_key;

create unique index if not exists one_live_dyeing_receipt_per_issue_line
  on dyeing_receipt_line (issue_line_id) where active;

create index if not exists dyeing_receipt_line_by_issue
  on dyeing_receipt_line (issue_line_id);
