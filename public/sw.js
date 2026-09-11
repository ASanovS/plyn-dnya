// sw.js
importScripts('/idb-queue.js');

const SHELL_CACHE = 'plyn-dnya-shell-v3';
const DATA_CACHE = 'plyn-dnya-data-v1';
const SHELL_ASSETS = [
  '/',
  '/idb-queue.js',
  '/manifest.json',
  '/special/badge.jpg',
  '/special/strength.jpg',
  '/special/perception.jpg',
  '/special/endurance.jpg',
  '/special/charisma.jpg',
  '/special/intelligence.jpg',
  '/special/agility.jpg',
  '/special/luck.jpg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL_CACHE && k !== DATA_CACHE).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

function isSupabaseRequest(url) {
  return url.hostname.endsWith('.supabase.co');
}

// Синтетична "успішна" відповідь-заглушка. Мутація насправді пішла в чергу,
// а не на сервер, але з точки зору supabase-js це виглядає як 2xx —
// тому оптимістична зміна в інтерфейсі НЕ відкочується (так і треба офлайн).
function queuedResponse() {
  return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // ---------- Supabase: мутації (POST/PATCH/DELETE) ----------
  if (isSupabaseRequest(url) && event.request.method !== 'GET') {
    event.respondWith((async () => {
      const reqClone = event.request.clone();
      try {
        return await fetch(event.request);
      } catch (err) {
        // Немає мережі — кладемо мутацію в чергу й повертаємо "успіх".
        const entry = await self.dayflowQueue.serializeRequest(reqClone);
        await self.dayflowQueue.enqueue(entry);
        // Просимо браузер розбудити нас, щойно з'явиться мережа (де підтримується).
        if ('sync' in self.registration) {
          try { await self.registration.sync.register('plyn-dnya-sync'); } catch (e) {}
        }
        return queuedResponse();
      }
    })());
    return;
  }

  // ---------- Supabase: читання (GET) ----------
  if (isSupabaseRequest(url) && event.request.method === 'GET') {
    event.respondWith((async () => {
      try {
        const res = await fetch(event.request);
        const cache = await caches.open(DATA_CACHE);
        cache.put(event.request, res.clone());
        return res;
      } catch (err) {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        // Зовсім немає навіть старих даних (перший офлайн-візит) —
        // повертаємо порожній масив, а не помилку, щоб фронтенд не впав.
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // ---------- Все інше: HTML-оболонка та статичні ресурси ----------
  if (event.request.mode === 'navigate' || url.pathname === '/') {
    // Network-first для самої сторінки — щоб не застрягти на старій версії
    // (сервер підставляє в неї ключі Supabase динамічно при кожному запиті).
    event.respondWith(
      fetch(event.request)
        .then(res => { caches.open(SHELL_CACHE).then(c => c.put(event.request, res.clone())); return res; })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Шрифти, supabase-js з CDN тощо — cache-first, рідко змінюються.
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(res => {
      caches.open(SHELL_CACHE).then(c => c.put(event.request, res.clone()));
      return res;
    }))
  );
});

// ---------- Background Sync (Chrome/Android; НЕ підтримується в Safari/iOS) ----------
self.addEventListener('sync', event => {
  if (event.tag === 'plyn-dnya-sync') {
    event.waitUntil(
      self.dayflowQueue.flushQueue().then(result => {
        // Повідомляємо всі відкриті вкладки, щоб оновили дані й показали тост.
        self.clients.matchAll().then(clients => {
          clients.forEach(c => c.postMessage({ type: 'dayflow-sync-complete', ...result }));
        });
      })
    );
  }
});
