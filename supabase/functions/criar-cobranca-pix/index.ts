// supabase functions deploy criar-cobranca-pix --no-verify-jwt --project-ref xnnhhhsxoaprgvfvqaak
// Cria uma cobrança Pix de verdade no Mercado Pago e devolve o QR Code
// (imagem) + código copia-e-cola pro cliente pagar.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { walletId, valor, nome, email, cpf } = await req.json();

    if (!walletId || !valor || Number(valor) <= 0) {
      return new Response(JSON.stringify({ error: "Dados inválidos (walletId e valor são obrigatórios)." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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

    // Data de expiração: 30 minutos a partir de agora, no formato exato
    // que o Mercado Pago exige (com milissegundos e offset com dois
    // pontos, ex: 2026-02-23T23:30:00.000-03:00).
    const expiracao = new Date(Date.now() + 30 * 60 * 1000);
    const isoComOffset = expiracao.toISOString().replace("Z", "-03:00");

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
        payment_method_id: "pix",
        date_of_expiration: isoComOffset,
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
      console.error("Erro Mercado Pago:", JSON.stringify(mpData));
      return new Response(JSON.stringify({ error: mpData.message || "Falha ao criar cobrança no Mercado Pago.", detalhe: mpData }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const qrCode = mpData?.point_of_interaction?.transaction_data?.qr_code || null;
    const qrCodeBase64 = mpData?.point_of_interaction?.transaction_data?.qr_code_base64 || null;

    if (!qrCode) {
      return new Response(JSON.stringify({ error: "Mercado Pago não retornou o QR Code Pix.", detalhe: mpData }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Registra a cobrança pra o webhook conseguir localizar depois.
    const { error: dbError } = await sb.from("pix_cobrancas").insert({
      wallet_id: walletId,
      mp_payment_id: String(mpData.id),
      valor: Number(valor),
      status: "pending",
    });
    if (dbError) {
      console.error("Erro ao salvar cobrança no banco:", dbError.message);
    }

    return new Response(JSON.stringify({
      paymentId: mpData.id,
      qrCode,
      qrCodeBase64,
      expiraEm: isoComOffset,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    console.error("Erro inesperado:", e);
    return new Response(JSON.stringify({ error: e.message || "Erro inesperado." }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
