-- ============================================================
-- LÓGICA DE MATCHING EM TEMPO REAL
-- Dispara a demanda para TODOS os prestadores online da categoria,
-- dentro de um raio, e fecha automaticamente para quem aceitar primeiro.
-- Requer: extensão postgis, extensão pg_cron (Supabase já oferece as duas)
-- ============================================================

-- ------------------------------------------------------------
-- 1. FUNÇÃO: despachar oferta para todos os prestadores elegíveis
-- ------------------------------------------------------------
create or replace function dispatch_request_offers(p_request_id uuid)
returns integer as $$
declare
  v_request service_requests%rowtype;
  v_count integer := 0;
  v_radius_meters integer := 5000; -- raio de busca, 5km (ajustável por categoria depois)
begin
  select * into v_request from service_requests where id = p_request_id;

  if v_request.status <> 'pending' then
    return 0; -- já foi atendida ou cancelada, não faz nada
  end if;

  -- Insere uma oferta para CADA prestador online, disponível, verificado,
  -- da categoria certa, dentro do raio -- todos recebem ao mesmo tempo
  insert into request_offers (request_id, provider_id, status, sent_at, expires_at)
  select
    v_request.id,
    p.id,
    'sent',
    now(),
    now() + interval '30 seconds'
  from providers p
  join provider_categories pc on pc.provider_id = p.id
  where p.is_online = true
    and p.is_available = true
    and p.verified = true
    and pc.category_id = v_request.category_id
    and st_dwithin(p.current_location, v_request.location, v_radius_meters)
    -- evita reenviar oferta pro mesmo prestador se já existir uma pendente
    and not exists (
      select 1 from request_offers ro
      where ro.request_id = v_request.id and ro.provider_id = p.id
    );

  get diagnostics v_count = row_count;
  return v_count;
end;
$$ language plpgsql;

-- ------------------------------------------------------------
-- 2. TRIGGER: ao criar uma demanda imediata, despacha na hora
-- ------------------------------------------------------------
create or replace function trg_dispatch_on_insert() returns trigger as $$
begin
  if new.type = 'immediate' and new.status = 'pending' then
    perform dispatch_request_offers(new.id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger after_request_insert
after insert on service_requests
for each row execute function trg_dispatch_on_insert();

-- ------------------------------------------------------------
-- 3. FUNÇÃO: prestador aceita a oferta (primeiro a aceitar, ganha)
-- Roda tudo em transação pra evitar dois prestadores "ganharem" a mesma demanda
-- ------------------------------------------------------------
create or replace function accept_offer(p_offer_id uuid, p_provider_id uuid)
returns jsonb as $$
declare
  v_offer request_offers%rowtype;
  v_request service_requests%rowtype;
begin
  -- Trava a linha da demanda pra evitar corrida entre prestadores
  select * into v_request
  from service_requests
  where id = (select request_id from request_offers where id = p_offer_id)
  for update;

  if v_request.status <> 'pending' then
    return jsonb_build_object('success', false, 'reason', 'já foi aceita por outro prestador');
  end if;

  select * into v_offer from request_offers where id = p_offer_id;

  if v_offer.provider_id <> p_provider_id then
    return jsonb_build_object('success', false, 'reason', 'oferta não pertence a este prestador');
  end if;

  if v_offer.status <> 'sent' or v_offer.expires_at < now() then
    return jsonb_build_object('success', false, 'reason', 'oferta expirada');
  end if;

  -- Fecha a demanda com este prestador
  update service_requests
  set status = 'matched', provider_id = p_provider_id, matched_at = now()
  where id = v_request.id;

  -- Marca esta oferta como aceita
  update request_offers set status = 'accepted', responded_at = now() where id = p_offer_id;

  -- Cancela as ofertas dos demais prestadores para essa mesma demanda
  update request_offers
  set status = 'rejected', responded_at = now()
  where request_id = v_request.id and id <> p_offer_id and status = 'sent';

  -- Marca o prestador como ocupado
  update providers set is_available = false where id = p_provider_id;

  -- Notifica o cliente (front-end escuta essa tabela via Realtime)
  insert into notifications (profile_id, title, body, data)
  values (v_request.client_id, 'Prestador encontrado!', 'Seu serviço foi aceito.',
          jsonb_build_object('request_id', v_request.id, 'provider_id', p_provider_id));

  return jsonb_build_object('success', true);
end;
$$ language plpgsql;

-- ------------------------------------------------------------
-- 4. JOB (pg_cron): expira ofertas antigas e re-tenta se ninguém aceitou
-- Roda a cada 15 segundos (ajuste o intervalo se seu plano do Supabase não suportar)
-- ------------------------------------------------------------
create or replace function expire_offers_and_retry() returns void as $$
declare
  r record;
begin
  -- Marca como expiradas as ofertas que passaram do tempo sem resposta
  update request_offers
  set status = 'expired'
  where status = 'sent' and expires_at < now();

  -- Para demandas ainda 'pending' sem nenhuma oferta 'sent' ativa, tenta de novo
  -- (expande o raio de busca a cada tentativa, ou você pode alertar o cliente)
  for r in
    select sr.id from service_requests sr
    where sr.status = 'pending'
      and sr.type = 'immediate'
      and not exists (
        select 1 from request_offers ro
        where ro.request_id = sr.id and ro.status = 'sent'
      )
  loop
    perform dispatch_request_offers(r.id);
  end loop;
end;
$$ language plpgsql;

select cron.schedule(
  'expire-and-retry-offers',
  '15 seconds',
  $$select expire_offers_and_retry()$$
);

-- ------------------------------------------------------------
-- 5. JOB: disparar demandas AGENDADAS um pouco antes do horário
-- Ex: 15 minutos antes do horário marcado, vira uma demanda "quase imediata"
-- ------------------------------------------------------------
create or replace function activate_scheduled_requests() returns void as $$
declare
  r record;
begin
  for r in
    select id from service_requests
    where type = 'scheduled'
      and status = 'pending'
      and scheduled_at <= now() + interval '15 minutes'
      and not exists (select 1 from request_offers where request_id = service_requests.id)
  loop
    perform dispatch_request_offers(r.id);
  end loop;
end;
$$ language plpgsql;

select cron.schedule(
  'activate-scheduled-requests',
  '1 minute',
  $$select activate_scheduled_requests()$$
);
