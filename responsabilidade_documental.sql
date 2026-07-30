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
