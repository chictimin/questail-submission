import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 서버(server.ts)는 publicDir(기본값 packages/collie/public)의 index.html을
// 기동 시 1회 읽고, /assets 같은 정적 라우트가 없다. 그래서 번들을 별도
// 파일로 두면 404가 난다. vite-plugin-singlefile로 JS·CSS를 index.html 하나에
// 인라인한다. emptyOutDir=false로 public/fixtures를 보존한다.
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  build: {
    outDir: resolve(here, '../public'),
    emptyOutDir: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4000,
  },
  plugins: [viteSingleFile()],
});
