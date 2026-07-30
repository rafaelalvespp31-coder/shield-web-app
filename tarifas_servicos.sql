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
