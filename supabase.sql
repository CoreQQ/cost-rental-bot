-- Run this once in the Supabase SQL editor.

-- Watched schemes (one row per scheme URL).
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

-- Small singleton bag for watchdog/heartbeat state.
create table if not exists public.watcher_meta (
  id   int primary key default 1,
  data jsonb not null default '{}',
  constraint watcher_meta_singleton check (id = 1)
);

-- The bot uses the service-role key (server-side only), which bypasses RLS.
-- Keep RLS ON and add NO public policies so the anon key cannot read/write these tables.
alter table public.cost_rental_schemes enable row level security;
alter table public.watcher_meta        enable row level security;
