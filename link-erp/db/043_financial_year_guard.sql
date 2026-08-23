-- India textile books need one unambiguous April-to-March year for every
-- posting. Overlapping or mislabelled years make trial balances and closes
-- depend on whichever row the planner happens to return.

create or replace function validate_financial_year()
returns trigger language plpgsql as $$
declare
  start_year integer := extract(year from new.starts_on)::integer;
  expected_label text;
begin
  expected_label := start_year::text || '-' || right((start_year + 1)::text, 2);

  if new.starts_on <> make_date(start_year, 4, 1)
     or new.ends_on <> make_date(start_year + 1, 3, 31)
     or new.label <> expected_label then
    raise exception 'financial year % must be % from % to %',
      new.label, expected_label, make_date(start_year, 4, 1), make_date(start_year + 1, 3, 31);
  end if;

  if exists (
    select 1 from financial_year fy
     where fy.tenant_id = new.tenant_id
       and daterange(fy.starts_on, fy.ends_on, '[]')
           && daterange(new.starts_on, new.ends_on, '[]')
       and (tg_op = 'INSERT' or (fy.tenant_id, fy.label) <> (old.tenant_id, old.label))
  ) then
    raise exception 'financial year % overlaps an existing year', new.label;
  end if;

  return new;
end;
$$;

drop trigger if exists financial_year_is_valid on financial_year;
create trigger financial_year_is_valid
  before insert or update of tenant_id, label, starts_on, ends_on on financial_year
  for each row execute function validate_financial_year();
