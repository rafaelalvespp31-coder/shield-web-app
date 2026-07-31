-- ============================================================
-- SHIELD — Categorias de atendimento para Empresa Parceira /
-- Prestador Vinculado (Escolta Armada, VSSP, Vigilante,
-- Controle de Acesso, Facility)
-- ============================================================
-- Rode este arquivo no SQL Editor do Supabase DEPOIS de
-- shield_migration_completa.sql e validar_token_convite.sql.
-- É incremental e seguro rodar mais de uma vez (idempotente).
-- ============================================================

insert into service_categories (name, icon, slug, requer_empresa_autorizada, numero_vigilantes_padrao)
select * from (values
  ('Escolta Armada',     'shield',      'escolta_armada',      true,  1),
  ('VSSP',               'shield-check','vssp',                true,  1),
  ('Vigilante',          'user-check',  'vigilante',           true,  1),
  ('Controle de Acesso', 'door-open',   'controle_de_acesso',  false, 1),
  ('Facility',           'building',    'facility',            false, 1)
) as v(name, icon, slug, requer_empresa_autorizada, numero_vigilantes_padrao)
where not exists (
  select 1 from service_categories where service_categories.name = v.name
);