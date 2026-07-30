-- ============================================================
-- SHIELD — Acionamento Triplo do Pânico
-- ============================================================
-- Continuação de "arquitetura_banco_shield.sql".
--
-- panic_alerts: cada acionamento de pânico. A simples INSERÇÃO nessa
-- tabela já é o "canal 1 e 2" do acionamento triplo — porque Empresa
-- Parceira e Dashboard da ShielD escutam essa tabela via Supabase
-- Realtime (que roda sobre WebSocket por baixo dos panos). O "canal 3"
-- (gerenciadoras de risco terceirizadas) é feito por webhook HTTP,
-- disparado pela função serverless que insere aqui.
-- ============================================================

create table if not exists panic_alerts (
  id uuid primary key default uuid_generate_v4(),
  provider_id uuid not null references usuarios_prestadores(id),
  company_id uuid references empresas_parceiras(id), -- null = prestador autônomo
  request_id uuid references service_requests(id),
  latitude numeric(10,7) not null,
  longitude numeric(10,7) not null,
  status text not null default 'ativo' check (status in ('ativo','em_atendimento','encerrado','falso_alarme')),
  acionado_em timestamptz not null default now(),
  encerrado_em timestamptz,
  encerrado_por uuid references profiles(id),
  observacoes text
);

create index if not exists idx_panic_alerts_provider on panic_alerts (provider_id);
create index if not exists idx_panic_alerts_company on panic_alerts (company_id);
create index if not exists idx_panic_alerts_status on panic_alerts (status) where status = 'ativo';

-- Webhooks das gerenciadoras de risco terceirizadas. Uma empresa parceira
-- pode ter a(s) sua(s) própria(s) gerenciadora(s); company_id nulo =
-- webhook "padrão" da ShielD (usado por prestadores autônomos, ou como
-- fallback caso a empresa não tenha uma própria configurada).
create table if not exists webhooks_gerenciadoras_risco (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references empresas_parceiras(id),
  nome_gerenciadora text not null,
  url_webhook text not null,
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_webhooks_risco_company on webhooks_gerenciadoras_risco (company_id, ativo);

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table panic_alerts enable row level security;
alter table webhooks_gerenciadoras_risco enable row level security;

-- Prestador sempre pode inserir o PRÓPRIO acionamento
drop policy if exists "Prestador aciona seu proprio panico" on panic_alerts;
create policy "Prestador aciona seu proprio panico" on panic_alerts for insert
  with check (auth.uid() = provider_id);

-- Prestador ve os proprios acionamentos; empresa ve os dos seus vinculados;
-- admin (Dashboard operacional da ShielD) ve TUDO.
drop policy if exists "Visualizacao de acionamentos de panico" on panic_alerts;
create policy "Visualizacao de acionamentos de panico" on panic_alerts for select
  using (
    auth.uid() = provider_id
    or company_id in (select id from empresas_parceiras where owner_id = auth.uid())
    or exists (select 1 from profiles where id = auth.uid() and role = 'admin')
  );

-- Empresa e admin podem atualizar o status (ex: marcar como "em_atendimento"/"encerrado")
drop policy if exists "Empresa/admin gerenciam o status do panico" on panic_alerts;
create policy "Empresa/admin gerenciam o status do panico" on panic_alerts for update
  using (
    company_id in (select id from empresas_parceiras where owner_id = auth.uid())
    or exists (select 1 from profiles where id = auth.uid() and role = 'admin')
  );

-- Webhooks: só a própria empresa (ou admin) gerencia os webhooks dela
drop policy if exists "Empresa gerencia seus webhooks de risco" on webhooks_gerenciadoras_risco;
create policy "Empresa gerencia seus webhooks de risco" on webhooks_gerenciadoras_risco for all
  using (
    company_id in (select id from empresas_parceiras where owner_id = auth.uid())
    or exists (select 1 from profiles where id = auth.uid() and role = 'admin')
  )
  with check (
    company_id in (select id from empresas_parceiras where owner_id = auth.uid())
    or exists (select 1 from profiles where id = auth.uid() and role = 'admin')
  );

-- ============================================================
-- FIM
-- ============================================================
