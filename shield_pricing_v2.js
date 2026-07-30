/**
 * ============================================================
 * MOTOR DE CÁLCULO INTELIGENTE - SISTEMA SHIELD
 * Precificação por Categoria + Urgência + Adicional Noturno + Retenção
 * ============================================================
 *
 * REGRAS (conforme especificado):
 * 1) Categorias base:
 *    - FACILITY  (Limpeza e Conservação): Agendado R$13,00/h | Urgente R$15,00/h — NUNCA tem condição Elite
 *    - PADRÃO    (Desarmado/Portaria/Lojas): Agendado R$13,00/h | Urgente R$15,00/h
 * 2) ELITE (exclusivo Segurança/Controlador Avançado, locais de alto padrão):
 *    - Valor base: Agendado R$26,00/h | Urgente R$28,00/h
 *    - Taxa de Elite: +10% sobre o valor/hora Elite
 *    - Requer prestador aprovado manualmente no banco (approved_elite = true)
 * 3) Adicional Noturno: +20% sobre o valor/hora aplicável, incide das 22h às 05h
 * 4) Retenção SHIELD (repasse ao prestador):
 *    - Facility / Padrão: prestador recebe 85% (retenção 15%)
 *    - Elite: prestador recebe 80% (retenção 20%)
 *
 * IMPORTANTE (premissa assumida, pois a regra não especifica a ordem exata):
 * os percentuais incidem em cascata sobre o valor corrente (Elite primeiro,
 * depois Noturno), e não são somados linearmente. Ex: Elite (+10%) + Noturno (+20%)
 * = valor_base x 1.10 x 1.20 = x1.32, não x1.30. Avise se a regra de negócio real
 * for aditiva simples (x1.30) em vez de composta — é fácil trocar.
 */

function arredondar(valor, casas = 2) {
  const limpo = Number(valor.toFixed(8));
  const fator = Math.pow(10, casas);
  return Math.round(limpo * fator) / fator;
}

/**
 * @param {Object} params
 * @param {'Facility'|'Padrão'|'Elite'} params.categoria
 * @param {'Agendado'|'Urgente'} params.urgencia
 * @param {string} params.inicioISO - data/hora de início do serviço (ISO 8601)
 * @param {number} params.duracaoHoras - duração contratada em horas
 * @param {boolean} [params.prestadorAprovadoElite] - obrigatório=true para aceitar serviços Elite
 */
function calcularServicoShield({ categoria, urgencia, inicioISO, duracaoHoras, prestadorAprovadoElite }) {
  if (categoria === 'Facility' && arguments[0].forcarElite) {
    throw new Error('Regra violada: Facility nunca pode receber a condição Elite.');
  }

  // 1) Valor base por hora
  let valorHora;
  if (categoria === 'Elite') {
    valorHora = urgencia === 'Urgente' ? 28.00 : 26.00;
  } else {
    valorHora = urgencia === 'Urgente' ? 15.00 : 13.00;
  }

  const adicionais = [];

  // 2) Condição ELITE (+10%) — só pode existir se categoria === 'Elite'
  if (categoria === 'Elite') {
    valorHora = arredondar(valorHora * 1.10);
    adicionais.push('Condição ELITE (+10%)');
  }

  // 3) Adicional Noturno (+20%, 22h-05h) — incide sobre o valor já ajustado
  const hora = new Date(inicioISO).getHours();
  const isNoturno = hora >= 22 || hora < 5;
  if (isNoturno) {
    valorHora = arredondar(valorHora * 1.20);
    adicionais.push('Adicional Noturno (+20%, 22h-05h)');
  }

  // 4) Total bruto cobrado do cliente
  const valorTotalCliente = arredondar(valorHora * duracaoHoras);

  // 5) Retenção SHIELD / repasse ao prestador
  const percentualPrestador = categoria === 'Elite' ? 0.80 : 0.85;
  const retencaoPct = categoria === 'Elite' ? 20 : 15;
  const valorTotalPrestador = arredondar(valorTotalCliente * percentualPrestador);

  const categoriaLabel =
    categoria === 'Facility' ? 'Facility - Limpeza e Conservação' :
    categoria === 'Elite' ? 'Elite' : 'Padrão';

  return {
    categoria, categoriaLabel, urgencia, isNoturno, adicionais,
    valorTotalCliente, valorTotalPrestador, retencaoPct,
    requerAprovacaoManual: categoria === 'Elite',
    bloqueadoPorFaltaDeAprovacao: categoria === 'Elite' && !prestadorAprovadoElite,
  };
}

function imprimirPainel(resultado) {
  const statusAdicionais = resultado.adicionais.length ? resultado.adicionais.join(' + ') : 'Nenhum';
  console.log('---');
  console.log('[PAINEL DO PRESTADOR]');
  if (resultado.bloqueadoPorFaltaDeAprovacao) {
    console.log('- BLOQUEADO: serviço Elite requer prestador aprovado manualmente no banco de dados.');
  } else {
    console.log(`- Total a Receber: R$ ${resultado.valorTotalPrestador.toFixed(2)} (já com retenção de ${resultado.retencaoPct}% aplicada)`);
    console.log(`- Status/Adicionais: ${statusAdicionais}`);
  }
  console.log('');
  console.log('[DASHBOARD DO CLIENTE]');
  console.log(`- Categoria Selecionada: ${resultado.categoriaLabel}`);
  console.log(`- Total a Pagar: R$ ${resultado.valorTotalCliente.toFixed(2)}`);
  console.log(`- Status/Adicionais: ${statusAdicionais}`);
  console.log('---');
}

// ------------------------------------------------------------
// TESTES / EXEMPLOS DE USO
// ------------------------------------------------------------
if (typeof require !== 'undefined' && require.main === module) {
  console.log('\n### Exemplo 1: Facility, Agendado, diurno, 4h ###');
  imprimirPainel(calcularServicoShield({
    categoria: 'Facility', urgencia: 'Agendado',
    inicioISO: '2026-07-20T09:00:00', duracaoHoras: 4
  }));

  console.log('\n### Exemplo 2: Padrão, Urgente, noturno (23h), 3h ###');
  imprimirPainel(calcularServicoShield({
    categoria: 'Padrão', urgencia: 'Urgente',
    inicioISO: '2026-07-20T23:00:00', duracaoHoras: 3
  }));

  console.log('\n### Exemplo 3: Elite, Agendado, diurno, 6h (casamento) - prestador aprovado ###');
  imprimirPainel(calcularServicoShield({
    categoria: 'Elite', urgencia: 'Agendado',
    inicioISO: '2026-07-25T18:00:00', duracaoHoras: 6, prestadorAprovadoElite: true
  }));

  console.log('\n### Exemplo 4: Elite, Urgente, noturno (00h), 5h - prestador aprovado ###');
  imprimirPainel(calcularServicoShield({
    categoria: 'Elite', urgencia: 'Urgente',
    inicioISO: '2026-07-21T00:00:00', duracaoHoras: 5, prestadorAprovadoElite: true
  }));

  console.log('\n### Exemplo 5: Elite solicitado, mas prestador NÃO aprovado (deve bloquear) ###');
  imprimirPainel(calcularServicoShield({
    categoria: 'Elite', urgencia: 'Agendado',
    inicioISO: '2026-07-22T14:00:00', duracaoHoras: 4, prestadorAprovadoElite: false
  }));
}

if (typeof module !== 'undefined') {
  module.exports = { calcularServicoShield, arredondar };
}
