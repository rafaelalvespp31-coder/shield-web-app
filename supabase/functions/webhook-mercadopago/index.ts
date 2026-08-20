// supabase functions deploy webhook-mercadopago --no-verify-jwt --project-ref xnnhhhsxoaprgvfvqaak
// URL pra cadastrar no Mercado Pago (Credenciais > Webhooks / Notificações):
// https://xnnhhhsxoaprgvfvqaak.supabase.co/functions/v1/webhook-mercadopago
//
// O Mercado Pago chama essa função toda vez que o status de um pagamento
// muda. A gente confere de verdade o status direto na API deles (nunca
// confia só no que veio no corpo da notificação) e credita a carteira.
//
// Agora reconhece 3 métodos: Pix (tabela pix_cobrancas, como já era) e
// cartão/boleto (tabela nova pagamentos_mercadopago). O fluxo de Pix não
// mudou em nada - só foi adicionado um segundo lugar pra procurar caso
// não ache na tabela do Pix.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { creditarWallet } from "../_shared/creditar-wallet.ts";

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const paymentId = body?.data?.id || new URL(req.url).searchParams.get("id");

    if (!paymentId) {
      // Mercado Pago manda notificações de teste sem payment id às vezes -
      // sempre responde 200 pra ele não ficar reenviando.
      return new Response("ok", { status: 200 });
    }

    const MP_TOKEN = Deno.env.get("MERCADOPAGO_ACCESS_TOKEN");
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Confirma o status DIRETO na API do Mercado Pago - nunca confia no
    // conteúdo do webhook em si, que pode ser forjado por qualquer um.
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { "Authorization": `Bearer ${MP_TOKEN}` },
    });
    if (!mpRes.ok) {
      console.error("Falha ao consultar pagamento no Mercado Pago:", await mpRes.text());
      return new Response("ok", { status: 200 });
    }
    const pagamento = await mpRes.json();

    if (pagamento.status !== "approved") {
      // Pendente, rejeitado, cancelado etc. - nada a fazer ainda.
      return new Response("ok", { status: 200 });
    }

    // 1) Tenta achar como Pix primeiro - fluxo original, intocado.
    const { data: cobrancaPix } = await sb
      .from("pix_cobrancas")
      .select("id, wallet_id, valor, status")
      .eq("mp_payment_id", String(paymentId))
      .maybeSingle();

    if (cobrancaPix) {
      if (cobrancaPix.status === "completed") return new Response("ok", { status: 200 });
      const creditou = await creditarWallet(sb, cobrancaPix.wallet_id, cobrancaPix.valor, "Depósito via Pix");
      if (creditou) {
        await sb.from("pix_cobrancas").update({ status: "completed" }).eq("id", cobrancaPix.id);
      }
      return new Response("ok", { status: 200 });
    }

    // 2) Se não achou no Pix, procura em cartão/boleto.
    const { data: cobrancaOutra } = await sb
      .from("pagamentos_mercadopago")
      .select("id, wallet_id, valor, status, metodo")
      .eq("mp_payment_id", String(paymentId))
      .maybeSingle();

    if (cobrancaOutra) {
      if (cobrancaOutra.status === "completed") return new Response("ok", { status: 200 });
      const descricao = cobrancaOutra.metodo === "cartao"
        ? "Depósito via cartão de crédito"
        : "Depósito via boleto";
      const creditou = await creditarWallet(sb, cobrancaOutra.wallet_id, cobrancaOutra.valor, descricao);
      if (creditou) {
        await sb.from("pagamentos_mercadopago").update({ status: "completed" }).eq("id", cobrancaOutra.id);
      }
      return new Response("ok", { status: 200 });
    }

    console.error("Cobrança não encontrada (pix nem cartão/boleto) pro payment_id:", paymentId);
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("Erro inesperado no webhook:", e);
    // Sempre 200 pro Mercado Pago não ficar retentando indefinidamente por
    // um erro nosso - o log acima já registra o problema pra investigar.
    return new Response("ok", { status: 200 });
  }
});
