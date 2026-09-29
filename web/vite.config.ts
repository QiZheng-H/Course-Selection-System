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
    // 监听所有网卡（IPv4 + IPv6）。
    // 原因：Vite 不带 --host 时只绑定 localhost 的解析结果（本机为 ::1），
    // IPv4 的 127.0.0.1 会连接失败；而 cloudflared 隧道回源用的是 http://localhost:5173，
    // 一旦解析到 IPv4 就打不开页面。固定成 0.0.0.0 后两种地址都可用。
    host: '0.0.0.0',
    // Cloudflare 隧道回源时，请求头里的 Host 是公网域名，Vite 5.4+ 会以
    // "Blocked request. This host is not allowed." 返回 403。
    // 前导点表示放行该域名的所有子域。
    // 换成自有域名后，把 'css.你的域名' 追加到数组里。
    // 根域名必须单独列一条：前导点只匹配"子域名"，不匹配裸域名本身。
    allowedHosts: [
      'huangqizheng.space',
      '.huangqizheng.space',
      // 当前正在使用的 Cloudflare 隧道域名（cloudflared /config 里的 ingress hostname）
      'ares-vision.xyz',
      '.ares-vision.xyz',
      '.trycloudflare.com',
    ],
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
