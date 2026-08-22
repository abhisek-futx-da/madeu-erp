-- Cancelling a document walks its pieces back, so the reverse of every forward
-- move has to be a legal transition. Without these the guard rejects the
-- reversal and a wrong document stays wrong forever.

insert into piece_status_transition (from_status, to_status) values
  ('issued_to_dyeing','grey_in_stock'),     -- issue cancelled
  ('received_finish','issued_to_dyeing'),   -- dyeing receipt cancelled
  ('cut_packed','received_finish'),         -- packing undone
  ('dispatched','cut_packed'),              -- dispatch cancelled
  ('returned_to_weaver','grey_in_stock'),   -- return taken back
  ('written_off','grey_in_stock')           -- write-off reversed
on conflict (from_status, to_status) do nothing;
