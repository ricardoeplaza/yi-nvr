/**
 * build-web.cjs — copia el build de Angular (dist/frontend/browser) a
 * apps/api/src/public, donde Express lo sirve en dev (PUBLIC_DIR default).
 *
 * Preserva mockup/ (tracked en git). Cross-platform (node, sin shell).
 * Uso: `npm run build:web` en apps/frontend (ejecuta `ng build` primero).
 */
const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '..', 'dist', 'frontend', 'browser');
const dst = path.resolve(__dirname, '..', '..', 'api', 'src', 'public');

if (!fs.existsSync(path.join(src, 'index.html'))) {
    console.error(`[build:web] ${src} no tiene index.html. Ejecuta \`ng build\` primero.`);
    process.exit(1);
}

fs.mkdirSync(dst, { recursive: true });

// Borra el build anterior pero conserva mockup/
for (const entry of fs.readdirSync(dst)) {
    if (entry === 'mockup') continue;
    fs.rmSync(path.join(dst, entry), { recursive: true, force: true });
}

fs.cpSync(src, dst, { recursive: true });
console.log(`[build:web] Copiado ${src} -> ${dst}`);
