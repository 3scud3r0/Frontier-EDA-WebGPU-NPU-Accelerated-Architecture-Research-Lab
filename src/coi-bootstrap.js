const RELOAD_KEY = 'frontier-eda-coi-reload';

async function bootstrapCrossOriginIsolation() {
  if (globalThis.crossOriginIsolated || !('serviceWorker' in navigator)) return;

  const base = import.meta.env.BASE_URL || './';
  const workerURL = new URL(`${base}coi-serviceworker.js`, window.location.href);
  const scopeURL = new URL(base, window.location.href);

  try {
    const registration = await navigator.serviceWorker.register(workerURL, {
      scope: scopeURL.pathname,
      updateViaCache: 'none',
    });

    if (navigator.serviceWorker.controller) {
      sessionStorage.removeItem(RELOAD_KEY);
      return;
    }

    const reloadOnce = () => {
      if (sessionStorage.getItem(RELOAD_KEY)) return;
      sessionStorage.setItem(RELOAD_KEY, '1');
      window.location.reload();
    };

    if (registration.active) {
      reloadOnce();
      return;
    }

    navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
  } catch (error) {
    console.warn('[Frontier EDA] Cross-origin isolation bootstrap failed:', error);
  }
}

await bootstrapCrossOriginIsolation();
