/**
 * ============================================================
 * MOTOR DE CÁLCULO INTELIGENTE - SISTEMA SHIELD (v3 - UNIFICADO)
 * ============================================================
 * Combina as duas regras de negócio construídas até aqui:
 *
 *  A) Categoria + Urgência + Adicional Noturno + Retenção (regra nova, oficial)
 *  B) Fator Geográfico por zona (regra anterior, Ibirité/Belvedere/Savassi/...)
 *
 * COMO SE ENCAIXAM:
 * - Facility e Padrão: só a regra (A). Nunca sofrem ajuste de zona (não faz
 *   sentido geográfico para limpeza/portaria neste modelo, e a especificação
 *   nova é explícita que Facility nunca tem Elite).
 * - Elite (Segurança/Controlador Avançado): regra (A) define a base
 *   (R$26/28 + 10% Elite), e a ZONA entra como um multiplicador adicional
 *   EM CIMA dessa base — preservando a proporção original de cada bairro
 *   (Ibirité era 24/21 = +14,3% sobre o padrão; Savassi era 25/21 = +19%;
 *   Alphaville era 26/21 = +23,8%). O Adicional Noturno entra por último.
 *
 * ORDEM DE APLICAÇÃO (cascata, não soma linear):
 *   valor_hora = base(categoria,urgência)
 *              x 1.10        (se Elite)
 *              x fatorZona   (se Elite e endereço bate com alguma zona mapeada)
 *              x 1.20        (se horário 22h-05h)
 */

function arredondar(valor, casas = 2) {
  const limpo = Number(valor.toFixed(8));
  const fator = Math.pow(10, casas);
  return Math.round(limpo * fator) / fator;
}

// Fator de zona = proporção herdada da tabela geográfica anterior (base 21 = zona padrão)
const RISK_ZONES = [
  { termo: 'ibirité',     tipo: 'Periculosidade', fatorZona: 24 / 21 },
  { termo: 'barreiro',    tipo: 'Periculosidade', fatorZona: 24 / 21 },
  { termo: 'ressaca',     tipo: 'Periculosidade', fatorZona: 24 / 21 },
  { termo: 'petrolândia', tipo: 'Periculosidade', fatorZona: 24 / 21 },
  { termo: 'belvedere',   tipo: 'Alto Padrão',    fatorZona: 25 / 21 },
  { termo: 'savassi',     tipo: 'Alto Padrão',    fatorZona: 25 / 21 },
  { termo: 'lourdes',     tipo: 'Alto Padrão',    fatorZona: 25 / 21 },
  { termo: 'alphaville',  tipo: 'Alto Padrão',    fatorZona: 26 / 21 },
];

/**
 * @param {Object} params
 * @param {'Facility'|'Padrão'|'Elite'} params.categoria
 * @param {'Agendado'|'Urgente'} params.urgencia
 * @param {string} params.inicioISO - data/hora de início (ISO 8601)
 * @param {number} params.duracaoHoras
 * @param {string} [params.endereco] - usado só quando categoria === 'Elite'
 * @param {boolean} [params.prestadorAprovadoElite]
 */
function calcularServicoShield({ categoria, urgencia, inicioISO, duracaoHoras, endereco, prestadorAprovadoElite }) {
  if (categoria === 'Facility' && urgencia !== 'Agendado' && urgencia !== 'Urgente') {
    throw new Error('Urgência inválida.');
  }

  // 1) Valor base por hora
  let valorHora = categoria === 'Elite'
    ? (urgencia === 'Urgente' ? 28.00 : 26.00)
    : (urgencia === 'Urgente' ? 15.00 : 13.00);

  const adicionais = [];
  let zonaAplicada = null;

  // 2) Condição ELITE (+10%) + Fator de Zona — só dentro de Elite
  if (categoria === 'Elite') {
    valorHora = arredondar(valorHora * 1.10);
    adicionais.push('Condição ELITE (+10%)');

    if (endereco) {
      const enderecoLower = endereco.toLowerCase();
      const zona = RISK_ZONES.find(z => enderecoLower.includes(z.termo));
      if (zona) {
        valorHora = arredondar(valorHora * zona.fatorZona);
        zonaAplicada = zona;
        const pct = Math.round((zona.fatorZona - 1) * 1000) / 10;
        adicionais.push(`Fator de Zona - ${zona.tipo} (${zona.termo}, +${pct}%)`);
      }
    }
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
    categoria, categoriaLabel, urgencia, isNoturno, zonaAplicada, adicionais,
    valorHoraFinal: valorHora,
    valorTotalCliente, valorTotalPrestador, retencaoPct,
    requerAprovacaoManual: categoria === 'Elite',
    bloqueadoPorFaltaDeAprovacao: categoria === 'Elite' && !prestadorAprovadoElite,
  };
}

