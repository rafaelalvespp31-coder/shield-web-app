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
