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
