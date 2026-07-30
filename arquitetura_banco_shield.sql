
-- ############################################################
-- ARQUIVO ORIGINAL: 00_header.sql
-- ############################################################
-- ============================================================
-- SHIELD — MIGRAÇÃO COMPLETA DO BANCO (arquivo único, ordem correta)
-- Gerado a partir dos 13 scripts enviados, consolidados e corrigidos.
-- Rode este arquivo inteiro de uma vez no SQL Editor do Supabase,
-- em um projeto novo (ou em cima do que você já tem — os scripts usam
-- IF NOT EXISTS/blocos condicionais na maior parte das vezes).
--
-- Extensões necessárias (algumas exigem habilitar em Database > Extensions
-- no painel do Supabase antes de rodar, caso o create extension abaixo falhe):
--   uuid-ossp, postgis, unaccent, pg_cron
-- ============================================================

create extension if not exists pg_cron;


-- ############################################################
-- ARQUIVO ORIGINAL: arquitetura_banco_shield.sql
-- ############################################################
-- ============================================================
-- SHIELD — ARQUITETURA DE BANCO DE DADOS (CONSOLIDADA)
-- ============================================================
-- Este arquivo é a fonte única de verdade do banco, reunindo tudo que já
-- existia (schema.sql, pricing_engine.sql, realtime_matching.sql e os
-- ajustes incrementais feitos ao longo da conversa) + as peças novas
-- pedidas agora: tabela de prestadores com tipo/status de aprovação,
-- tabela de empresas, tabela de tarifas e tokens de convite de uso único.
--
-- Seguro rodar em um projeto Supabase novo OU em cima do que você já tem
-- (os comandos usam "if not exists" / blocos condicionais sempre que
-- possível, pra não quebrar se algo já existir).
-- ============================================================

create extension if not exists "uuid-ossp";
create extension if not exists "postgis";

-- ============================================================
-- 1. PERFIS — os 4 papéis do sistema
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type user_role as enum ('client', 'provider', 'company', 'admin');
  else
    -- adiciona 'company' ao enum existente, caso o tipo já tenha sido criado antes sem ele
    if not exists (
      select 1 from pg_enum e join pg_type t on e.enumtypid = t.oid
      where t.typname = 'user_role' and e.enumlabel = 'company'
    ) then
      alter type user_role add value 'company';
    end if;
  end if;
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
-- 2. EMPRESAS PARCEIRAS
-- ============================================================
create table if not exists companies (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid not null references profiles(id),
  razao_social text not null,
  cnpj text not null unique,
  telefone text,
  autorizacao_pf_valida_ate date,
  verified boolean not null default false,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 3. PRESTADORES — autônomos e vinculados a empresa
-- ============================================================
-- tipo_prestador:
--   'autonomo'  -> presta serviço por conta própria (fica ativo imediatamente)
--   'vinculado' -> está associado a uma empresa parceira (fica pendente até o
--                  "chefe" da empresa aprovar o vínculo no painel dela)
--
-- status_aprovacao:
--   'pendente' -> vinculado aguardando aprovação da empresa
--   'ativo'    -> autônomo (sempre) ou vinculado já aprovado pela empresa
--   'recusado' -> a empresa recusou o vínculo
--   'desativado' -> desligado da plataforma ou da empresa

do $$
begin
  if not exists (select 1 from pg_type where typname = 'tipo_prestador_enum') then
    create type tipo_prestador_enum as enum ('autonomo', 'vinculado');
  end if;
  if not exists (select 1 from pg_type where typname = 'status_aprovacao_enum') then
    create type status_aprovacao_enum as enum ('pendente', 'ativo', 'recusado', 'desativado');
  end if;
end $$;

-- Se a tabela antiga "providers" já existir (versão anterior deste schema),
-- renomeia pra "usuarios_prestadores" em vez de criar uma tabela duplicada.
do $$
begin
  if exists (select 1 from information_schema.tables where table_name = 'providers')
     and not exists (select 1 from information_schema.tables where table_name = 'usuarios_prestadores') then
    alter table providers rename to usuarios_prestadores;
  end if;
end $$;

create table if not exists usuarios_prestadores (
  id uuid primary key references profiles(id) on delete cascade,
  tipo_prestador tipo_prestador_enum not null default 'autonomo',
  company_id uuid references companies(id),
  status_aprovacao status_aprovacao_enum not null default 'ativo',
  bio text,
  is_online boolean not null default false,
  is_available boolean not null default true,
  current_location geography(Point, 4326),
  last_location_at timestamptz,
  rating_avg numeric(3,2) default 0,
  rating_count integer default 0,
  verified boolean not null default false,
  documents_status text default 'pending',
  approved_elite boolean not null default false,
  nivel text not null default 'Bronze' check (nivel in ('Bronze','Prata','Ouro','Platina')),
  pontos_nivel integer not null default 0,
  created_at timestamptz not null default now(),
  -- regra de consistência: autônomo nunca tem empresa; vinculado sempre tem empresa
  constraint chk_vinculo_coerente check (
    (tipo_prestador = 'autonomo' and company_id is null) or
    (tipo_prestador = 'vinculado' and company_id is not null)
  )
);

create index if not exists idx_prestadores_location on usuarios_prestadores using gist (current_location);
create index if not exists idx_prestadores_online on usuarios_prestadores (is_online, is_available);
create index if not exists idx_prestadores_company on usuarios_prestadores (company_id);

-- Garante que autônomo sempre entra "ativo" e vinculado sempre entra "pendente",
-- mesmo que a aplicação esqueça de mandar o status explicitamente.
create or replace function trg_set_status_aprovacao_default() returns trigger as $$
begin
  if new.tipo_prestador = 'autonomo' then
    new.status_aprovacao := 'ativo';
  elsif new.tipo_prestador = 'vinculado' and (new.status_aprovacao is null or tg_op = 'INSERT') then
    new.status_aprovacao := coalesce(new.status_aprovacao, 'pendente');
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists before_insert_usuarios_prestadores on usuarios_prestadores;
create trigger before_insert_usuarios_prestadores
before insert on usuarios_prestadores
for each row execute function trg_set_status_aprovacao_default();

-- ============================================================
-- 4. TOKENS DE CONVITE DE USO ÚNICO (empresa → prestador)
-- ============================================================
create table if not exists company_invite_tokens (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  token text not null unique,
  status text not null default 'ativo' check (status in ('ativo','usado','expirado','revogado')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '48 hours'),
  used_at timestamptz,
  used_by uuid references profiles(id)
);

create index if not exists idx_invite_tokens_company on company_invite_tokens (company_id, status);

-- Gera um código curto tipo "SNT-7X29" pra empresa compartilhar com o vigilante
create or replace function gerar_token_convite_empresa(p_company_id uuid)
returns text as $$
declare
  v_token text;
begin
  v_token := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 3)) || '-' ||
             upper(substr(md5(random()::text || clock_timestamp()::text), 1, 4));
  insert into company_invite_tokens (company_id, token) values (p_company_id, v_token);
  return v_token;
end;
$$ language plpgsql security definer;

-- Prestador resgata o token (uso único: token vira "usado" e nunca mais funciona)
create or replace function redimir_token_convite(p_token text, p_provider_id uuid)
returns jsonb as $$
declare
  v_row company_invite_tokens%rowtype;
begin
  select * into v_row from company_invite_tokens where token = p_token for update;

  if v_row.id is null then
    return jsonb_build_object('success', false, 'reason', 'token_invalido');
  end if;

  if v_row.status <> 'ativo' then
    return jsonb_build_object('success', false, 'reason', 'token_ja_utilizado_ou_revogado');
  end if;

  if v_row.expires_at < now() then
    update company_invite_tokens set status = 'expirado' where id = v_row.id;
    return jsonb_build_object('success', false, 'reason', 'token_expirado');
  end if;

  update company_invite_tokens
  set status = 'usado', used_at = now(), used_by = p_provider_id
  where id = v_row.id;

  update usuarios_prestadores
  set tipo_prestador = 'vinculado', company_id = v_row.company_id, status_aprovacao = 'pendente'
  where id = p_provider_id;

  return jsonb_build_object('success', true, 'company_id', v_row.company_id);
