/**
 * push/sw.js — service worker mínimo de Web Push (scope /push/).
 *
 * Independiente de ngsw (scope /): el PWA registra los dos (ver
 * docs/ARCHITECTURE.md, D27). VIVE EN public/ para que el build de Angular
 * lo copie a la raíz de dist y Express lo sirva en /push/sw.js.
 *
 * Contrato del payload (lo envía apps/api/src/push/webpush.js):
 *   JSON {title, body, icon, url, data}
 */
/* global self */

self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (e) {
        payload = { body: event.data ? event.data.text() : '' };
    }
    event.waitUntil(
        self.registration.showNotification(payload.title || 'yi-nvr', {
            body: payload.body || '',
            icon: payload.icon || '/icons/icon-192x192.png',
            badge: '/icons/icon-192x192.png',
            data: { url: payload.url || '/' }
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((windows) => {
                for (const win of windows) {
                    if ('focus' in win) {
                        win.focus();
                        win.navigate(url);
                        return;
                    }
                }
                return self.clients.openWindow(url);
            })
    );
});
