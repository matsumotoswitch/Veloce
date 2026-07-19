import { defineConfig } from 'vite';
import { resolve, join } from 'path';
import license from 'rollup-plugin-license';

export default defineConfig(async () => ({
  // HTMLファイルが src フォルダにあることを指定
  root: 'src',

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    }
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // ビルド結果は src の外（元の dist フォルダ）に出力
    outDir: '../dist',
    emptyOutDir: true,

    target: process.env.TAURI_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,

    // エントリとビルド時の出力設定
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/index.html'),
        viewer: resolve(__dirname, 'src/viewer.html')
      },
      plugins: [
        license({
          thirdParty: {
            output: resolve(__dirname, 'dist/NPM_LICENSES.txt'),
            includePrivate: false,
          },
        }),
      ]
    }
  },
}));