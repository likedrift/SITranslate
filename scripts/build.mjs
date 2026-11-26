import { build } from 'vite';
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { deflateSync, gzipSync } from 'node:zlib';
import path from 'node:path';

await build({ configFile: false, build: { outDir: 'dist', rollupOptions: {
  input: { popup: 'popup.html', options: 'options.html', offscreen:'offscreen.html', background: 'src/background.ts' },
  output: { entryFileNames: '[name].js', chunkFileNames: 'assets/[name]-[hash].js' }
} } });
await build({ configFile: false, publicDir: false, build: { outDir: 'dist', emptyOutDir: false,
  lib: { entry: 'src/content.ts', name: 'SiTranslate', formats: ['iife'], fileName: () => 'content.js' },
  rollupOptions: { output: { inlineDynamicImports: true } }
} });

await build({ configFile:false,publicDir:false,build:{outDir:'dist',emptyOutDir:false,
  lib:{entry:'src/video.ts',name:'SiVideoTranslate',formats:['iife'],fileName:()=> 'video.js'},
  rollupOptions:{output:{inlineDynamicImports:true}}} });

await build({configFile:false,publicDir:false,build:{outDir:'dist',emptyOutDir:false,
  lib:{entry:'src/player-controls.ts',name:'SiPlayerControls',formats:['iife'],fileName:()=> 'player-controls.js'},
  rollupOptions:{output:{inlineDynamicImports:true}}}});

// Antialiased brand icons with modern dual-card translation glyph, generated locally without external image dependencies.
function crc32(bytes) { let crc = -1; for (const b of bytes) { crc ^= b; for (let k=0;k<8;k++) crc = (crc>>>1) ^ (0xedb88320 & -(crc&1)); } return (crc^-1)>>>0; }
function chunk(type, body) { const t=Buffer.from(type); const size=Buffer.alloc(4); size.writeUInt32BE(body.length); const crc=Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t,body]))); return Buffer.concat([size,t,body,crc]); }