end;
$$ language plpgsql security definer;

-- Empresa aprova o vínculo pendente (o "chefe" confirmando o vigilante convidado)
create or replace function aprovar_vinculo_prestador(p_provider_id uuid, p_company_id uuid)
returns boolean as $$
begin
  update usuarios_prestadores
  set status_aprovacao = 'ativo'
  where id = p_provider_id and company_id = p_company_id and tipo_prestador = 'vinculado';
  return found;
end;
$$ language plpgsql security definer;

-- Empresa recusa o vínculo pendente
create or replace function recusar_vinculo_prestador(p_provider_id uuid, p_company_id uuid)
returns boolean as $$
begin
  update usuarios_prestadores
  set status_aprovacao = 'recusado'
  where id = p_provider_id and company_id = p_company_id and tipo_prestador = 'vinculado';
  return found;
end;
$$ language plpgsql security definer;

-- ============================================================
-- 5. CATEGORIAS DE SERVIÇO
-- ============================================================
create table if not exists service_categories (
  id serial primary key,
  name text not null,
  icon text,
  base_price numeric(10,2) default 0,
  requer_empresa_autorizada boolean not null default false,
  numero_vigilantes_padrao integer not null default 1,
  active boolean default true
);

insert into service_categories (name, icon)
select * from (values
  ('Lojas', 'store'), ('Mercados', 'shopping-cart'), ('Eventos', 'calendar'),
  ('Galpão', 'warehouse'), ('Apoio', 'life-buoy'), ('Bar/Restaurante', 'utensils'),
  ('Portaria', 'door-open')
) as v(name, icon)
where not exists (select 1 from service_categories where service_categories.name = v.name);

-- Categorias Elite/armadas: exclusivas de empresa parceira autorizada pela PF
insert into service_categories (name, icon, requer_empresa_autorizada, numero_vigilantes_padrao)
select * from (values
  ('Elite', 'shield', true, 1),
  ('Motorista (Avançado)', 'car', true, 2) -- escolta de carga/valores: mínimo 2 vigilantes
) as v(name, icon, requer_empresa_autorizada, numero_vigilantes_padrao)
where not exists (select 1 from service_categories where service_categories.name = v.name);

create table if not exists provider_categories (
  provider_id uuid references usuarios_prestadores(id) on delete cascade,
  category_id integer references service_categories(id) on delete cascade,
  primary key (provider_id, category_id)
);

-- ============================================================
-- 6. TARIFAS — valores-base oficiais (fonte única de verdade do preço)
-- ============================================================
-- Espelha o motor de cálculo já embutido no front-end (calcularServicoShield):
-- valor_hora_final = valor_hora_base × numeroVigilantes × (1.10 se Elite em zona)
--                    × (1.20 se 22h-05h)
create table if not exists tarifas (
  id serial primary key,
  tier text not null check (tier in ('Facility','Padrão','Elite')),
  urgencia text not null check (urgencia in ('Agendado','Urgente')),
  valor_hora_base numeric(10,2) not null,
  percentual_retencao_shield numeric(5,2) not null,
  ativo boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (tier, urgencia)
);

insert into tarifas (tier, urgencia, valor_hora_base, percentual_retencao_shield) values
  ('Facility', 'Agendado', 13.00, 15.00),
  ('Facility', 'Urgente',  15.00, 15.00),
  ('Padrão',   'Agendado', 13.00, 15.00),
  ('Padrão',   'Urgente',  15.00, 15.00),
  ('Elite',    'Agendado', 50.00, 20.00),
  ('Elite',    'Urgente',  55.00, 20.00)
on conflict (tier, urgencia) do nothing;

-- ============================================================
-- 7. DEMANDAS
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'request_type') then
    create type request_type as enum ('immediate', 'scheduled');
  end if;
  if not exists (select 1 from pg_type where typname = 'request_status') then
    create type request_status as enum ('pending','matched','in_progress','completed','cancelled','expired');
  end if;
end $$;

create table if not exists service_requests (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references profiles(id),
  category_id integer not null references service_categories(id),
  provider_id uuid references usuarios_prestadores(id),
  company_id uuid references companies(id), -- preenchido quando a demanda vai pra empresa, nao pro prestador direto
  type request_type not null default 'immediate',
  status request_status not null default 'pending',
  tier text not null default 'Padrão' check (tier in ('Facility','Padrão','Elite')),
  natureza text not null default 'Imediata' check (natureza in ('Imediata','Agendada','Recorrente')),
  plantao_urgencia boolean not null default false,
  numero_vigilantes integer not null default 1,
  duracao_horas numeric(5,2),
  dias_recorrentes jsonb,
  description text,
  address text,
  location geography(Point, 4326) not null,
  scheduled_at timestamptz,
  price_estimate numeric(10,2),
  price_final numeric(10,2),
  valor_negociado numeric(10,2),
  valor_original numeric(10,2),
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
create index if not exists idx_requests_company on service_requests (company_id);

-- ============================================================
-- 8. OFERTAS DE DEMANDA (matching em tempo real)
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'offer_status') then
    create type offer_status as enum ('sent', 'accepted', 'rejected', 'expired');
  end if;
end $$;

create table if not exists request_offers (
  id uuid primary key default uuid_generate_v4(),
  request_id uuid not null references service_requests(id) on delete cascade,
  provider_id uuid not null references usuarios_prestadores(id),
  status offer_status not null default 'sent',
  sent_at timestamptz not null default now(),
  responded_at timestamptz,
  expires_at timestamptz not null default (now() + interval '30 seconds')
);

create index if not exists idx_offers_provider on request_offers (provider_id, status);
create index if not exists idx_offers_request on request_offers (request_id);

-- Negociação de valor (contraproposta do prestador/empresa)
create table if not exists request_negotiations (
  id uuid primary key default uuid_generate_v4(),
  request_id uuid not null references service_requests(id) on delete cascade,
  provider_id uuid not null references usuarios_prestadores(id),
  valor_proposto numeric(10,2) not null,
  status text not null default 'pending' check (status in ('pending','accepted','rejected')),
  created_at timestamptz not null default now()
);

-- Painel Corporativo (contratos recorrentes do lado do cliente)
create table if not exists corp_contracts (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references profiles(id),
  category_id integer references service_categories(id),
  status text not null default 'ativo' check (status in ('ativo','pausado','encerrado')),
  dias_semana text[],
  horario_inicio time,
  horario_fim time,
  valor_mensal numeric(10,2),
  created_at timestamptz not null default now()
);

-- ============================================================
-- 9. CARTEIRA / SAQUE
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'transaction_type') then
    create type transaction_type as enum ('credit', 'debit', 'withdrawal', 'refund');
  end if;
  if not exists (select 1 from pg_type where typname = 'transaction_status') then
    create type transaction_status as enum ('pending', 'completed', 'failed');
  end if;
  if not exists (select 1 from pg_type where typname = 'withdrawal_status') then
    create type withdrawal_status as enum ('pending', 'processing', 'paid', 'failed');
  end if;
end $$;

create table if not exists wallets (
  id uuid primary key references profiles(id) on delete cascade,
  balance numeric(12,2) not null default 0,
  updated_at timestamptz not null default now()
);

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

create table if not exists withdrawal_requests (
  id uuid primary key default uuid_generate_v4(),
  provider_id uuid not null references usuarios_prestadores(id),
  amount numeric(12,2) not null,
  status withdrawal_status not null default 'pending',
  payment_method text,
  pix_key text,
  external_reference text,
  requested_at timestamptz not null default now(),
  processed_at timestamptz
);

-- ============================================================
-- 10. AVALIAÇÕES, NOTIFICAÇÕES E CHAT
-- ============================================================
create table if not exists ratings (
  id uuid primary key default uuid_generate_v4(),
  request_id uuid not null references service_requests(id),
  client_id uuid not null references profiles(id),
  provider_id uuid not null references usuarios_prestadores(id),
  rating smallint not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now()
);

create table if not exists notifications (
  id uuid primary key default uuid_generate_v4(),
  profile_id uuid not null references profiles(id),
  title text not null,
  body text,
  read boolean not null default false,
  data jsonb,
  created_at timestamptz not null default now()
);

