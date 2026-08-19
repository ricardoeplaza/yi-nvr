#!/usr/bin/env node
/**
 * scripts/mqtt-db-tail.js
 *
 * Muestra las últimas N filas (default 10) de la tabla `mqtt_events` de la
 * BD del NVR. Abre la BD en solo-lectura (compatible con el servidor
 * corriendo en WAL).
 *
 * Uso:
 *   node scripts/mqtt-db-tail.js [n]
 */

const path = require('path');
const Database = require('better-sqlite3');

const n = parseInt(process.argv[2], 10) > 0 ? parseInt(process.argv[2], 10) : 10;

const storageDir = process.env.STORAGE_DIR
    ? path.resolve(process.env.STORAGE_DIR)
    : path.join(__dirname, '..', 'src', 'storage');
const dbPath = path.join(storageDir, 'surveillance.db');

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const rows = db.prepare('SELECT * FROM mqtt_events ORDER BY id DESC LIMIT ?').all(n);
db.close();

if (rows.length === 0) {
    console.log('[db-tail] mqtt_events está vacía');
    process.exit(0);
}

console.log(`[db-tail] Últimas ${rows.length} filas de mqtt_events:`);
for (const row of rows.reverse()) {
    console.log(`  #${row.id} ${row.received_at} cam=${row.camera_id} type=${row.event_type} payload=${JSON.stringify(row.payload)}`);
}
