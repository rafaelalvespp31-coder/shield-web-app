// ============================================================
// SERVICE WORKER - SHIELD
// Fica registrado no navegador do usuário e continua rodando
// (dentro do processo do navegador) mesmo com o site fechado.
// É isso que recebe o push do servidor e mostra a notificação.
//
// IMPORTANTE: precisa estar na RAIZ do site (mesma pasta do
// index.html), servido em https://seudominio.com/sw.js - não
// funciona se ficar dentro de uma subpasta.
// ============================================================

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Chega aqui quando o servidor (nossa Edge Function) dispara um push.
self.addEventListener('push', (event) => {
  let dados = {};
  try {
    dados = event.data ? event.data.json() : {};
  } catch (e) {
    dados = { title: 'ShielD', body: event.data ? event.data.text() : 'Você tem uma nova atualização.' };
  }

  const titulo = dados.title || 'ShielD';
  const opcoes = {
    body: dados.body || '',
    icon: dados.icon || '/icon-192.png',
    badge: dados.badge || '/icon-192.png',
    tag: dados.tag || 'shield-notificacao',
    renotify: true,
    data: { url: dados.url || '/' },
    vibrate: [120, 60, 120],
  };

  event.waitUntil(self.registration.showNotification(titulo, opcoes));
});

// Clique na notificação: foca uma aba já aberta do site, ou abre uma nova.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlAlvo = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((janelas) => {
      for (const janela of janelas) {
        if ('focus' in janela) {
          janela.focus();
          if ('navigate' in janela) janela.navigate(urlAlvo);
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(urlAlvo);
    })
  );
});
