-- ============================================================
-- SHIELD — validar_token_convite (checagem PRÉVIA, sem gastar o token)
-- ============================================================
-- Continuação de "arquitetura_banco_shield.sql" (que já tem
-- company_invite_tokens e redimir_token_convite).
--
-- Por que isso precisava existir: redimir_token_convite só pode rodar
-- DEPOIS que a conta (auth.users) já foi criada, porque ele precisa de
-- um p_provider_id. Isso significa que, sem essa função, se o vigilante
-- digitasse um código errado, a conta dele já teria sido criada mesmo
-- assim. Esta função é só LEITURA (não marca o token como usado, não
-- precisa de usuário logado) — serve pra validar o código ANTES de
-- criar a conta, no formulário de cadastro.
-- ============================================================

create or replace function validar_token_convite(p_token text)
returns jsonb as $$
declare
  v_row company_invite_tokens%rowtype;
  v_razao_social text;
begin
  select * into v_row from company_invite_tokens where token = p_token;

  if v_row.id is null then
    return jsonb_build_object('valido', false, 'motivo', 'codigo_invalido');
  end if;

  if v_row.status <> 'ativo' then
    return jsonb_build_object('valido', false, 'motivo', 'codigo_ja_utilizado_ou_revogado');
  end if;

  if v_row.expires_at < now() then
    return jsonb_build_object('valido', false, 'motivo', 'codigo_expirado');
  end if;

  select razao_social into v_razao_social from empresas_parceiras where id = v_row.company_id;

  return jsonb_build_object('valido', true, 'empresa_nome', v_razao_social, 'company_id', v_row.company_id);
end;
$$ language plpgsql security definer;

-- Permite que qualquer pessoa (mesmo não logada) rode a validação —
-- é só leitura, não expõe nada sensível além do nome da empresa.
grant execute on function validar_token_convite(text) to anon, authenticated;

-- ============================================================
-- FIM
-- ============================================================
