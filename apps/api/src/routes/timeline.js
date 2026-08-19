/**
 * routes/timeline.js
 *
 * Router de la API para el timeline (se monta en /api).
 *
 * Endpoints:
 *  - GET /timeline - Datos agregados para el timeline (videos por fecha y cámara)
 */

const express = require('express');
const { getTimelineData } = require('../database');

const router = express.Router();

/**
 * GET /api/timeline
 *
 * Obtiene datos agregados para mostrar un timeline en el frontend.
 * Agrupa videos por fecha y cámara.
 */
router.get('/timeline', (req, res) => {
    try {
        const timeline = getTimelineData();

        // Reorganizamos los datos para facilitar el consumo en el frontend
        const groupedByDate = {};
        timeline.forEach(item => {
            if (!groupedByDate[item.date]) {
                groupedByDate[item.date] = {
                    date: item.date,
                    total: 0,
                    cameras: {}
                };
            }
            groupedByDate[item.date].total += item.count;
            groupedByDate[item.date].cameras[item.camera_name] = item.count;
        });

        res.json({
            success: true,
            data: Object.values(groupedByDate)
        });

    } catch (error) {
        console.error('[API] Error al obtener timeline:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
