-- ============================================================
-- SHIELD — Histórico de posições GPS (fila offline-first)
-- ============================================================
-- Continuação de "arquitetura_banco_shield.sql".
-- Guarda TODO ponto de GPS capturado do vigilante, mesmo os que chegaram
-- atrasados (enviados em lote, depois de ficar sem sinal em rodovia/zona
-- rural). `captured_at` é quando o ponto foi capturado de verdade no
-- celular; `received_at` é quando o servidor recebeu — podem ser bem
-- diferentes quando o envio veio da fila offline.
-- ============================================================

create table if not exists provider_location_pings (
  id uuid primary key default uuid_generate_v4(),
  provider_id uuid not null references usuarios_prestadores(id) on delete cascade,
  request_id uuid references service_requests(id), -- opcional: a que atendimento esse trajeto pertence
  latitude numeric(10,7) not null,
  longitude numeric(10,7) not null,
  accuracy numeric(6,2),
  captured_at timestamptz not null,
  received_at timestamptz not null default now(),
  veio_da_fila_offline boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_location_pings_provider on provider_location_pings (provider_id, captured_at);
create index if not exists idx_location_pings_request on provider_location_pings (request_id);

-- Sempre que um ping novo chega, atualiza a posição "atual" do prestador
-- (usada pelo matching) -- só se for mais recente que a que já está lá.
create or replace function trg_atualizar_posicao_atual_prestador() returns trigger as $$
begin
  update usuarios_prestadores
  set current_location = ST_SetSRID(ST_MakePoint(new.longitude, new.latitude), 4326)::geography,
      last_location_at = new.captured_at
  where id = new.provider_id
    and (last_location_at is null or new.captured_at > last_location_at);
  return new;
end;
$$ language plpgsql;

drop trigger if exists after_insert_location_ping on provider_location_pings;
create trigger after_insert_location_ping
after insert on provider_location_pings
for each row execute function trg_atualizar_posicao_atual_prestador();

alter table provider_location_pings enable row level security;

drop policy if exists "Prestador insere seus proprios pings" on provider_location_pings;
create policy "Prestador insere seus proprios pings" on provider_location_pings for insert
  with check (auth.uid() = provider_id);

drop policy if exists "Prestador ve seus proprios pings" on provider_location_pings;
create policy "Prestador ve seus proprios pings" on provider_location_pings for select
  using (auth.uid() = provider_id);

-- ============================================================
-- FIM
-- ============================================================
