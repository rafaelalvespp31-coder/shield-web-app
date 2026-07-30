/**
 * ============================================================
 * SHIELD — Login.jsx
 * ============================================================
 * Substitui o LoginModal que hoje vive embutido dentro do App.tsx
 * (index.html). Mesma aparência (usa os mesmos componentes Modal,
 * Field, PasswordField, AngledButton já existentes no projeto),
 * mas o redirecionamento agora vem de `auth.js` (baseado no
 * profiles.role do banco), não do botão que a pessoa clicou.
 *
 * Uso (dentro do App.jsx, no lugar do antigo <LoginModal ... />):
 *
 *   import Login from './Login';
 *
 *   {modal === 'login' && (
 *     <Login
 *       sb={sb}
 *       tone={tone}                 // só estética: 'teal' | 'gold' | 'empresa'
 *       roleClicado={role}          // 'cliente' | 'prestador' | 'empresa' — só pra exibir o aviso, não decide o destino
 *       onClose={() => setModal(null)}
 *       onLoginSuccess={(resultado) => {
 *         setCurrentUserId(resultado.userId);
 *         setModal(null);
 *         setScreen(resultado.screen);
 *         if (resultado.screen === 'empresaDashboard') setCompanyId(resultado.extra.companyId);
 *         if (resultado.screen === 'prestadorVinculadoDashboard') setVinculoInfo(resultado.extra);
 *         if (resultado.aviso) showToast(resultado.aviso);
 *       }}
 *     />
 *   )}
 *
 * Depende de: Modal, Field, PasswordField, AngledButton (já existentes
 * no projeto) e da função `login` de auth.js.
 * ============================================================
 */

import React, { useState } from 'react';
import { login } from './auth';

const TITULOS_POR_TONE = {
  gold: 'Entrar como Prestador',
  empresa: 'Entrar como Empresa',
  teal: 'Entrar como Cliente',
  vinculado: 'Entrar como Vigilante Vinculado',
};

export default function Login({ sb, tone = 'teal', roleClicado, onClose, onLoginSuccess }) {
  const [form, setForm] = useState({ email: '', senha: '' });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();

    const errs = {};
    if (!/^\S+@\S+\.\S+$/.test(form.email)) errs.email = 'E-mail inválido';
    if (form.senha.length < 1) errs.senha = 'Informe sua senha';
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setLoading(true);
    try {
      const resultado = await login(sb, { email: form.email, senha: form.senha, roleClicado });
      if (!resultado.success) {
        setErrors({ senha: resultado.error });
        return;
      }
      onLoginSuccess(resultado);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal tone={tone} title={TITULOS_POR_TONE[tone] || 'Entrar'} onClose={onClose}>
      <form onSubmit={submit}>
        <Field
          label="E-mail"
          type="email"
          value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          error={errors.email}
          placeholder="voce@email.com"
        />
        <PasswordField
          label="Senha"
          value={form.senha}
          onChange={(e) => setForm((f) => ({ ...f, senha: e.target.value }))}
        />
        {errors.senha && <p className="text-red-400 text-xs -mt-2 mb-3">{errors.senha}</p>}
        <AngledButton tone={tone} type="submit" disabled={loading}>
          {loading ? 'Entrando...' : 'Entrar'}
        </AngledButton>
      </form>
    </Modal>
  );
}
