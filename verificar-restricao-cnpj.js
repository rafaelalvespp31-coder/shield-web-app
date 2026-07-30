/**
 * ============================================================
 * SHIELD — BARREIRA PRÉ-SERVIÇO (checkout "Pagar via Boleto Faturado")
 * ============================================================
 * Função serverless (Vercel /api). Roda no servidor porque precisa da
 * chave secreta do Asaas — nunca pode ficar no navegador.
 *
 * O que faz:
 *   1) Chama o endpoint oficial do Asaas que consulta o Serasa Experian
 *      (POST /v3/creditBureauReport) pro CNPJ do cliente.
 *   2) Extrai o texto do relatório (vem em PDF, em base64, no campo
 *      `reportFile`) e procura por indícios de restrição/protesto.
 *   3) Devolve { bloqueado, motivo, downloadUrl } pro front-end decidir
 *      se libera ou barra o boleto ANTES do início do serviço.
 *
 * ------------------------------------------------------------
 * DETALHES REAIS DA API DO ASAAS (verificados na documentação oficial
 * em docs.asaas.com/reference/realizar-consulta) — 2 correções
 * importantes em relação ao que foi descrito:
 *
 *  1) O endpoint é de fato `v3/creditBureauReport`, mas a Asaas recomenda
 *     um timeout de **30 segundos ou mais** (não 3s) — é uma consulta ao
 *     vivo no Serasa Experian, então pode demorar mais que uma chamada
 *     de API comum. Um timeout de 3s tem boa chance de falhar por
 *     lentidão da própria Serasa, não por erro seu.
 *
 *  2) A resposta da Asaas NÃO devolve um campo pronto tipo
 *     "temRestricao: true/false". Ela devolve o relatório em si
 *     (`reportFile`, PDF em base64). Quem restrição/protesto aparece
 *     escrito dentro do PDF — por isso essa função extrai o texto do
 *     PDF e procura por palavras-chave. É uma heurística: funciona bem
 *     na prática, mas o ideal é você rodar uma consulta de teste real
 *     e ajustar as palavras-chave (`PALAVRAS_RESTRICAO` abaixo) de
 *     acordo com o texto exato que aparecer no seu relatório.
 *
 *  3) Pré-requisito operacional: a Asaas exige que você peça liberação
 *     desse endpoint com o seu gerente de conta antes de conseguir
 *     usá-lo — não é self-service.
 * ------------------------------------------------------------
 */

const pdfParse = require('pdf-parse');

const ASAAS_API_KEY = process.env.ASAAS_API_KEY; // nunca no front-end
const ASAAS_BASE_URL = process.env.ASAAS_ENV === 'production'
  ? 'https://api.asaas.com/v3'
  : 'https://api-sandbox.asaas.com/v3';

// Termos que indicam restrição/protesto num relatório Serasa Experian.
// Ajuste esta lista depois de ver um relatório real da sua conta.
const PALAVRAS_RESTRICAO = [
  'protesto',
  'restrição',
  'restricao',
  'negativado',
  'negativação',
  'pendência financeira',
  'pendencia financeira',
  'dívida vencida',
  'divida vencida',
  'ação judicial',
  'acao judicial',
  'cheque sem fundo',
];

/**
 * Verifica se um texto de relatório contém indícios de restrição/protesto.
 * Extraída como função pura pra ser fácil de testar isoladamente.
 * @param {string} textoRelatorio - texto já em minúsculas
 * @returns {string|null} o termo encontrado, ou null se nada foi encontrado
 */
function buscarTermoRestricao(textoRelatorio) {
  return PALAVRAS_RESTRICAO.find((termo) => textoRelatorio.includes(termo)) || null;
}

/**
 * Consulta o Serasa Experian via Asaas pra um CNPJ, e decide se o
 * boleto deve ser bloqueado antes do início do serviço.
 *
 * @param {string} cpfCnpj
 * @param {string} state - UF (2 letras), obrigatório pela Asaas
 * @param {string} [customerId] - id do cliente já cadastrado no Asaas (opcional)
 */
async function verificarRestricaoCnpj(cpfCnpj, state, customerId) {
  if (!ASAAS_API_KEY) {
    throw new Error('ASAAS_API_KEY não configurada nas variáveis de ambiente do servidor.');
  }

  const body = customerId
    ? { customer: customerId, state }
    : { cpfCnpj, state };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s, conforme recomendação oficial da Asaas

  let resp;
  try {
    resp = await fetch(`${ASAAS_BASE_URL}/creditBureauReport`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'access_token': ASAAS_API_KEY,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('A consulta ao Serasa Experian excedeu 30 segundos. Tente novamente.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`Asaas retornou ${resp.status} ao consultar o Serasa: ${errBody}`);
  }

  const data = await resp.json();
  // data esperado: { id, dateCreated, cpfCnpj, state, customer, downloadUrl, reportFile (base64) }

  let textoRelatorio = '';
  if (data.reportFile) {
    try {
      const pdfBuffer = Buffer.from(data.reportFile, 'base64');
      const parsed = await pdfParse(pdfBuffer);
      textoRelatorio = (parsed.text || '').toLowerCase();
    } catch (err) {
      // Se o PDF não puder ser lido, não travamos o checkout silenciosamente —
      // melhor liberar com um aviso do que bloquear por um erro de leitura nosso.
      return {
        bloqueado: false,
        motivo: 'Não foi possível ler o relatório automaticamente. Revise manualmente: ' + data.downloadUrl,
        downloadUrl: data.downloadUrl,
        consultaId: data.id,
      };
    }
  }

  const termoEncontrado = buscarTermoRestricao(textoRelatorio);

  return {
    bloqueado: !!termoEncontrado,
    motivo: termoEncontrado
      ? `Indício de restrição encontrado no relatório: "${termoEncontrado}".`
      : 'Nenhuma restrição ou protesto identificado no relatório.',
    downloadUrl: data.downloadUrl,
    consultaId: data.id,
  };
}

// ------------------------------------------------------------
// Handler da rota serverless (Vercel: /api/verificar-restricao-cnpj)
// ------------------------------------------------------------
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const { cpfCnpj, state, customerId } = req.body || {};
  if (!state || (!cpfCnpj && !customerId)) {
    return res.status(400).json({ error: 'Informe "state" e ("cpfCnpj" ou "customerId").' });
  }

  try {
    const resultado = await verificarRestricaoCnpj(cpfCnpj, state, customerId);
    return res.status(200).json(resultado);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};

// Exportado também como função pura, pra poder testar sem precisar do handler HTTP
module.exports.verificarRestricaoCnpj = verificarRestricaoCnpj;
module.exports.buscarTermoRestricao = buscarTermoRestricao;
module.exports.PALAVRAS_RESTRICAO = PALAVRAS_RESTRICAO;
