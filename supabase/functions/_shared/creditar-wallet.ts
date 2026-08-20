// supabase/functions/_shared/creditar-wallet.ts
//
// Credita uma wallet e é reaproveitado por qualquer método de pagamento
// (pix, cartão, boleto), tanto no momento em que o pagamento é aprovado
// na hora (cartão) quanto quando o webhook confirma depois (pix/boleto).
// Centralizar isso aqui evita a mesma lógica duplicada em 3 arquivos
// diferentes divergindo com o tempo.

export async function creditarWallet(
  sb: any,
  walletId: string,
  valor: number,
  descricao: string
): Promise<boolean> {
  const { error: insertErr } = await sb.from("wallet_transactions").insert({
    wallet_id: walletId,
    type: "credit",
    amount: valor,
    status: "completed",
    description: descricao,
  });
  if (insertErr) {
    console.error("Falha ao inserir wallet_transaction:", insertErr.message);
    return false;
  }

  const { error: rpcErr } = await sb.rpc("incrementar_saldo_wallet", {
    p_wallet_id: walletId,
    p_valor: valor,
  });
  if (rpcErr) {
    console.error("Falha ao incrementar saldo (confira se incrementar_saldo_wallet existe):", rpcErr.message);
    return false;
  }

  return true;
}
