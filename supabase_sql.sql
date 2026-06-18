create table if not exists public.merchants (
  id text primary key,
  merchant_name text not null,
  category text,
  address text,
  latitude double precision,
  longitude double precision,
  area_name text,
  lvm_status text default 'Non-LVM',
  priority_score integer default 0,
  visit_status text default 'Belum Dikunjungi',
  pipeline_status text default 'New Prospect',
  qr_provider text,
  edc_provider text,
  competitor_bank text,
  next_followup_date date,
  last_visit_date date,
  notes text,
  source text default 'upload',
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

create table if not exists public.visits (
  id uuid primary key default gen_random_uuid(),
  merchant_id text references public.merchants(id) on delete cascade,
  visit_date date not null,
  officer_name text,
  visit_result text,
  pic_name text,
  pic_phone text,
  qr_provider text,
  edc_provider text,
  competitor_bank text,
  mandiri_opportunity text[],
  next_action text,
  next_followup_date date,
  notes text,
  created_at timestamptz default now()
);

create index if not exists idx_merchants_status on public.merchants(visit_status);
create index if not exists idx_merchants_pipeline on public.merchants(pipeline_status);
create index if not exists idx_merchants_area on public.merchants(area_name);
create index if not exists idx_visits_merchant on public.visits(merchant_id);
create index if not exists idx_visits_date on public.visits(visit_date);

alter table public.merchants enable row level security;
alter table public.visits enable row level security;

drop policy if exists "kgb public read merchants" on public.merchants;
drop policy if exists "kgb public insert merchants" on public.merchants;
drop policy if exists "kgb public update merchants" on public.merchants;
drop policy if exists "kgb public delete merchants" on public.merchants;
drop policy if exists "kgb public read visits" on public.visits;
drop policy if exists "kgb public insert visits" on public.visits;
drop policy if exists "kgb public update visits" on public.visits;
drop policy if exists "kgb public delete visits" on public.visits;

create policy "kgb public read merchants" on public.merchants for select using (true);
create policy "kgb public insert merchants" on public.merchants for insert with check (true);
create policy "kgb public update merchants" on public.merchants for update using (true) with check (true);
create policy "kgb public delete merchants" on public.merchants for delete using (true);

create policy "kgb public read visits" on public.visits for select using (true);
create policy "kgb public insert visits" on public.visits for insert with check (true);
create policy "kgb public update visits" on public.visits for update using (true) with check (true);
create policy "kgb public delete visits" on public.visits for delete using (true);
