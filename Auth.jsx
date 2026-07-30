/**
 * ============================================================
 * SHIELD — AUTH.JS (login + descoberta de destino pós-login)
 * ============================================================
 * Extraído/refatorado do App.tsx (index.html) que já está no ar.
 * Antes, o dashboard pós-login era decidido pela variável `role`
 * (qual botão a pessoa clicou na tela inicial: "SOU CLIENTE" /
 * "PRESTADOR" / "EMPRESA"). Isso funciona no caminho feliz, mas se
 * a pessoa clicar no botão errado, ela entra na dashboard errada
 * mesmo com login correto.
 *
 * Aqui, o destino é decidido pelo `profiles.role` DE VERDADE, lido
 * do banco depois da autenticação — nunca pelo botão que a pessoa
 * clicou. O `role` do botão continua existindo só pra escolher o
 * TEMA visual do modal de login (teal/gold/empresa), nunca pra
 * decidir a lógica de redirecionamento.
 *
 * Uso (dentro do App.jsx):
 *   import { login } from './auth';
 *
 *   const resultado = await login({ email, senha });
 *   if (!resultado.success) {
 *     // resultado.error -> mensagem pra mostrar no formulário
 *     return;
 *   }
 *   setCurrentUserId(resultado.userId);
 *   setScreen(resultado.screen);
 *   if (resultado.aviso) showToast(resultado.aviso);
 *   // dados extras específicos da tela (ex: companyId, vinculoInfo)
 *   if (resultado.screen === 'empresaDashboard') setCompanyId(resultado.extra.companyId);
 *   if (resultado.screen === 'prestadorVinculadoDashboard') setVinculoInfo(resultado.extra);
 * ============================================================
 */

/**
 * Descobre pra onde mandar o usuário depois de autenticado, consultando
 * SEMPRE o banco (profiles.role) — nunca o botão que a pessoa clicou.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {string} userId
 * @returns {Promise<{ screen: string, roleReal: string, extra: object|null }>}
 */
async function determinarDestinoPosLogin(sb, userId) {
  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('role, full_name')
    .eq('id', userId)
    .single();

  if (profileError || !profile) {
    // Sem perfil legível (raro, mas não pode travar o login) -> manda pro
    // destino mais seguro/genérico e deixa a tela decidir o que fazer.
    return { screen: 'clientDashboard', roleReal: null, extra: null };
  }

  switch (profile.role) {
    case 'provider': {
      // Verifica se é autônomo ou vinculado a uma empresa parceira —
      // se vinculado, tem uma dashboard própria (com status de aprovação).
      try {
        const { data: prestadorInfo } = await sb
          .from('usuarios_prestadores')
          .select('tipo_prestador, status_aprovacao, company_id, empresas_parceiras(razao_social)')
          .eq('id', userId)
          .single();

        if (prestadorInfo && prestadorInfo.tipo_prestador === 'vinculado') {
          return {
            screen: 'prestadorVinculadoDashboard',
            roleReal: 'provider',
            extra: {
              empresaNome: prestadorInfo.empresas_parceiras ? prestadorInfo.empresas_parceiras.razao_social : null,
              statusAprovacao: prestadorInfo.status_aprovacao,
            },
          };
        }
      } catch (e) {
        // se a consulta falhar, cai no comportamento padrão (dashboard autônomo)
      }
      return { screen: 'providerDashboard', roleReal: 'provider', extra: null };
    }

    case 'company': {
      let companyId = null;
      try {
        const { data: empresa } = await sb
          .from('empresas_parceiras')
          .select('id')
          .eq('owner_id', userId)
          .single();
        companyId = empresa ? empresa.id : null;
      } catch (e) {
        companyId = null;
      }
      return { screen: 'empresaDashboard', roleReal: 'company', extra: { companyId } };
    }

    case 'admin':
      // Ainda não existe uma tela de admin construída — cai num destino
      // seguro por enquanto. Troque 'clientDashboard' por 'adminDashboard'
      // assim que essa tela existir.
      return { screen: 'clientDashboard', roleReal: 'admin', extra: null };

    case 'client':
    default:
      return { screen: 'clientDashboard', roleReal: 'client', extra: null };
  }
}

/**
 * Faz o login e já devolve pra onde a tela deve navegar — de acordo com o
 * banco, não com o botão clicado. Também avisa (via `aviso`) se a pessoa
 * clicou num botão diferente do papel real dela, pra você poder mostrar um
 * toast tipo "Você entrou como Prestador" em vez de simplesmente trocar de
 * tela sem explicação.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {{ email: string, senha: string, roleClicado?: 'cliente'|'prestador'|'empresa' }} params
 */
async function login(sb, { email, senha, roleClicado }) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });

  if (error) {
    return { success: false, error: error.message || 'Não foi possível entrar. Verifique seus dados.' };
  }

  const userId = data && data.user ? data.user.id : null;
  if (!userId) {
    return { success: false, error: 'Login retornou sem usuário. Tente novamente.' };
  }

  const destino = await determinarDestinoPosLogin(sb, userId);

  const roleClicadoNormalizado = { cliente: 'client', prestador: 'provider', empresa: 'company' }[roleClicado] || null;
  const aviso = (roleClicadoNormalizado && destino.roleReal && roleClicadoNormalizado !== destino.roleReal)
    ? `Você entrou como ${{ client: 'Cliente', provider: 'Prestador', company: 'Empresa' }[destino.roleReal] || destino.roleReal}.`
    : null;

  return {
    success: true,
    userId,
    session: data.session,
    screen: destino.screen,
    roleReal: destino.roleReal,
    extra: destino.extra,
    aviso,
  };
}

if (typeof module !== 'undefined') {
  module.exports = { login, determinarDestinoPosLogin };
}