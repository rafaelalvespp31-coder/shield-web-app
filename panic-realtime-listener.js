/**
 * ============================================================
 * SHIELD — ESCUTA EM TEMPO REAL DO PÂNICO (Empresa / Dashboard ShielD)
 * ============================================================
 * Isso é o "canal 1 e 2" do acionamento triplo: tanto o painel da
 * Empresa Parceira quanto o Dashboard operacional da ShielD escutam a
 * tabela `panic_alerts` via Supabase Realtime (WebSocket por baixo dos
 * panos) — assim que a função serverless insere o alerta, quem estiver
 * com esse canal aberto recebe instantaneamente, sem precisar recarregar
 * a página nem ficar consultando o banco de tempos em tempos.
 * ============================================================
 */

/**
 * Painel da EMPRESA PARCEIRA: escuta só os alertas dos vigilantes dela.
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {string} companyId
 * @param {(alerta: object) => void} onNovoAlerta
 * @returns {() => void} função pra parar de escutar (chamar ao sair da tela)
 */
function escutarPanicoDaEmpresa(sb, companyId, onNovoAlerta) {
  const channel = sb
    .channel(`panico-empresa-${companyId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'panic_alerts', filter: `company_id=eq.${companyId}` },
      (payload) => onNovoAlerta(payload.new)
    )
    .subscribe();

  return () => sb.removeChannel(channel);
}

/**
 * DASHBOARD OPERACIONAL DA SHIELD: escuta TODOS os alertas, de qualquer
 * empresa/autônomo — é o painel central que vê tudo que acontece na rede.
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {(alerta: object) => void} onNovoAlerta
 * @returns {() => void}
 */
function escutarTodosOsPanicosShield(sb, onNovoAlerta) {
  const channel = sb
    .channel('panico-shield-operacional')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'panic_alerts' }, // sem filtro = todos
      (payload) => onNovoAlerta(payload.new)
    )
    .subscribe();

  return () => sb.removeChannel(channel);
}

/**
 * CLIENTE: escuta só os alertas de pânico ligados ao(s) atendimento(s) dele -
 * pra ele saber, com transparência, se algo aconteceu com o vigilante que
 * está atendendo ele, sem precisar ficar recarregando a tela.
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {string} clientId
 * @param {(alerta: object) => void} onNovoAlerta
 * @returns {() => void}
 */
function escutarPanicoDoCliente(sb, clientId, onNovoAlerta) {
  const channel = sb
    .channel(`panico-cliente-${clientId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'panic_alerts', filter: `client_id=eq.${clientId}` },
      (payload) => onNovoAlerta(payload.new)
    )
    .subscribe();

  return () => sb.removeChannel(channel);
}

if (typeof module !== 'undefined') {
  module.exports = { escutarPanicoDaEmpresa, escutarTodosOsPanicosShield, escutarPanicoDoCliente };
}
