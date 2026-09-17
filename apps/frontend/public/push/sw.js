/**
 * push/sw.js — service worker mínimo de Web Push.
 *
 * El PWA se sirve plano desde la raíz (/), así que este SW se sirve en
 * /push/sw.js (scope /push/). Independiente de ngsw (scope /): el PWA
 * registra los dos (ver docs/ARCHITECTURE.md, D27). VIVE EN public/ para
 * que el build de Angular lo copie a la raíz de dist y Express lo sirva en
 * /push/sw.js.
 *
 * Contrato del payload (lo envía apps/api/src/push/webpush.js):
 *   JSON {title, body, icon, image, url, data}
 * `icon` es el ícono pequeño de la app (o se usa el default); `image` es la
 * previsualización grande (thumbnail del clip) que Android renderiza en la
 * notificación (iOS la ignora). Al hacer clic se abre `data.url` tal cual.
 */
/* global self */

const ICON_URL = '/icons/icon-192x192.png';

// Títulos generados por el backend (apps/api/src/ftp.js y server.js) en
// español. Se traducen aquí según el idioma del navegador — mismo criterio
// de detección que la app (navigator.language, sin persistencia).
const TITLE_I18N = {
    'Movimiento': 'Motion',
    'Nuevo clip': 'New clip'
};

function translateTitle(title) {
    const lang = (self.navigator.language || 'es').toLowerCase();
    return lang.startsWith('en') ? (TITLE_I18N[title] ?? title) : title;
}

self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (e) {
        payload = { body: event.data ? event.data.text() : '' };
    }
    event.waitUntil(
        self.registration.showNotification(translateTitle(payload.title) || 'yi-nvr', {
            body: payload.body || '',
            icon: payload.icon || ICON_URL,
            image: payload.image || undefined,
            badge: ICON_URL,
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
