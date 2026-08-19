/**
 * routes/push.js
 *
 * Router de la API para las suscripciones Web Push (se monta en /api).
 *
 * Endpoints:
 *  - GET /push/vapid-public-key - Clave pública VAPID (o null si no está
 *    configurada; el frontend la usa para suscribirse con PushManager)
 *  - POST /push/subscribe - Suscribe un PushSubscription estándar
 *    ({endpoint, expirationTime, keys: {p256dh, auth}}). Éxito: 201.
 *  - POST /push/unsubscribe - Quita una suscripción por endpoint
 *
 * Errores de validación: 400 {success:false, error}.
 */

const express = require('express');
const webpush = require('../push/webpush');

const router = express.Router();

/**
 * GET /api/push/vapid-public-key
 *
 * Devuelve la clave pública VAPID para que el navegador pueda suscribirse.
 * Si VAPID no está configurado (dev), devuelve null (el frontend degrada a
 * "sin notificaciones").
 */
router.get('/push/vapid-public-key', (req, res) => {
    res.json({
        success: true,
        publicKey: webpush.getPublicKey()
    });
});

/**
 * POST /api/push/subscribe
 *
 * Cuerpo: PushSubscription JSON estándar del navegador:
 * {"endpoint": "https://fcm.googleapis.com/...", "expirationTime": null,
 *  "keys": {"p256dh": "<base64url>", "auth": "<base64url>"}}
 * Opcional: userAgent (se guarda para diagnóstico).
 * Éxito: 201 {success:true}. Sin endpoint/keys: 400 {success:false, error}.
 */
router.post('/push/subscribe', (req, res) => {
    const sub = req.body || {};
    if (!sub.endpoint || !sub.keys) {
        return res.status(400).json({ success: false, error: 'falta "endpoint" y/o "keys" en la suscripción' });
    }
    try {
        webpush.subscribe(sub);
        res.status(201).json({ success: true });
    } catch (error) {
        res.status(error.status || 400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/push/unsubscribe
 *
 * Cuerpo: {"endpoint": "https://fcm.googleapis.com/..."}
 * Éxito: {success:true} (idempotente: no falla si el endpoint no existe).
 */
router.post('/push/unsubscribe', (req, res) => {
    const { endpoint } = req.body || {};
    if (!endpoint) {
        return res.status(400).json({ success: false, error: 'falta "endpoint"' });
    }
    try {
        webpush.unsubscribe(endpoint);
        res.json({ success: true });
    } catch (error) {
        res.status(error.status || 400).json({ success: false, error: error.message });
    }
});

module.exports = router;