create table if not exists chat_messages (
  id uuid primary key default uuid_generate_v4(),
  request_id uuid not null references service_requests(id) on delete cascade,
  sender_id uuid not null references profiles(id),
  message text not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 11. TRIGGERS ÚTEIS
-- ============================================================
create or replace function update_provider_rating() returns trigger as $$
begin
  update usuarios_prestadores
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
-- 12. ROW LEVEL SECURITY
-- ============================================================
alter table profiles enable row level security;
alter table usuarios_prestadores enable row level security;
alter table companies enable row level security;
alter table company_invite_tokens enable row level security;
alter table service_categories enable row level security;
alter table provider_categories enable row level security;
alter table service_requests enable row level security;
alter table request_offers enable row level security;
alter table request_negotiations enable row level security;
alter table corp_contracts enable row level security;
alter table wallets enable row level security;
alter table wallet_transactions enable row level security;

-- --- profiles: cada um vê/edita o próprio perfil ---
drop policy if exists "Usuários veem o próprio perfil" on profiles;
create policy "Usuários veem o próprio perfil" on profiles for select using (auth.uid() = id);

drop policy if exists "Usuário insere o próprio perfil" on profiles;
create policy "Usuário insere o próprio perfil" on profiles for insert with check (auth.uid() = id);

drop policy if exists "Usuário atualiza o próprio perfil" on profiles;
create policy "Usuário atualiza o próprio perfil" on profiles for update using (auth.uid() = id);

-- --- usuarios_prestadores: cada prestador ve/gerencia o proprio registro; empresa ve seus vinculados ---
drop policy if exists "Prestador vê o próprio registro" on usuarios_prestadores;
create policy "Prestador vê o próprio registro" on usuarios_prestadores for select using (auth.uid() = id);

drop policy if exists "Prestador insere o próprio registro" on usuarios_prestadores;
create policy "Prestador insere o próprio registro" on usuarios_prestadores for insert with check (auth.uid() = id);

drop policy if exists "Prestador atualiza o próprio registro" on usuarios_prestadores;
create policy "Prestador atualiza o próprio registro" on usuarios_prestadores for update using (auth.uid() = id);

drop policy if exists "Empresa ve prestadores vinculados a ela" on usuarios_prestadores;
create policy "Empresa ve prestadores vinculados a ela" on usuarios_prestadores for select
  using (company_id in (select id from companies where owner_id = auth.uid()));

-- --- companies: dono ve/gerencia a propria empresa ---
drop policy if exists "Empresa ve/gerencia o proprio registro" on companies;
create policy "Empresa ve/gerencia o proprio registro" on companies for all
  using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- --- tokens de convite: só a empresa dona ve/gerencia os proprios tokens ---
drop policy if exists "Empresa gerencia seus tokens de convite" on company_invite_tokens;
create policy "Empresa gerencia seus tokens de convite" on company_invite_tokens for all
  using (company_id in (select id from companies where owner_id = auth.uid()))
  with check (company_id in (select id from companies where owner_id = auth.uid()));

-- --- categorias de servico: leitura publica ---
drop policy if exists "Qualquer um vê as categorias de serviço" on service_categories;
create policy "Qualquer um vê as categorias de serviço" on service_categories for select using (true);

-- --- vinculo prestador <-> categoria ---
drop policy if exists "Prestador vê suas categorias" on provider_categories;
create policy "Prestador vê suas categorias" on provider_categories for select using (auth.uid() = provider_id);

drop policy if exists "Prestador insere suas categorias" on provider_categories;
create policy "Prestador insere suas categorias" on provider_categories for insert with check (auth.uid() = provider_id);

-- --- demandas: cliente ve as proprias; prestador/empresa veem as que sao deles ---
drop policy if exists "Cliente vê suas próprias demandas" on service_requests;
create policy "Cliente vê suas próprias demandas" on service_requests for select
  using (
    auth.uid() = client_id
    or auth.uid() = provider_id
    or company_id in (select id from companies where owner_id = auth.uid())
  );

drop policy if exists "Cliente cria suas demandas" on service_requests;
create policy "Cliente cria suas demandas" on service_requests for insert with check (auth.uid() = client_id);

-- --- negociacoes ---
drop policy if exists "Prestador ve/insere suas negociações" on request_negotiations;
create policy "Prestador ve/insere suas negociações" on request_negotiations for all
  using (auth.uid() = provider_id) with check (auth.uid() = provider_id);

-- --- contratos corporativos ---
drop policy if exists "Cliente ve/gerencia seus contratos corporativos" on corp_contracts;
create policy "Cliente ve/gerencia seus contratos corporativos" on corp_contracts for all
  using (auth.uid() = client_id) with check (auth.uid() = client_id);

-- ============================================================
-- FIM DO ARQUIVO
-- ============================================================


-- ############################################################
-- ARQUIVO ORIGINAL: empresas_parceiras.sql
-- ############################################################
-- ============================================================
-- SHIELD — TABELA: empresas_parceiras
-- ============================================================
-- Continuação do arquivo "arquitetura_banco_shield.sql".
-- Renomeia a tabela "companies" (se já existir) para "empresas_parceiras"
-- e adiciona: plano contratado (bronze/prata/ouro) + geolocalização da sede.
-- Seguro rodar tanto em cima do banco que você já tem quanto num projeto novo.
-- ============================================================

-- Se a tabela "companies" já existir (do script anterior), renomeia em vez
-- de criar uma tabela duplicada. As foreign keys que apontam pra ela
-- (usuarios_prestadores.company_id, service_requests.company_id,
-- company_invite_tokens.company_id) são atualizadas automaticamente pelo
-- Postgres, sem precisar recriar nada.
do $$
begin
  if exists (select 1 from information_schema.tables where table_name = 'companies')
     and not exists (select 1 from information_schema.tables where table_name = 'empresas_parceiras') then
    alter table companies rename to empresas_parceiras;
  end if;
end $$;

create table if not exists empresas_parceiras (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid not null references profiles(id),
  razao_social text not null,
  cnpj text not null unique,
  telefone text,
  autorizacao_pf_valida_ate date,
  verified boolean not null default false,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Plano contratado
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'plano_empresa_enum') then
    create type plano_empresa_enum as enum ('bronze', 'prata', 'ouro');
  end if;
end $$;

alter table empresas_parceiras
  add column if not exists plano plano_empresa_enum not null default 'bronze';

-- ------------------------------------------------------------
-- Dados geográficos da sede física
-- ------------------------------------------------------------
alter table empresas_parceiras
  add column if not exists endereco_sede text,
  add column if not exists latitude_sede numeric(9,6),
  add column if not exists longitude_sede numeric(9,6),
  add column if not exists localizacao_sede geography(Point, 4326),
  add column if not exists updated_at timestamptz not null default now();

-- Mantém localizacao_sede sempre sincronizada com latitude_sede/longitude_sede,
-- pra você poder gravar/ler só os dois números (mais simples no front-end) e ainda
-- ter o ponto geográfico pronto pra consultas de distância (ST_DWithin, etc.)
create or replace function trg_sync_localizacao_sede() returns trigger as $$
begin
  if new.latitude_sede is not null and new.longitude_sede is not null then
    new.localizacao_sede := ST_SetSRID(ST_MakePoint(new.longitude_sede, new.latitude_sede), 4326)::geography;
  else
    new.localizacao_sede := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists before_upsert_localizacao_sede on empresas_parceiras;
create trigger before_upsert_localizacao_sede
before insert or update on empresas_parceiras
for each row execute function trg_sync_localizacao_sede();

create index if not exists idx_empresas_localizacao_sede on empresas_parceiras using gist (localizacao_sede);
create index if not exists idx_empresas_plano on empresas_parceiras (plano);

-- ============================================================
-- FIM
-- ============================================================


-- ############################################################
-- ARQUIVO ORIGINAL: planos_parceria.sql
-- ############################################################
-- ============================================================
-- SHIELD — TABELA: planos_parceria (Bronze / Prata / Ouro)
-- ============================================================
-- Continuação de "arquitetura_banco_shield.sql" + "empresas_parceiras.sql".
-- Define a mensalidade e a taxa de retenção ShielD de cada plano — a
-- empresa paga mais fixo pra pagar menos variável (%) por demanda.
-- ============================================================

create table if not exists planos_parceria (
  plano plano_empresa_enum primary key,
  mensalidade numeric(10,2) not null,
  taxa_shield_percentual numeric(5,2) not null, -- em pontos percentuais, ex: 15.00 = 15%
  updated_at timestamptz not null default now()
);

insert into planos_parceria (plano, mensalidade, taxa_shield_percentual) values
  ('bronze', 0.00,   15.00),
  ('prata',  199.00,  8.00),
  ('ouro',   499.00,  3.00)
on conflict (plano) do update
  set mensalidade = excluded.mensalidade,
      taxa_shield_percentual = excluded.taxa_shield_percentual,
      updated_at = now();

-- ------------------------------------------------------------
-- Função: retorna a taxa ShielD (em fração decimal, ex: 0.15) da
-- empresa informada, já resolvendo o plano dela automaticamente.
-- ------------------------------------------------------------
create or replace function taxa_shield_da_empresa(p_company_id uuid)
returns numeric as $$
declare
  v_taxa numeric;
begin
  select pp.taxa_shield_percentual into v_taxa
  from empresas_parceiras ep
  join planos_parceria pp on pp.plano = ep.plano
  where ep.id = p_company_id;

  if v_taxa is null then
    raise exception 'Empresa % não encontrada ou sem plano definido', p_company_id;
  end if;

  return v_taxa / 100.0;
end;
$$ language plpgsql stable;

-- ------------------------------------------------------------
-- RLS: leitura pública (é uma tabela de referência, não sensível)
-- ------------------------------------------------------------
alter table planos_parceria enable row level security;

drop policy if exists "Qualquer um vê os planos" on planos_parceria;
create policy "Qualquer um vê os planos" on planos_parceria for select using (true);

-- ============================================================
-- FIM
-- ============================================================


-- ############################################################
-- ARQUIVO ORIGINAL: modelo_calculo_categoria.sql
-- ############################################################
-- ============================================================
-- SHIELD — MODELO DE CÁLCULO POR CATEGORIA (logístico vs posto)
-- ============================================================
-- Continuação de "arquitetura_banco_shield.sql" + "tarifas_servicos.sql".
-- Cada categoria de serviço passa a saber qual REGRA DE CÁLCULO usar:
--
--   'logistico' -> Regra A (deslocamento rodoviário: KM excedente + pedágio)
--                  Ex: escolta_de_carga
--
--   'posto'     -> Regra B (posto/permanência: profissionais x horas)
--                  Ex: eventos, vigilância patrimonial, facilities
-- ============================================================

alter table service_categories
  add column if not exists modelo_calculo text not null default 'posto'
    check (modelo_calculo in ('logistico', 'posto'));

update service_categories set modelo_calculo = 'logistico'
  where slug in ('escolta_de_carga');

update service_categories set modelo_calculo = 'posto'
  where slug in (
    'seguranca_eventos', 'seguranca_elite', 'facilities_limpeza',
    'portaria', 'apoio', 'bar_restaurante', 'lojas', 'mercados', 'galpao'
  );

-- ============================================================
-- FIM
-- ============================================================


-- ############################################################
-- ARQUIVO ORIGINAL: tarifas_servicos.sql
-- ############################################################
-- ============================================================
-- SHIELD — TABELA: tarifas_servicos
-- ============================================================
-- Continuação de "arquitetura_banco_shield.sql" + "empresas_parceiras.sql".
-- Guarda o tarifário PRÓPRIO de cada empresa parceira (Valor Base, Franquia
-- de KM, KM Excedente, Franquia de Horas, Hora Excedente), por tipo de
-- serviço (escolta_de_carga, seguranca_eventos, facilities_limpeza, etc.).
--
-- Isso é diferente da tabela "tarifas" (valores-base fixos e iguais pra
-- todo mundo no motor de matching automático) — "tarifas_servicos" é o
-- preço que a PRÓPRIA empresa configura, pensado pra orçamentos/contratos
-- negociados (ex: um contrato corporativo recorrente de facilities).
-- ============================================================

create extension if not exists unaccent;


-- ------------------------------------------------------------
-- 1. "slug" nas categorias de serviço, pra ter um identificador estável
--    (ex: 'escolta_de_carga') além do nome de exibição (ex: 'Motorista (Avançado)')
-- ------------------------------------------------------------
alter table service_categories
  add column if not exists slug text;

update service_categories set slug = 'lojas' where name = 'Lojas' and slug is null;
update service_categories set slug = 'mercados' where name = 'Mercados' and slug is null;
update service_categories set slug = 'seguranca_eventos' where name = 'Eventos' and slug is null;
update service_categories set slug = 'galpao' where name = 'Galpão' and slug is null;
update service_categories set slug = 'apoio' where name = 'Apoio' and slug is null;
update service_categories set slug = 'bar_restaurante' where name = 'Bar/Restaurante' and slug is null;
update service_categories set slug = 'portaria' where name = 'Portaria' and slug is null;
update service_categories set slug = 'seguranca_elite' where name = 'Elite' and slug is null;
update service_categories set slug = 'escolta_de_carga' where name = 'Motorista (Avançado)' and slug is null;

-- Categoria nova que o pedido menciona e ainda não existia: facilities/limpeza
insert into service_categories (name, icon, slug, requer_empresa_autorizada, numero_vigilantes_padrao)
select 'Facilities/Limpeza', 'sparkles', 'facilities_limpeza', false, 1
where not exists (select 1 from service_categories where slug = 'facilities_limpeza');

-- fallback: qualquer categoria que por acaso tenha ficado sem slug, gera um a partir do nome
update service_categories
set slug = lower(regexp_replace(unaccent(name), '[^a-zA-Z0-9]+', '_', 'g'))
where slug is null;

alter table service_categories
  add constraint uq_service_categories_slug unique (slug);

-- ------------------------------------------------------------
-- 2. Tabela tarifas_servicos
-- ------------------------------------------------------------
create table if not exists tarifas_servicos (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references empresas_parceiras(id) on delete cascade,
  tipo_servico text not null references service_categories(slug),
  valor_base numeric(10,2) not null,
  franquia_km numeric(6,2) not null default 0,       -- km incluídos antes de cobrar excedente
  km_excedente numeric(10,2) not null default 0,      -- valor por km além da franquia
  franquia_horas numeric(5,2) not null default 0,     -- horas incluídas antes de cobrar excedente
  hora_excedente numeric(10,2) not null default 0,    -- valor por hora além da franquia
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, tipo_servico)
);

