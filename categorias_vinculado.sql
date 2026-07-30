-- ============================================================
-- SHIELD — Categorias de atendimento para Empresa Parceira /
-- Prestador Vinculado (Escolta Armada, VSSP, Vigilante,
-- Controle de Acesso, Facility)
-- ============================================================
-- Este arquivo é autossuficiente: cria a coluna "slug" em
-- service_categories caso ela ainda não exista (ela normalmente
-- só é criada mais adiante, na parte de tarifas_servicos.sql da
-- migração completa). Seguro rodar mais de uma vez (idempotente).
-- ============================================================

alter table service_categories add column if not exists slug text;

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

-- Se essas categorias já existiam sem slug preenchido (ex: inseridas
-- antes deste arquivo), preenche o slug agora:
update service_categories set slug = 'escolta_armada'     where name = 'Escolta Armada'     and slug is null;
update service_categories set slug = 'vssp'               where name = 'VSSP'               and slug is null;
update service_categories set slug = 'vigilante'          where name = 'Vigilante'          and slug is null;
update service_categories set slug = 'controle_de_acesso' where name = 'Controle de Acesso' and slug is null;
update service_categories set slug = 'facility'           where name = 'Facility'           and slug is null;
