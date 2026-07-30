/**
 * ============================================================
 * SHIELD — FILA LOCAL DE GPS (Offline-First)
 * ============================================================
 * Pensado pro vigilante em rodovia/zona rural, onde o sinal cai com
 * frequência. Em vez de perder os pontos de GPS quando não há conexão,
 * eles ficam guardados no próprio navegador (IndexedDB) e são enviados
 * em lote assim que a conexão volta.
 *
 * Por que IndexedDB e não localStorage:
 *   - localStorage é síncrono (trava a thread a cada leitura/escrita) e
 *     tem limite baixo (~5-10MB) — arriscado numa viagem longa gerando
 *     ponto a cada poucos segundos por horas.
 *   - IndexedDB é assíncrono, aguenta MUITO mais dado, e já vem pronto
 *     em qualquer navegador (não precisa de biblioteca externa).
 *
 * Como usar (dentro do dashboard do prestador, depois do login real):
 *
 *   const fila = new FilaGpsOffline({
 *     providerId: window.CURRENT_PROVIDER_ID,
 *     enviarLote: async (pontos) => {
 *       const { error } = await window.sb.from('provider_location_pings').insert(
 *         pontos.map(p => ({
 *           provider_id: p.providerId,
 *           latitude: p.lat,
 *           longitude: p.lng,
 *           accuracy: p.accuracy,
 *           captured_at: new Date(p.timestamp).toISOString(),
 *           veio_da_fila_offline: p.veioDaFila,
 *         }))
 *       );
 *       if (error) throw error;
 *     },
 *   });
 *   fila.iniciarRastreamento(); // liga o watchPosition + o flush automático
 *   // fila.pararRastreamento(); // quando o prestador ficar offline/sair
 * ============================================================
 */

class FilaGpsOffline {
  /**
   * @param {Object} opts
   * @param {string} opts.providerId
   * @param {(pontos: Array) => Promise<void>} opts.enviarLote - função que manda o lote pro backend (deve lançar erro se falhar)
   * @param {number} [opts.intervaloFlushMs=15000] - de quanto em quanto tempo tenta esvaziar a fila
   * @param {number} [opts.tamanhoMaximoLote=200] - quantos pontos manda por vez, no máximo
   */
  constructor({ providerId, enviarLote, intervaloFlushMs = 15000, tamanhoMaximoLote = 200 }) {
    this.providerId = providerId;
    this.enviarLote = enviarLote;
    this.intervaloFlushMs = intervaloFlushMs;
    this.tamanhoMaximoLote = tamanhoMaximoLote;
    this.db = null;
    this.watchId = null;
    this.flushTimer = null;
    this.enviandoAgora = false; // evita duas tentativas de flush simultâneas
  }

  // ------------------------------------------------------------
  // Infraestrutura do IndexedDB
  // ------------------------------------------------------------
  _abrirBanco() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('shield_gps_queue', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('pontos')) {
          const store = db.createObjectStore('pontos', { keyPath: 'id', autoIncrement: true });
          store.createIndex('timestamp', 'timestamp');
        }
      };
      req.onsuccess = () => { this.db = req.result; resolve(this.db); };
      req.onerror = () => reject(req.error);
    });
  }

  async _salvarPonto(ponto) {
    const db = await this._abrirBanco();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pontos', 'readwrite');
      tx.objectStore('pontos').add(ponto);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async _lerPontosPendentes(limite) {
    const db = await this._abrirBanco();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pontos', 'readonly');
      const store = tx.objectStore('pontos');
      const index = store.index('timestamp');
      const resultado = [];
      const cursorReq = index.openCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && resultado.length < limite) {
          resultado.push(cursor.value);
          cursor.continue();
        } else {
          resolve(resultado);
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  async _removerPontos(ids) {
    const db = await this._abrirBanco();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pontos', 'readwrite');
      const store = tx.objectStore('pontos');
      ids.forEach((id) => store.delete(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Quantos pontos ainda estão esperando pra serem enviados (útil pra mostrar na UI, ex: "12 pontos pendentes"). */
  async contarPendentes() {
    const db = await this._abrirBanco();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pontos', 'readonly');
      const req = tx.objectStore('pontos').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ------------------------------------------------------------
  // Captura de posição (GPS)
  // ------------------------------------------------------------
  iniciarRastreamento() {
    if (!navigator.geolocation) {
      console.warn('[FilaGpsOffline] Geolocalização não suportada neste navegador.');
      return;
    }

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this._onNovaPosicao(pos),
      (err) => console.warn('[FilaGpsOffline] Erro ao obter posição:', err.message),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );

    // Assim que a conexão voltar, tenta esvaziar a fila imediatamente
    window.addEventListener('online', () => this.tentarEnviarFila());

    // Além do evento "online" (que nem sempre dispara de forma confiável em
    // celular), tenta de tempos em tempos também - rede "instável" costuma
    // parecer "online" pro navegador mesmo sem completar requisições.
    this.flushTimer = setInterval(() => this.tentarEnviarFila(), this.intervaloFlushMs);
  }

  pararRastreamento() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.watchId = null;
    this.flushTimer = null;
  }

  async _onNovaPosicao(pos) {
    const ponto = {
      providerId: this.providerId,
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      timestamp: pos.timestamp || Date.now(),
    };

    // Tenta mandar direto primeiro (caminho feliz: sinal bom, sem fila)
    try {
      await this.enviarLote([{ ...ponto, veioDaFila: false }]);
    } catch (e) {
      // Sem sinal / falha de rede -> guarda na fila local, sem perder o ponto
      await this._salvarPonto(ponto);
    }
  }

  // ------------------------------------------------------------
  // Envio em lote (flush da fila)
  // ------------------------------------------------------------
  async tentarEnviarFila() {
    if (this.enviandoAgora) return; // já tem um flush rodando, não duplica
    this.enviandoAgora = true;
    try {
      const pendentes = await this._lerPontosPendentes(this.tamanhoMaximoLote);
      if (!pendentes.length) return;

      const lote = pendentes.map((p) => ({
        providerId: p.providerId, lat: p.lat, lng: p.lng, accuracy: p.accuracy,
        timestamp: p.timestamp, veioDaFila: true,
      }));

      await this.enviarLote(lote);
      await this._removerPontos(pendentes.map((p) => p.id));
      return lote.length; // quantos pontos foram enviados com sucesso
    } catch (e) {
      // Ainda sem sinal (ou o backend recusou) - mantém tudo na fila pra próxima tentativa
      return 0;
    } finally {
      this.enviandoAgora = false;
    }
  }
}

if (typeof module !== 'undefined') {
  module.exports = { FilaGpsOffline };
}
