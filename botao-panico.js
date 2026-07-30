/**
 * ============================================================
 * SHIELD — BOTÃO DE PÂNICO (acionamento por 3 segundos seguros)
 * ============================================================
 * Exige pressionar e SEGURAR por 3 segundos, não um simples toque —
 * evita acionamento acidental (bolso, criança mexendo no celular, etc.)
 * mantendo o acionamento rápido o bastante numa emergência real.
 *
 * Uso (dentro do dashboard do prestador):
 *   inicializarBotaoPanico({
 *     elementoId: 'botaoPanico',
 *     duracaoMs: 3000,
 *     onAcionar: async () => {
 *       const pos = await new Promise((resolve, reject) =>
 *         navigator.geolocation.getCurrentPosition(resolve, reject)
 *       );
 *       const resp = await fetch('/api/acionar-panico', {
 *         method: 'POST',
 *         headers: { 'Content-Type': 'application/json' },
 *         body: JSON.stringify({
 *           providerId: window.CURRENT_PROVIDER_ID,
 *           latitude: pos.coords.latitude,
 *           longitude: pos.coords.longitude,
 *         }),
 *       });
 *       if (!resp.ok) throw new Error('Falha ao acionar pânico');
 *     },
 *   });
 * ============================================================
 */

function inicializarBotaoPanico({ elementoId, duracaoMs = 3000, onAcionar, onProgresso, onCancelado, onSucesso, onErro }) {
  const el = document.getElementById(elementoId);
  if (!el) throw new Error(`Elemento #${elementoId} não encontrado.`);

  let inicioPressao = null;
  let animFrame = null;
  let acionando = false;
  let jaAcionou = false;

  function tick() {
    if (inicioPressao === null) return;
    const decorrido = Date.now() - inicioPressao;
    const progresso = Math.min(decorrido / duracaoMs, 1);
    if (onProgresso) onProgresso(progresso);

    if (progresso >= 1 && !jaAcionou) {
      jaAcionou = true;
      disparar();
      return;
    }
    animFrame = requestAnimationFrame(tick);
  }

  async function disparar() {
    acionando = true;
    try {
      await onAcionar();
      if (onSucesso) onSucesso();
    } catch (e) {
      if (onErro) onErro(e);
    } finally {
      acionando = false;
      resetar();
    }
  }

  function resetar() {
    inicioPressao = null;
    jaAcionou = false;
    if (animFrame) cancelAnimationFrame(animFrame);
    animFrame = null;
    if (onProgresso) onProgresso(0);
  }

  function onPressStart(e) {
    e.preventDefault();
    if (acionando) return; // já em andamento, ignora nova pressão
    inicioPressao = Date.now();
    jaAcionou = false;
    animFrame = requestAnimationFrame(tick);
  }

  function onPressEnd() {
    if (acionando) return; // já disparou e está processando - não cancela no meio
    if (inicioPressao !== null && !jaAcionou) {
      if (onCancelado) onCancelado();
    }
    resetar();
  }

  el.addEventListener('pointerdown', onPressStart);
  el.addEventListener('pointerup', onPressEnd);
  el.addEventListener('pointerleave', onPressEnd);
  el.addEventListener('pointercancel', onPressEnd);

  // Expõe uma forma de "desligar" o botão (ex: se o prestador sair da tela)
  return function destruir() {
    el.removeEventListener('pointerdown', onPressStart);
    el.removeEventListener('pointerup', onPressEnd);
    el.removeEventListener('pointerleave', onPressEnd);
    el.removeEventListener('pointercancel', onPressEnd);
    resetar();
  };
}

if (typeof module !== 'undefined') {
  module.exports = { inicializarBotaoPanico };
}
