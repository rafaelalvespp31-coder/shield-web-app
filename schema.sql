-- ============================================================
-- SCHEMA: App de Serviços (estilo Uber) - Cliente / Prestador
-- Banco: PostgreSQL (Supabase)
-- Supabase já cria auth.users (login/senha/JWT). Este schema
-- referencia auth.users como base de identidade.
-- ============================================================

-- Extensões úteis
create extension if not exists "uuid-ossp";
create extension if not exists "postgis"; -- para cálculos de distância/geolocalização

-- ============================================================
-- 1. PERFIS (base para cliente e prestador)
-- ============================================================
do $$ begin
    create type user_role as enum ('client', 'provider', 'admin');
exception
    when duplicate_object then null;
end $$;

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role user_role not null default 'client',
  full_name text not null,
  phone text,
  avatar_url text,
  cpf_cnpj text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 2. PRESTADORES (dados extras + status online + localização)
-- ============================================================
create table if not exists providers (
  id uuid primary key references profiles(id) on delete cascade,
  bio text,
  is_online boolean not null default false,
  is_available boolean not null default true, -- online mas ocupado em outra demanda
  current_location geography(Point, 4326), -- lat/lng em tempo real
  last_location_at timestamptz,
  rating_avg numeric(3,2) default 0,
  rating_count integer default 0,
  verified boolean not null default false,
  documents_status text default 'pending', -- pending, approved, rejected
  created_at timestamptz not null default now()
);

create index if not exists idx_providers_location on providers using gist (current_location);
create index if not exists idx_providers_online on providers (is_online, is_available);

-- ============================================================
-- 3. CATEGORIAS DE SERVIÇO
-- ============================================================
drop table if exists provider_categories cascade;
drop table if exists service_categories cascade;

create table service_categories (
  id serial primary key,
  name text not null unique,
  icon text,
  base_price numeric(10,2) default 0,
  active boolean default true
);

create table provider_categories (
  provider_id uuid references providers(id) on delete cascade,
  category_id integer references service_categories(id) on delete cascade,
  primary key (provider_id, category_id)
);

-- Categorias oficiais da plataforma
insert into service_categories (name, icon) values
  ('Lojas', 'store'),
  ('Mercados', 'shopping-cart'),
  ('Eventos', 'calendar'),
  ('Galpão', 'warehouse'),
  ('Apoio', 'life-buoy'),
  ('Bar/Restaurante', 'utensils'),
  ('Portaria', 'door-open');

-- ============================================================
-- 4. DEMANDAS (o coração do app)
-- ============================================================
do $$ begin
    create type request_type as enum ('immediate', 'scheduled');
exception
    when duplicate_object then null;
end $$;

do $$ begin
    create type request_status as enum (
      'pending',       -- aguardando prestador aceitar
      'matched',       -- prestador aceitou
      'in_progress',   -- serviço em andamento
      'completed',     -- finalizado
      'cancelled',     -- cancelado por qualquer parte
      'expired'        -- ninguém aceitou a tempo
    );
exception
    when duplicate_object then null;
end $$;

create table if not exists service_requests (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references profiles(id),
  category_id integer not null references service_categories(id),
  provider_id uuid references providers(id), -- preenchido após match
  type request_type not null default 'immediate',
  status request_status not null default 'pending',
  description text,
  address text,
  location geography(Point, 4326) not null,
  scheduled_at timestamptz, -- só usado quando type = 'scheduled'
  price_estimate numeric(10,2),
  price_final numeric(10,2),
  created_at timestamptz not null default now(),
  matched_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text
);

create index if not exists idx_requests_status on service_requests (status);
create index if not exists idx_requests_scheduled on service_requests (scheduled_at) where type = 'scheduled';
create index if not exists idx_requests_location on service_requests using gist (location);

-- ============================================================
-- 5. OFERTAS DE DEMANDA (dispara para vários prestadores online)
-- ============================================================
do $$ begin
    create type offer_status as enum ('sent', 'accepted', 'rejected', 'expired');
exception
    when duplicate_object then null;
end $$;