create index if not exists idx_tarifas_servicos_company on tarifas_servicos (company_id);
create index if not exists idx_tarifas_servicos_tipo on tarifas_servicos (tipo_servico);

create or replace function trg_touch_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists before_update_tarifas_servicos on tarifas_servicos;
create trigger before_update_tarifas_servicos
before update on tarifas_servicos
for each row execute function trg_touch_updated_at();

-- ------------------------------------------------------------
-- 3. Função auxiliar: calcula o valor de um serviço a partir do tarifário
--    da própria empresa (Valor Base + excedentes de KM e de horas)
-- ------------------------------------------------------------
create or replace function calcular_valor_tarifa_servico(
  p_company_id uuid,
  p_tipo_servico text,
  p_km_rodados numeric,
  p_horas_utilizadas numeric
) returns numeric as $$
declare
  v_tarifa tarifas_servicos%rowtype;
  v_km_excedentes numeric;
  v_horas_excedentes numeric;
  v_total numeric;
begin
  select * into v_tarifa
  from tarifas_servicos
  where company_id = p_company_id and tipo_servico = p_tipo_servico and ativo = true;

  if v_tarifa.id is null then
    raise exception 'Tarifa não configurada para esta empresa/tipo de serviço';
  end if;

  v_km_excedentes := greatest(p_km_rodados - v_tarifa.franquia_km, 0);
  v_horas_excedentes := greatest(p_horas_utilizadas - v_tarifa.franquia_horas, 0);

  v_total := v_tarifa.valor_base
    + (v_km_excedentes * v_tarifa.km_excedente)
    + (v_horas_excedentes * v_tarifa.hora_excedente);

  return round(v_total, 2);
