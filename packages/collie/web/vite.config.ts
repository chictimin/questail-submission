import { defineConfig, type Plugin } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

// 서버(server.ts)는 public/index.html + /assets 정적 서빙 위에서 동작한다.
// 일반 Vite 다중 파일 산출물(index.html + assets/*.js/css)을 public에 둔다.
// emptyOutDir=true는 public/fixtures까지 지우므로 쓰지 않는다. 대신 빌드
// 시작 시 assets 디렉터리만 지워 낡은 해시 자산이 쌓이지 않게 한다.
const here = dirname(fileURLToPath(import.meta.url));

function cleanAssetsOnly(): Plugin {
  return {
    name: 'clean-assets-only',
    buildStart() {
      rmSync(resolve(here, '../public/assets'), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  root: here,
  build: {
    outDir: resolve(here, '../public'),
    emptyOutDir: false,
    chunkSizeWarningLimit: 4000,
  },
  plugins: [cleanAssetsOnly()],
});
