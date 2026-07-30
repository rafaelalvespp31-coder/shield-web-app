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
