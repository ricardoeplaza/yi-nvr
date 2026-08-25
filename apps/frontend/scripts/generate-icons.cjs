/**
 * generate-icons.cjs — regenera todos los iconos de la app a partir de los SVG
 * oficiales (public/icons/icon.svg, icon-maskable.svg y favicon.svg).
 *
 * Salida:
 *   - public/icons/icon-{size}x{size}.png         (manifest "any", desde favicon.svg, fondo transparente)
 *   - public/icons/icon-maskable-{size}x{size}.png (manifest "maskable", desde icon-maskable.svg)
 *   - public/favicon.ico                          (16/32/48/64, contenedor ICO con entradas PNG)
 *
 * Uso: npm run icons
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const publicDir = path.join(__dirname, '..', 'public');
const iconsDir = path.join(publicDir, 'icons');

const ANY_SIZES = [72, 96, 128, 144, 152, 192, 384, 512];
const MASKABLE_SIZES = [192, 512];
const ICO_SIZES = [16, 32, 48, 64];

async function svgToPng(svgPath, size) {
  return sharp(svgPath, { density: 72 }).resize(size, size).png().toBuffer();
}

async function buildIco(svgPath, sizes) {
  const images = [];
  for (const size of sizes) {
    images.push({ size, data: await svgToPng(svgPath, size) });
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;
  images.forEach((img, i) => {
    const entry = i * 16;
    directory.writeUInt8(img.size >= 256 ? 0 : img.size, entry + 0);
    directory.writeUInt8(img.size >= 256 ? 0 : img.size, entry + 1);
    directory.writeUInt8(0, entry + 2); // palette
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // planes
    directory.writeUInt16LE(32, entry + 6); // bpp
    directory.writeUInt32LE(img.data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += img.data.length;
  });

  return Buffer.concat([header, directory, ...images.map((img) => img.data)]);
}

async function main() {
  const maskableSvg = path.join(iconsDir, 'icon-maskable.svg');
  const faviconSvg = path.join(iconsDir, 'favicon.svg');

  for (const size of ANY_SIZES) {
    const out = path.join(iconsDir, `icon-${size}x${size}.png`);
    await fs.promises.writeFile(out, await svgToPng(faviconSvg, size));
    console.log(`✓ ${path.relative(publicDir, out)}`);
  }

  for (const size of MASKABLE_SIZES) {
    const out = path.join(iconsDir, `icon-maskable-${size}x${size}.png`);
    await fs.promises.writeFile(out, await svgToPng(maskableSvg, size));
    console.log(`✓ ${path.relative(publicDir, out)}`);
  }

  const ico = await buildIco(faviconSvg, ICO_SIZES);
  const icoPath = path.join(publicDir, 'favicon.ico');
  await fs.promises.writeFile(icoPath, ico);
  console.log(`✓ ${path.relative(publicDir, icoPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
