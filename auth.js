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

/**
 * Valida o código de convite da empresa (ex: "SNT-7X29") ANTES de criar
 * a conta — evita gerar uma conta órfã quando o código está errado.
 * Não precisa de usuário logado (função pública, só leitura).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {string} codigoEmpresa
 * @returns {Promise<{ valido: boolean, empresaNome?: string, motivo?: string }>}
 */
async function validarCodigoEmpresa(sb, codigoEmpresa) {
  const codigo = (codigoEmpresa || '').trim().toUpperCase();
  if (!codigo) return { valido: false, motivo: 'codigo_vazio' };

  const { data, error } = await sb.rpc('validar_token_convite', { p_token: codigo });
  if (error || !data) return { valido: false, motivo: 'erro_ao_validar' };

  return {
    valido: !!data.valido,
    empresaNome: data.empresa_nome || null,
    motivo: data.motivo || null,
  };
}

/**
 * Cadastra um Prestador VINCULADO: cria a conta, o perfil, o registro em
 * usuarios_prestadores, as categorias de atendimento, e já resgata o
 * código de convite pra deixá-lo vinculado (pendente de aprovação da
 * empresa). O código já deve ter sido validado antes (validarCodigoEmpresa),
 * mas o resgate real (redimir_token_convite) é a fonte de verdade —
 * é ele que efetivamente marca o token como usado.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {Object} params
 * @param {string} params.nome
 * @param {string} params.email
 * @param {string} params.telefone
 * @param {string} params.cpfCnpj
 * @param {string} params.senha
 * @param {string} params.bio
 * @param {string} params.codigoEmpresa
 * @param {string[]} params.categorias - nomes das categorias (ex: ['Portaria', 'Eventos'])
 * @returns {Promise<{ success: boolean, error?: string, empresaNome?: string }>}
 */
async function cadastrarPrestadorVinculado(sb, { nome, email, telefone, cpfCnpj, senha, bio, codigoEmpresa, categorias = [] }) {
  // 1) Confere o código de novo, imediatamente antes de criar a conta
  // (proteção extra caso o usuário tenha demorado entre digitar e enviar).
  const validacao = await validarCodigoEmpresa(sb, codigoEmpresa);
  if (!validacao.valido) {
    return { success: false, error: mensagemErroCodigoEmpresa(validacao.motivo) };
  }

  // 2) Cria a conta
  const { data, error } = await sb.auth.signUp({
    email,
    password: senha,
    options: { data: { full_name: nome, phone: telefone, cpf_cnpj: cpfCnpj, role: 'provider' } },
  });
  if (error) return { success: false, error: error.message || 'Erro ao criar a conta.' };
  if (!data.user) return { success: false, error: 'Cadastro não retornou usuário. Tente novamente.' };

  const userId = data.user.id;

  try {
    // 3) Perfil + registro de prestador (entra como 'autonomo' por padrão;
    // o resgate do token no passo 5 é que efetivamente vincula à empresa)
    const { error: profileError } = await sb.from('profiles').upsert({
      id: userId, role: 'provider', full_name: nome, phone: telefone, cpf_cnpj: cpfCnpj,
    });
    if (profileError) throw profileError;

    const { error: providerError } = await sb.from('usuarios_prestadores').upsert({
      id: userId, bio, verified: false, documents_status: 'pending',
    });
    if (providerError) throw providerError;

    // 4) Categorias de atendimento
    if (categorias.length) {
      const { data: cats, error: catsError } = await sb
        .from('service_categories')
        .select('id,name')
        .in('name', categorias);
      if (catsError) throw catsError;
      if (cats && cats.length) {
        const rows = cats.map((c) => ({ provider_id: userId, category_id: c.id }));
        const { error: pcError } = await sb.from('provider_categories').insert(rows);
        if (pcError) throw pcError;
      }
    }

    // 5) Resgata o código -> vira 'vinculado' + 'pendente' (aguardando a empresa aprovar)
    const { data: resgate, error: resgateError } = await sb.rpc('redimir_token_convite', {
      p_token: (codigoEmpresa || '').trim().toUpperCase(),
      p_provider_id: userId,
    });
    if (resgateError) throw resgateError;
    if (!resgate || !resgate.success) {
      // Muito raro chegar aqui (já validamos antes), mas cobre corrida de
      // outro prestador usando o mesmo código nesse meio-tempo.
      return {
        success: false,
        error: 'O código já não está mais válido (pode ter sido usado por outra pessoa nesse instante). Sua conta foi criada — peça um novo código à empresa e entre em contato com o suporte para vincular.',
      };
    }

    return { success: true, empresaNome: validacao.empresaNome };
  } catch (err) {
    return { success: false, error: (err && err.message) || 'Erro ao concluir o cadastro. Tente novamente.' };
  }
}

function mensagemErroCodigoEmpresa(motivo) {
  switch (motivo) {
    case 'codigo_invalido': return 'Código da empresa não encontrado. Confira com quem te enviou.';
    case 'codigo_ja_utilizado_ou_revogado': return 'Esse código já foi usado ou foi cancelado. Peça um novo à empresa.';
    case 'codigo_expirado': return 'Esse código expirou. Peça um novo à empresa.';
    case 'codigo_vazio': return 'Digite o código da empresa.';
    default: return 'Não foi possível validar o código agora. Tente novamente.';
  }
}

if (typeof module !== 'undefined') {
  module.exports = {
    login,
    determinarDestinoPosLogin,
    validarCodigoEmpresa,
    cadastrarPrestadorVinculado,
  };
}
