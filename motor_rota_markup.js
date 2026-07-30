/**
 * ============================================================
 * SHIELD — MOTOR DE CÁLCULO DE ROTA + MARKUP DIVISOR
 * ============================================================
 * Duas responsabilidades, nesta ordem:
 *
 * 1) calcularRota(origem, destino)
 *    Descobre a distância real em KM entre dois pontos (e uma estimativa
 *    de pedágio), pra alimentar cobranças por KM rodado.
 *
 * 2) calcularPrecoFinalComMarkup({ custoPrestador, ... })
 *    Pega o custo que o prestador precisa receber e "infla" esse valor
 *    pro preço final que o cliente vê na tela — de um jeito que garanta
 *    que, DEPOIS de descontadas todas as taxas percentuais (seu plano,
 *    o gateway de pagamento, o imposto da nota), o prestador ainda
 *    recebe exatamente o valor combinado. Isso só funciona corretamente
 *    com DIVISÃO, não com uma simples soma de percentual (explicado
 *    em detalhe no comentário da função).
 *
 * Nenhuma das duas funções precisa de chave de API secreta pra rodar no
 * modo padrão — dá pra usar direto no navegador. Se um dia você quiser
 * trocar por uma API paga (Google Routes, Mapbox) que devolve pedágio
 * real, é só trocar o provedor dentro de calcularRota (ver comentário).
 * ============================================================
 */

// ------------------------------------------------------------
// 1. CÁLCULO DE ROTA (distância real em KM + pedágio estimado)
// ------------------------------------------------------------

/**
 * Estimativa de custo médio de pedágio por KM rodado em rodovias
 * brasileiras. É uma HEURÍSTICA, não um valor oficial — ajuste esse
 * número conforme a realidade das rotas que o seu app realmente cobre
 * (rotas 100% urbanas tendem a ter pedágio ≈ 0; rotas rodoviárias entre
 * cidades costumam ficar entre R$0,08 e R$0,20 por km, dependendo do
 * estado/concessionária).
 */
const PEDAGIO_ESTIMADO_POR_KM_BR = 0.12;

/**
 * Calcula a rota real entre dois pontos usando o OSRM (Open Source
 * Routing Machine) — motor de rotas open-source, gratuito, sem
 * necessidade de chave de API. É o mesmo motor por trás de vários
 * apps de navegação open-source.
 *
 * IMPORTANTE sobre o pedágio: o OSRM não devolve custo de pedágio (só
 * geometria/distância/duração da rota). O valor de pedágio abaixo é uma
 * ESTIMATIVA por km rodado, não um valor real captado de fonte oficial.
 * Se seu volume de demandas rodoviárias crescer e pedágio virar um custo
 * relevante, o upgrade natural é trocar por uma API paga que devolve
 * pedágio de verdade (ex: Google Routes API com
 * `extraComputations: ["TOLLS"]`, ou Mapbox Directions com dados de
 * pedágio). Isso precisa de chave secreta, então nesse caso o certo é
 * mover essa chamada pra uma função serverless (Vercel /api), nunca
 * deixar a chave exposta no front-end.
 *
 * @param {{lat:number,lng:number}} origem
 * @param {{lat:number,lng:number}} destino
 * @returns {Promise<{distanciaKm:number, duracaoMinutos:number, pedagioEstimado:number, fonte:string}>}
 */
