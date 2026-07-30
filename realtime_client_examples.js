// ============================================================
// EXEMPLOS DE INTEGRAÇÃO EM TEMPO REAL (front-end + Supabase JS)
// npm install @supabase/supabase-js
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

// ------------------------------------------------------------
// 1. PRESTADOR: escuta novas ofertas de demanda em tempo real
// (assim que o gatilho SQL insere uma linha em request_offers
//  com o provider_id dele, ele recebe instantaneamente)
// ------------------------------------------------------------
export function subscribeToOffers(providerId, onNewOffer) {
  const channel = supabase
    .channel(`offers-${providerId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'request_offers',
        filter: `provider_id=eq.${providerId}`,
      },
      (payload) => {
        onNewOffer(payload.new); // { id, request_id, status, expires_at, ... }
      }
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}

// ------------------------------------------------------------
// 2. PRESTADOR: aceitar a oferta (primeiro que chamar essa função, ganha)
// ------------------------------------------------------------
export async function acceptOffer(offerId, providerId) {
  const { data, error } = await supabase.rpc('accept_offer', {
    p_offer_id: offerId,
    p_provider_id: providerId,
  });

  if (error) throw error;
  return data; // { success: true } ou { success: false, reason: '...' }
}

// ------------------------------------------------------------
// 3. CLIENTE: escuta quando a demanda dele muda de status
// (ex: quando um prestador aceita, o status vira 'matched')
// ------------------------------------------------------------
export function subscribeToRequestStatus(requestId, onStatusChange) {
  const channel = supabase
    .channel(`request-${requestId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'service_requests',
        filter: `id=eq.${requestId}`,
      },
      (payload) => {
        onStatusChange(payload.new); // traz provider_id assim que houver match
      }
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}

// ------------------------------------------------------------
// 4. PRESTADOR: atualizar localização em tempo real (a cada poucos segundos)
// ------------------------------------------------------------
export async function updateProviderLocation(providerId, lat, lng) {
  const { error } = await supabase
    .from('providers')
    .update({
      current_location: `SRID=4326;POINT(${lng} ${lat})`,
      last_location_at: new Date().toISOString(),
    })
    .eq('id', providerId);

  if (error) throw error;
}

// ------------------------------------------------------------
// 5. CLIENTE: criar uma nova demanda (dispara tudo automaticamente
// via trigger no banco -- o front não precisa fazer mais nada)
// ------------------------------------------------------------
export async function createServiceRequest({
  clientId,
  categoryId,
  description,
  lat,
  lng,
  address,
  type = 'immediate', // ou 'scheduled'
  scheduledAt = null,
}) {
  const { data, error } = await supabase
    .from('service_requests')
    .insert({
      client_id: clientId,
      category_id: categoryId,
      description,
      address,
      location: `SRID=4326;POINT(${lng} ${lat})`,
      type,
      scheduled_at: scheduledAt,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

// ------------------------------------------------------------
// USO TÍPICO NO DASHBOARD DO PRESTADOR (React, resumido):
//
// useEffect(() => {
//   const unsubscribe = subscribeToOffers(providerId, (offer) => {
//     setIncomingOffers((prev) => [...prev, offer]); // mostra card na tela
//   });
//   return unsubscribe;
// }, [providerId]);
// ------------------------------------------------------------
