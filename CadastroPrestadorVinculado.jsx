/**
 * ============================================================
 * SHIELD — CadastroPrestadorVinculado.jsx
 * ============================================================
 * Cadastro dedicado para o Vigilante VINCULADO a uma empresa parceira —
 * entrada própria na tela inicial, com o tom esmeralda do Painel da
 * Empresa (dashboard_empresa.html: #10b981 / #34d399 / #6ee7b7, fundo
 * #060f0d), diferente do dourado do prestador autônomo e do teal do
 * cliente.
 *
 * Diferença chave em relação ao CadastroPrestadorModal genérico: aqui
 * o campo "Código da Empresa" é OBRIGATÓRIO (não uma opção com
 * checkbox) — porque quem entra por essa porta já sabe que vai
 * trabalhar vinculado a uma empresa parceira.
 *
 * O código é o mesmo gerado pela empresa em gerar_token_convite_empresa()
 * (ex: "SNT-7X29") — validado AO VIVO (ao digitar, com debounce) contra
 * o banco, mostrando o nome da empresa antes mesmo de enviar o formulário.
 *
 * Uso (dentro do App.jsx):
 *   import CadastroPrestadorVinculado from './CadastroPrestadorVinculado';
 *
 *   {modal === 'cadastroVinculado' && (
 *     <CadastroPrestadorVinculado
 *       sb={sb}
 *       onClose={() => setModal(null)}
 *       onSuccess={(empresaNome) => showToast(`Cadastro enviado! Aguardando aprovação de ${empresaNome}.`)}
 *     />
 *   )}
 * ============================================================
 */

import React, { useState, useRef } from 'react';
import { validarCodigoEmpresa, cadastrarPrestadorVinculado } from './auth';

const CATEGORIAS_DISPONIVEIS = [
  'Lojas', 'Mercados', 'Eventos', 'Galpão', 'Apoio', 'Bar/Restaurante', 'Portaria',
];

// Paleta esmeralda emprestada do dashboard_empresa.html
const EMERALD = {
  border: 'border-emerald-500/40',
  text: 'text-emerald-300',
  textLight: 'text-emerald-200',
  bg: 'bg-[#060f0d]',
  gradBtn: 'from-emerald-400 to-emerald-700',
  fieldBorder: 'border-emerald-800 focus:border-emerald-400',
};

function CampoCodigoEmpresa({ value, onChange, status, empresaNome, error }) {
  return (
    <div className="mb-4">
      <span className="text-xs text-emerald-200/70 mb-1 block">Código da Empresa</span>
      <input
        value={value}
        onChange={onChange}
        placeholder="Ex: SNT-7X29"
        className={`w-full bg-[#0a1e1a] border ${EMERALD.fieldBorder} outline-none rounded-lg px-3 py-2.5 text-sm text-white placeholder-emerald-800 uppercase tracking-wide`}
      />
      {status === 'checando' && (
        <p className="text-[11px] text-emerald-400/70 mt-1">Verificando código...</p>
      )}
      {status === 'valido' && (
        <p className="text-[11px] text-emerald-400 mt-1">✓ Código válido — vínculo com {empresaNome}</p>
      )}
      {status === 'invalido' && (
        <p className="text-[11px] text-red-400 mt-1">{error}</p>
      )}
      <p className="text-[11px] text-emerald-200/40 mt-1">
        Peça esse código para o responsável da empresa parceira onde você vai atuar.
      </p>
    </div>
  );
}

