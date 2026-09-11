// idb-queue.js
// Спільний модуль для сторінки (index.html) і Service Worker (sw.js).
// Тримає чергу невдалих мутацій до Supabase та вміє її "програвати" назад.
(function (root) {
  const DB_NAME = 'dayflow-offline';
  const DB_VERSION = 1;
  const STORE = 'mutation-queue';

  // Заголовки, які небезпечно/безглуздо повторно виставляти вручну при replay.
  const HEADER_DENYLIST = new Set(['host', 'content-length', 'connection']);

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function enqueue(entry) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add({ ...entry, queuedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function remove(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function count() {
    const items = await getAll();
    return items.length;
  }

  // Серіалізує Request у звичайний об'єкт, придатний для IndexedDB
  // (сам Request/Headers зберігати не можна — тільки прості значення).
  async function serializeRequest(request) {
    const headers = [];
    for (const [k, v] of request.headers.entries()) {
      if (!HEADER_DENYLIST.has(k.toLowerCase())) headers.push([k, v]);
    }
    let body = null;
    try { body = await request.clone().text(); } catch (e) { /* GET без тіла */ }
    return { url: request.url, method: request.method, headers, body: body || null };
  }

  // Програвання черги по одній мутації за раз, у порядку додавання (FIFO),
  // щоб пізніші зміни того самого завдання не випередили ранні.
  // Зупиняється на першій-ліпшій невдачі, щоб не порушити порядок.
  async function flushQueue(onProgress) {
    const items = await getAll();
    items.sort((a, b) => a.id - b.id);
    let synced = 0, authFailed = false;

    for (const item of items) {
      let response;
      try {
        response = await fetch(item.url, {
          method: item.method,
          headers: item.headers,
          body: item.body || undefined
        });
      } catch (err) {
        break; // все ще офлайн — зупиняємось, спробуємо пізніше
      }

      if (response.status === 401 || response.status === 403) {
        authFailed = true;
        break; // токен протух — далі проганяти немає сенсу, лишаємо в черзі
      }
      if (!response.ok) {
        break; // інша помилка сервера — не видаляємо, спробуємо ще раз пізніше
      }

      await remove(item.id);
      synced++;
      if (onProgress) onProgress(synced, items.length);
    }

    return { synced, remaining: (await count()), authFailed };
  }

  root.dayflowQueue = { enqueue, getAll, remove, count, serializeRequest, flushQueue };
})(typeof self !== 'undefined' ? self : this);
