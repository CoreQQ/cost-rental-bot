-- Run this once in the Supabase SQL editor.
create table if not exists public.cost_rental_schemes (
  url            text primary key,
  site           text not null,
  title          text,
  status         text not null default 'open',   -- 'open' | 'closed'
  beds           int[] not null default '{}',
  notified_open  boolean not null default false,
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now()
);

-- The bot uses the service-role key (server-side only), which bypasses RLS.
-- Keep RLS ON and add no public policies so the table is not exposed via the anon key.
alter table public.cost_rental_schemes enable row level security;
