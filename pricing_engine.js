/**
 * ============================================================
 * MOTOR DE PRECIFICAÇÃO DINÂMICA - "CONTROLADOR AVANÇADO"
 * ============================================================
 * Espelha exatamente a lógica da função SQL `calcular_preco_controlador_avancado`.
 * Use esta versão no front-end (para mostrar uma estimativa de preço ao cliente
 * antes de publicar a demanda) e/ou em uma função serverless (Vercel/Supabase Edge)
 * que gera a cobrança real no Asaas.
 *
 * IMPORTANTE: o valor final que vale juridicamente é sempre o calculado no banco
 * (função SQL), no momento da criação da demanda. Este arquivo é para preview e
 * para montar o payload de split do Asaas.
 */

// ------------------------------------------------------------
// 1. FATOR GEOGRÁFICO (espelha a tabela risk_zones)
// ------------------------------------------------------------
const RISK_ZONES = [
  { termo: 'ibirité',    classificacao: 'risco', valorBase: 24.00 },
  { termo: 'barreiro',   classificacao: 'risco', valorBase: 24.00 },
  { termo: 'ressaca',    classificacao: 'risco', valorBase: 24.00 },
  { termo: 'petrolândia',classificacao: 'risco', valorBase: 24.00 },
  { termo: 'belvedere',  classificacao: 'elite', valorBase: 25.00 },
  { termo: 'savassi',    classificacao: 'elite', valorBase: 25.00 },
  { termo: 'alphaville', classificacao: 'elite', valorBase: 26.00 },
  { termo: 'lourdes',    classificacao: 'elite', valorBase: 25.00 },
];

const VALOR_BASE_PADRAO = 21.00; // mínimo garantido ao prestador

// ------------------------------------------------------------
// 2. FATOR DE CONTEXTO (espelha a tabela location_types)
// ------------------------------------------------------------
const LOCATION_TYPES = [
  { termo: 'farmácia 24h',                categoria: 'risco_local',  multiplicador: 1.10 },
  { termo: 'farmacia 24h',                categoria: 'risco_local',  multiplicador: 1.10 },
  { termo: 'posto de combustível',        categoria: 'risco_local',  multiplicador: 1.10 },
  { termo: 'posto de combustivel',        categoria: 'risco_local',  multiplicador: 1.10 },
  { termo: 'loja de conveniência 24h',    categoria: 'risco_local',  multiplicador: 1.10 },
  { termo: 'festa/show elite',            categoria: 'evento_elite', multiplicador: 1.15 },
  { termo: 'evento corporativo alto padrão', categoria: 'evento_elite', multiplicador: 1.15 },
];

const MULTIPLICADOR_PADRAO = 1.00;
const SHIELD_MARKUP_PCT = 20; // 20% de markup -> valor_cliente = valor_prestador / 0.80

/**
 * Arredondamento financeiro seguro (evita erros clássicos de ponto flutuante
 * do JavaScript, ex: 29.9/0.8 === 37.37499999999999 em vez de 37.375).
 * Passa primeiro por toFixed(8) para "limpar" o ruído de representação binária
 * antes de arredondar de verdade para o número de casas desejado.
 */
function arredondar(valor, casas = 2) {
  const limpo = Number(valor.toFixed(8));
  const fator = Math.pow(10, casas);
  return Math.round(limpo * fator) / fator;
}

/**
 * Calcula o valor por hora do prestador e do cliente para o serviço
 * "Controlador Avançado", com base no endereço e no tipo/contexto do local.
 *
 * @param {string} endereco - endereço completo informado pelo cliente
 * @param {string} tipoServico - descrição do tipo de local/evento (contexto)
 * @returns {{
 *   valorPrestador: number,
 *   valorCliente: number,
 *   zonaClassificacao: 'risco'|'padrao'|'elite',
 *   zonaIdentificada: string,
 *   contextoCategoria: 'risco_local'|'evento_elite'|'padrao',
 *   contextoMultiplicador: number,
 *   shieldMarkupPct: number
 * }}
 */