function imprimirPainel(titulo, resultado) {
  const statusAdicionais = resultado.adicionais.length ? resultado.adicionais.join(' + ') : 'Nenhum';
  console.log(`\n### ${titulo} ###`);
  console.log('[PAINEL DO PRESTADOR]');
  if (resultado.bloqueadoPorFaltaDeAprovacao) {
    console.log('- BLOQUEADO: serviço Elite requer prestador aprovado manualmente no banco de dados.');
  } else {
    console.log(`- Total a Receber: R$ ${resultado.valorTotalPrestador.toFixed(2)} (já com retenção de ${resultado.retencaoPct}% aplicada)`);
    console.log(`- Status/Adicionais: ${statusAdicionais}`);
  }
  console.log('[DASHBOARD DO CLIENTE]');
  console.log(`- Categoria Selecionada: ${resultado.categoriaLabel}`);
  console.log(`- Total a Pagar: R$ ${resultado.valorTotalCliente.toFixed(2)}`);
  console.log(`- Status/Adicionais: ${statusAdicionais}`);
}

// ------------------------------------------------------------
// TESTES
// ------------------------------------------------------------
if (typeof require !== 'undefined' && require.main === module) {
  imprimirPainel('1) Facility, Agendado, diurno, 4h', calcularServicoShield({
    categoria: 'Facility', urgencia: 'Agendado', inicioISO: '2026-07-20T09:00:00', duracaoHoras: 4
  }));

  imprimirPainel('2) Padrão, Urgente, noturno (23h), 3h', calcularServicoShield({
    categoria: 'Padrão', urgencia: 'Urgente', inicioISO: '2026-07-20T23:00:00', duracaoHoras: 3
  }));

  imprimirPainel('3) Elite, Agendado, diurno, 6h, endereço PADRÃO (sem zona mapeada)', calcularServicoShield({
    categoria: 'Elite', urgencia: 'Agendado', inicioISO: '2026-07-25T18:00:00', duracaoHoras: 6,
    endereco: 'Av. Cristiano Machado, Belo Horizonte', prestadorAprovadoElite: true
  }));

  imprimirPainel('4) Elite, Agendado, diurno, 6h, Savassi (zona Alto Padrão)', calcularServicoShield({
    categoria: 'Elite', urgencia: 'Agendado', inicioISO: '2026-07-25T18:00:00', duracaoHoras: 6,
    endereco: 'Rua Fernandes Tourinho, Savassi, BH', prestadorAprovadoElite: true
  }));

  imprimirPainel('5) Elite, Urgente, NOTURNO (00h), 5h, Ibirité (zona Periculosidade)', calcularServicoShield({
    categoria: 'Elite', urgencia: 'Urgente', inicioISO: '2026-07-21T00:00:00', duracaoHoras: 5,
    endereco: 'Av. Vereador José Gomes, Ibirité', prestadorAprovadoElite: true
  }));

  imprimirPainel('6) Elite, Agendado, diurno, 4h, Alphaville, prestador NÃO aprovado', calcularServicoShield({
    categoria: 'Elite', urgencia: 'Agendado', inicioISO: '2026-07-22T14:00:00', duracaoHoras: 4,
    endereco: 'Alameda da Serra, Alphaville, Nova Lima', prestadorAprovadoElite: false
  }));
}

if (typeof module !== 'undefined') {
  module.exports = { calcularServicoShield, arredondar, RISK_ZONES };
}
