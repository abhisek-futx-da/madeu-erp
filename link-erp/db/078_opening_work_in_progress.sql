-- Opening stock that is not in the godown but out at a process house.
--
-- A converter switching systems on 1 April always has lots at the dyer. Until
-- now opening stock could only be 'grey' or 'finish', so that cloth had two
-- bad options: enter it as though it were on a rack, which is a lie the floor
-- discovers on the first stock count, or leave it out, which breaks the books.
--
-- Worse, status alone would not have been enough. A dyeing receipt finds its
-- pieces through dyeing_issue_line -> dyeing_issue, so a piece marked
-- issued_to_dyeing without an issue document behind it could never be received
-- back: the cloth would be stranded in the system forever. Migrated
-- work-in-progress therefore creates a real issue document, flagged as an
-- opening one so a register can tell a migrated lot from a lot this mill
-- actually sent out.

alter table opening_stock_line
  add column if not exists process_house_id uuid references ledger_account(id);

alter table opening_stock_line drop constraint if exists opening_stock_line_stock_kind_check;
alter table opening_stock_line add constraint opening_stock_line_stock_kind_check
  check (stock_kind in ('grey', 'finish', 'at_process'));

-- The process house is what makes the row receivable; without it the piece
-- could not be matched back to the party holding it.
alter table opening_stock_line drop constraint if exists opening_stock_line_process_house_shape;
alter table opening_stock_line add constraint opening_stock_line_process_house_shape
  check ((stock_kind = 'at_process') = (process_house_id is not null));

create index if not exists opening_stock_line_process_house_fk
  on opening_stock_line (process_house_id) where process_house_id is not null;

alter table dyeing_issue add column if not exists is_opening boolean not null default false;

comment on column dyeing_issue.is_opening is
  'true when this issue was created by an opening-stock migration, not by a real despatch to the process house';
