/**
 * ============================================================
 * SHIELD — PROCESSAMENTO PÓS-SERVIÇO (Lastro em D+7 via Asaas)
 * ============================================================
 * Função serverless (Vercel /api). Precisa rodar no servidor porque usa
 * a chave secreta do Asaas.
 *
 * Fluxo:
 *   1) Empresa parceira anexa a Nota Fiscal do serviço concluído.
 *   2) Esta função (a) simula a antecipação pra saber se documentação é
 *      obrigatória, e (b) envia a cobrança + a NF pro endpoint oficial
 *      de antecipação da Asaas.
 *   3) A Asaas analisa (crédito) e, se aprovado, injeta o valor na conta
 *      master. O Split de Pagamento que já foi configurado na cobrança
 *      original (ver pricing_engine.js / montarSplitAsaas) direciona a
 *      fatia da empresa parceira pra subconta dela automaticamente.
 *
 * ------------------------------------------------------------
 * DETALHES REAIS DA API (verificados em docs.asaas.com/reference/
 * solicitar-antecipacao) — pontos importantes:
 *
 *  1) O endpoint É de fato feito pra receber o documento junto: o body
 *     tem os campos `payment` (ou `installment`) + `documents` (arquivo),
 *     via multipart/form-data. Isso confere com o que você descreveu.
 *
 *  2) Antes de enviar, existe um endpoint de SIMULAÇÃO
 *     (`/v3/anticipations/simulate`) que devolve `isDocumentationRequired`
 *     — usamos ele primeiro pra confirmar que a NF é realmente exigida
 *     pra essa cobrança específica, em vez de assumir sempre que sim.
 *
 *  3) Sobre o prazo "D+7": a documentação geral da Asaas fala em análise
 *     de crédito de até 2 dias úteis (cartão) ou 3 dias úteis (boleto)
 *     antes da liberação — não um prazo fixo de 7 dias. Um lastro de
 *     D+7 é uma margem de segurança segura (maior que o prazo típico de
 *     aprovação), mas não é um número que a própria Asaas garante
 *     contratualmente. Vale confirmar o SLA exato com o gerente de
 *     conta antes de prometer D+7 pros seus prestadores.
 *
 *  4) Cobranças com Split configurado têm regras próprias quando
 *     antecipadas — a Asaas tem uma página específica sobre isso
 *     ("Split em cobranças antecipadas") que vale revisar com atenção
 *     antes de ir pra produção, pois não é o split "padrão".
 * ------------------------------------------------------------
 */

const Busboy = require('busboy');
const FormData = require('form-data');

const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
const ASAAS_BASE_URL = process.env.ASAAS_ENV === 'production'
  ? 'https://api.asaas.com/v3'
  : 'https://api-sandbox.asaas.com/v3';

module.exports.config = {
  api: { bodyParser: false }, // precisamos do body cru pra fazer o parse multipart nós mesmos
};

/**
 * Extrai o campo `paymentId` e o arquivo (Nota Fiscal) de uma requisição
 * multipart/form-data, sem depender de nenhum framework externo além do busboy.
 */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    const fields = {};
    let fileBuffer = null;
    let fileName = null;
    let fileMime = null;

    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      fileName = info.filename;
      fileMime = info.mimeType;
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });
    bb.on('close', () => resolve({ fields, fileBuffer, fileName, fileMime }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

/**
 * Simula a antecipação pra descobrir se a documentação (NF-e/contrato)
 * é obrigatória pra essa cobrança específica.
 */
async function simularAntecipacao(paymentId) {
  const resp = await fetch(`${ASAAS_BASE_URL}/anticipations/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY },
    body: JSON.stringify({ payment: paymentId }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Falha ao simular antecipação (HTTP ${resp.status}): ${body}`);
  }
  return resp.json();
}

/**
 * Envia a cobrança + a Nota Fiscal pro endpoint real de antecipação da Asaas.
 */
async function solicitarAntecipacao(paymentId, fileBuffer, fileName, fileMime) {
  const form = new FormData();
  form.append('payment', paymentId);
  if (fileBuffer) {
    form.append('documents', fileBuffer, { filename: fileName || 'nota-fiscal.pdf', contentType: fileMime || 'application/pdf' });
  }

  const resp = await fetch(`${ASAAS_BASE_URL}/anticipations`, {
    method: 'POST',
    headers: { 'access_token': ASAAS_API_KEY, ...form.getHeaders() },
    body: form,
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(`Asaas recusou a antecipação (HTTP ${resp.status}): ${data ? JSON.stringify(data) : ''}`);
  }
  return data;
}

// ------------------------------------------------------------
// Handler da rota serverless (Vercel: /api/solicitar-antecipacao)
// ------------------------------------------------------------
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }
  if (!ASAAS_API_KEY) {
    return res.status(500).json({ error: 'ASAAS_API_KEY não configurada no servidor.' });
  }

  try {
    const { fields, fileBuffer, fileName, fileMime } = await parseMultipart(req);
    const paymentId = fields.paymentId;
    if (!paymentId) {
      return res.status(400).json({ error: 'Informe "paymentId" (ID da cobrança já criada no Asaas).' });
    }

    // 1) Simula primeiro, pra saber se a NF é realmente exigida
    const simulacao = await simularAntecipacao(paymentId);

    if (simulacao.isDocumentationRequired && !fileBuffer) {
      return res.status(400).json({
        error: 'Esta cobrança exige o envio da Nota Fiscal (ou contrato de prestação de serviço) para ser antecipada.',
        simulacao,
      });
    }

    // 2) Envia a antecipação de verdade, com a NF anexada (se houver)
    const resultado = await solicitarAntecipacao(paymentId, fileBuffer, fileName, fileMime);

    return res.status(200).json({
      success: true,
      antecipacao: resultado,
      simulacao,
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};

module.exports.simularAntecipacao = simularAntecipacao;
module.exports.solicitarAntecipacao = solicitarAntecipacao;
module.exports.parseMultipart = parseMultipart;
