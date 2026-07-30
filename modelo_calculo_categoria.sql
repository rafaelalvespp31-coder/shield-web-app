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
