/* ============================================================
   FINANÇAS FAMÍLIA — Service Worker v3.0
   Strategy:
     • Static assets → Cache-first (versioned cache)
     • Supabase API  → Network-first (fall back to nothing)
     • Background Sync → drain OfflineQueue when reconnected
   ============================================================ */

const CACHE_NAME    = 'financas-familia-v3';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/script.js',
    '/manifest.json',
    // CDN assets are cached on first fetch via runtime caching below
];

// ============================================================
// INSTALL — pre-cache static shell
// ============================================================
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())  // Activate immediately
    );
});

// ============================================================
// ACTIVATE — purge old caches
// ============================================================
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            )
        ).then(() => self.clients.claim())  // Take control of all pages
    );
});

// ============================================================
// FETCH — routing strategy
// ============================================================
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // 1. Supabase API → Network-only (don't cache DB responses)
    if (url.hostname.includes('supabase.co') ||
        url.hostname.includes('awesomeapi.com.br') ||
        url.hostname.includes('open.er-api.com')) {
        event.respondWith(
            fetch(event.request).catch(() =>
                new Response(JSON.stringify({ error: 'offline' }), {
                    status: 503,
                    headers: { 'Content-Type': 'application/json' },
                })
            )
        );
        return;
    }

    // 2. Google Fonts / CDN → Cache-first with network fallback
    if (url.hostname.includes('fonts.googleapis.com') ||
        url.hostname.includes('fonts.gstatic.com') ||
        url.hostname.includes('cdn.jsdelivr.net')) {
        event.respondWith(
            caches.match(event.request).then(cached => {
                if (cached) return cached;
                return fetch(event.request).then(response => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
                    return response;
                });
            })
        );
        return;
    }

    // 3. App shell (HTML/CSS/JS) → Cache-first, update in background
    event.respondWith(
        caches.match(event.request).then(cached => {
            const networkFetch = fetch(event.request).then(response => {
                // Update cache with fresh version
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
                }
                return response;
            }).catch(() => null);

            // Return cached immediately; network runs in background
            return cached || networkFetch;
        })
    );
});

// ============================================================
// BACKGROUND SYNC — triggered by app._registerSW()
// When the browser regains connectivity it fires 'sync'.
// The actual queue drain happens in the main thread via
// OfflineQueue.drain(), triggered by window 'online' event.
// This SW sync is a belt-and-suspenders mechanism for
// browsers that support it (Chrome/Edge on Android).
// ============================================================
self.addEventListener('sync', event => {
    if (event.tag === 'sync-offline-queue') {
        event.waitUntil(
            // Notify all controlled clients to drain the queue
            self.clients.matchAll({ type: 'window' }).then(clients => {
                clients.forEach(client =>
                    client.postMessage({ type: 'SYNC_OFFLINE_QUEUE' })
                );
            })
        );
    }
});

// ============================================================
// MESSAGE — handle postMessage from clients
// ============================================================
self.addEventListener('message', event => {
    if (event.data?.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});