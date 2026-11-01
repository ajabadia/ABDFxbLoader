import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webappDir = path.resolve(__dirname, '..');
const publicDir = path.resolve(webappDir, 'public');

const svgContent = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="100%" height="100%">
  <rect width="40" height="40" rx="10" fill="#b4532a"/>
  <path d="M7 11l7 18 6-14 6 14 7-18" fill="none" stroke="white" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M9 34h22" stroke="white" stroke-width="2" stroke-linecap="round"/>
</svg>
`;

function createIco(pngBuffersWithSizes) {
  const count = pngBuffersWithSizes.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // 1 = ICO
  header.writeUInt16LE(count, 4); // Count

  let offset = 6 + count * 16;
  const directoryEntries = [];

  for (const { size, buffer } of pngBuffersWithSizes) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // Width
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // Height
    entry.writeUInt8(0, 2); // Colors in palette
    entry.writeUInt8(0, 3); // Reserved
    entry.writeUInt16LE(1, 4); // Color planes
    entry.writeUInt16LE(32, 6); // Bits per pixel
    entry.writeUInt32LE(buffer.length, 8); // Image data size
    entry.writeUInt32LE(offset, 12); // Image data offset
    directoryEntries.push(entry);
    offset += buffer.length;
  }

  return Buffer.concat([
    header,
    ...directoryEntries,
    ...pngBuffersWithSizes.map((item) => item.buffer),
  ]);
}

async function main() {
  console.log('[generate-icons] Lanzando navegador Playwright para renderizar activos...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: transparent;
            display: flex;
            align-items: center;
            justify-content: center;
          }
        </style>
      </head>
      <body>
        ${svgContent}
      </body>
    </html>
  `;

  await page.setContent(html);

  const sizes = [16, 32, 48, 64, 128, 192, 256, 512];
  const pngBuffers = {};

  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    const buffer = await page.screenshot({ omitBackground: true, type: 'png' });
    pngBuffers[size] = buffer;
    if (size === 192 || size === 512 || size === 256) {
      const pngPath = path.join(publicDir, `icon-${size}.png`);
      fs.writeFileSync(pngPath, buffer);
      console.log(`[generate-icons] Generado: ${pngPath}`);
    }
  }

  await browser.close();

  // Generar favicon.ico con tamaños estándar (16, 32, 48, 64, 128, 256)
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const icoData = createIco(icoSizes.map((size) => ({ size, buffer: pngBuffers[size] })));
  const icoPath = path.join(publicDir, 'favicon.ico');
  fs.writeFileSync(icoPath, icoData);
  console.log(`[generate-icons] Generado: ${icoPath}`);

  // Generar manifest.json
  const manifest = {
    name: 'VFX Plugin & Bank Manager',
    short_name: 'VFX Manager',
    description: 'Gestor y configurador de plugins y bancos VFX',
    start_url: '/',
    display: 'standalone',
    background_color: '#121212',
    theme_color: '#b4532a',
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/icon-256.png',
        sizes: '256x256',
        type: 'image/png',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  };

  const manifestPath = path.join(publicDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[generate-icons] Generado: ${manifestPath}`);
}

main().catch((err) => {
  console.error('[generate-icons] Error:', err);
  process.exit(1);
});
