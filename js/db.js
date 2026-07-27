/* ==========================================================================
   BetSmart AI — Couche de persistance (IndexedDB)
   Stores : bets (paris), settings (clé/valeur)
   ========================================================================== */
'use strict';

const DB = (() => {
  const NAME = 'betsmart';
  const VERSION = 3;
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
        if (!d.objectStoreNames.contains('transactions')) {
          const t = d.createObjectStore('transactions', { keyPath: 'id' });
          t.createIndex('date', 'date');
        }
        if (!d.objectStoreNames.contains('picks')) {
          const p = d.createObjectStore('picks', { keyPath: 'id' });
          p.createIndex('status', 'status');
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

  /* ---- Hooks de synchronisation (branchés par cloud.js) ---- */
  const hooks = { afterSaveBet: null, afterDeleteBet: null, afterSetSetting: null, afterSaveTx: null, afterDeleteTx: null, afterSavePick: null, afterDeletePick: null };

  /* ---- Paris ---- */
  async function getBets() {
    const d = await open();
    const req = d.transaction('bets', 'readonly').objectStore('bets').getAll();
    const bets = await reqToPromise(req);
    return bets.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));
  }

  function saveBet(bet, opts = {}) {
    if (!bet.id) bet.id = crypto.randomUUID();
    if (!bet.createdAt) bet.createdAt = Date.now();
    if (!opts.silent) bet.updatedAt = Date.now(); // les applications distantes gardent leur horodatage
    return tx('bets', 'readwrite', (s) => s.put(bet)).then(() => {
      if (!opts.silent) hooks.afterSaveBet?.(bet);
      return bet;
    });
  }

  function deleteBet(id, opts = {}) {
    return tx('bets', 'readwrite', (s) => s.delete(id)).then((r) => {
      if (!opts.silent) hooks.afterDeleteBet?.(id);
      return r;
    });
  }

  function clearBets() {
    return tx('bets', 'readwrite', (s) => s.clear());
  }

  /* ---- Transactions (dépôts / retraits / bonus) ---- */
  async function getTransactions() {
    const d = await open();
    const req = d.transaction('transactions', 'readonly').objectStore('transactions').getAll();
    const txs = await reqToPromise(req);
    return txs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));
  }

  function saveTransaction(t, opts = {}) {
    if (!t.id) t.id = crypto.randomUUID();
    if (!t.createdAt) t.createdAt = Date.now();
    if (!opts.silent) t.updatedAt = Date.now();
    return tx('transactions', 'readwrite', (s) => s.put(t)).then(() => {
      if (!opts.silent) hooks.afterSaveTx?.(t);
      return t;
    });
  }

  function deleteTransaction(id, opts = {}) {
    return tx('transactions', 'readwrite', (s) => s.delete(id)).then((r) => {
      if (!opts.silent) hooks.afterDeleteTx?.(id);
      return r;
    });
  }

  /* ---- Picks du Radar IA ---- */
  async function getPicks() {
    const d = await open();
    const req = d.transaction('picks', 'readonly').objectStore('picks').getAll();
    const picks = await reqToPromise(req);
    return picks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  function savePick(p, opts = {}) {
    if (!p.id) p.id = crypto.randomUUID();
    if (!p.createdAt) p.createdAt = Date.now();
    if (!opts.silent) p.updatedAt = Date.now();
    return tx('picks', 'readwrite', (s) => s.put(p)).then(() => {
      if (!opts.silent) hooks.afterSavePick?.(p);
      return p;
    });
  }

  function deletePick(id, opts = {}) {
    return tx('picks', 'readwrite', (s) => s.delete(id)).then((r) => {
      if (!opts.silent) hooks.afterDeletePick?.(id);
      return r;
    });
  }

  /* ---- Réglages ---- */
  async function getSetting(key, fallback = null) {
    const d = await open();
    const req = d.transaction('settings', 'readonly').objectStore('settings').get(key);
    const row = await reqToPromise(req);
    return row ? row.value : fallback;
  }

  function setSetting(key, value, opts = {}) {
    return tx('settings', 'readwrite', (s) => s.put({ key, value })).then((r) => {
      if (!opts.silent) hooks.afterSetSetting?.(key, value);
      return r;
    });
  }

  async function getAllSettings() {
    const d = await open();
    const req = d.transaction('settings', 'readonly').objectStore('settings').getAll();
    const rows = await reqToPromise(req);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /* ---- Export / Import ---- */
  async function exportAll() {
    const [bets, settings, transactions, picks] = await Promise.all([getBets(), getAllSettings(), getTransactions(), getPicks()]);
    delete settings.apiKey; // ne jamais exporter la clé API
    return { app: 'betsmart-ai', version: 3, exportedAt: new Date().toISOString(), settings, bets, transactions, picks };
  }

  async function importAll(data) {
    if (!data || data.app !== 'betsmart-ai' || !Array.isArray(data.bets)) {
      throw new Error('Fichier invalide : export BetSmart AI attendu.');
    }
    for (const bet of data.bets) await saveBet(bet);
    for (const t of data.transactions || []) await saveTransaction(t);
    for (const p of data.picks || []) await savePick(p);
    if (data.settings) {
      for (const [k, v] of Object.entries(data.settings)) {
        if (k !== 'apiKey') await setSetting(k, v);
      }
    }
    return data.bets.length;
  }

  /** Réglages propres à l'appareil (clés d'API, préférences d'affichage) :
      conservés lors d'un changement de compte, contrairement aux données de jeu. */
  const DEVICE_SETTINGS = ['apiKey', 'apiFootballKey', 'oddsApiKey', 'githubToken', 'model', 'notifyAlerts'];

  /** Efface toutes les données DE COMPTE (paris, transactions, picks, réglages de
      bankroll…). Utilisé au changement d'utilisateur pour garantir des comptes
      strictement indépendants. Les réglages d'appareil sont préservés. */
  async function clearAccountData() {
    const d = await open();
    const keep = {};
    for (const k of DEVICE_SETTINGS) {
      const v = await getSetting(k);
      if (v !== undefined && v !== null) keep[k] = v;
    }
    await reqToPromise(d.transaction('bets', 'readwrite').objectStore('bets').clear());
    await reqToPromise(d.transaction('picks', 'readwrite').objectStore('picks').clear());
    await reqToPromise(d.transaction('transactions', 'readwrite').objectStore('transactions').clear());
    await reqToPromise(d.transaction('settings', 'readwrite').objectStore('settings').clear());
    for (const [k, v] of Object.entries(keep)) await setSetting(k, v, { silent: true });
  }

  async function wipe() {
    await clearBets();
    const d = await open();
    await reqToPromise(d.transaction('picks', 'readwrite').objectStore('picks').clear());
    await reqToPromise(d.transaction('transactions', 'readwrite').objectStore('transactions').clear());
    return reqToPromise(d.transaction('settings', 'readwrite').objectStore('settings').clear());
  }

  return {
    getBets, saveBet, deleteBet,
    getTransactions, saveTransaction, deleteTransaction,
    getPicks, savePick, deletePick,
    getSetting, setSetting, getAllSettings,
    exportAll, importAll, wipe, clearAccountData, hooks
  };
})();
