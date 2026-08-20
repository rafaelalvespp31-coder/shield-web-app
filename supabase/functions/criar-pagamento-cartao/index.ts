// supabase functions deploy criar-pagamento-cartao --no-verify-jwt --project-ref xnnhhhsxoaprgvfvqaak
//
// Cobra no cartão de crédito via Mercado Pago. O NÚMERO DO CARTÃO NUNCA
// passa por aqui - o frontend usa o SDK oficial (MercadoPago.js v2) pra
// transformar os dados do cartão num token antes de mandar pra essa
// função. Isso não é opcional: é exigência de PCI compliance do próprio
// Mercado Pago, e o token é a única coisa que essa função recebe.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { creditarWallet } from "../_shared/creditar-wallet.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const {
      walletId, valor, token, paymentMethodId, installments,
      nome, email, cpf,
    } = await req.json();

    if (!walletId || !valor || Number(valor) <= 0 || !token || !paymentMethodId) {
      return new Response(JSON.stringify({
        error: "Dados inválidos (walletId, valor, token e paymentMethodId são obrigatórios).",
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const MP_TOKEN = Deno.env.get("MERCADOPAGO_ACCESS_TOKEN");
    if (!MP_TOKEN) {
      return new Response(JSON.stringify({ error: "MERCADOPAGO_ACCESS_TOKEN não configurado no servidor." }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const idempotencyKey = crypto.randomUUID();

    const mpResponse = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${MP_TOKEN}`,
        "X-Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        transaction_amount: Number(Number(valor).toFixed(2)),
        token,
        description: "Créditos ShielD",
        installments: Number(installments) || 1,
        payment_method_id: paymentMethodId,
        payer: {
          email: email || "cliente@shield.app",
          first_name: (nome || "Cliente").split(" ")[0],
          last_name: (nome || "").split(" ").slice(1).join(" ") || "ShielD",
          identification: cpf ? { type: "CPF", number: String(cpf).replace(/\D/g, "") } : undefined,
        },
      }),
    });

    const mpData = await mpResponse.json();

    if (!mpResponse.ok) {
      console.error("Erro Mercado Pago (cartão):", JSON.stringify(mpData));
      return new Response(JSON.stringify({ error: mpData.message || "Falha ao processar cartão.", detalhe: mpData }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Cartão responde na hora - "approved", "rejected" ou "in_process"
    // (análise antifraude). Pix e boleto ficam "pending" até o webhook
    // confirmar; cartão às vezes já vem decidido nessa mesma resposta.
    const statusInterno =
      mpData.status === "approved" ? "completed" :
      mpData.status === "in_process" ? "pending" :
      "rejected";

    await sb.from("pagamentos_mercadopago").insert({
      wallet_id: walletId,
      mp_payment_id: String(mpData.id),
      metodo: "cartao",
      valor: Number(valor),
      status: statusInterno,
    });

    // Se já aprovou na hora, credita já - não precisa esperar o webhook.
    // Quando o webhook chegar depois pro mesmo payment_id, ele vai ver
    // status "completed" nessa tabela e não credita de novo.
    if (statusInterno === "completed") {
      await creditarWallet(sb, walletId, Number(valor), "Depósito via cartão de crédito");
    }

    return new Response(JSON.stringify({
      paymentId: mpData.id,
      status: mpData.status,
      statusDetail: mpData.status_detail,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    console.error("Erro inesperado (cartão):", e);
    return new Response(JSON.stringify({ error: e.message || "Erro inesperado." }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
