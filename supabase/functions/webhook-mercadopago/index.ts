// supabase functions deploy webhook-mercadopago --no-verify-jwt --project-ref xnnhhhsxoaprgvfvqaak
// URL pra cadastrar no Mercado Pago (Credenciais > Webhooks / Notificações):
// https://xnnhhhsxoaprgvfvqaak.supabase.co/functions/v1/webhook-mercadopago
//
// O Mercado Pago chama essa função toda vez que o status de um pagamento
// muda. A gente confere de verdade o status direto na API deles (nunca
// confia só no que veio no corpo da notificação) e credita a carteira.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    // Busca a cobrança correspondente que a gente registrou ao criar o Pix.
    const { data: cobranca, error: cobrancaErr } = await sb
      .from("pix_cobrancas")
      .select("id, wallet_id, valor, status")
      .eq("mp_payment_id", String(paymentId))
      .maybeSingle();

    if (cobrancaErr || !cobranca) {
      console.error("Cobrança não encontrada pro payment_id:", paymentId);
      return new Response("ok", { status: 200 });
    }

    // Evita creditar duas vezes se o Mercado Pago reenviar a notificação.
    if (cobranca.status === "completed") {
      return new Response("ok", { status: 200 });
    }

    const { error: insertErr } = await sb.from("wallet_transactions").insert({
      wallet_id: cobranca.wallet_id,
      type: "credit",
      amount: cobranca.valor,
      status: "completed",
      description: "Depósito via Pix",
    });
    if (insertErr) {
      console.error("Falha ao inserir wallet_transaction:", insertErr.message);
      return new Response("ok", { status: 200 });
    }

    const { error: rpcErr } = await sb.rpc("incrementar_saldo_wallet", {
      p_wallet_id: cobranca.wallet_id,
      p_valor: cobranca.valor,
    });
    if (rpcErr) {
      console.error("Falha ao incrementar saldo (confira se a função incrementar_saldo_wallet existe):", rpcErr.message);
    }

    await sb.from("pix_cobrancas").update({ status: "completed" }).eq("id", cobranca.id);

    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("Erro inesperado no webhook:", e);
    // Sempre 200 pro Mercado Pago não ficar retentando indefinidamente por
    // um erro nosso - o log acima já registra o problema pra investigar.
    return new Response("ok", { status: 200 });
  }
});
