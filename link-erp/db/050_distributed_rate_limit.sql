-- Shared API rate-limit buckets. Login throttling already survives restarts;
-- this table gives the general request ceiling the same property when more
-- than one API replica serves a deployment.
create table if not exists api_rate_limit (
  bucket_key        text primary key,
  window_started_at timestamptz not null default clock_timestamp(),
  hits              integer not null default 1 check (hits > 0)
);

create index if not exists api_rate_limit_window_idx
  on api_rate_limit (window_started_at);

grant select, insert, update, delete on api_rate_limit to link_erp_app;