function calcularPrecoControladorAvancado(endereco, tipoServico) {
  const enderecoLower = (endereco || '').toLowerCase();
  const tipoLower = (tipoServico || '').toLowerCase();

  // 1) Fator geográfico — prioriza "elite" sobre "risco" em caso de match duplo
  const zonaMatches = RISK_ZONES.filter(z => enderecoLower.includes(z.termo));
  const zona = zonaMatches.sort((a, b) => {
    const rank = { elite: 0, risco: 1, padrao: 2 };
    return rank[a.classificacao] - rank[b.classificacao];
  })[0];
  const valorBase = zona ? zona.valorBase : VALOR_BASE_PADRAO;

  // 2) Fator de contexto
  const contexto = LOCATION_TYPES.find(l => tipoLower.includes(l.termo));
  const multiplicador = contexto ? contexto.multiplicador : MULTIPLICADOR_PADRAO;

  // 3) Cálculo final + split ShielD (20%)
  const valorPrestador = arredondar(valorBase * multiplicador);
  const valorCliente = arredondar(valorPrestador / 0.80);

  return {
    valorPrestador,
    valorCliente,
    zonaClassificacao: zona ? zona.classificacao : 'padrao',
    zonaIdentificada: zona ? zona.termo : 'Zona padrão (não mapeada)',
    contextoCategoria: contexto ? contexto.categoria : 'padrao',
    contextoMultiplicador: multiplicador,
    shieldMarkupPct: SHIELD_MARKUP_PCT,
  };
}

// ------------------------------------------------------------
// 3. SPLIT DE PAGAMENTO NO PADRÃO ASAAS
// ------------------------------------------------------------
/**
 * Monta o payload de split para a API do Asaas (POST /v3/payments).
 * Como valor_cliente = valor_prestador / 0.80, a diferença (20% do valor
 * cobrado do cliente) É EXATAMENTE o valor_prestador subtraído do total —
 * ou seja, basta declarar o valor fixo do prestador no split; o restante
 * (a comissão ShielD) fica retido automaticamente na conta principal,
 * sem precisar ser declarado explicitamente.
 *
 * @param {string} prestadorWalletId - walletId do prestador cadastrado no Asaas
 * @param {number} valorTotalHoras - horas contratadas (ex: 8h de serviço)
 * @param {object} precificacao - retorno de calcularPrecoControladorAvancado()
 */
function montarSplitAsaas(prestadorWalletId, horasContratadas, precificacao) {
  const valorTotalCliente = arredondar(precificacao.valorCliente * horasContratadas);
  const valorTotalPrestador = arredondar(precificacao.valorPrestador * horasContratadas);
  const valorShield = arredondar(valorTotalCliente - valorTotalPrestador);

  return {
    value: valorTotalCliente, // valor total cobrado do cliente
    billingType: 'PIX', // ou 'CREDIT_CARD' / 'BOLETO'
    split: [
      {
        walletId: prestadorWalletId,
        fixedValue: valorTotalPrestador, // 80% efetivo do valor cobrado
      },
      // A ShielD não precisa declarar sua própria wallet no split — o Asaas
      // credita o restante automaticamente na conta principal (dona da cobrança).
    ],
    // Metadados úteis para conciliação/auditoria interna:
    _metadata: {
      valorHoraPrestador: precificacao.valorPrestador,
      valorHoraCliente: precificacao.valorCliente,
      horasContratadas,
      valorTotalPrestador,
      valorTotalCliente,
      valorRetidoShield: valorShield,
      percentualRetidoShield: arredondar((valorShield / valorTotalCliente) * 100), // deve dar ~20%
    },
  };
}

// ------------------------------------------------------------
// 4. EXEMPLOS DE USO / TESTES RÁPIDOS
// ------------------------------------------------------------
if (typeof module !== 'undefined' && require.main === module) {
  const ex1 = calcularPrecoControladorAvancado('Rua Fernandes Tourinho, Savassi, Belo Horizonte', 'Padrão');
  console.log('Savassi / Padrão ->', ex1);

  const ex2 = calcularPrecoControladorAvancado('Av. Vereador José Gomes, Ibirité', 'Farmácia 24h');
  console.log('Ibirité / Farmácia 24h ->', ex2);

  const ex3 = calcularPrecoControladorAvancado('Alameda da Serra, Alphaville, Nova Lima', 'Festa/Show Elite');
  console.log('Alphaville / Festa Elite ->', ex3);

  const split = montarSplitAsaas('wallet_id_do_prestador_xyz', 8, ex3);
  console.log('Split Asaas (8h contratadas) ->', JSON.stringify(split, null, 2));
}

if (typeof module !== 'undefined') {
  module.exports = { calcularPrecoControladorAvancado, montarSplitAsaas, RISK_ZONES, LOCATION_TYPES };
}