end;
$$ language plpgsql stable;

-- ------------------------------------------------------------
-- 4. RLS
-- ------------------------------------------------------------
alter table tarifas_servicos enable row level security;

drop policy if exists "Qualquer um vê tarifas ativas" on tarifas_servicos;
create policy "Qualquer um vê tarifas ativas" on tarifas_servicos for select
  using (ativo = true or company_id in (select id from empresas_parceiras where owner_id = auth.uid()));

drop policy if exists "Empresa gerencia seu proprio tarifario" on tarifas_servicos;
create policy "Empresa gerencia seu proprio tarifario" on tarifas_servicos for all
  using (company_id in (select id from empresas_parceiras where owner_id = auth.uid()))
  with check (company_id in (select id from empresas_parceiras where owner_id = auth.uid()));

-- ============================================================
-- FIM
-- ============================================================


-- ############################################################
-- ARQUIVO ORIGINAL: tarifas_servicos_json.sql
-- ############################################################
-- ============================================================
-- SHIELD — tarifas_servicos: um único JSON pros dois formatos de preço
-- ============================================================
-- Continuação de "tarifas_servicos.sql" + "modelo_calculo_categoria.sql".
--
-- Em vez de 5 colunas fixas (algumas sempre vazias, dependendo da
-- categoria), a empresa configura um único campo `parametros` (jsonb)
-- — e o FORMATO esperado dentro desse JSON muda de acordo com o
-- `modelo_calculo` da categoria (que já vive em service_categories):
--
--   logistico -> { "valor_base": 500.00, "franquia_km": 50, "km_excedente": 4.50 }
--   posto     -> { "valor_base_profissional": 45.00, "franquia_horas": 6, "hora_excedente": 12.00 }
--
-- Um gatilho valida automaticamente que o JSON enviado tem as chaves
-- certas pro modelo daquela categoria — a empresa não consegue salvar
-- um JSON incompleto/errado pra categoria escolhida.
-- ============================================================

alter table tarifas_servicos add column if not exists parametros jsonb;

-- Migra os dados das colunas antigas (se existirem) pro novo JSON,
-- de acordo com o modelo_calculo da categoria
update tarifas_servicos ts
set parametros = case sc.modelo_calculo
  when 'logistico' then jsonb_build_object(
    'valor_base', ts.valor_base,
    'franquia_km', ts.franquia_km,
    'km_excedente', ts.km_excedente
  )
  else jsonb_build_object(
    'valor_base_profissional', ts.valor_base,
    'franquia_horas', ts.franquia_horas,
    'hora_excedente', ts.hora_excedente
  )
end
from service_categories sc
where sc.slug = ts.tipo_servico and ts.parametros is null;

alter table tarifas_servicos alter column parametros set not null;

-- ------------------------------------------------------------
-- Validação automática: o JSON precisa ter as chaves certas pro
-- modelo_calculo da categoria (logistico ou posto)
-- ------------------------------------------------------------
create or replace function trg_validar_parametros_tarifa() returns trigger as $$
declare
  v_modelo text;
begin
  select modelo_calculo into v_modelo from service_categories where slug = new.tipo_servico;

  if v_modelo is null then
    raise exception 'Categoria "%" não existe ou está sem modelo_calculo definido', new.tipo_servico;
  end if;

  if v_modelo = 'logistico' then
    if not (new.parametros ? 'valor_base' and new.parametros ? 'franquia_km' and new.parametros ? 'km_excedente') then
      raise exception 'parametros inválido para serviço logístico ("%"): precisa das chaves valor_base, franquia_km, km_excedente', new.tipo_servico;
    end if;
  elsif v_modelo = 'posto' then
    if not (new.parametros ? 'valor_base_profissional' and new.parametros ? 'franquia_horas' and new.parametros ? 'hora_excedente') then
      raise exception 'parametros inválido para serviço de posto ("%"): precisa das chaves valor_base_profissional, franquia_horas, hora_excedente', new.tipo_servico;
    end if;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists before_insert_update_tarifas_servicos on tarifas_servicos;
create trigger before_insert_update_tarifas_servicos
before insert or update on tarifas_servicos
for each row execute function trg_validar_parametros_tarifa();

-- ------------------------------------------------------------
-- Remove as colunas antigas (agora tudo mora dentro de "parametros")
-- ------------------------------------------------------------
alter table tarifas_servicos
  drop column if exists valor_base,
  drop column if exists franquia_km,
  drop column if exists km_excedente,
  drop column if exists franquia_horas,
  drop column if exists hora_excedente;

-- ------------------------------------------------------------
-- Atualiza a função de cálculo pra ler do JSON, ramificando por modelo
-- ------------------------------------------------------------
create or replace function calcular_valor_tarifa_servico(
  p_company_id uuid,
  p_tipo_servico text,
  p_km_rodados numeric default null,
  p_horas_utilizadas numeric default null,
  p_qtd_profissionais numeric default null,
  p_pedagio_rota numeric default 0
) returns numeric as $$
declare
  v_tarifa tarifas_servicos%rowtype;
  v_modelo text;
  v_km_excedentes numeric;
  v_horas_excedentes numeric;
  v_total numeric;
begin
  select * into v_tarifa
  from tarifas_servicos
  where company_id = p_company_id and tipo_servico = p_tipo_servico and ativo = true;

  if v_tarifa.id is null then
    raise exception 'Tarifa não configurada para esta empresa/tipo de serviço';
  end if;

  select modelo_calculo into v_modelo from service_categories where slug = p_tipo_servico;

  if v_modelo = 'logistico' then
    if p_km_rodados is null then
      raise exception 'p_km_rodados é obrigatório para serviços logísticos';
    end if;
    v_km_excedentes := greatest(p_km_rodados - (v_tarifa.parametros->>'franquia_km')::numeric, 0);
    v_total := (v_tarifa.parametros->>'valor_base')::numeric
      + (v_km_excedentes * (v_tarifa.parametros->>'km_excedente')::numeric)
      + coalesce(p_pedagio_rota, 0);
  else
    if p_horas_utilizadas is null or p_qtd_profissionais is null then
      raise exception 'p_horas_utilizadas e p_qtd_profissionais são obrigatórios para serviços de posto';
    end if;
    v_horas_excedentes := greatest(p_horas_utilizadas - (v_tarifa.parametros->>'franquia_horas')::numeric, 0);
    v_total := ((v_tarifa.parametros->>'valor_base_profissional')::numeric * p_qtd_profissionais)
      + (v_horas_excedentes * (v_tarifa.parametros->>'hora_excedente')::numeric);
  end if;

  return round(v_total, 2);
end;
$$ language plpgsql stable;

-- ============================================================
-- FIM
-- ============================================================


-- ############################################################
-- ARQUIVO ORIGINAL: responsabilidade_documental.sql
-- ############################################################
-- ============================================================
-- SHIELD — Responsabilidade Documental da Empresa Parceira
-- ============================================================
-- Continuação de "arquitetura_banco_shield.sql".
--
-- A conferência e validade jurídica da documentação do vigilante (CNV -
-- Carteira Nacional de Vigilante, e as reciclagens periódicas) é
-- responsabilidade EXCLUSIVA da empresa parceira, não da ShielD.
--
-- Isso é reforçado de duas formas:
--   1) Campos próprios pra registrar os dados (preenchidos pela empresa,
--      nunca pelo ShielD).
--   2) Uma TRAVA TÉCNICA: a função de aprovar o vínculo agora EXIGE uma
--      confirmação explícita da empresa (p_confirma_documentacao = true).
--      Sem isso, a aprovação é recusada pelo próprio banco — não é
--      apenas um texto no contrato, é uma regra que o sistema obriga.
-- ============================================================

alter table usuarios_prestadores
  add column if not exists numero_cnv text,
  add column if not exists cnv_validade date,
  add column if not exists reciclagem_validade date,
  add column if not exists documentacao_conferida_pela_empresa boolean not null default false,
  add column if not exists documentacao_conferida_em timestamptz,
  add column if not exists documentacao_conferida_por uuid references profiles(id);