create table if not exists request_offers (
  id uuid primary key default uuid_generate_v4(),
  request_id uuid not null references service_requests(id) on delete cascade,
  provider_id uuid not null references providers(id),
  status offer_status not null default 'sent',
  sent_at timestamptz not null default now(),
  responded_at timestamptz,
  expires_at timestamptz not null default (now() + interval '30 seconds')
);

create index if not exists idx_offers_provider on request_offers (provider_id, status);
create index if not exists idx_offers_request on request_offers (request_id);

-- ============================================================
-- 6. CARTEIRA / SAQUE
-- ============================================================
create table if not exists wallets (
  id uuid primary key references profiles(id) on delete cascade,
  balance numeric(12,2) not null default 0,
  updated_at timestamptz not null default now()
);

do $$ begin
    create type transaction_type as enum ('credit', 'debit', 'withdrawal', 'refund');
exception
    when duplicate_object then null;
end $$;

do $$ begin
    create type transaction_status as enum ('pending', 'completed', 'failed');
exception
    when duplicate_object then null;
end $$;

create table if not exists wallet_transactions (
  id uuid primary key default uuid_generate_v4(),
  wallet_id uuid not null references wallets(id),
  type transaction_type not null,
  amount numeric(12,2) not null,
  status transaction_status not null default 'completed',
  related_request_id uuid references service_requests(id),
  description text,
  created_at timestamptz not null default now()
);

do $$ begin
    create type withdrawal_status as enum ('pending', 'processing', 'paid', 'failed');
exception
    when duplicate_object then null;
end $$;

create table if not exists withdrawal_requests (
  id uuid primary key default uuid_generate_v4(),
  provider_id uuid not null references providers(id),
  amount numeric(12,2) not null,
  status withdrawal_status not null default 'pending',
  payment_method text, -- pix, ted, etc
  pix_key text,
  external_reference text, -- id retornado pelo processador de pagamento (Stripe/Asaas)
  requested_at timestamptz not null default now(),
  processed_at timestamptz
);

-- ============================================================
-- 7. AVALIAÇÕES
-- ============================================================
create table if not exists ratings (
  id uuid primary key default uuid_generate_v4(),
  request_id uuid not null references service_requests(id),
  client_id uuid not null references profiles(id),
  provider_id uuid not null references providers(id),
  rating smallint not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 8. NOTIFICAÇÕES
-- ============================================================
create table if not exists notifications (
  id uuid primary key default uuid_generate_v4(),
  profile_id uuid not null references profiles(id),
  title text not null,
  body text,
  read boolean not null default false,
  data jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 9. CHAT DURANTE A DEMANDA (opcional, cliente <-> prestador)
-- ============================================================
create table if not exists chat_messages (
  id uuid primary key default uuid_generate_v4(),
  request_id uuid not null references service_requests(id) on delete cascade,
  sender_id uuid not null references profiles(id),
  message text not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 10. TRIGGERS ÚTEIS
-- ============================================================

-- Atualiza rating_avg do prestador automaticamente
create or replace function update_provider_rating() returns trigger as $$
begin
  update providers
  set rating_avg = (select avg(rating) from ratings where provider_id = new.provider_id),
      rating_count = (select count(*) from ratings where provider_id = new.provider_id)
  where id = new.provider_id;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_update_rating on ratings;
create trigger trg_update_rating
after insert on ratings
for each row execute function update_provider_rating();

-- ============================================================
-- 11. ROW LEVEL SECURITY (essencial no Supabase)
-- ============================================================
alter table profiles enable row level security;
alter table providers enable row level security;
alter table service_requests enable row level security;
alter table wallets enable row level security;
alter table wallet_transactions enable row level security;

-- Políticas de segurança (Drop para evitar erro caso já existam)
drop policy if exists "Usuários veem o próprio perfil" on profiles;
create policy "Usuários veem o próprio perfil"
  on profiles for select using (auth.uid() = id);

drop policy if exists "Cliente vê suas próprias demandas" on service_requests;
create policy "Cliente vê suas próprias demandas"
  on service_requests for select
  using (auth.uid() = client_id or auth.uid() = provider_id);