function sdRoundBox(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - hx + r;
  const qy = Math.abs(py - cy) - hy + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

function icon(size) {
  const rowSize = size * 4 + 1;
  const data = Buffer.alloc(size * rowSize);
  const pxSize = 1 / size;
  const small = size <= 20;
  const medium = size > 20 && size <= 36;
  const strokeW = small ? 0.052 : medium ? 0.036 : Math.max(0.025, 0.65 / size);

  for (let y = 0; y < size; y++) {
    data[y * rowSize] = 0;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;

      // Base squircle: clean cobalt blue without purple AI gradient.
      const pad = small ? 0.47 : 0.45;
      const radius = small ? 0.23 : 0.22;
      const dBase = sdRoundBox(u, v, 0.5, 0.5, pad, pad, radius);
      const aBase = Math.max(0, Math.min(1, 0.5 - dBase / pxSize));
      if (aBase <= 0) continue;

      // Subtle vertical Bluestone × Classic Blue depth: #3b6ad4 (top) -> #2b5ce0 (bottom)
      const tGrad = Math.max(0, Math.min(1, v * 0.95));
      let r = 59 + (43 - 59) * tGrad;
      let g = 106 + (92 - 106) * tGrad;
      let b = 212 + (224 - 212) * tGrad;

      if (!small) {
        const dInnerTop = sdRoundBox(u, v - 0.012, 0.5, 0.5, pad - 0.018, pad - 0.018, radius - 0.02);
        if (dBase < 0 && dInnerTop > 0 && v < 0.28) {
          const hLight = Math.max(0, Math.min(1, 1 - Math.abs(dBase) / 0.035)) * 0.22;
          r = r * (1 - hLight) + 255 * hLight;
          g = g * (1 - hLight) + 255 * hLight;
          b = b * (1 - hLight) + 255 * hLight;
        }
      }

      if (small) {
        // 16px crisp simplified mark: bold white "文" centered on cobalt squircle for instant legibility.
        const dWenDot = sdSegment(u, v, 0.50, 0.24, 0.50, 0.34) - strokeW;
        const dWenTop = sdSegment(u, v, 0.26, 0.36, 0.74, 0.36) - strokeW;
        const dWenLeg1 = sdSegment(u, v, 0.61, 0.39, 0.28, 0.76) - strokeW;
        const dWenLeg2 = sdSegment(u, v, 0.39, 0.44, 0.72, 0.76) - strokeW;
        const aWen = Math.max(0, Math.min(1, 0.5 - Math.min(dWenDot, dWenTop, dWenLeg1, dWenLeg2) / pxSize));
        if (aWen > 0) {
          r = r * (1 - aWen) + 255 * aWen;
          g = g * (1 - aWen) + 255 * aWen;
          b = b * (1 - aWen) + 255 * aWen;
        }
      } else {
        // Card 1 (Back left, translucent white)
        const c1Pos = medium ? 0.37 : 0.38;
        const c1Half = medium ? 0.215 : 0.21;
        const dCard1 = sdRoundBox(u, v, c1Pos, c1Pos, c1Half, c1Half, 0.075);
        const aCard1 = Math.max(0, Math.min(1, 0.5 - dCard1 / pxSize));

        // Card 2 (Front right, crisp white)
        const c2Pos = medium ? 0.63 : 0.62;
        const c2Half = medium ? 0.225 : 0.215;
        const dCard2 = sdRoundBox(u, v, c2Pos, c2Pos, c2Half, c2Half, 0.075);
        const aCard2 = Math.max(0, Math.min(1, 0.5 - dCard2 / pxSize));

        // Subtle crisp shadow behind Card 2
        const dShadow = sdRoundBox(u + 0.018, v + 0.018, c2Pos, c2Pos, c2Half + 0.006, c2Half + 0.006, 0.08);
        const aShadow = Math.max(0, Math.min(1, 0.5 - dShadow / (pxSize * (medium ? 1.5 : 2.0)))) * (medium ? 0.22 : 0.26);

        if (aCard1 > 0) {
          const c1Opacity = 0.28 * aCard1;
          r = r * (1 - c1Opacity) + 255 * c1Opacity;
          g = g * (1 - c1Opacity) + 255 * c1Opacity;
          b = b * (1 - c1Opacity) + 255 * c1Opacity;
        }

        // Letter 'A' in Card 1
        const dLegL = sdSegment(u, v, c1Pos - 0.06, c1Pos + 0.095, c1Pos, c1Pos - 0.10) - strokeW;
        const dLegR = sdSegment(u, v, c1Pos, c1Pos - 0.10, c1Pos + 0.06, c1Pos + 0.095) - strokeW;
        const dBar = sdSegment(u, v, c1Pos - 0.04, c1Pos + 0.04, c1Pos + 0.04, c1Pos + 0.04) - strokeW * 0.88;
        const aA = Math.max(0, Math.min(1, 0.5 - Math.min(dLegL, dLegR, dBar) / pxSize));
        if (aA > 0 && aCard1 > 0.5) {
          r = r * (1 - aA) + 255 * aA;
          g = g * (1 - aA) + 255 * aA;
          b = b * (1 - aA) + 255 * aA;
        }

        if (aShadow > 0 && aCard2 < 0.5) {
          r *= 1 - aShadow;
          g *= 1 - aShadow;
          b *= 1 - aShadow;
        }

        if (aCard2 > 0) {
          r = r * (1 - aCard2) + 255 * aCard2;
          g = g * (1 - aCard2) + 255 * aCard2;
          b = b * (1 - aCard2) + 255 * aCard2;
        }

        // Character '文' in Card 2
        const dWenTop = sdSegment(u, v, c2Pos - 0.095, c2Pos - 0.095, c2Pos + 0.095, c2Pos - 0.095) - strokeW;
        const dWenDot = sdSegment(u, v, c2Pos, c2Pos - 0.165, c2Pos, c2Pos - 0.095) - strokeW;
        const dWenLeg1 = sdSegment(u, v, c2Pos + 0.032, c2Pos - 0.085, c2Pos - 0.092, c2Pos + 0.105) - strokeW;
        const dWenLeg2 = sdSegment(u, v, c2Pos - 0.04, c2Pos - 0.055, c2Pos + 0.092, c2Pos + 0.105) - strokeW;
        const aWen = Math.max(0, Math.min(1, 0.5 - Math.min(dWenTop, dWenDot, dWenLeg1, dWenLeg2) / pxSize));
        if (aWen > 0 && aCard2 > 0.5) {
          const wR = 43, wG = 92, wB = 224;
          r = r * (1 - aWen) + wR * aWen;
          g = g * (1 - aWen) + wG * aWen;
          b = b * (1 - aWen) + wB * aWen;
        }
      }

      const offset = y * rowSize + 1 + x * 4;
      data[offset] = Math.round(r);
      data[offset + 1] = Math.round(g);
      data[offset + 2] = Math.round(b);
      data[offset + 3] = Math.round(aBase * 255);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(data)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
await mkdir('dist/icons',{recursive:true});
await mkdir('public/icons',{recursive:true});
for(const size of [16,32,48,128]) {
  const png = icon(size);
  await writeFile(`dist/icons/${size}.png`, png);
  await writeFile(`public/icons/${size}.png`, png);
}
const rows=[];
async function inspect(dir) { for(const name of await readdir(dir)) { const file=path.join(dir,name); if((await stat(file)).isDirectory()) await inspect(file); else { const data=await readFile(file); rows.push({file:file.replaceAll('\\','/'),bytes:data.length,gzip:gzipSync(data).length}); } } }
await inspect('dist');
await mkdir('artifacts',{recursive:true});
await writeFile('artifacts/build-sizes.json',JSON.stringify(rows,null,2));
console.log('Build complete. Load the dist folder in Chrome.');
