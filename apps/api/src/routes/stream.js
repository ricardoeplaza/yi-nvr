/**
 * routes/stream.js
 *
 * Router de la API para el live view (se monta en /api).
 *
 * Endpoints:
 *  - GET /cameras/:id/stream - URLs de streaming (WebRTC + MSE) vía go2rtc
 *
 * Las URLs devueltas son RELATIVAS al proxy /stream-proxy (go2rtc proxied
 * dentro de Express), de modo que el navegador habla siempre con el puerto
 * 3000 y go2rtc queda tras el proxy (sin exponer su puerto).
 */

const express = require('express');
const registry = require('../camera-registry');

const router = express.Router();

/**
 * GET /api/cameras/:id/stream
 *
 * Si la cámara existe en el registry:
 *   200 {success, src, webrtc_url, mse_url}
 * Si no existe:
 *   404 {success:false, error}
 */
router.get('/cameras/:id/stream', (req, res) => {
    const camera = registry.getCameraById(req.params.id);
    if (!camera) {
        return res.status(404).json({
            success: false,
            error: `cámara "${req.params.id}" no encontrada`
        });
    }

    res.json({
        success: true,
        src: camera.id,
        webrtc_url: `/stream-proxy/api/webrtc?src=${camera.id}`,
        mse_url: `/stream-proxy/api/stream.mp4?src=${camera.id}`
    });
});

module.exports = router;
