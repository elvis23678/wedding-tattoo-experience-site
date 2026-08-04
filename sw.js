const CACHE_VERSION = 'wte-no-cache-20260804-1600';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;

  // Never serve cached HTML/navigation.
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request, { cache: 'no-store' }).catch(() => fetch('/'))
    );
    return;
  }

  // Always prefer the network for all project files.
  event.respondWith(
    fetch(request, { cache: 'no-store' }).catch(() => caches.match(request))
  );
});
