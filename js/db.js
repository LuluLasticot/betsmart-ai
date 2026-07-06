/* ==========================================================================
   BetSmart AI — Couche de persistance (IndexedDB)
   Stores : bets (paris), settings (clé/valeur)
   ========================================================================== */
'use strict';

const DB = (() => {
  const NAME = 'betsmart';
  const VERSION = 1;
  let db = null;

  function open() {
    if (db) return Promise.resolve(db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('bets')) {
          const store = d.createObjectStore('bets', { keyPath: 'id' });
          store.createIndex('date', 'date');
          store.createIndex('status', 'status');
        }
        if (!d.objectStoreNames.contains('settings')) {
          d.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode, fn) {
    return open().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      const result = fn(s);
      t.oncomplete = () => resolve(result && result._value !== undefined ? result._value : result);
      t.onerror = () => reject(t.error);
    }));
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /* ---- Paris ---- */
  async function getBets() {
    const d = await open();
    const req = d.transaction('bets', 'readonly').objectStore('bets').getAll();
    const bets = await reqToPromise(req);
    return bets.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));
  }

  function saveBet(bet) {
    if (!bet.id) bet.id = crypto.randomUUID();
    if (!bet.createdAt) bet.createdAt = Date.now();
    return tx('bets', 'readwrite', (s) => s.put(bet)).then(() => bet);
  }

  function deleteBet(id) {
    return tx('bets', 'readwrite', (s) => s.delete(id));
  }

  function clearBets() {
    return tx('bets', 'readwrite', (s) => s.clear());
  }

  /* ---- Réglages ---- */
  async function getSetting(key, fallback = null) {
    const d = await open();
    const req = d.transaction('settings', 'readonly').objectStore('settings').get(key);
    const row = await reqToPromise(req);
    return row ? row.value : fallback;
  }

  function setSetting(key, value) {
    return tx('settings', 'readwrite', (s) => s.put({ key, value }));
  }

  async function getAllSettings() {
    const d = await open();
    const req = d.transaction('settings', 'readonly').objectStore('settings').getAll();
    const rows = await reqToPromise(req);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /* ---- Export / Import ---- */
  async function exportAll() {
    const [bets, settings] = await Promise.all([getBets(), getAllSettings()]);
    delete settings.apiKey; // ne jamais exporter la clé API
    return { app: 'betsmart-ai', version: 1, exportedAt: new Date().toISOString(), settings, bets };
  }

  async function importAll(data) {
    if (!data || data.app !== 'betsmart-ai' || !Array.isArray(data.bets)) {
      throw new Error('Fichier invalide : export BetSmart AI attendu.');
    }
    for (const bet of data.bets) await saveBet(bet);
    if (data.settings) {
      for (const [k, v] of Object.entries(data.settings)) {
        if (k !== 'apiKey') await setSetting(k, v);
      }
    }
    return data.bets.length;
  }

  async function wipe() {
    await clearBets();
    const d = await open();
    return reqToPromise(d.transaction('settings', 'readwrite').objectStore('settings').clear());
  }

  return { getBets, saveBet, deleteBet, getSetting, setSetting, getAllSettings, exportAll, importAll, wipe };
})();
