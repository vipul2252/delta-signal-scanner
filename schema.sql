-- Supabase > SQL Editor me ye poora paste karke "Run" dabayein

create table if not exists public.delta_snapshots (
  id                bigserial primary key,
  ts                timestamptz not null,
  symbol            text not null,
  mark_price        double precision,
  funding_rate      double precision,
  oi_usd            double precision,
  oi_change_6h_usd  double precision,
  volume_usd        double precision,
  change_24h        double precision
);

create index if not exists delta_snapshots_ts_idx on public.delta_snapshots (ts);
create index if not exists delta_snapshots_symbol_ts_idx on public.delta_snapshots (symbol, ts);

create table if not exists public.delta_alerts (
  symbol      text primary key,
  last_ts     timestamptz not null,
  last_score  int not null
);

-- Security: bahar se koi in tables ko padh/likh na sake.
-- Scanner service_role key use karta hai jo RLS ko bypass karti hai.
alter table public.delta_snapshots enable row level security;
alter table public.delta_alerts enable row level security;
