/**
 * camera/index.js
 *
 * Factory de adapters de cámara por ecosistema + helper de resolución de
 * cámara para las rutas (el helper responde él mismo los errores).
 */

const registry = require('../camera-registry');
const yiHack = require('./adapters/yi-hack');

/**
 * Devuelve el adapter del ecosistema de la cámara, o null si el ecosistema
 * no tiene adapter (método ausente = no soportado).
 * @param {Object|undefined} cam - Cámara del registry
 * @returns {Object|null} - Adapter (objeto de funciones) o null
 */
function getCameraAdapter(cam) {
    if (!cam) return null;
    return registry.getEcosystem(cam) === 'yi-hack' ? yiHack : null;
}

/**
 * Resuelve la cámara de req.params.id y su adapter para una ruta. Responde
 * él mismo los errores de resolución (la ruta solo hace `if (!r) return`):
 *  - 404 {success:false, error:'cámara no encontrada'}
 *  - 409 {success:false, error:unsupportedMessage} (ecosistema sin adapter
 *    o método no soportado por el adapter)
 *  - 400 {success:false, error:'la cámara no tiene host configurado'}
 * Uso:
 *   const r = resolveCameraFor(req, res, 'reboot', MSG_409);
 *   if (!r) return;
 *   await r.adapter.reboot(r.cam);
 * @param {Object} req - Request de Express (usa req.params.id)
 * @param {Object} res - Response de Express (responde él los errores)
 * @param {string} method - Método del adapter que la ruta va a llamar
 * @param {string} [unsupportedMessage] - Texto del 409 (default: mensaje de
 *   gestión de SD de routes/storage.js)
 * @returns {{cam: Object, adapter: Object}|null} - null si ya respondió
 */
function resolveCameraFor(req, res, method, unsupportedMessage) {
    const cam = registry.getCameraById(req.params.id);
    if (!cam) {
        res.status(404).json({ success: false, error: 'cámara no encontrada' });
        return null;
    }
    const adapter = getCameraAdapter(cam);
    if (!adapter || typeof adapter[method] !== 'function') {
        res.status(409).json({
            success: false,
            error: unsupportedMessage ||
                `la cámara "${cam.id}" es de ecosistema "${registry.getEcosystem(cam)}": la gestión de SD requiere firmware yi-hack`
        });
        return null;
    }
    if (!cam.host) {
        res.status(400).json({ success: false, error: 'la cámara no tiene host configurado' });
        return null;
    }
    return { cam, adapter };
}

module.exports = { getCameraAdapter, resolveCameraFor };
