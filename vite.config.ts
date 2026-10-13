import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const renderer = fileURLToPath(new URL('./src/renderer', import.meta.url));
const shared = fileURLToPath(new URL('./src/shared', import.meta.url));
const mobile = fileURLToPath(new URL('./src/mobile', import.meta.url));
const stubs = fileURLToPath(new URL('./src/stubs', import.meta.url));

/**
 * 未 vendor 的模块用 alias 重定向到 src/stubs。
 *
 * 为什么用 alias 而不是改内核文件：`scripts/sync-upstream.mjs` 会全量覆盖
 * src/renderer 下的内核目录，只要一个字节不同，每次同步都会产生冲突。
 * 把差异挡在别名这一层，内核文件就能保持与上游逐字节一致。
 *
 * ⚠️ 顺序敏感：`@/plugins/runtime/theme` 必须排在 `@/plugins/runtime` 之前，
 * Vite 的字符串别名是前缀匹配，顺序反了前者会永远命不中。
 */

const stubAliases = [
  { find: '@/plugins/runtime/theme', replacement: `${stubs}/plugins-runtime-theme.ts` },
  { find: '@/plugins/runtime', replacement: `${stubs}/plugins-runtime.ts` },
  { find: '@/plugins/taskPanel', replacement: `${stubs}/plugins-task-panel.ts` },
  { find: '@/tasks/taskControl', replacement: `${stubs}/tasks-task-control.ts` },
  // 第三方包也可以重定向：外部歌单导入的 providers 用 electron-log，
  // WebView 里没有 Electron 日志栈，换成转 console 的桩。
  { find: 'electron-log', replacement: `${stubs}/electron-log.ts` },
];

/**
 * 输出构建清单，供 scripts/check-boot-order.mjs 检查加载顺序。
 *
 * 为什么不用 manualChunks 固定分块：分块策略是优化手段，会随代码变化；
 * 而这里要守的是一个**依赖图不变量** —— 「入口 chunk 的静态依赖里不能出现内核模块」。
 * 直接拿 Rollup 的分块结果（每个 chunk 里到底装了哪些源文件）来判定，
 * 既不约束分块策略，又能捕获间接的静态链路（A→B→内核 也算违规）。
 */
function buildManifest() {
  return {
    name: 'echo-build-manifest',
    generateBundle(_options, bundle) {
      const manifest = Object.entries(bundle)
        .filter(([, item]) => item.type === 'chunk')
        .map(([file, chunk]) => ({
          file,
          isEntry: Boolean(chunk.isEntry),
          isDynamicEntry: Boolean(chunk.isDynamicEntry),
          imports: chunk.imports,
          dynamicImports: chunk.dynamicImports,
          modules: Object.keys(chunk.modules),
        }));
      this.emitFile({
        type: 'asset',
        fileName: 'build-manifest.json',
        source: `${JSON.stringify({ chunks: manifest }, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [vue(), buildManifest()],
  resolve: {
    alias: [
      ...stubAliases,
      { find: '@shared', replacement: shared },
      { find: '@mobile', replacement: mobile },
      { find: '@stubs', replacement: stubs },
      { find: '@', replacement: renderer },
    ],
    // 渲染层与移动端各自 import vue/pinia，不收敛就会有**两个 pinia 实例**，
    // 于是 setActivePinia 对另一侧创建的 store 不生效
    // （报 `Cannot read properties of undefined (reading '_s')`）。
    dedupe: ['vue', 'pinia', 'vue-router'],
  },
  define: {
    // 打包进来的 server/ 代码里有 `typeof global` 这类环境判断
    global: 'globalThis',
    __APP_VERSION__: JSON.stringify(`${pkg.version}-mobile.1`),
  },
  optimizeDeps: {
    // server/util 依赖的加密栈要预构建，否则 dev 下逐个转换很慢
    include: ['buffer', 'crypto-js', 'node-forge', 'pako', 'big-integer', 'axios', 'qrcode'],
  },
  build: {
    // Android 12 上常见 WebView 是 Chrome 110；es2022 是安全上限。
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    // 内核 + KuGou API 打包产物本来就大，别在 500KB 处刷警告
    chunkSizeWarningLimit: 3000,
  },
  server: {
    host: '0.0.0.0',
    port: 5174,
  },
});
