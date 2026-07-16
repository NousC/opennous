import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig(({ mode }) => {
  const gaId = process.env.VITE_GOOGLE_ANALYTICS_ID || '';

  return {
    envDir: path.resolve(__dirname, '../../'),
    server: {
      host: "::",
      port: 8080,
      // Proxy every API path the app, CLI, and MCP hit, so the dev server's own
      // origin is a complete API base (matching production single-domain self-host
      // where nginx fronts all of these under one host).
      proxy: Object.fromEntries(
        ['/api', '/v2', '/me', '/health', '/install'].map((p) => [p, {
          target: process.env.VITE_API_URL || 'http://localhost:3000',
          changeOrigin: true,
          secure: false,
        }]),
      ),
    },
    plugins: [
      react(),
      {
        name: 'html-transform',
        transformIndexHtml(html) {
          if (gaId) {
            return html.replace(/G-XXXXXXXXXX/g, gaId);
          }
          // No GA id configured (e.g. self-host): strip the whole gtag block
          // (loader script + inline config) so nothing phones home.
          return html.replace(/<!-- Google tag \(gtag\.js\)[\s\S]*?<\/script>\s*<script>[\s\S]*?<\/script>\s*/g, '');
        },
      },
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
      dedupe: ['react', 'react-dom'],
    },
    build: {
      rollupOptions: {
        output: {
          chunkFileNames: 'assets/[name]-[hash].js',
          entryFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash].[ext]',
          manualChunks: (id) => {
            if (id.includes('node_modules')) {
              if (id.includes('react') || id.includes('react-dom') || id.includes('react-router')) {
                return 'react-vendor';
              }
              if (id.includes('@supabase')) {
                return 'supabase-vendor';
              }
              return 'vendor';
            }
          },
        },
      },
      chunkSizeWarningLimit: 1000,
    },
  };
});
