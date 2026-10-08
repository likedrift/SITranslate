import { build } from 'vite';
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { deflateSync, gzipSync } from 'node:zlib';
import path from 'node:path';

await build({ configFile: false, build: { outDir: 'dist', rollupOptions: {
  input: { popup: 'popup.html', options: 'options.html', background: 'src/background.ts' },
  output: { entryFileNames: '[name].js', chunkFileNames: 'assets/[name]-[hash].js' }
} } });
await build({ configFile: false, publicDir: false, build: { outDir: 'dist', emptyOutDir: false,
  lib: { entry: 'src/content.ts', name: 'SiTranslate', formats: ['iife'], fileName: () => 'content.js' },
  rollupOptions: { output: { inlineDynamicImports: true } }
} });

await build({ configFile:false,publicDir:false,build:{outDir:'dist',emptyOutDir:false,
  lib:{entry:'src/video.ts',name:'SiVideoTranslate',formats:['iife'],fileName:()=> 'video.js'},
  rollupOptions:{output:{inlineDynamicImports:true}}} });

// Small raster toolbar icons, generated locally without an external font or image dependency.
function crc32(bytes) { let crc = -1; for (const b of bytes) { crc ^= b; for (let k=0;k<8;k++) crc = (crc>>>1) ^ (0xedb88320 & -(crc&1)); } return (crc^-1)>>>0; }
function chunk(type, body) { const t=Buffer.from(type); const size=Buffer.alloc(4); size.writeUInt32BE(body.length); const crc=Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t,body]))); return Buffer.concat([size,t,body,crc]); }
function icon(size) {
  const data=Buffer.alloc(size*(size*4+1));
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const u=x/size,v=y/size, radius=.18;
    const dx=Math.max(radius-u,0,u-(1-radius)),dy=Math.max(radius-v,0,v-(1-radius));
    const inside=dx*dx+dy*dy<=radius*radius;
    const stroke=(u>.25&&u<.75&&v>.27&&v<.36)||(u>.455&&u<.545&&v>.3&&v<.74);
    const i=y*(size*4+1)+1+x*4;
    data.set(stroke?[255,255,255,255]:[68,82,168,inside?255:0],i);
  }
  const header=Buffer.alloc(13); header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(data)),chunk('IEND',Buffer.alloc(0))]);
}
await mkdir('dist/icons',{recursive:true});
for(const size of [16,32,48,128]) await writeFile(`dist/icons/${size}.png`,icon(size));
const rows=[];
async function inspect(dir) { for(const name of await readdir(dir)) { const file=path.join(dir,name); if((await stat(file)).isDirectory()) await inspect(file); else { const data=await readFile(file); rows.push({file:file.replaceAll('\\','/'),bytes:data.length,gzip:gzipSync(data).length}); } } }
await inspect('dist');
await mkdir('artifacts',{recursive:true});
await writeFile('artifacts/build-sizes.json',JSON.stringify(rows,null,2));
console.log('Build complete. Load the dist folder in Chrome.');
