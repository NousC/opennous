import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from "fs";

// Cloud's own edits to index.html (src/cloud/indexHtml.mjs, GET-761), applied after the public
// transform. The open-source export has no src/cloud/, so a self-hosted build skips them.
const CLOUD_HTML = path.resolve(__dirname, "src/cloud/indexHtml.mjs");

export default defineConfig(async ({ mode }) => {
  const gaId = process.env.VITE_GOOGLE_ANALYTICS_ID || '';
  const cloudHtml: (html: string) => string = fs.existsSync(CLOUD_HTML)
    ? (await import(CLOUD_HTML)).transformIndexHtml
    : (html) => html;

  return {
    envDir: path.resolve(__dirname, '../../'),
    server: {
      host: "::",
      port: 8080,
      // Proxy every API path the app, CLI, and MCP hit, so the dev server's own
      // origin is a complete API base (matching production single-domain self-host
      // where nginx fronts all of these under one host).
      proxy: Object.fromEntries(
        ['/api', '/v2', '/me', '/health'].map((p) => [p, {
          // VITE_PROXY_TARGET lets parallel preview runs (visual tests) each talk to their own mock API.
          target: process.env.VITE_PROXY_TARGET || process.env.VITE_API_URL || 'http://localhost:3000',
          changeOrigin: true,
          secure: false,
        }]),
      ),
    },
    plugins: [
      react(),
      {
        name: 'html-transform',
        transformIndexHtml(raw: string) {
          const html = cloudHtml(raw);
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
          manualChunks: (id: string) => {
            if (id.includes('node_modules')) {
              // Clerk before the react check: '@clerk/react' contains "react", and
              // landing it in react-vendor would ship Clerk eagerly to self-host
              // builds that never use it (GET-577). Its own chunk loads only with
              // the lazy Clerk provider.
              if (id.includes('@clerk')) {
                return 'clerk-vendor';
              }
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
