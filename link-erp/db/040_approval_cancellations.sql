-- A cancelled financial exception is a decision, not a disappearing row.
-- Keep it in the same immutable history used by maker-checker approval.

alter table approval_event drop constraint if exists approval_action;
alter table approval_event add constraint approval_action
  check (action in ('submitted', 'approved', 'rejected', 'cancelled'));
