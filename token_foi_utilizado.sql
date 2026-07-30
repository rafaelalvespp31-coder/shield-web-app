-- ============================================================
-- SHIELD — Mecanismo de Uso Único do Token de Convite
-- ============================================================
-- Continuação de "arquitetura_banco_shield.sql" (que já tem a tabela
-- company_invite_tokens e a função redimir_token_convite).
--
-- Adiciona a coluna `foi_utilizado` (booleana, calculada automaticamente
-- pelo próprio banco — nunca fica dessincronizada do status real):
--   foi_utilizado = true   assim que o token é resgatado com sucesso
--   foi_utilizado = false  enquanto ainda está ativo, expirado ou revogado
-- ============================================================

alter table company_invite_tokens
  add column if not exists foi_utilizado boolean generated always as (status = 'usado') stored;

create index if not exists idx_invite_tokens_foi_utilizado on company_invite_tokens (foi_utilizado);

-- ============================================================
-- FIM
-- ============================================================