async function calcularRota(origem, destino) {
  if (!origem || !destino || typeof origem.lat !== 'number' || typeof destino.lat !== 'number') {
    throw new Error('Origem e destino precisam ter { lat, lng } numéricos.');
  }

  const url = `https://router.project-osrm.org/route/v1/driving/`
    + `${origem.lng},${origem.lat};${destino.lng},${destino.lat}`
    + `?overview=false`;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Falha ao consultar o serviço de rotas (HTTP ${resp.status}).`);
  }
  const data = await resp.json();

  if (!data.routes || !data.routes.length) {
    throw new Error('Não foi possível calcular uma rota entre os pontos informados.');
  }

  const distanciaKm = data.routes[0].distance / 1000;
  const duracaoMinutos = data.routes[0].duration / 60;
  const pedagioEstimado = arredondar(distanciaKm * PEDAGIO_ESTIMADO_POR_KM_BR, 2);

  return {
    distanciaKm: arredondar(distanciaKm, 2),
    duracaoMinutos: arredondar(duracaoMinutos, 1),
    pedagioEstimado,
    fonte: 'OSRM (distância real) + estimativa heurística (pedágio)',
  };
}

// ------------------------------------------------------------
// 2. FÓRMULA DO MARKUP DIVISOR
// ------------------------------------------------------------

/**
 * Por que DIVIDIR e não apenas SOMAR um percentual?
 *
 * Errado (soma simples): preco_final = custo_prestador * (1 + 0.20 + 0.03 + 0.06)
 *   Isso parece certo à primeira vista, mas quando você tira as taxas de
 *   volta (como % do preço final, que é como cartão/gateway/imposto
 *   realmente cobram), o prestador acaba recebendo MENOS do que o
 *   combinado, porque a taxa percentual incide sobre um valor maior
 *   (o preço final), não sobre o custo original.
 *
 * Certo (divisor): preco_final = custo_prestador / (1 - (taxa_plano + taxa_gateway + imposto))
 *   Isolando a equação "o que sobra depois de tirar tudo = custo_prestador":
 *     preco_final - preco_final*taxa_plano - preco_final*taxa_gateway - preco_final*imposto = custo_prestador
 *     preco_final * (1 - taxa_plano - taxa_gateway - imposto) = custo_prestador
 *     preco_final = custo_prestador / (1 - taxa_plano - taxa_gateway - imposto)
 *   Com essa fórmula, depois de descontar as 3 taxas percentuais do
 *   preco_final, sobra EXATAMENTE o custo_prestador — sua margem nunca
 *   é corroída pelas taxas.
 *
 * Sobre taxas FIXAS (ex: Pix no Asaas, que é um valor fixo em R$ por
 * transação — R$0,99 ou R$1,99 — e não um percentual): uma taxa fixa
 * não pode entrar dentro do divisor (ela não escala com o preço). Por
 * isso ela é somada ANTES de dividir — assim ela também fica protegida
 * pelas taxas percentuais que vêm depois, e o prestador continua
 * recebendo exatamente o combinado.
 *
 * @param {Object} params
 * @param {number} params.custoPrestador      Valor que o prestador precisa receber (R$)
 * @param {number} params.taxaPlano           Sua comissão/retenção, em fração (ex: 0.20 = 20%)
 * @param {number} [params.taxaGatewayPercentual=0]  Taxa percentual do gateway (ex: cartão ~0.0349 = 3,49%)
 * @param {number} [params.taxaGatewayFixa=0]        Taxa fixa do gateway em R$ (ex: Pix Asaas = 1.99)
 * @param {number} [params.impostoNotaApp=0]         Imposto sobre a nota emitida pelo app, em fração (ex: 0.06 = 6%)
 */
function calcularPrecoFinalComMarkup({
  custoPrestador,
  taxaPlano,
  taxaGatewayPercentual = 0,
  taxaGatewayFixa = 0,
  impostoNotaApp = 0,
}) {
  if (typeof custoPrestador !== 'number' || custoPrestador <= 0) {
    throw new Error('custoPrestador precisa ser um número maior que zero.');
  }

  const somaPercentuais = taxaPlano + taxaGatewayPercentual + impostoNotaApp;
  if (somaPercentuais >= 1) {
    throw new Error(
      `A soma das taxas percentuais (${(somaPercentuais * 100).toFixed(2)}%) não pode ser >= 100%. ` +
      `Configuração inválida — revise taxaPlano/taxaGatewayPercentual/impostoNotaApp.`
    );
  }

  const divisor = 1 - somaPercentuais;
  const baseAntesDoDivisor = custoPrestador + taxaGatewayFixa;
  const precoFinal = arredondar(baseAntesDoDivisor / divisor, 2);

  const valorTaxaPlano = arredondar(precoFinal * taxaPlano, 2);
  const valorTaxaGatewayPercentual = arredondar(precoFinal * taxaGatewayPercentual, 2);
  const valorImposto = arredondar(precoFinal * impostoNotaApp, 2);
  const valorTotalRetido = arredondar(
    valorTaxaPlano + valorTaxaGatewayPercentual + valorImposto + taxaGatewayFixa,
    2
  );

  return {
    precoFinal,
    custoPrestador,
    valorTotalRetido,
    detalhamento: {
      taxaPlano: { fracao: taxaPlano, valor: valorTaxaPlano },
      taxaGatewayPercentual: { fracao: taxaGatewayPercentual, valor: valorTaxaGatewayPercentual },
      taxaGatewayFixa: { valor: taxaGatewayFixa },
      impostoNotaApp: { fracao: impostoNotaApp, valor: valorImposto },
      divisor,
    },
  };
}

// ------------------------------------------------------------
// PLANOS DE PARCERIA — mesmos valores da tabela "planos_parceria" no banco.
// Mantenha isso sincronizado manualmente com o banco, ou troque por uma
// consulta real (ex: sb.from('planos_parceria').select() no front-end).
// ------------------------------------------------------------
const PLANOS_SHIELD = {
  bronze: { mensalidade: 0.00, taxaShieldPercentual: 15.00 },
  prata: { mensalidade: 199.00, taxaShieldPercentual: 8.00 },
  ouro: { mensalidade: 499.00, taxaShieldPercentual: 3.00 },
};

/**
 * Atalho de calcularPrecoFinalComMarkup() pra quando você já sabe o PLANO
 * da empresa (bronze/prata/ouro) em vez do percentual bruto — resolve a
 * taxaPlano automaticamente a partir de PLANOS_SHIELD.
 *
 * @param {'bronze'|'prata'|'ouro'} plano
 * @param {Object} outrosParametros - mesmos parâmetros de calcularPrecoFinalComMarkup, exceto taxaPlano
 */
function calcularPrecoFinalParaEmpresa(plano, outrosParametros) {
  const config = PLANOS_SHIELD[plano];
  if (!config) {
    throw new Error(`Plano "${plano}" não reconhecido. Use 'bronze', 'prata' ou 'ouro'.`);
  }
  return calcularPrecoFinalComMarkup({
    ...outrosParametros,
    taxaPlano: config.taxaShieldPercentual / 100,
  });
}

// ------------------------------------------------------------
// 3. MOTOR HÍBRIDO MULTICATEGORIAS (Regra A logística / Regra B posto)
// ------------------------------------------------------------

/**
 * Espelha a coluna "modelo_calculo" da tabela service_categories.
 * Mantenha sincronizado manualmente, ou troque por uma consulta real
 * (ex: sb.from('service_categories').select('slug, modelo_calculo')).
 */
const MODELO_CALCULO_POR_TIPO = {
  escolta_de_carga: 'logistico',
  seguranca_eventos: 'posto',
  seguranca_elite: 'posto',
  facilities_limpeza: 'posto',
  portaria: 'posto',
  apoio: 'posto',
  bar_restaurante: 'posto',
  lojas: 'posto',
  mercados: 'posto',
  galpao: 'posto',
};

/**
 * REGRA A — Serviços logísticos (ex: escolta armada de carga).
 * Custo_Prestador = Valor_Base + (KM_Excedentes × Valor_KM_Excedente) + Pedágios_Rota
 *
 * @param {Object} tarifa - linha de tarifas_servicos; espera tarifa.parametros =
 *   { valor_base, franquia_km, km_excedente }  (mesmo JSON gravado no banco)
 * @param {{lat:number,lng:number}} origem
 * @param {{lat:number,lng:number}} destino
 */
async function calcularCustoPrestadorLogistico(tarifa, origem, destino) {
  const p = tarifa.parametros || tarifa; // aceita tanto { parametros: {...} } quanto o objeto já "achatado"
  const rota = await calcularRota(origem, destino);
  const kmExcedentes = Math.max(rota.distanciaKm - Number(p.franquia_km), 0);
  const custoKmExcedente = arredondar(kmExcedentes * Number(p.km_excedente), 2);
  const custoPrestador = arredondar(
    Number(p.valor_base) + custoKmExcedente + rota.pedagioEstimado,
    2
  );

  return {
    modelo: 'logistico',
    custoPrestador,
    detalhamento: {
      valorBase: Number(p.valor_base),
      kmRodados: rota.distanciaKm,
      franquiaKm: Number(p.franquia_km),
      kmExcedentes: arredondar(kmExcedentes, 2),
      valorKmExcedente: Number(p.km_excedente),
      custoKmExcedente,
      pedagioRota: rota.pedagioEstimado,
      duracaoMinutos: rota.duracaoMinutos,
    },
  };
}

/**
 * REGRA B — Serviços de posto/permanência (ex: eventos, vigilância
 * patrimonial, facilities). Ignora quilometragem; foca em profissionais e horas.
 * Custo_Prestador = (Valor_Base_por_Profissional × Qtd_Profissionais)
 *                   + (Horas_Excedentes × Valor_Hora_Excedente)
 *
 * @param {Object} tarifa - linha de tarifas_servicos; espera tarifa.parametros =
 *   { valor_base_profissional, franquia_horas, hora_excedente }  (mesmo JSON gravado no banco)
 * @param {number} qtdProfissionais
 * @param {number} horasUtilizadas
 */
function calcularCustoPrestadorPosto(tarifa, qtdProfissionais, horasUtilizadas) {
  if (qtdProfissionais < 1) throw new Error('qtdProfissionais precisa ser >= 1.');
  const p = tarifa.parametros || tarifa;

  const horasExcedentes = Math.max(horasUtilizadas - Number(p.franquia_horas), 0);
  const custoBaseEquipe = arredondar(Number(p.valor_base_profissional) * qtdProfissionais, 2);
  const custoHorasExcedentes = arredondar(horasExcedentes * Number(p.hora_excedente), 2);
  const custoPrestador = arredondar(custoBaseEquipe + custoHorasExcedentes, 2);

  return {
    modelo: 'posto',
    custoPrestador,
    detalhamento: {
      valorBasePorProfissional: Number(p.valor_base_profissional),
      qtdProfissionais,
      custoBaseEquipe,
      horasUtilizadas,
      franquiaHoras: Number(p.franquia_horas),
      horasExcedentes: arredondar(horasExcedentes, 2),
      valorHoraExcedente: Number(p.hora_excedente),
      custoHorasExcedentes,
    },
  };
}

/**
 * PONTO DE ENTRADA ÚNICO — decide sozinho qual regra (A ou B) aplicar,
 * de acordo com o tipo de serviço, e devolve o Custo_Prestador já calculado.
 *
 * @param {Object} params
 * @param {string} params.tipoServico - slug da categoria (ex: 'escolta_de_carga')
 * @param {Object} params.tarifa - linha correspondente da tabela tarifas_servicos
 * @param {{lat:number,lng:number}} [params.origem] - obrigatório se for 'logistico'
 * @param {{lat:number,lng:number}} [params.destino] - obrigatório se for 'logistico'
 * @param {number} [params.qtdProfissionais] - obrigatório se for 'posto'
 * @param {number} [params.horasUtilizadas] - obrigatório se for 'posto'
 */
async function calcularCustoPrestadorPorCategoria({
  tipoServico, tarifa, origem, destino, qtdProfissionais, horasUtilizadas,
}) {
  const modelo = MODELO_CALCULO_POR_TIPO[tipoServico];
  if (!modelo) {
    throw new Error(`Categoria "${tipoServico}" não tem modelo de cálculo definido (logistico/posto).`);
  }

  if (modelo === 'logistico') {
    if (!origem || !destino) {
      throw new Error('Serviços logísticos exigem origem e destino pra calcular KM rodado.');
    }
    return calcularCustoPrestadorLogistico(tarifa, origem, destino);
  }

  // modelo === 'posto'
  if (!qtdProfissionais || !horasUtilizadas) {
    throw new Error('Serviços de posto exigem qtdProfissionais e horasUtilizadas.');
  }
  return calcularCustoPrestadorPosto(tarifa, qtdProfissionais, horasUtilizadas);
}

/**
 * ORQUESTRADOR FINAL — do tipo de serviço até o preço que o cliente vê na
 * tela, numa única chamada. Encadeia:
 *   1) calcularCustoPrestadorPorCategoria()  -> descobre o Custo_Prestador
 *      (decidindo sozinho entre Regra A logística / Regra B posto)
 *   2) calcularPrecoFinalParaEmpresa()       -> aplica o markup divisor
 *      (usando a taxa do PLANO contratado pela empresa)
 *
 * @param {Object} params
 * @param {string} params.tipoServico - slug da categoria (ex: 'escolta_de_carga', 'seguranca_eventos')
 * @param {Object} params.tarifa - linha de tarifas_servicos (valor_base, franquia_km, km_excedente, franquia_horas, hora_excedente)
 * @param {'bronze'|'prata'|'ouro'} params.plano - plano contratado pela empresa
 * @param {{lat:number,lng:number}} [params.origem] - obrigatório se o serviço for 'logistico'
 * @param {{lat:number,lng:number}} [params.destino] - obrigatório se o serviço for 'logistico'
 * @param {number} [params.qtdProfissionais] - obrigatório se o serviço for 'posto'
 * @param {number} [params.horasUtilizadas] - obrigatório se o serviço for 'posto'
 * @param {number} [params.taxaGatewayPercentual=0] - ex: 0.0349 se pago por cartão
 * @param {number} [params.taxaGatewayFixa=0] - ex: 1.99 se pago por Pix (Asaas)
 * @param {number} [params.impostoNotaApp=0] - ex: 0.06
 */
async function calcularPrecoCompleto({
  tipoServico, tarifa, plano,
  origem, destino, qtdProfissionais, horasUtilizadas,
  taxaGatewayPercentual = 0, taxaGatewayFixa = 0, impostoNotaApp = 0,
}) {
  const resultadoCusto = await calcularCustoPrestadorPorCategoria({
    tipoServico, tarifa, origem, destino, qtdProfissionais, horasUtilizadas,
  });

  const resultadoPreco = calcularPrecoFinalParaEmpresa(plano, {
    custoPrestador: resultadoCusto.custoPrestador,
    taxaGatewayPercentual,
    taxaGatewayFixa,
    impostoNotaApp,
  });

  return {
    tipoServico,
    modelo: resultadoCusto.modelo,
    plano,
    custoPrestador: resultadoCusto.custoPrestador,
    precoFinal: resultadoPreco.precoFinal,
    valorTotalRetido: resultadoPreco.valorTotalRetido,
    detalhamentoCusto: resultadoCusto.detalhamento,
    detalhamentoPreco: resultadoPreco.detalhamento,
  };
}

// ------------------------------------------------------------
// Utilitário de arredondamento financeiro seguro
// ------------------------------------------------------------
function arredondar(valor, casas = 2) {
  const limpo = Number(valor.toFixed(8));
  const fator = Math.pow(10, casas);
  return Math.round(limpo * fator) / fator;
}

// ------------------------------------------------------------
// EXEMPLOS / TESTES RÁPIDOS
// ------------------------------------------------------------
if (typeof require !== 'undefined' && require.main === module) {
  console.log('\n### Exemplo 1: Elite (custo prestador R$480), pago via Pix ###');
  const ex1 = calcularPrecoFinalComMarkup({
    custoPrestador: 480,
    taxaPlano: 0.20,          // retenção ShielD pra categoria Elite
    taxaGatewayFixa: 1.99,     // Pix Asaas (taxa fixa, após os 3 primeiros meses)
    impostoNotaApp: 0.06,      // estimativa de imposto sobre a nota (ajuste com seu contador)
  });
  console.log(ex1);
  console.log('Confere: prestador recebe de volta =',
    arredondar(ex1.precoFinal - ex1.valorTotalRetido, 2), '(deve bater com custoPrestador)');

  console.log('\n### Exemplo 2: Facility (custo prestador R$100), pago via cartão ###');
  const ex2 = calcularPrecoFinalComMarkup({
    custoPrestador: 100,
    taxaPlano: 0.15,               // retenção ShielD pra Facility/Padrão
    taxaGatewayPercentual: 0.0349, // taxa de cartão (confirme o valor real na sua conta Asaas)
    impostoNotaApp: 0.06,
  });
  console.log(ex2);
  console.log('Confere: prestador recebe de volta =',
    arredondar(ex2.precoFinal - ex2.valorTotalRetido, 2), '(deve bater com custoPrestador)');

  console.log('\n### Exemplo 3: mesma empresa em cada plano (custo prestador R$480, Pix) ###');
  ['bronze', 'prata', 'ouro'].forEach((plano) => {
    const r = calcularPrecoFinalParaEmpresa(plano, {
      custoPrestador: 480,
      taxaGatewayFixa: 1.99,
      impostoNotaApp: 0.06,
    });
    const mensalidade = PLANOS_SHIELD[plano].mensalidade;
    console.log(`${plano.toUpperCase()} (mensalidade R$${mensalidade}): preço final R$${r.precoFinal} | retido R$${r.valorTotalRetido}`);
  });

  console.log('\n### Exemplo 4: cálculo de rota real (BH -> Contagem) ###');
  calcularRota({ lat: -19.9227, lng: -43.9451 }, { lat: -19.9317, lng: -44.0536 })
    .then((r) => console.log(r))
    .catch((e) => console.log('Aviso: rota real precisa de internet no ambiente onde isso rodar. Erro:', e.message));
  console.log('\n### Exemplo 5: motor híbrido - Regra B (posto), Eventos, 3 profissionais, 8h ###');
  const tarifaEventos = { parametros: { valor_base_profissional: 45.00, franquia_horas: 6, hora_excedente: 12.00 } };
  calcularCustoPrestadorPorCategoria({
    tipoServico: 'seguranca_eventos',
    tarifa: tarifaEventos,
    qtdProfissionais: 3,
    horasUtilizadas: 8,
  }).then((r) => console.log(r));
  // esperado: (45*3) + (8-6)*12 = 135 + 24 = 159

  console.log('\n### Exemplo 6: motor híbrido - Regra A (logístico), Escolta de Carga ###');
  const tarifaEscolta = { parametros: { valor_base: 500.00, franquia_km: 50, km_excedente: 4.50 } };
  calcularCustoPrestadorPorCategoria({
    tipoServico: 'escolta_de_carga',
    tarifa: tarifaEscolta,
    origem: { lat: -19.9227, lng: -43.9451 },
    destino: { lat: -19.9317, lng: -44.0536 },
  })
    .then((r) => console.log(r))
    .catch((e) => console.log('Aviso: rota real precisa de internet no ambiente onde isso rodar. Erro:', e.message));
  console.log('\n### Exemplo 7: ORQUESTRADOR COMPLETO - Eventos, plano Prata, pago via Pix ###');
  calcularPrecoCompleto({
    tipoServico: 'seguranca_eventos',
    tarifa: tarifaEventos,
    plano: 'prata',
    qtdProfissionais: 3,
    horasUtilizadas: 8,
    taxaGatewayFixa: 1.99,
    impostoNotaApp: 0.06,
  }).then((r) => console.log(r));
  // esperado: custoPrestador=159 -> precoFinal = (159+1.99)/(1-0.08-0.06) = 187.20
}

if (typeof module !== 'undefined') {
  module.exports = {
    calcularRota,
    calcularPrecoFinalComMarkup,
    calcularPrecoFinalParaEmpresa,
    calcularCustoPrestadorPorCategoria,
    calcularCustoPrestadorLogistico,
    calcularCustoPrestadorPosto,
    calcularPrecoCompleto,
    MODELO_CALCULO_POR_TIPO,
    PLANOS_SHIELD,
    arredondar,
  };
}
