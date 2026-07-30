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