-- Precisa dropar antes pois o tipo de retorno muda (de boolean pra jsonb)
drop function if exists aprovar_vinculo_prestador(uuid, uuid);

create or replace function aprovar_vinculo_prestador(
  p_provider_id uuid,
  p_company_id uuid,
  p_confirma_documentacao boolean,
  p_numero_cnv text default null,
  p_cnv_validade date default null,
  p_reciclagem_validade date default null
) returns jsonb as $$
declare
  v_owner_id uuid;
begin
  if not p_confirma_documentacao then
    return jsonb_build_object(
      'success', false,
      'reason', 'confirmacao_documentacao_obrigatoria'
    );
  end if;

  select owner_id into v_owner_id from empresas_parceiras where id = p_company_id;

  update usuarios_prestadores
  set status_aprovacao = 'ativo',
      numero_cnv = coalesce(p_numero_cnv, numero_cnv),
      cnv_validade = coalesce(p_cnv_validade, cnv_validade),
      reciclagem_validade = coalesce(p_reciclagem_validade, reciclagem_validade),
      documentacao_conferida_pela_empresa = true,
      documentacao_conferida_em = now(),
      documentacao_conferida_por = v_owner_id
  where id = p_provider_id and company_id = p_company_id and tipo_prestador = 'vinculado';

  if not found then
    return jsonb_build_object('success', false, 'reason', 'vinculo_nao_encontrado');
  end if;

  return jsonb_build_object('success', true);
end;
$$ language plpgsql security definer;

-- ============================================================
-- FIM
-- ============================================================


-- ############################################################
-- ARQUIVO ORIGINAL: panic_alerts.sql
-- ############################################################
-- ============================================================
-- SHIELD — Acionamento Triplo do Pânico
-- ============================================================
-- Continuação de "arquitetura_banco_shield.sql".
--
-- panic_alerts: cada acionamento de pânico. A simples INSERÇÃO nessa
-- tabela já é o "canal 1 e 2" do acionamento triplo — porque Empresa
-- Parceira e Dashboard da ShielD escutam essa tabela via Supabase
-- Realtime (que roda sobre WebSocket por baixo dos panos). O "canal 3"
-- (gerenciadoras de risco terceirizadas) é feito por webhook HTTP,
-- disparado pela função serverless que insere aqui.
-- ============================================================

create table if not exists panic_alerts (
  id uuid primary key default uuid_generate_v4(),
  provider_id uuid not null references usuarios_prestadores(id),
  company_id uuid references empresas_parceiras(id), -- null = prestador autônomo
  request_id uuid references service_requests(id),
  latitude numeric(10,7) not null,
  longitude numeric(10,7) not null,
  status text not null default 'ativo' check (status in ('ativo','em_atendimento','encerrado','falso_alarme')),
  acionado_em timestamptz not null default now(),
  encerrado_em timestamptz,
  encerrado_por uuid references profiles(id),
  observacoes text
);

create index if not exists idx_panic_alerts_provider on panic_alerts (provider_id);
create index if not exists idx_panic_alerts_company on panic_alerts (company_id);
create index if not exists idx_panic_alerts_status on panic_alerts (status) where status = 'ativo';

