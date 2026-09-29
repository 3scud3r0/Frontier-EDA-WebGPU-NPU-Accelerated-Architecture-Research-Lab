/*
 * Frontier EDA cross-origin-isolation bootstrap for static hosts such as GitHub Pages.
 * It is intentionally self-contained and must be loaded before the Vite module entry.
 */
(() => {
  const CACHE = 'frontier-eda-v4-coi';
  const isServiceWorker = typeof Window === 'undefined';

  function isolatedResponse(response) {
    if (!response || response.status === 0) return response;
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    headers.set('Origin-Agent-Cluster', '?1');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  if (isServiceWorker) {
    self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
    self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', event => {
      if (event.request.method !== 'GET') return;
      event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        try {
          const fresh = await fetch(event.request, { cache: 'no-store' });
          const wrapped = isolatedResponse(fresh);
          if (new URL(event.request.url).origin === self.location.origin && fresh.ok) {
            cache.put(event.request, wrapped.clone()).catch(() => {});
          }
          return wrapped;
        } catch {
          const cached = await cache.match(event.request);
          if (cached) return isolatedResponse(cached);
          throw new Error(`Frontier EDA offline cache miss: ${event.request.url}`);
        }
      })());
    });
    return;
  }

  if (window.crossOriginIsolated || !('serviceWorker' in navigator)) return;
  const url = new URL('./coi-serviceworker.js', window.location.href);
  navigator.serviceWorker.register(url, { scope: './' }).then(registration => {
    if (registration.active && !navigator.serviceWorker.controller) {
      window.location.reload();
      return;
    }
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
  }).catch(error => console.warn('[Frontier EDA] COI service worker:', error));
})();
