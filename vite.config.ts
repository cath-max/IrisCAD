import { sentryVitePlugin } from '@sentry/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { nitro } from 'nitro/vite';
import fs from 'node:fs';
import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const appBase = '/';
const normalizedAppBase = appBase.replace(/\/$/, '');

/** Serve Pyodide wheels from `public/vendor/simplecadapi/` without SPA HTML fallback. */
function serveSimpleCadWheelsInDev(): Plugin {
  const vendorDir = path.resolve(__dirname, 'public', 'vendor', 'simplecadapi');
  return {
    name: 'serve-simplecadapi-wheels-in-dev',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        const url = new URL(req.url, 'http://localhost');
        const prefix = `${normalizedAppBase}/vendor/simplecadapi/`;
        if (
          !url.pathname.startsWith(prefix) ||
          !url.pathname.endsWith('.whl')
        ) {
          return next();
        }

        const name = path.basename(url.pathname);
        const filePath = path.join(vendorDir, name);
        if (!fs.existsSync(filePath)) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(`Missing wheel: ${name}`);
          return;
        }

        const size = fs.statSync(filePath).size;
        const fd = fs.openSync(filePath, 'r');
        const magic = Buffer.alloc(2);
        fs.readSync(fd, magic, 0, 2, 0);
        fs.closeSync(fd);
        if (size < 50_000 || magic[0] !== 0x50 || magic[1] !== 0x4b) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(
            `Invalid wheel ${name} (${size} bytes). Re-download; a zip starts with PK.`,
          );
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/octet-stream');
        // Cache so PromptView prefetch and micropip.install share one download.
        // Not `immutable`: a truncated 0-byte response must be replaceable.
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('Content-Length', String(size));
        fs.createReadStream(filePath).pipe(res);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Vite loads .env files after evaluating this config. Read them explicitly
  // here so local development keeps `.env.local`, while Docker/Cloud Build's
  // process environment still takes precedence for production builds.
  const fileEnv = loadEnv(mode, process.cwd(), '');
  const buildEnv = { ...fileEnv, ...process.env };
  const publicBuildEnv = {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(
      buildEnv.VITE_SUPABASE_URL ?? '',
    ),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(
      buildEnv.VITE_SUPABASE_ANON_KEY ?? '',
    ),
    'import.meta.env.VITE_SIMPLECAD_WHEEL_CHINA_MIRROR_BASE_URL':
      JSON.stringify(
        buildEnv.VITE_SIMPLECAD_WHEEL_CHINA_MIRROR_BASE_URL ??
          'https://iris-wheel-test-1476610316.cos.ap-shanghai.myqcloud.com/vendor/simplecadapi/',
      ),
  };

  return {
    base: appBase,
    define: publicBuildEnv,
    plugins: [
      serveSimpleCadWheelsInDev(),
      tanstackStart({
        router: {
          basepath: appBase,
        },
        spa: {
          enabled: true,
          maskPath: appBase,
        },
      }),
      nitro({
        baseURL: appBase,
        inlineDynamicImports: true,
        publicAssets: [
          {
            baseURL: '/vendor/simplecadapi',
            dir: path.resolve(__dirname, 'public', 'vendor', 'simplecadapi'),
            maxAge: 60 * 60 * 24 * 365,
          },
        ],
      }),
      react(),
      sentryVitePlugin({
        org: 'adamcad',
        project: 'adamcad',
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@shared': path.resolve(__dirname, './shared'),
      },
    },
    build: {
      chunkSizeWarningLimit: 1000,

      outDir: 'dist/client',
      emptyOutDir: true,

      sourcemap: true,
    },
    // The CAD runtime is a module Worker and imports Pyodide from its published
    // ESM URL. IIFE workers turn that URL into an unresolved generated global
    // (`https___cdn_...`) at build time, so keep worker assets as native ESM.
    worker: {
      format: 'es',
    },
    environments: {
      client: {
        build: {
          outDir: 'dist/client',
          rollupOptions: {
            output: {
              manualChunks(id) {
                if (
                  id.includes('/node_modules/react/') ||
                  id.includes('/node_modules/react-dom/') ||
                  id.includes('/node_modules/@tanstack/react-router/') ||
                  id.includes('/node_modules/@tanstack/react-start/') ||
                  id.includes('/node_modules/lucide-react/')
                ) {
                  return 'vendor';
                }
              },
            },
          },
        },
      },
      server: {
        build: {
          outDir: 'dist/server',
        },
      },
    },
    preview: {
      port: 4173,
      host: true,
    },
    server: {
      port: 3000,
      open: false,
    },
    optimizeDeps: {
      exclude: [
        '@zip.js/zip.js',
        'three',
        'three-stdlib',
        '@sentry/vite-plugin',
      ],
    },
  };
});
