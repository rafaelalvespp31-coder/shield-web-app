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
