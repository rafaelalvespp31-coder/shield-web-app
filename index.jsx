import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Shield, User, X, Wrench, Check, Loader2 } from 'lucide-react';
import Login from './Login';
import CadastroPrestadorVinculado from './CadastroPrestadorVinculado';

// TODO: importe os modais e dashboards que já existem no seu projeto
// import { CadastroClienteModal, CadastroPrestadorModal, CadastroEmpresaModal } from './cadastros';
// import { ClientDashboard, ProviderDashboard, EmpresaDashboard, PrestadorVinculadoDashboard } from './dashboards';

const sb = createClient(
  'https://xnnhhhsxoaprgvfvqaak.supabase.co',
  'sb_publishable_QzFnirQmvpN4WVwxiBBVeg_zVMNC7O1'
);

const CATEGORIAS = [
  'Segurança Pessoal',
  'Escolta Armada',
  'Motorista Blindado',
  'Segurança Residencial',
  'Segurança de Evento',
  'Monitoramento 24h',
];

// ------------------------------------------------------------
// Componentes Visuais & Fundo Tecnológico
// ------------------------------------------------------------
function CircuitBackground() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <svg className="absolute inset-0 w-full h-full opacity-[0.18]" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="circuit" width="120" height="120" patternUnits="userSpaceOnUse">
            <path d="M10 10 H60 V50 H110 M60 10 V60 M10 60 H40 V110 M80 60 H110 V90 H60 V120"
              stroke="#2dd4c8" strokeWidth="1" fill="none" />
            <circle cx="10" cy="10" r="2.5" fill="#2dd4c8" />
            <circle cx="60" cy="50" r="2.5" fill="#2dd4c8" />
            <circle cx="110" cy="10" r="2.5" fill="#2dd4c8" />
            <circle cx="40" cy="110" r="2.5" fill="#2dd4c8" />
            <circle cx="60" cy="120" r="2.5" fill="#2dd4c8" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#circuit)" />
      </svg>
      <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-[500px] h-[500px] rounded-full bg-cyan-500/10 blur-3xl" />
    </div>
  );
}