export default function CadastroPrestadorVinculado({ sb, onClose, onSuccess }) {
  const [step, setStep] = useState(0); // 0: dados, 1: categorias, 2: código da empresa + envio
  const [form, setForm] = useState({ nome: '', email: '', telefone: '', cpfCnpj: '', senha: '', bio: '' });
  const [categorias, setCategorias] = useState([]);
  const [codigoEmpresa, setCodigoEmpresa] = useState('');
  const [statusCodigo, setStatusCodigo] = useState('idle'); // idle | checando | valido | invalido
  const [empresaNome, setEmpresaNome] = useState(null);
  const [erroCodigo, setErroCodigo] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const debounceRef = useRef(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const toggleCategoria = (cat) => {
    setCategorias((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]));
  };

  const validarCodigoAoVivo = (valor) => {
    setCodigoEmpresa(valor);
    setStatusCodigo('idle');
    setErroCodigo(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!valor.trim()) return;

    debounceRef.current = setTimeout(async () => {
      setStatusCodigo('checando');
      const resultado = await validarCodigoEmpresa(sb, valor);
      if (resultado.valido) {
        setStatusCodigo('valido');
        setEmpresaNome(resultado.empresaNome);
      } else {
        setStatusCodigo('invalido');
        setErroCodigo({
          codigo_invalido: 'Código não encontrado. Confira com a empresa.',
          codigo_ja_utilizado_ou_revogado: 'Esse código já foi usado ou foi cancelado.',
          codigo_expirado: 'Esse código expirou. Peça um novo.',
        }[resultado.motivo] || 'Não foi possível validar agora.');
      }
    }, 500); // debounce: espera meio segundo sem digitar antes de validar
  };

  const validateStep = () => {
    const e = {};
    if (step === 0) {
      if (!form.nome.trim()) e.nome = 'Informe seu nome completo';
      if (!/^\S+@\S+\.\S+$/.test(form.email)) e.email = 'E-mail inválido';
      if (form.telefone.replace(/\D/g, '').length < 10) e.telefone = 'Telefone inválido';
      if (![11, 14].includes(form.cpfCnpj.replace(/\D/g, '').length)) e.cpfCnpj = 'CPF/CNPJ inválido';
      if (form.senha.length < 6) e.senha = 'Mínimo de 6 caracteres';
    }
    if (step === 1 && categorias.length === 0) e.categorias = 'Selecione ao menos uma categoria';
    if (step === 2 && statusCodigo !== 'valido') e.codigo = 'Informe um código de empresa válido';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const next = () => { if (validateStep()) setStep((s) => s + 1); };
  const voltar = () => setStep((s) => Math.max(0, s - 1));

  const submit = async () => {
    if (!validateStep()) return;
    setSaving(true);
    try {
      const resultado = await cadastrarPrestadorVinculado(sb, {
        nome: form.nome, email: form.email, telefone: form.telefone, cpfCnpj: form.cpfCnpj,
        senha: form.senha, bio: form.bio, codigoEmpresa, categorias,
      });
      if (!resultado.success) {
        setErrors({ geral: resultado.error });
        return;
      }
      setDone(true);
      setTimeout(() => { onSuccess?.(resultado.empresaNome); onClose(); }, 1200);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-4">
      <div className={`w-full sm:max-w-md max-h-[90vh] overflow-y-auto rounded-t-3xl sm:rounded-2xl ${EMERALD.bg} border ${EMERALD.border} p-6 relative`}>
        <button onClick={onClose} className="absolute top-4 right-4 text-emerald-200/50 hover:text-white">✕</button>
        <h2 className={`text-xl font-bold mb-1 ${EMERALD.text}`}>Cadastro — Vigilante Vinculado</h2>
        <p className="text-xs text-emerald-200/50 mb-5">Para profissionais que atuam através de uma empresa parceira ShielD</p>

        {done ? (
          <div className="py-8 text-center">
            <div className="text-4xl mb-2">✓</div>
            <p className={EMERALD.textLight}>Cadastro enviado! Aguardando aprovação de {empresaNome}.</p>
          </div>
        ) : (
          <>
            {step === 0 && (
              <div>
                {['nome', 'email', 'telefone', 'cpfCnpj', 'senha'].map((campo) => (
                  <label className="block mb-3" key={campo}>
                    <span className="text-xs text-emerald-200/70 mb-1 block">
                      {{ nome: 'Nome completo', email: 'E-mail', telefone: 'Telefone', cpfCnpj: 'CPF/CNPJ', senha: 'Senha' }[campo]}
                    </span>
                    <input
                      type={campo === 'senha' ? 'password' : campo === 'email' ? 'email' : 'text'}
                      value={form[campo]}
                      onChange={set(campo)}
                      className={`w-full bg-[#0a1e1a] border ${EMERALD.fieldBorder} outline-none rounded-lg px-3 py-2.5 text-sm text-white`}
                    />
                    {errors[campo] && <p className="text-red-400 text-xs mt-1">{errors[campo]}</p>}
                  </label>
                ))}
                <label className="block mb-3">
                  <span className="text-xs text-emerald-200/70 mb-1 block">Experiência / Bio</span>
                  <textarea
                    value={form.bio} onChange={set('bio')} rows={2}
                    className={`w-full bg-[#0a1e1a] border ${EMERALD.fieldBorder} outline-none rounded-lg px-3 py-2 text-sm text-white`}
                  />
                </label>
                <button onClick={next} className={`w-full mt-2 py-3 rounded-lg font-bold text-slate-900 bg-gradient-to-b ${EMERALD.gradBtn}`}>
                  Continuar
                </button>
              </div>
            )}

            {step === 1 && (
              <div>
                <span className="text-xs text-emerald-200/70 mb-2 block">Categorias de atendimento</span>
                <div className="grid grid-cols-2 gap-2 mb-4">
                  {CATEGORIAS_DISPONIVEIS.map((cat) => (
                    <button key={cat} type="button" onClick={() => toggleCategoria(cat)}
                      className={`text-xs px-2 py-2 rounded-lg border text-left transition ${
                        categorias.includes(cat)
                          ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200'
                          : 'bg-[#0a1e1a] border-emerald-900 text-emerald-200/50'
                      }`}>
                      {cat}
                    </button>
                  ))}
                </div>
                {errors.categorias && <p className="text-red-400 text-xs mb-2">{errors.categorias}</p>}
                <div className="flex gap-2">
                  <button onClick={voltar} className="flex-1 py-3 rounded-lg font-bold text-emerald-200 bg-[#0a1e1a] border border-emerald-800">Voltar</button>
                  <button onClick={next} className={`flex-1 py-3 rounded-lg font-bold text-slate-900 bg-gradient-to-b ${EMERALD.gradBtn}`}>Continuar</button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div>
                <CampoCodigoEmpresa
                  value={codigoEmpresa}
                  onChange={(e) => validarCodigoAoVivo(e.target.value)}
                  status={statusCodigo}
                  empresaNome={empresaNome}
                  error={erroCodigo}
                />
                {errors.codigo && <p className="text-red-400 text-xs mb-2">{errors.codigo}</p>}
                {errors.geral && <p className="text-red-400 text-xs mb-2">{errors.geral}</p>}
                <div className="flex gap-2">
                  <button onClick={voltar} className="flex-1 py-3 rounded-lg font-bold text-emerald-200 bg-[#0a1e1a] border border-emerald-800">Voltar</button>
                  <button
                    onClick={submit}
                    disabled={saving || statusCodigo !== 'valido'}
                    className={`flex-1 py-3 rounded-lg font-bold text-slate-900 bg-gradient-to-b ${EMERALD.gradBtn} disabled:opacity-50`}
                  >
                    {saving ? 'Enviando...' : 'Enviar Cadastro'}
                  </button>
                </div>
                <p className="text-[11px] text-emerald-200/40 mt-3">
                  Seu cadastro fica pendente até a empresa aprovar o vínculo.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