-- Webhooks das gerenciadoras de risco terceirizadas. Uma empresa parceira
-- pode ter a(s) sua(s) própria(s) gerenciadora(s); company_id nulo =
-- webhook "padrão" da ShielD (usado por prestadores autônomos, ou como
-- fallback caso a empresa não tenha uma própria configurada).
create table if not exists webhooks_gerenciadoras_risco (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references empresas_parceiras(id),
  nome_gerenciadora text not null,
  url_webhook text not null,
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_webhooks_risco_company on webhooks_gerenciadoras_risco (company_id, ativo);

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table panic_alerts enable row level security;
alter table webhooks_gerenciadoras_risco enable row level security;

-- Prestador sempre pode inserir o PRÓPRIO acionamento
drop policy if exists "Prestador aciona seu proprio panico" on panic_alerts;
create policy "Prestador aciona seu proprio panico" on panic_alerts for insert
  with check (auth.uid() = provider_id);

-- Prestador ve os proprios acionamentos; empresa ve os dos seus vinculados;
-- admin (Dashboard operacional da ShielD) ve TUDO.
drop policy if exists "Visualizacao de acionamentos de panico" on panic_alerts;
create policy "Visualizacao de acionamentos de panico" on panic_alerts for select
  using (
    auth.uid() = provider_id
    or company_id in (select id from empresas_parceiras where owner_id = auth.uid())
    or exists (select 1 from profiles where id = auth.uid() and role = 'admin')
  );

-- Empresa e admin podem atualizar o status (ex: marcar como "em_atendimento"/"encerrado")
drop policy if exists "Empresa/admin gerenciam o status do panico" on panic_alerts;
create policy "Empresa/admin gerenciam o status do panico" on panic_alerts for update
  using (
    company_id in (select id from empresas_parceiras where owner_id = auth.uid())
    or exists (select 1 from profiles where id = auth.uid() and role = 'admin')
  );

-- Webhooks: só a própria empresa (ou admin) gerencia os webhooks dela
drop policy if exists "Empresa gerencia seus webhooks de risco" on webhooks_gerenciadoras_risco;
create policy "Empresa gerencia seus webhooks de risco" on webhooks_gerenciadoras_risco for all
  using (
    company_id in (select id from empresas_parceiras where owner_id = auth.uid())
    or exists (select 1 from profiles where id = auth.uid() and role = 'admin')
  )
  with check (
    company_id in (select id from empresas_parceiras where owner_id = auth.uid())
    or exists (select 1 from profiles where id = auth.uid() and role = 'admin')
  );

-- ============================================================
-- FIM
-- ============================================================


-- ############################################################
-- ARQUIVO ORIGINAL: panic_alerts_client_id.sql
-- ############################################################
-- ============================================================
-- SHIELD — panic_alerts: adiciona client_id (avisar o cliente também)
-- ============================================================
-- Continuação de "panic_alerts.sql". Sem isso, só Empresa e ShielD
-- ficavam sabendo do acionamento — o cliente que está recebendo aquele
-- atendimento também precisa ser avisado (reasseguramento + transparência).
-- ============================================================

alter table panic_alerts
  add column if not exists client_id uuid references profiles(id);

create index if not exists idx_panic_alerts_client on panic_alerts (client_id);

-- Cliente pode ver os próprios acionamentos (do atendimento que ele contratou)
drop policy if exists "Cliente ve panico do proprio atendimento" on panic_alerts;
create policy "Cliente ve panico do proprio atendimento" on panic_alerts for select
  using (auth.uid() = client_id);

-- ============================================================
-- FIM
-- ============================================================


-- ############################################################
-- ARQUIVO ORIGINAL: token_foi_utilizado.sql
-- ############################################################
-- ============================================================
-- SHIELD — Mecanismo de Uso Único do Token de Convite
-- ============================================================
-- Continuação de "arquitetura_banco_shield.sql" (que já tem a tabela
-- company_invite_tokens e a função redimir_token_convite).
--
-- Adiciona a coluna `foi_utilizado` (booleana, calculada automaticamente
-- pelo próprio banco — nunca fica dessincronizada do status real):
--   foi_utilizado = true   assim que o token é resgatado com sucesso
--   foi_utilizado = false  enquanto ainda está ativo, expirado ou revogado
-- ============================================================

alter table company_invite_tokens
  add column if not exists foi_utilizado boolean generated always as (status = 'usado') stored;

create index if not exists idx_invite_tokens_foi_utilizado on company_invite_tokens (foi_utilizado);

-- ============================================================
-- FIM
-- ============================================================


-- ############################################################
-- ARQUIVO ORIGINAL: provider_location_pings.sql
-- ############################################################
-- ============================================================
-- SHIELD — Histórico de posições GPS (fila offline-first)
-- ============================================================
-- Continuação de "arquitetura_banco_shield.sql".
-- Guarda TODO ponto de GPS capturado do vigilante, mesmo os que chegaram
-- atrasados (enviados em lote, depois de ficar sem sinal em rodovia/zona
-- rural). `captured_at` é quando o ponto foi capturado de verdade no
-- celular; `received_at` é quando o servidor recebeu — podem ser bem
-- diferentes quando o envio veio da fila offline.
-- ============================================================

create table if not exists provider_location_pings (
  id uuid primary key default uuid_generate_v4(),
  provider_id uuid not null references usuarios_prestadores(id) on delete cascade,
  request_id uuid references service_requests(id), -- opcional: a que atendimento esse trajeto pertence
  latitude numeric(10,7) not null,
  longitude numeric(10,7) not null,
  accuracy numeric(6,2),
  captured_at timestamptz not null,
  received_at timestamptz not null default now(),
  veio_da_fila_offline boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_location_pings_provider on provider_location_pings (provider_id, captured_at);
create index if not exists idx_location_pings_request on provider_location_pings (request_id);

-- Sempre que um ping novo chega, atualiza a posição "atual" do prestador
-- (usada pelo matching) -- só se for mais recente que a que já está lá.
create or replace function trg_atualizar_posicao_atual_prestador() returns trigger as $$
begin
  update usuarios_prestadores
  set current_location = ST_SetSRID(ST_MakePoint(new.longitude, new.latitude), 4326)::geography,
      last_location_at = new.captured_at
  where id = new.provider_id
    and (last_location_at is null or new.captured_at > last_location_at);
  return new;
end;
$$ language plpgsql;

drop trigger if exists after_insert_location_ping on provider_location_pings;
create trigger after_insert_location_ping
after insert on provider_location_pings
for each row execute function trg_atualizar_posicao_atual_prestador();

alter table provider_location_pings enable row level security;

drop policy if exists "Prestador insere seus proprios pings" on provider_location_pings;
create policy "Prestador insere seus proprios pings" on provider_location_pings for insert
  with check (auth.uid() = provider_id);

drop policy if exists "Prestador ve seus proprios pings" on provider_location_pings;
create policy "Prestador ve seus proprios pings" on provider_location_pings for select
  using (auth.uid() = provider_id);

-- ============================================================
-- FIM
-- ============================================================


-- ############################################################
-- ARQUIVO ORIGINAL: pricing_engine.sql
-- ############################################################
-- ============================================================
-- MÓDULO: PRECIFICAÇÃO DINÂMICA POR ANÁLISE DE RISCO
-- Serviço: "Controlador Avançado"
-- Regra: valor_prestador (geografia x contexto) -> valor_cliente = valor_prestador / 0.80
-- ============================================================

-- ------------------------------------------------------------
-- 1. TABELA: risk_zones (Fator Geográfico)
-- ------------------------------------------------------------
create table risk_zones (
  id serial primary key,
  bairro_ou_cidade text not null unique,
  classificacao text not null check (classificacao in ('risco', 'padrao', 'elite')),
  valor_base_hora numeric(10,2) not null,
  observacao text,
  created_at timestamptz not null default now()
);

-- Seed inicial (Grande BH) — ajuste/expanda livremente pelo painel admin depois
insert into risk_zones (bairro_ou_cidade, classificacao, valor_base_hora, observacao) values
  ('Ibirité',                         'risco',  24.00, 'Fator de periculosidade local'),
  ('Barreiro',                        'risco',  24.00, 'Fator de periculosidade local (região profunda)'),
  ('Ressaca',                         'risco',  24.00, 'Contagem - fator de periculosidade local'),
  ('Petrolândia',                     'risco',  24.00, 'Contagem - fator de periculosidade local'),
  ('Belvedere',                       'elite',  25.00, 'Alto padrão / poder aquisitivo'),
  ('Savassi',                         'elite',  25.00, 'Alto padrão / poder aquisitivo'),
  ('Alphaville',                      'elite',  26.00, 'Nova Lima - alto padrão / poder aquisitivo'),
  ('Lourdes',                         'elite',  25.00, 'Alto padrão / poder aquisitivo');
-- Qualquer bairro NÃO cadastrado aqui cai automaticamente na zona "padrão" (R$21,00/h) via COALESCE na função.

-- ------------------------------------------------------------
-- 2. TABELA: location_types (Fator de Contexto)
-- ------------------------------------------------------------
create table location_types (
  id serial primary key,
  tipo_servico text not null unique,
  categoria text not null check (categoria in ('risco_local', 'evento_elite', 'padrao')),
  multiplicador numeric(5,4) not null default 1.0000,
  observacao text,
  created_at timestamptz not null default now()
);

insert into location_types (tipo_servico, categoria, multiplicador, observacao) values
  ('Farmácia 24h',              'risco_local',  1.10, 'Vulnerabilidade do local (+10%)'),
  ('Posto de Combustível',      'risco_local',  1.10, 'Vulnerabilidade do local (+10%)'),
  ('Loja de Conveniência 24h',  'risco_local',  1.10, 'Vulnerabilidade do local (+10%)'),
  ('Festa/Show Elite',          'evento_elite', 1.15, 'Exigência de traje/postura/nível do público (+15%)'),
  ('Evento Corporativo Alto Padrão', 'evento_elite', 1.15, 'Exigência de traje/postura (+15%)');
-- Qualquer tipo_servico NÃO cadastrado cai em multiplicador 1.00 (sem ajuste de contexto).

-- ------------------------------------------------------------
-- 3. FUNÇÃO: calcular_preco_controlador_avancado
-- Recebe endereço (texto livre) e tipo_servico (texto livre/categoria),
-- faz correspondência textual (ILIKE) contra as tabelas acima e retorna
-- o valor exato do prestador e do cliente.
-- ------------------------------------------------------------
create or replace function calcular_preco_controlador_avancado(
  p_endereco text,
  p_tipo_servico text
) returns table (
  valor_prestador numeric(10,2),
  valor_cliente numeric(10,2),
  zona_classificacao text,
  zona_identificada text,
  contexto_categoria text,
  contexto_multiplicador numeric(5,4),
  shield_markup_pct numeric(5,2)
) as $$
declare
  v_zone risk_zones%rowtype;
  v_loc location_types%rowtype;
  v_base numeric(10,2) := 21.00;   -- valor mínimo padrão do prestador
  v_mult numeric(5,4)  := 1.0000;  -- sem ajuste de contexto por padrão
  v_valor_prestador numeric(10,2);
  v_valor_cliente numeric(10,2);
begin
  -- 1) FATOR GEOGRÁFICO
  -- Prioriza "elite" sobre "risco" caso o endereço combine com mais de um termo
  -- (ex: evita ambiguidade se dois nomes de bairro aparecerem no texto)
  select * into v_zone
  from risk_zones
  where p_endereco ilike '%' || bairro_ou_cidade || '%'
  order by case classificacao when 'elite' then 1 when 'risco' then 2 else 3 end
  limit 1;

  if v_zone.id is not null then
    v_base := v_zone.valor_base_hora;
  end if; -- senão, mantém o padrão de R$21,00/h

  -- 2) FATOR DE CONTEXTO
  select * into v_loc
  from location_types
  where p_tipo_servico ilike '%' || tipo_servico || '%'
  limit 1;

  if v_loc.id is not null then
    v_mult := v_loc.multiplicador;
  end if; -- senão, multiplicador neutro 1.00

  -- 3) CÁLCULO FINAL + SPLIT SHIELD (20%)
  v_valor_prestador := round(v_base * v_mult, 2);
  v_valor_cliente    := round(v_valor_prestador / 0.80, 2);

  return query select
    v_valor_prestador,
    v_valor_cliente,
    coalesce(v_zone.classificacao, 'padrao'),
    coalesce(v_zone.bairro_ou_cidade, 'Zona padrão (não mapeada)'),
    coalesce(v_loc.categoria, 'padrao'),
    v_mult,
    20.00::numeric(5,2);
end;
$$ language plpgsql stable;

-- ------------------------------------------------------------
-- 4. EXEMPLOS DE USO
-- ------------------------------------------------------------
-- select * from calcular_preco_controlador_avancado('Rua Fernandes Tourinho, Savassi, BH', 'Padrão');
-- >> valor_prestador: 25.00 | valor_cliente: 31.25 | zona: elite (Savassi)