function ShieldBadge({ active, size = 'lg', tone = 'teal' }) {
  const isLg = size === 'lg';
  const ring = tone === 'teal' 
    ? 'from-cyan-300 via-cyan-500 to-slate-700' 
    : tone === 'gold' 
    ? 'from-yellow-200 via-yellow-500 to-yellow-800'
    : 'from-emerald-300 via-emerald-500 to-slate-700';
  
  const glow = tone === 'teal' 
    ? 'shadow-[0_0_40px_rgba(45,212,200,0.55)]' 
    : tone === 'gold' 
    ? 'shadow-[0_0_40px_rgba(240,196,25,0.55)]'
    : 'shadow-[0_0_40px_rgba(52,211,153,0.55)]';

  return (
    <div className={`relative ${isLg ? 'w-32 h-32' : 'w-12 h-12'} rounded-full bg-gradient-to-br ${ring} p-[3px] ${active ? glow : 'opacity-70'} transition-all duration-300`}>
      <div className="w-full h-full rounded-full bg-slate-900 flex items-center justify-center relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-slate-700/40 to-transparent" />
        <Shield className={isLg ? 'w-12 h-12' : 'w-5 h-5'} strokeWidth={1.5} color={tone === 'teal' ? '#7dd3fc' : tone === 'gold' ? '#fde68a' : '#6ee7b7'} />
        <User className={`absolute ${isLg ? 'w-6 h-6' : 'w-2.5 h-2.5'}`} strokeWidth={1.5} color={tone === 'teal' ? '#e0f2fe' : tone === 'gold' ? '#fff7d6' : '#a7f3d0'} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Configuração dos Tons para os 4 Papéis
// ------------------------------------------------------------
const TONS = {
  cliente: { grad: 'from-cyan-300 to-cyan-600', border: 'border-cyan-200/40', label: 'SOU CLIENTE', toneKey: 'teal' },
  prestador: { grad: 'from-yellow-300 to-yellow-600', border: 'border-yellow-200/40', label: 'PRESTADOR AUTÔNOMO', toneKey: 'gold' },
  empresa: { grad: 'from-amber-400 to-amber-700', border: 'border-amber-200/40', label: 'EMPRESA PARCEIRA', toneKey: 'gold' },
  vinculado: { grad: 'from-emerald-400 to-emerald-700', border: 'border-emerald-200/40', label: 'VIGILANTE VINCULADO', toneKey: 'emerald' },
};

function BotaoEntrada({ role, onEscolher }) {
  const t = TONS[role];
  return (
    <button
      onClick={() => onEscolher(role)}
      className={`py-3 rounded-xl font-bold text-slate-900 bg-gradient-to-b ${t.grad} border ${t.border} shadow-md active:translate-y-0.5 active:shadow-none transition w-full`}
      style={{ fontFamily: 'Orbitron, sans-serif' }}
    >
      {t.label}
    </button>
  );
}

// ------------------------------------------------------------
// TELA INICIAL / APP RAIZ
// ------------------------------------------------------------
export default function App() {
  const [role, setRole] = useState('cliente');          // 'cliente' | 'prestador' | 'empresa' | 'vinculado'
  const [modal, setModal] = useState(null);             // 'cadastro' | 'login' | null
  const [screen, setScreen] = useState('home');         // 'home' | dashboards...
  const [currentUserId, setCurrentUserId] = useState(null);
  const [companyId, setCompanyId] = useState(null);
  const [vinculoInfo, setVinculoInfo] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = (msg) => setToast(msg);

  const abrirCadastro = (roleEscolhido) => { setRole(roleEscolhido); setModal('cadastro'); };
  const abrirLogin = (roleEscolhido) => { setRole(roleEscolhido); setModal('login'); };

  const onLoginSuccess = (resultado) => {
    setCurrentUserId(resultado.userId);
    setModal(null);
    setScreen(resultado.screen);
    if (resultado.screen === 'empresaDashboard' && resultado.extra) setCompanyId(resultado.extra.companyId);
    if (resultado.screen === 'prestadorVinculadoDashboard' && resultado.extra) setVinculoInfo(resultado.extra);
    if (resultado.aviso) showToast(resultado.aviso);
  };

  // Roteamento de Dashboards (descomente conforme importar os reais)
  // if (screen === 'clientDashboard') return <ClientDashboard onBack={() => setScreen('home')} />;
  // if (screen === 'providerDashboard') return <ProviderDashboard onBack={() => setScreen('home')} />;
  // if (screen === 'empresaDashboard') return <EmpresaDashboard companyId={companyId} onBack={() => setScreen('home')} />;
  // if (screen === 'prestadorVinculadoDashboard') return <PrestadorVinculadoDashboard vinculoInfo={vinculoInfo} onBack={() => setScreen('home')} />;

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-[#03110f] via-[#04201c] to-[#020a09] flex items-center justify-center p-4 relative">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800&display=swap');
        @keyframes slideUp { from { transform: translateY(24px); opacity:0 } to { transform: translateY(0); opacity:1 } }
        @keyframes floatY { 0%,100%{ transform: translateY(0) } 50%{ transform: translateY(-6px) } }
      `}</style>
      <CircuitBackground />

      <div className="relative w-full max-w-sm rounded-3xl border border-cyan-500/30 bg-slate-950/70 backdrop-blur-md shadow-[0_0_60px_rgba(0,0,0,0.6)] px-6 py-8">
        <div className="flex justify-center mb-4" style={{ animation: 'floatY 4s ease-in-out infinite' }}>
          <ShieldBadge active tone={TONS[role]?.toneKey || 'teal'} />
        </div>

        <h1 
          className="text-center text-2xl font-extrabold tracking-wide bg-gradient-to-r from-cyan-300 to-cyan-500 bg-clip-text text-transparent mb-6"
          style={{ fontFamily: 'Orbitron, sans-serif' }}
        >
          Escolha sua Função
        </h1>

        <div className="flex flex-col gap-3">
          <BotaoEntrada role="cliente" onEscolher={abrirLogin} />
          <BotaoEntrada role="prestador" onEscolher={abrirLogin} />
          <BotaoEntrada role="empresa" onEscolher={abrirLogin} />
          <BotaoEntrada role="vinculado" onEscolher={abrirLogin} />
        </div>

        <p className="text-center text-slate-400 text-xs mt-6">
          Ainda não tem conta? Cadastre-se abaixo:
        </p>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <button onClick={() => abrirCadastro('cliente')} className="text-xs py-2 rounded-lg border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/10 transition">Cliente</button>
          <button onClick={() => abrirCadastro('prestador')} className="text-xs py-2 rounded-lg border border-yellow-500/30 text-yellow-300 hover:bg-yellow-500/10 transition">Prestador</button>
          <button onClick={() => abrirCadastro('empresa')} className="text-xs py-2 rounded-lg border border-amber-500/30 text-amber-300 hover:bg-amber-500/10 transition">Empresa</button>
          <button onClick={() => abrirCadastro('vinculado')} className="text-xs py-2 rounded-lg border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10 transition">Vig. Vinculado</button>
        </div>
      </div>

      {/* ---------------------- CADASTROS ---------------------- */}
      {modal === 'cadastro' && role === 'vinculado' && (
        <CadastroPrestadorVinculado
          sb={sb}
          onClose={() => setModal(null)}
          onSuccess={(nomeEmpresa) => showToast(`Cadastro enviado! Aguardando aprovação de ${nomeEmpresa}.`)}
        />
      )}

      {/* ---------------------- LOGIN ÚNICO ---------------------- */}
      {modal === 'login' && (
        <Login
          sb={sb}
          tone={TONS[role]?.toneKey}
          roleClicado={role}
          onClose={() => setModal(null)}
          onLoginSuccess={onLoginSuccess}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 border border-cyan-500/40 text-cyan-200 text-sm px-4 py-2 rounded-full shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}