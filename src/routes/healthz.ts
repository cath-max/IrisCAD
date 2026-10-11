import { createFileRoute } from '@tanstack/react-router';

// Deliberately avoids auth, Supabase, and model providers. Cloud Run uses this
// endpoint to distinguish a live application process from a ready web service.
export const Route = createFileRoute('/healthz')({
  server: {
    handlers: {
      GET: () =>
        new Response(JSON.stringify({ status: 'ok' }), {
          headers: {
            'cache-control': 'no-store',
            'content-type': 'application/json; charset=utf-8',
          },
        }),
      HEAD: () =>
        new Response(null, {
          headers: { 'cache-control': 'no-store' },
        }),
    },
  },
});
