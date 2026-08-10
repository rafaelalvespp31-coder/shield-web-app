-- ============================================================
-- FIX: Prestador nao consegue enviar contraproposta de valor
-- ============================================================
-- Causa provavel: a política de RLS de UPDATE em service_requests
-- só permite que o prestador JÁ ATRIBUÍDO (provider_id) atualize a
-- linha. Mas quando o prestador está negociando, ele ainda não foi
-- aceito oficialmente (provider_id pode estar nulo) - ele só tem
-- uma oferta pendente na tabela request_offers.
--
-- Esse fix libera UPDATE nas colunas de contraproposta para
-- qualquer prestador que tenha uma oferta ATIVA (status='sent')
-- para aquela demanda, mesmo sem ainda ser o provider_id oficial.
-- ============================================================

DROP POLICY IF EXISTS "prestador_pode_enviar_contraproposta" ON service_requests;

CREATE POLICY "prestador_pode_enviar_contraproposta"
ON service_requests
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM request_offers ro
    WHERE ro.request_id = service_requests.id
      AND ro.provider_id = auth.uid()
      AND ro.status = 'sent'
  )
  OR provider_id = auth.uid()
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM request_offers ro
    WHERE ro.request_id = service_requests.id
      AND ro.provider_id = auth.uid()
      AND ro.status = 'sent'
  )
  OR provider_id = auth.uid()
);

-- Depois de rodar, teste de novo o fluxo de negociar.
-- Se ainda não funcionar, rode esta query como o usuário prestador
-- (ou olhe os logs do Supabase) para confirmar se é mesmo RLS:
--
-- SELECT * FROM service_requests WHERE id = '<id_da_demanda>';
-- UPDATE service_requests SET contraproposta_valor = 999
--   WHERE id = '<id_da_demanda>';
-- (se retornar "0 rows affected" sem erro, é RLS)