-- select * from calcular_preco_controlador_avancado('Av. Vereador José Gomes, Ibirité', 'Farmácia 24h');
-- >> valor_base 24.00 x 1.10 = valor_prestador: 26.40 | valor_cliente: 33.00 | zona: risco | contexto: risco_local

-- select * from calcular_preco_controlador_avancado('Av. Cristiano Machado, BH', 'Padrão');
-- >> valor_prestador: 21.00 | valor_cliente: 26.25 | zona: padrao (não mapeada)

-- ------------------------------------------------------------
-- 5. TRIGGER OPCIONAL: preencher price_estimate automaticamente
-- ao criar uma demanda da categoria "Controlador Avançado"
-- (integra com a tabela service_requests já existente no schema.sql principal)
-- ------------------------------------------------------------
create or replace function trg_precificar_controlador_avancado()
returns trigger as $$
declare
  v_categoria_nome text;
  v_calc record;
begin
  select name into v_categoria_nome from service_categories where id = new.category_id;

  if v_categoria_nome = 'Controlador Avançado' then
    select * into v_calc from calcular_preco_controlador_avancado(new.address, coalesce(new.description, 'Padrão'));
    new.price_estimate := v_calc.valor_cliente;
    -- o valor do prestador (v_calc.valor_prestador) fica registrado no split de pagamento,
    -- não na própria linha de service_requests (ver seção Asaas abaixo)
  end if;

  return new;
end;
$$ language plpgsql;

create trigger before_request_insert_pricing
before insert on service_requests
for each row execute function trg_precificar_controlador_avancado();


-- ############################################################
-- ARQUIVO ORIGINAL: realtime_matching.sql
-- ############################################################
-- ============================================================
-- LÓGICA DE MATCHING EM TEMPO REAL
-- Dispara a demanda para TODOS os prestadores online da categoria,
-- dentro de um raio, e fecha automaticamente para quem aceitar primeiro.
-- Requer: extensão postgis, extensão pg_cron (Supabase já oferece as duas)
-- ============================================================

-- ------------------------------------------------------------
-- 1. FUNÇÃO: despachar oferta para todos os prestadores elegíveis
-- ------------------------------------------------------------
create or replace function dispatch_request_offers(p_request_id uuid)
returns integer as $$
declare
  v_request service_requests%rowtype;
  v_count integer := 0;
  v_radius_meters integer := 5000; -- raio de busca, 5km (ajustável por categoria depois)
begin
  select * into v_request from service_requests where id = p_request_id;

  if v_request.status <> 'pending' then
    return 0; -- já foi atendida ou cancelada, não faz nada
  end if;

  -- Insere uma oferta para CADA prestador online, disponível, verificado,
  -- da categoria certa, dentro do raio -- todos recebem ao mesmo tempo
  insert into request_offers (request_id, provider_id, status, sent_at, expires_at)
  select
    v_request.id,
    p.id,
    'sent',
    now(),
    now() + interval '30 seconds'
  from usuarios_prestadores p
  join provider_categories pc on pc.provider_id = p.id
  where p.is_online = true
    and p.is_available = true
    and p.verified = true
    and pc.category_id = v_request.category_id
    and st_dwithin(p.current_location, v_request.location, v_radius_meters)
    -- evita reenviar oferta pro mesmo prestador se já existir uma pendente
    and not exists (
      select 1 from request_offers ro
      where ro.request_id = v_request.id and ro.provider_id = p.id
    );

  get diagnostics v_count = row_count;
  return v_count;
end;
$$ language plpgsql;

-- ------------------------------------------------------------
-- 2. TRIGGER: ao criar uma demanda imediata, despacha na hora
-- ------------------------------------------------------------
create or replace function trg_dispatch_on_insert() returns trigger as $$
begin
  if new.type = 'immediate' and new.status = 'pending' then
    perform dispatch_request_offers(new.id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger after_request_insert
after insert on service_requests
for each row execute function trg_dispatch_on_insert();

-- ------------------------------------------------------------
-- 3. FUNÇÃO: prestador aceita a oferta (primeiro a aceitar, ganha)
-- Roda tudo em transação pra evitar dois prestadores "ganharem" a mesma demanda
-- ------------------------------------------------------------
create or replace function accept_offer(p_offer_id uuid, p_provider_id uuid)
returns jsonb as $$
declare
  v_offer request_offers%rowtype;
  v_request service_requests%rowtype;
begin
  -- Trava a linha da demanda pra evitar corrida entre prestadores
  select * into v_request
  from service_requests
  where id = (select request_id from request_offers where id = p_offer_id)
  for update;

  if v_request.status <> 'pending' then
    return jsonb_build_object('success', false, 'reason', 'já foi aceita por outro prestador');
  end if;

  select * into v_offer from request_offers where id = p_offer_id;

  if v_offer.provider_id <> p_provider_id then
    return jsonb_build_object('success', false, 'reason', 'oferta não pertence a este prestador');
  end if;

  if v_offer.status <> 'sent' or v_offer.expires_at < now() then
    return jsonb_build_object('success', false, 'reason', 'oferta expirada');
  end if;

  -- Fecha a demanda com este prestador
  update service_requests
  set status = 'matched', provider_id = p_provider_id, matched_at = now()
  where id = v_request.id;

  -- Marca esta oferta como aceita
  update request_offers set status = 'accepted', responded_at = now() where id = p_offer_id;

  -- Cancela as ofertas dos demais prestadores para essa mesma demanda
  update request_offers
  set status = 'rejected', responded_at = now()
  where request_id = v_request.id and id <> p_offer_id and status = 'sent';

  -- Marca o prestador como ocupado
  update usuarios_prestadores set is_available = false where id = p_provider_id;

  -- Notifica o cliente (front-end escuta essa tabela via Realtime)
  insert into notifications (profile_id, title, body, data)
  values (v_request.client_id, 'Prestador encontrado!', 'Seu serviço foi aceito.',
          jsonb_build_object('request_id', v_request.id, 'provider_id', p_provider_id));

  return jsonb_build_object('success', true);
end;
$$ language plpgsql;

-- ------------------------------------------------------------
-- 4. JOB (pg_cron): expira ofertas antigas e re-tenta se ninguém aceitou
-- Roda a cada 15 segundos (ajuste o intervalo se seu plano do Supabase não suportar)
-- ------------------------------------------------------------
create or replace function expire_offers_and_retry() returns void as $$
declare
  r record;
begin
  -- Marca como expiradas as ofertas que passaram do tempo sem resposta
  update request_offers
  set status = 'expired'
  where status = 'sent' and expires_at < now();

  -- Para demandas ainda 'pending' sem nenhuma oferta 'sent' ativa, tenta de novo
  -- (expande o raio de busca a cada tentativa, ou você pode alertar o cliente)
  for r in
    select sr.id from service_requests sr
    where sr.status = 'pending'
      and sr.type = 'immediate'
      and not exists (
        select 1 from request_offers ro
        where ro.request_id = sr.id and ro.status = 'sent'
      )
  loop
    perform dispatch_request_offers(r.id);
  end loop;
end;
$$ language plpgsql;

select cron.schedule(
  'expire-and-retry-offers',
  '15 seconds',
  $$select expire_offers_and_retry()$$
);

-- ------------------------------------------------------------
-- 5. JOB: disparar demandas AGENDADAS um pouco antes do horário
-- Ex: 15 minutos antes do horário marcado, vira uma demanda "quase imediata"
-- ------------------------------------------------------------
create or replace function activate_scheduled_requests() returns void as $$
declare
  r record;
begin
  for r in
    select id from service_requests
    where type = 'scheduled'
      and status = 'pending'
      and scheduled_at <= now() + interval '15 minutes'
      and not exists (select 1 from request_offers where request_id = service_requests.id)
  loop
    perform dispatch_request_offers(r.id);
  end loop;
end;
$$ language plpgsql;

select cron.schedule(
  'activate-scheduled-requests',
  '1 minute',
  $$select activate_scheduled_requests()$$
);