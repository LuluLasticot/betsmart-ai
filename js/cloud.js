/* ==========================================================================
   BetSmart AI — Synchronisation cloud (Firebase Auth + Firestore)

   Architecture : IndexedDB reste la source d'affichage (l'app fonctionne
   sans compte). Une fois connecté, chaque écriture locale est répliquée
   dans Firestore (users/{uid}/…) et chaque changement distant est appliqué
   en local. Firestore gère lui-même la file hors-ligne.
   Le SDK est chargé à la demande (import dynamique) : zéro impact sur le
   temps de chargement tant que la synchro n'est pas utilisée.
   ========================================================================== */
'use strict';

const Cloud = (() => {
  const SDK = 'https://www.gstatic.com/firebasejs/11.6.1';
  const SYNCED_SETTINGS = ['initialBankroll', 'bookrolls', 'model', 'apiKey'];

  let mods = null;          // modules firebase importés
  let auth = null;
  let db = null;
  let user = null;
  let unsubBets = null;
  let unsubSettings = null;
  let onChange = null;      // rechargement UI (app.js)
  let onStatus = null;      // mise à jour du panneau compte (app.js)

  const isConfigured = () => typeof FIREBASE_CONFIG === 'object' && FIREBASE_CONFIG !== null && !!FIREBASE_CONFIG.apiKey;
  const isOn = () => !!user;

  /* ------------------------------------------------------------------
     Chargement paresseux du SDK
     ------------------------------------------------------------------ */
  async function load() {
    if (mods) return mods;
    const [appMod, authMod, fsMod] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`)
    ]);
    const app = appMod.initializeApp(FIREBASE_CONFIG);
    auth = authMod.getAuth(app);
    try {
      db = fsMod.initializeFirestore(app, {
        localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentSingleTabManager() })
      });
    } catch (_) {
      db = fsMod.getFirestore(app); // cache persistant indisponible (onglet multiple…)
    }
    mods = { ...authMod, ...fsMod };
    return mods;
  }

  /* ------------------------------------------------------------------
     Initialisation (appelée au démarrage de l'app)
     ------------------------------------------------------------------ */
  async function init(callbacks) {
    onChange = callbacks.onChange;
    onStatus = callbacks.onStatus;
    if (!isConfigured()) { onStatus?.({ state: 'unconfigured' }); return; }

    try {
      const m = await load();
      m.onAuthStateChanged(auth, async (u) => {
        user = u;
        stopSync();
        if (u) {
          onStatus?.({ state: 'connected', email: u.email });
          await startSync();
        } else {
          onStatus?.({ state: 'signedout' });
        }
      });
    } catch (err) {
      onStatus?.({ state: 'error', message: err.message });
    }
  }

  /* ------------------------------------------------------------------
     Authentification
     ------------------------------------------------------------------ */
  async function signUp(email, password) {
    const m = await load();
    await m.createUserWithEmailAndPassword(auth, email, password);
  }

  async function signIn(email, password) {
    const m = await load();
    await m.signInWithEmailAndPassword(auth, email, password);
  }

  async function signOutUser() {
    const m = await load();
    await m.signOut(auth);
  }

  /* ------------------------------------------------------------------
     Synchronisation
     ------------------------------------------------------------------ */
  const betsCol = () => mods.collection(db, 'users', user.uid, 'bets');
  const settingsDoc = () => mods.doc(db, 'users', user.uid, 'meta', 'settings');

  async function startSync() {
    const m = mods;

    // 1. Fusion initiale : le plus récent (updatedAt) gagne, sans perte de données.
    const [localBets, cloudSnap] = await Promise.all([DB.getBets(), m.getDocs(betsCol())]);
    const cloud = new Map();
    cloudSnap.forEach((d) => cloud.set(d.id, d.data()));

    for (const local of localBets) {
      const remote = cloud.get(local.id);
      if (!remote || (local.updatedAt || 0) > (remote.updatedAt || 0)) {
        await m.setDoc(m.doc(betsCol(), local.id), sanitize(local));
      }
    }
    for (const [id, remote] of cloud) {
      const local = localBets.find((b) => b.id === id);
      if (!local || (remote.updatedAt || 0) > (local.updatedAt || 0)) {
        await DB.saveBet({ ...remote, id }, { silent: true });
      }
    }

    // Réglages : le cloud fait foi s'il existe, sinon on y pousse le local.
    const sSnap = await m.getDoc(settingsDoc());
    if (sSnap.exists()) {
      await applyRemoteSettings(sSnap.data());
    } else {
      await pushSettings();
    }
    onChange?.();

    // 2. Écoute temps réel (les écritures locales en attente sont ignorées).
    unsubBets = m.onSnapshot(betsCol(), async (snap) => {
      if (snap.metadata.hasPendingWrites) return;
      let touched = false;
      for (const ch of snap.docChanges()) {
        if (ch.type === 'removed') {
          await DB.deleteBet(ch.doc.id, { silent: true });
          touched = true;
        } else {
          const remote = { ...ch.doc.data(), id: ch.doc.id };
          const local = (await DB.getBets()).find((b) => b.id === remote.id);
          if (!local || (remote.updatedAt || 0) > (local.updatedAt || 0)) {
            await DB.saveBet(remote, { silent: true });
            touched = true;
          }
        }
      }
      if (touched) onChange?.();
    });

    unsubSettings = m.onSnapshot(settingsDoc(), async (snap) => {
      if (snap.metadata.hasPendingWrites || !snap.exists()) return;
      await applyRemoteSettings(snap.data());
      onChange?.();
    });

    // 3. Réplication des écritures locales.
    DB.hooks.afterSaveBet = (bet) => {
      if (isOn()) m.setDoc(m.doc(betsCol(), bet.id), sanitize(bet)).catch(console.warn);
    };
    DB.hooks.afterDeleteBet = (id) => {
      if (isOn()) m.deleteDoc(m.doc(betsCol(), id)).catch(console.warn);
    };
    DB.hooks.afterSetSetting = (key) => {
      if (isOn() && SYNCED_SETTINGS.includes(key)) pushSettings().catch(console.warn);
    };
  }

  function stopSync() {
    unsubBets?.(); unsubSettings?.();
    unsubBets = unsubSettings = null;
    DB.hooks.afterSaveBet = DB.hooks.afterDeleteBet = DB.hooks.afterSetSetting = null;
  }

  async function pushSettings() {
    const all = await DB.getAllSettings();
    const subset = { updatedAt: Date.now() };
    for (const k of SYNCED_SETTINGS) if (all[k] !== undefined) subset[k] = all[k];
    await mods.setDoc(settingsDoc(), subset, { merge: true });
  }

  async function applyRemoteSettings(data) {
    for (const k of SYNCED_SETTINGS) {
      if (data[k] !== undefined) await DB.setSetting(k, data[k], { silent: true });
    }
  }

  /** Firestore refuse `undefined` : on nettoie l'objet avant écriture. */
  function sanitize(bet) {
    const clean = {};
    for (const [k, v] of Object.entries(bet)) if (v !== undefined) clean[k] = v;
    return clean;
  }

  /** Messages d'erreur Firebase → français lisible. */
  function friendlyError(err) {
    const code = err?.code || '';
    const map = {
      'auth/invalid-email': 'Adresse email invalide.',
      'auth/email-already-in-use': 'Un compte existe déjà avec cet email — utilisez "Se connecter".',
      'auth/weak-password': 'Mot de passe trop court (6 caractères minimum).',
      'auth/invalid-credential': 'Email ou mot de passe incorrect.',
      'auth/wrong-password': 'Email ou mot de passe incorrect.',
      'auth/user-not-found': 'Aucun compte avec cet email — utilisez "Créer un compte".',
      'auth/too-many-requests': 'Trop de tentatives — réessayez dans quelques minutes.',
      'auth/network-request-failed': 'Pas de connexion internet.'
    };
    return map[code] || err?.message || 'Erreur inconnue.';
  }

  return { init, signUp, signIn, signOutUser, isConfigured, isOn, friendlyError };
})();
