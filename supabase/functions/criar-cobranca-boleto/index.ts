// supabase functions deploy criar-cobranca-boleto --no-verify-jwt --project-ref xnnhhhsxoaprgvfvqaak
//
// Gera um boleto via Mercado Pago. Diferente do Pix e do cartão, o
// boleto EXIGE CPF e endereço completo do pagador (sem isso o Mercado
// Pago recusa o pedido), e a compensação pode levar dias - o crédito
// na carteira só acontece de verdade quando o webhook confirmar o
// pagamento, igual já acontece com o Pix.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const {
      walletId, valor, nome, email, cpf,
      cep, endereco, numero, bairro, cidade, uf,
    } = await req.json();

    if (!walletId || !valor || Number(valor) <= 0 || !cpf || !cep || !endereco || !cidade || !uf) {
      return new Response(JSON.stringify({
        error: "Dados inválidos (walletId, valor, cpf e endereço completo são obrigatórios pro boleto).",
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
        description: "Créditos ShielD",
        payment_method_id: "bolbradesco",
        payer: {
          email: email || "cliente@shield.app",
          first_name: (nome || "Cliente").split(" ")[0],
          last_name: (nome || "").split(" ").slice(1).join(" ") || "ShielD",
          identification: { type: "CPF", number: String(cpf).replace(/\D/g, "") },
          address: {
            zip_code: String(cep).replace(/\D/g, ""),
            street_name: endereco,
            street_number: numero || "S/N",
            neighborhood: bairro || "",
            city: cidade,
            federal_unit: uf,
          },
        },
      }),
    });

    const mpData = await mpResponse.json();

    if (!mpResponse.ok) {
      console.error("Erro Mercado Pago (boleto):", JSON.stringify(mpData));
      return new Response(JSON.stringify({ error: mpData.message || "Falha ao gerar boleto.", detalhe: mpData }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const linkBoleto = mpData?.transaction_details?.external_resource_url || null;
    const codigoBarras = mpData?.barcode?.content || null;

    if (!linkBoleto) {
      return new Response(JSON.stringify({ error: "Mercado Pago não retornou o link do boleto.", detalhe: mpData }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await sb.from("pagamentos_mercadopago").insert({
      wallet_id: walletId,
      mp_payment_id: String(mpData.id),
      metodo: "boleto",
      valor: Number(valor),
      status: "pending",
    });

    return new Response(JSON.stringify({
      paymentId: mpData.id,
      linkBoleto,
      codigoBarras,
      vencimento: mpData.date_of_expiration,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    console.error("Erro inesperado (boleto):", e);
    return new Response(JSON.stringify({ error: e.message || "Erro inesperado." }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
