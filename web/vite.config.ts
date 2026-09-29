import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Cloudflare 隧道回源时，请求头里的 Host 是公网域名，Vite 5.4+ 会以
    // "Blocked request. This host is not allowed." 返回 403。
    // 前导点表示放行该域名的所有子域。
    // 换成自有域名后，把 'css.你的域名' 追加到数组里。
    // 根域名必须单独列一条：前导点只匹配"子域名"，不匹配裸域名本身。
    allowedHosts: ['huangqizheng.space', '.huangqizheng.space', '.trycloudflare.com'],
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
