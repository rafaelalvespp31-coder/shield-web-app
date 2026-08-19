// ============================================================
// EDGE FUNCTION: send-push
// Recebida uma mudança de status ou mensagem de chat (via gatilho
// do banco), decide quem precisa ser avisado e manda o push de
// verdade pro navegador da pessoa - funciona mesmo com o site
// totalmente fechado, contanto que ela tenha autorizado
// notificações antes (e o navegador continue instalado/ativo).
//
// DEPLOY:
//   supabase functions deploy send-push --no-verify-jwt
//
// SECRETS NECESSÁRIOS (rodar uma vez):
//   supabase secrets set VAPID_PUBLIC_KEY="BAOl76_uM6KH-4zvicX5Ffo6ekn8odvcuZYWp29T3jBFBTxdXqLedcMguyTitNVWcAsUe9Jb0I6fmcxiiaM1NBk"
//   supabase secrets set VAPID_PRIVATE_KEY="zDYN_s_hjAnktl2XhRxm6QBw8Gh0y2lq2DDKdEdar38"
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já ficam disponíveis
// automaticamente em toda Edge Function, não precisa configurar)
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;

webpush.setVapidDetails("mailto:contato@shield.app", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function mensagemStatus(novoStatus: string) {
  switch (novoStatus) {
    case "matched":
      return { title: "Prestador encontrado!", body: "Um prestador aceitou sua demanda." };
    case "confirmed":
      return { title: "Serviço confirmado!", body: "Seu prestador confirmou o atendimento. O chat já está disponível." };
    case "a_caminho":
      return { title: "Prestador a caminho!", body: "Seu prestador está se deslocando até você." };
    case "in_progress":
      return { title: "Serviço iniciado", body: "O atendimento começou agora." };
    case "completed":
      return { title: "Serviço concluído", body: "Seu atendimento foi finalizado." };
    default:
      return null;
  }
}

async function enviarParaUsuario(userId: string, role: string, payload: Record<string, unknown>) {
  const { data: inscricoes, error } = await sb
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth_key")
    .eq("user_id", userId)
    .eq("role", role);

  if (error || !inscricoes || inscricoes.length === 0) return;

  await Promise.all(
    inscricoes.map(async (ins) => {
      try {
        await webpush.sendNotification(
          { endpoint: ins.endpoint, keys: { p256dh: ins.p256dh, auth: ins.auth_key } },
          JSON.stringify(payload)
        );
      } catch (e) {
        // Inscrição expirada/inválida (usuário desinstalou, trocou de
        // navegador etc.) - limpa do banco pra não tentar de novo.
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          await sb.from("push_subscriptions").delete().eq("endpoint", ins.endpoint);
        } else {
          console.warn("Falha ao enviar push:", e?.message || e);
        }
      }
    })
  );
}

Deno.serve(async (req) => {
  try {
    const body = await req.json();

    if (body.type === "status_change") {
      const { new_status, client_id, provider_id, cancelado_por, motivo_cancelamento } = body;

      if (new_status === "paid" && provider_id) {
        // Caso especial: quem precisa ser avisado aqui é o PRESTADOR (o
        // cliente acabou de pagar, e é ele quem toma a próxima ação).
        await enviarParaUsuario(provider_id, "prestador", {
          title: "Cliente pagou!",
          body: "O pagamento foi confirmado. Toque para confirmar o serviço.",
          tag: "shield-status",
          url: "/",
        });
      } else if (new_status === "cancelled") {
        if (cancelado_por === "prestador" && client_id) {
          await enviarParaUsuario(client_id, "cliente", {
            title: "Serviço cancelado",
            body: motivo_cancelamento
              ? "Seu prestador cancelou por força maior: " + String(motivo_cancelamento).slice(0, 100)
              : "Seu prestador precisou cancelar o serviço.",
            tag: "shield-status",
            url: "/",
          });
        } else if (provider_id) {
          await enviarParaUsuario(provider_id, "prestador", {
            title: "Demanda cancelada",
            body: "O cliente cancelou a demanda.",
            tag: "shield-status",
            url: "/",
          });
        }
      } else {
        const msg = mensagemStatus(new_status);
        if (msg && client_id) {
          await enviarParaUsuario(client_id, "cliente", { ...msg, tag: "shield-status", url: "/" });
        }
      }
    }

    if (body.type === "chat_message") {
      const { request_id, sender_role, message } = body;
      const { data: demanda } = await sb
        .from("service_requests")
        .select("client_id, provider_id")
        .eq("id", request_id)
        .maybeSingle();

      if (demanda) {
        const destinatarioId = sender_role === "cliente" ? demanda.provider_id : demanda.client_id;
        const destinatarioRole = sender_role === "cliente" ? "prestador" : "cliente";
        if (destinatarioId) {
          await enviarParaUsuario(destinatarioId, destinatarioRole, {
            title: "Nova mensagem",
            body: String(message).slice(0, 120),
            tag: "shield-chat-" + request_id,
            url: "/",
          });
        }
      }
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("Erro na send-push:", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
