-- ============================================================
-- SHIELD — panic_alerts: adiciona client_id (avisar o cliente também)
-- ============================================================
-- Continuação de "panic_alerts.sql". Sem isso, só Empresa e ShielD
-- ficavam sabendo do acionamento — o cliente que está recebendo aquele
-- atendimento também precisa ser avisado (reasseguramento + transparência).
-- ============================================================

alter table panic_alerts
  add column if not exists client_id uuid references profiles(id);

create index if not exists idx_panic_alerts_client on panic_alerts (client_id);

-- Cliente pode ver os próprios acionamentos (do atendimento que ele contratou)
drop policy if exists "Cliente ve panico do proprio atendimento" on panic_alerts;
create policy "Cliente ve panico do proprio atendimento" on panic_alerts for select
  using (auth.uid() = client_id);

-- ============================================================
-- FIM
-- ============================================================
