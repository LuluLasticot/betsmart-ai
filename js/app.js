/* ==========================================================================
   BetSmart AI — Application
   ========================================================================== */
'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  /* ---- État ---- */
  const DEFAULT_SETTINGS = () => ({
    initialBankroll: 500, apiKey: '', oddsApiKey: '', apiFootballKey: '', githubToken: '',
    oddsSource: 'coteur', model: 'gemini-2.5-flash', bookrolls: [], stakingMode: 'kelly',
    maxExposurePct: 25, notifyAlerts: false, currency: 'EUR', showEurEquiv: true, freeTierGuard: false
  });
  const state = {
    bets: [],
    txs: [],
    picks: [],
    settings: DEFAULT_SETTINGS(),
    period: 'all',
    view: 'dashboard',
    charts: {},
    scanQueue: [],
    betsPage: 1,
    geminiModels: null
  };

  const APP_VERSION = 'v78';

  /** Devises déclarées sur les bookmakers (pour précharger les cours). */
  const bookCurrencies = () => (state.settings.bookrolls || []).map((b) => b.currency).filter(Boolean);

  /** Devise d'un bookmaker (par son nom) — sert à la saisie des montants. */
  function bookCurrency(name) {
    const n = String(name || '').trim().toLowerCase();
    const b = (state.settings.bookrolls || []).find((x) => (x.name || '').trim().toLowerCase() === n);
    return (b && b.currency) || state.settings.currency || 'EUR';
  }

  /** Capital initial effectif, exprimé dans la devise principale (conversion si besoin). */
  function effInitial() {
    const main = state.settings.currency || 'EUR';
    const br = (state.settings.bookrolls || []).filter((b) => b.name && b.name.trim());
    if (!br.length) return Number(state.settings.initialBankroll) || 0;
    return br.reduce((s, b) => {
      const v = Number(b.initial) || 0;
      const conv = Money.convert(v, b.currency || main, main);
      return s + (conv === null ? v : conv); // cours indisponible → valeur brute
    }, 0);
  }

  const STATUS_LABELS = { pending: 'En attente', won: 'Gagné', lost: 'Perdu', void: 'Annulé', cashout: 'Cash out' };
  const TYPE_LABELS = { simple: 'Simple', combine: 'Combiné', systeme: 'Système' };

  /* ========================================================================
     Initialisation
     ======================================================================== */
  /** Aligne les modèles Gemini utilisés sur ceux réellement disponibles avec la clé
      (Google retire régulièrement les anciens : aucun nom n'est figé dans le code). */
  async function syncGeminiModels({ force = false } = {}) {
    if (!state.settings.apiKey) return null;
    try {
      const m = await Gemini.resolveModels(state.settings.apiKey, { force });
      state.geminiModels = m;
      // Le modèle enregistré n'existe plus (ou est vide) → on prend le meilleur dispo
      if (m.flash && !(m.all || []).includes(state.settings.model)) {
        state.settings.model = m.flash;
        await DB.setSetting('model', m.flash);
      }
      renderModelOptions();
      return m;
    } catch (_) { return null; }
  }

  /** Garde-fous de débit : actifs uniquement si l'utilisateur est resté en free tier. */
  function applyQuotaLimits() {
    const guard = state.settings.freeTierGuard === true;
    Gemini.quota.setLimits(guard ? { rpm: 5, rpd: 20 } : {});
  }

  /** Consommation Gemini du jour (le free tier est la vraie ressource rare). */
  function renderQuotaInfo() {
    const el = document.getElementById('quotaInfo');
    if (!el || typeof Gemini === 'undefined' || !Gemini.quota) return;
    const u = Gemini.quota.usage();
    const capped = isFinite(u.rpd);
    const left = capped ? Math.max(0, u.rpd - u.day) : null;
    el.innerHTML = `Requêtes Gemini aujourd'hui : <strong>${u.day}</strong>`
      + (capped ? ` / ${u.rpd} (garde-fou free tier)${left > 0 ? ` · ≈ ${Math.floor(left / 2)} scan(s)` : ' · plafond atteint'}` : ' · aucune limite (facturation active)');
    el.style.color = (capped && left <= 2) ? 'var(--red)' : '';
  }

  /** Remplit la liste des modèles avec ceux réellement disponibles. */
  function renderModelOptions() {
    const sel = document.getElementById('setModel');
    if (!sel) return;
    const m = state.geminiModels;
    const ids = (m && m.all && m.all.length) ? m.all : [state.settings.model].filter(Boolean);
    sel.innerHTML = ids.map((id) => {
      const tag = m && id === m.flash ? ' — rapide (recommandé)' : (m && id === m.pro ? ' — approfondi' : '');
      return `<option value="${escapeHTML(id)}"${id === state.settings.model ? ' selected' : ''}>${escapeHTML(id)}${tag}</option>`;
    }).join('');
    const hint = document.getElementById('modelHint');
    if (hint && m) hint.textContent = `Détecté automatiquement : ${ids.length} modèle(s) disponible(s) avec votre clé. Rapide : ${m.flash}${m.pro && m.pro !== m.flash ? ` · Approfondi : ${m.pro}` : ''}.`;
  }

  async function init() {
    const saved = await DB.getAllSettings();
    Object.assign(state.settings, saved);
    applyQuotaLimits();
    syncGeminiModels().catch(() => {});
    Money.setCurrency(state.settings.currency, state.settings.showEurEquiv);
    Money.ensureRates(bookCurrencies()).then(() => { applyCurrencyUI(); renderAll(); }).catch(() => {});
    [state.bets, state.txs, state.picks] = await Promise.all([DB.getBets(), DB.getTransactions(), DB.getPicks()]);

    bindNav();
    bindModal();
    bindTxModal();
    bindFilters();
    restoreFilters();
    bindSettings();
    bindCoach();
    bindAdvisor();
    bindSettle();
    bindPaste();
    bindLive();
    maybeOnboard();

    const vb = document.getElementById('versionBadge');
    if (vb) vb.textContent = APP_VERSION;

    renderAll();
    renderTxList();
    setTimeout(captureCLV, 3000); // capture différée de la CLV des picks dont le match a commencé

    // Synchronisation cloud (chargée en arrière-plan, sans bloquer l'affichage)
    bindCloud();
    Cloud.init({
      onChange: async () => {
        const saved = await DB.getAllSettings();
        // Repartir des valeurs par défaut : au changement de compte, les réglages
        // de l'ancien compte (bankroll, books…) ne doivent pas persister en mémoire.
        state.settings = Object.assign(DEFAULT_SETTINGS(), saved);
        Money.setCurrency(state.settings.currency, state.settings.showEurEquiv);
        [state.bets, state.txs, state.picks] = await Promise.all([DB.getBets(), DB.getTransactions(), DB.getPicks()]);
        renderRadarPerf();
        bindSettingsValues();
        renderBookrollRows();
        renderAll();
        renderTxList();
      },
      onStatus: updateCloudPanel
    });

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      // updateViaCache:'none' garantit que les nouvelles versions arrivent dès le rechargement
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    }
  }

  /* ========================================================================
     Compte & synchronisation cloud
     ======================================================================== */
  let cloudState = { state: 'loading' };
  let authMode = 'signin';

  function updateCloudPanel(status) {
    const wasConnected = cloudState.state === 'connected';
    cloudState = status;

    // Réglages
    $('#cloudUnconfigured').hidden = status.state !== 'unconfigured' && status.state !== 'error';
    $('#cloudSignedOut').hidden = status.state !== 'signedout';
    $('#cloudSignedIn').hidden = status.state !== 'connected';

    // Sidebar
    const canAuth = status.state === 'signedout' || status.state === 'connected';
    $('#sidebarAccount').style.display = canAuth ? '' : 'none';
    $('#sidebarAccountLabel').textContent = status.state === 'connected' ? status.email : 'Se connecter';
    $('#sidebarAccountDot').hidden = status.state !== 'connected';

    // Bannière dashboard (masquable pour la session)
    $('#syncBanner').hidden = !(status.state === 'signedout' && !sessionStorage.getItem('hideSyncBanner'));

    if (status.state === 'connected') {
      $('#cloudUserEmail').textContent = status.email;
      closeAuthModal();
      if (!wasConnected) toast('Synchronisation active ✓');
    }
    if (status.state === 'error') {
      const el = $('#cloudError');
      el.textContent = `Initialisation impossible : ${status.message}`;
      el.className = 'api-test ko';
    }
  }

  function openAuthModal(mode = 'signin') {
    if (cloudState.state === 'connected') { showView('settings'); return; }
    setAuthMode(mode);
    $('#authError').hidden = true;
    $('#authModal').hidden = false;
    document.body.style.overflow = 'hidden';
    $('#authEmail').focus();
  }

  function closeAuthModal() {
    if ($('#authModal').hidden) return;
    $('#authModal').hidden = true;
    document.body.style.overflow = '';
  }

  function setAuthMode(mode) {
    authMode = mode;
    $('#tabSignIn').classList.toggle('active', mode === 'signin');
    $('#tabSignUp').classList.toggle('active', mode === 'signup');
    $('#authConfirmField').hidden = mode === 'signin';
    $('#authSubmit').textContent = mode === 'signin' ? 'Se connecter' : 'Créer mon compte';
    $('#authIntro').textContent = mode === 'signin'
      ? 'Retrouvez vos paris synchronisés sur cet appareil.'
      : 'Vos paris et réglages seront synchronisés en temps réel sur tous vos appareils.';
    $('#authPassword').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  }

  function showAuthError(msg) {
    const el = $('#authError');
    el.textContent = msg;
    el.hidden = false;
  }

  function bindCloud() {
    // Points d'entrée
    $('#sidebarAccount').addEventListener('click', () => openAuthModal('signin'));
    $('#cloudOpenAuth').addEventListener('click', () => openAuthModal('signin'));
    $('#syncBannerBtn').addEventListener('click', () => openAuthModal('signup'));
    $('#syncBannerClose').addEventListener('click', () => {
      sessionStorage.setItem('hideSyncBanner', '1');
      $('#syncBanner').hidden = true;
    });

    // Modal
    $('#closeAuthModal').addEventListener('click', closeAuthModal);
    $('#authModal').addEventListener('click', (e) => { if (e.target === $('#authModal')) closeAuthModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#authModal').hidden) closeAuthModal(); });
    $('#tabSignIn').addEventListener('click', () => setAuthMode('signin'));
    $('#tabSignUp').addEventListener('click', () => setAuthMode('signup'));

    $('#authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#authError').hidden = true;
      const email = $('#authEmail').value.trim();
      const password = $('#authPassword').value;

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showAuthError('Adresse email invalide.');
      if (password.length < 6) return showAuthError('Mot de passe trop court (6 caractères minimum).');
      if (authMode === 'signup' && password !== $('#authConfirm').value) return showAuthError('Les deux mots de passe ne correspondent pas.');

      const btn = $('#authSubmit');
      btn.disabled = true;
      btn.textContent = authMode === 'signin' ? 'Connexion…' : 'Création du compte…';
      try {
        if (authMode === 'signin') await Cloud.signIn(email, password);
        else await Cloud.signUp(email, password);
        // updateCloudPanel('connected') ferme la modal et affiche le toast
      } catch (err) {
        showAuthError(Cloud.friendlyError(err));
      } finally {
        btn.disabled = false;
        setAuthMode(authMode);
      }
    });

    $('#authForgot').addEventListener('click', async () => {
      const email = $('#authEmail').value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showAuthError('Entrez d\'abord votre email ci-dessus, puis recliquez.');
      try {
        await Cloud.resetPassword(email);
        $('#authError').hidden = true;
        toast(`Email de réinitialisation envoyé à ${email}`);
      } catch (err) {
        showAuthError(Cloud.friendlyError(err));
      }
    });

    // Déconnexion (Réglages)
    $('#cloudSignOut').addEventListener('click', async () => {
      if (!confirm('Se déconnecter ? Les données restent sur cet appareil et dans le cloud.')) return;
      await Cloud.signOutUser();
      toast('Déconnecté');
    });
  }

  function renderAll() {
    renderDashboard();
    renderBets();
    renderSidebarBankroll();
  }

  /* ========================================================================
     Navigation
     ======================================================================== */
  function bindNav() {
    $$('.nav-item').forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.view)));
    $$('[data-goto]').forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.goto)));
    $$('.period-btn').forEach((btn) => btn.addEventListener('click', () => {
      state.period = btn.dataset.period;
      $$('.period-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderDashboard();
    }));
    $('#fab').addEventListener('click', () => openBetModal());
    $('#fabMobile').addEventListener('click', () => openBetModal());
  }

  function showView(view) {
    state.view = view;
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    if (view === 'dashboard') renderDashboard();
    if (view === 'bets') renderBets();
    if (view === 'analytics') renderAnalytics();
  }

  /* ========================================================================
     Dashboard
     ======================================================================== */
  function renderDashboard() {
    const bets = Stats.inPeriod(state.bets, state.period);
    const txs = Stats.inPeriod(state.txs, state.period);
    const k = Stats.kpis(bets, effInitial(), txs);
    const series = Stats.bankrollSeries(bets, effInitial(), txs);
    const dd = Stats.maxDrawdown(series);

    $('#dashboardSub').textContent = state.period === 'all'
      ? `${k.count} paris enregistrés · ${k.pendingCount} en attente (${Stats.fmtMoney(k.pendingStake)} engagés)`
      : `${k.count} paris sur les ${state.period} derniers jours`;

    const cls = (n) => (n > 0.001 ? 'pos' : n < -0.001 ? 'neg' : '');
    $('#kpiGrid').innerHTML = [
      kpiCard('Bankroll', Stats.fmtMoney(k.bankroll), cls(k.profit), `Investi : ${Stats.fmtMoney(k.invested)}`),
      kpiCard('Bénéfice net', Stats.fmtSigned(k.profit), cls(k.profit), `${Stats.fmtMoney(k.totalStaked)} misés`),
      kpiCard('ROI', Stats.fmtPct(k.roi), cls(k.roi), 'Profit / total misé'),
      kpiCard('ROC', Stats.fmtPct(k.roc), cls(k.roc), 'Profit / capital investi'),
      kpiCard('Hit rate', `${k.hitRate.toFixed(0)} %`, '', `${k.won} gagnés · ${k.lost} perdus`),
      kpiCard('Drawdown max', dd.amount > 0 ? `−${Stats.fmtMoney(dd.amount)}` : '—', dd.amount > 0 ? 'neg' : '', dd.amount > 0 ? `Pire chute : −${dd.pct} % du pic` : 'Aucune chute mesurée')
    ].join('');

    renderBankrollChart(series);
    renderDoughnut('sportChart', Stats.groupBy(bets, 'sport'));
    renderBarChart('bookmakerChart', Stats.groupBy(bets, 'bookmaker'));
    renderMonthlyChart(bets);
    renderOddsBreakdown(bets);
    renderBookrollPanel();
    renderRecentBets(bets);
    renderSidebarBankroll();
    updateLiveVisibility();
    renderLiveStrip();
  }

  function updateLiveVisibility() {
    const show = todaysPendingBets().length > 0;
    if ($('#liveBox')) $('#liveBox').hidden = !show;
    if ($('#liveBoxMobile')) $('#liveBoxMobile').hidden = !show;
  }

  /** Bandeau dashboard : paris en direct + imminents, mis en avant avec score et compte à rebours. */
  function renderLiveStrip() {
    const el = $('#liveStrip');
    if (!el) return;
    const items = state.bets
      .filter((b) => b.status === 'pending')
      .map((b) => ({ b, p: betPhase(b) }))
      .filter((o) => o.p.phase === 'live' || o.p.phase === 'soon')
      .sort((a, c) => (PHASE_ORDER[a.p.phase] - PHASE_ORDER[c.p.phase]) || ((a.p.ko || 0) - (c.p.ko || 0)));

    if (!items.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const liveN = items.filter((o) => o.p.phase === 'live').length;
    el.innerHTML = `<div class="live-strip-head"><span class="live-dot"></span>À suivre maintenant<span class="live-strip-count">${liveN ? liveN + ' en direct' : items.length + ' imminent' + (items.length > 1 ? 's' : '')}</span></div>
      <div class="live-strip-list">${items.map(({ b, p }) => {
        const teams = escapeHTML((b.event || '').replace(/\s*[–—-]\s*/g, ' – '));
        const tag = p.phase === 'live'
          ? `<span class="ls-tag live"><span class="live-dot"></span>EN DIRECT${p.score ? ' · ' + escapeHTML(p.score) : ''}${p.min ? ' · ' + escapeHTML(p.min) : ''}</span>`
          : `<span class="ls-tag soon">⏱ dans ${fmtCountdown(p.ko - Date.now())}</span>`;
        return `<div class="ls-card ${p.phase}" data-id="${b.id}">
          <div class="ls-top">${tag}<span class="ls-odds">${Number(b.odds).toFixed(2)}</span></div>
          <div class="ls-teams">${teams}</div>
          <div class="ls-meta">${escapeHTML(b.selection)} · ${Stats.fmtMoney(Number(b.stake))} misés</div>
        </div>`;
      }).join('')}</div>`;
  }

  function renderMonthlyChart(bets) {
    destroyChart('monthlyChart');
    const months = Stats.monthlyProfit(bets);
    const labels = months.map((m) => new Date(m.month + '-01T00:00:00').toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }));
    state.charts.monthlyChart = new Chart($('#monthlyChart'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: months.map((m) => m.profit),
          backgroundColor: months.map((m) => (m.profit >= 0 ? 'rgba(52,211,153,0.75)' : 'rgba(240,101,95,0.75)')),
          borderRadius: 5,
          maxBarThickness: 30
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1d212a', borderColor: '#2e3340', borderWidth: 1, padding: 10, displayColors: false,
            callbacks: { label: (item) => Stats.fmtSigned(item.parsed.y) }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: chartDefaults.color, font: chartDefaults.font }, border: { color: chartDefaults.borderColor } },
          y: { grid: { color: 'rgba(34,38,47,0.6)' }, ticks: { color: chartDefaults.color, font: chartDefaults.font, callback: (v) => Stats.fmtMoney(v) }, border: { display: false } }
        }
      }
    });
  }

  function renderOddsBreakdown(bets) {
    const rows = Stats.oddsBreakdown(bets);
    $('#oddsBreakdown').innerHTML = rows.length
      ? `<div class="col-headers odds-grid"><span>Cotes</span><span class="r">Paris</span><span class="r">Réussite</span><span class="r">ROI</span><span class="r">P/L</span></div>`
        + rows.map((r) => {
          const cls = r.profit > 0.001 ? 'pos' : r.profit < -0.001 ? 'neg' : 'zero';
          return `<div class="bet-row odds-grid">
            <div class="bet-event">${r.label}</div>
            <div class="bet-num">${r.count}</div>
            <div class="bet-num">${r.hitRate.toFixed(0)} %</div>
            <div class="bet-profit ${cls}">${Stats.fmtPct(r.roi)}</div>
            <div class="bet-profit ${cls}">${Stats.fmtSigned(r.profit)}</div>
          </div>`;
        }).join('')
      : '<div class="empty-state"><p>Réglez quelques paris pour voir où vos cotes sont rentables.</p></div>';
  }

  /** Détail de bankroll par bookmaker (toujours sur l'ensemble de l'historique). */
  function renderBookrollPanel() {
    const rows = Stats.bookmakerBreakdown(state.bets, state.settings.bookrolls || [], state.txs);
    const panel = $('#bookrollPanel');
    if (!rows.length) { panel.hidden = true; return; }
    panel.hidden = false;

    $('#bookrollList').innerHTML =
      `<div class="col-headers bookroll-grid"><span>Bookmaker</span><span class="r hide-m">Paris</span><span class="r hide-m">Départ</span><span class="r">P/L</span><span class="r hide-m">ROI</span><span class="r">Bankroll</span></div>`
      + rows.map((r) => {
        const cls = r.profit > 0.001 ? 'pos' : r.profit < -0.001 ? 'neg' : 'zero';
        return `<div class="bet-row bookroll-grid">
          <div class="bet-main"><div class="bet-event">${escapeHTML(r.name)}</div>${!r.hasInitial ? '<div class="bet-meta">capital de départ non renseigné</div>' : `<div class="bet-meta">${[r.moves !== 0 ? `${Stats.fmtSigned(r.moves)} de mouvements` : '', r.pendingStake > 0 ? `${Stats.fmtMoney(r.pendingStake)} en attente` : ''].filter(Boolean).join(' · ') || '&nbsp;'}</div>`}</div>
          <div class="bet-num hide-m">${r.count}</div>
          <div class="bet-num hide-m">${r.hasInitial ? Stats.fmtMoney(r.initial) : '—'}</div>
          <div class="bet-profit ${cls}">${Stats.fmtSigned(r.profit)}</div>
          <div class="bet-profit ${cls} hide-m">${r.staked > 0 ? Stats.fmtPct(r.roi) : '—'}</div>
          <div class="bet-num strong">${r.hasInitial ? Stats.fmtMoney(r.bankroll) : '—'}</div>
        </div>`;
      }).join('');
  }

  function kpiCard(label, value, cls, sub) {
    return `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value ${cls}">${value}</div><div class="kpi-sub">${sub}</div></div>`;
  }

  function renderSidebarBankroll() {
    const k = Stats.kpis(state.bets, effInitial(), state.txs);
    const brEur = Money.eurHint(k.bankroll);
    $('#sidebarBankroll').innerHTML = escapeHTML(Stats.fmtMoney(k.bankroll))
      + (brEur ? `<span class="bankroll-eur">${escapeHTML(brEur)}</span>` : '');
    $('#sidebarBankroll').style.color = k.profit > 0 ? 'var(--accent)' : k.profit < 0 ? 'var(--red)' : 'var(--text)';
  }

  /* ---- Graphiques ---- */
  const chartDefaults = {
    color: '#9aa1b0',
    borderColor: '#22262f',
    font: { family: "'Inter', sans-serif", size: 11 }
  };

  function destroyChart(id) {
    if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
  }

  function renderBankrollChart(points) {
    destroyChart('bankroll');
    const ctx = $('#bankrollChart').getContext('2d');
    const labels = points.map((p) => p.x);
    const values = points.map((p) => p.y);
    const up = values[values.length - 1] >= values[0];
    const color = up ? '#34d399' : '#f0655f';

    const gradient = ctx.createLinearGradient(0, 0, 0, 280);
    gradient.addColorStop(0, up ? 'rgba(52,211,153,0.18)' : 'rgba(240,101,95,0.18)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');

    state.charts.bankroll = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: color,
          backgroundColor: gradient,
          fill: true,
          borderWidth: 2,
          pointRadius: values.length > 40 ? 0 : 2.5,
          pointBackgroundColor: color,
          tension: 0.32
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1d212a',
            borderColor: '#2e3340',
            borderWidth: 1,
            titleFont: chartDefaults.font,
            bodyFont: { ...chartDefaults.font, family: "'JetBrains Mono', monospace" },
            padding: 10,
            displayColors: false,
            callbacks: {
              title: (items) => points[items[0].dataIndex].label || items[0].label,
              label: (item) => Stats.fmtMoney(item.parsed.y)
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: chartDefaults.color, font: chartDefaults.font, maxTicksLimit: 8 }, border: { color: chartDefaults.borderColor } },
          y: { grid: { color: 'rgba(34,38,47,0.6)' }, ticks: { color: chartDefaults.color, font: chartDefaults.font, callback: (v) => Stats.fmtMoney(v) }, border: { display: false } }
        }
      }
    });
  }

  const PALETTE = ['#34d399', '#5b8def', '#e8b45a', '#c084fc', '#f0655f', '#38bdf8', '#a3b18a', '#f472b6'];

  function renderDoughnut(canvasId, groups) {
    destroyChart(canvasId);
    const top = groups.slice(0, 8);
    state.charts[canvasId] = new Chart($(`#${canvasId}`), {
      type: 'doughnut',
      data: {
        labels: top.map((g) => g.name),
        datasets: [{
          data: top.map((g) => Math.round(g.staked * 100) / 100),
          backgroundColor: PALETTE,
          borderColor: '#111318',
          borderWidth: 3,
          hoverOffset: 5
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          legend: { position: 'right', labels: { color: chartDefaults.color, font: chartDefaults.font, boxWidth: 9, boxHeight: 9, padding: 10, usePointStyle: true } },
          tooltip: {
            backgroundColor: '#1d212a', borderColor: '#2e3340', borderWidth: 1, padding: 10,
            callbacks: {
              label: (item) => {
                const g = top[item.dataIndex];
                return ` ${Stats.fmtMoney(g.staked)} misés · ROI ${Stats.fmtPct(g.roi)}`;
              }
            }
          }
        }
      }
    });
  }

  function renderBarChart(canvasId, groups) {
    destroyChart(canvasId);
    const top = groups.slice(0, 8);
    state.charts[canvasId] = new Chart($(`#${canvasId}`), {
      type: 'bar',
      data: {
        labels: top.map((g) => g.name),
        datasets: [{
          data: top.map((g) => Math.round(g.profit * 100) / 100),
          backgroundColor: top.map((g) => (g.profit >= 0 ? 'rgba(52,211,153,0.75)' : 'rgba(240,101,95,0.75)')),
          borderRadius: 5,
          maxBarThickness: 34
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1d212a', borderColor: '#2e3340', borderWidth: 1, padding: 10, displayColors: false,
            callbacks: { label: (item) => `Profit : ${Stats.fmtSigned(item.parsed.y)}` }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: chartDefaults.color, font: chartDefaults.font }, border: { color: chartDefaults.borderColor } },
          y: { grid: { color: 'rgba(34,38,47,0.6)' }, ticks: { color: chartDefaults.color, font: chartDefaults.font, callback: (v) => Stats.fmtMoney(v) }, border: { display: false } }
        }
      }
    });
  }

  function renderRecentBets(bets) {
    const recent = bets.slice(0, 5);
    $('#recentBets').innerHTML = recent.length
      ? recent.map(betRowHTML).join('')
      : '<div class="empty-state"><p>Aucun pari pour l\'instant. Ajoutez votre premier ticket avec le bouton <strong>+</strong>.</p></div>';
    bindBetRowActions($('#recentBets'));
  }

  /* ========================================================================
     Liste des paris
     ======================================================================== */
  const FILTER_IDS = ['filterStatus', 'filterSport', 'filterCompetition', 'filterBookmaker', 'filterType', 'filterTipster'];

  function bindFilters() {
    FILTER_IDS.forEach((id) =>
      $(`#${id}`).addEventListener('change', () => { state.betsPage = 1; persistFilters(); renderBets(); }));
    $('#filterSearch').addEventListener('input', debounce(() => { state.betsPage = 1; renderBets(); }, 180));
  }

  function persistFilters() {
    try {
      localStorage.setItem('betFilters', JSON.stringify(Object.fromEntries(FILTER_IDS.map((id) => [id, $(`#${id}`).value]))));
    } catch (_) { /* stockage indisponible */ }
  }

  function restoreFilters() {
    try {
      const saved = JSON.parse(localStorage.getItem('betFilters') || '{}');
      refreshFilterOptions();
      for (const [id, v] of Object.entries(saved)) if ($(`#${id}`)) $(`#${id}`).value = v;
    } catch (_) { /* ignore */ }
  }

  function refreshFilterOptions() {
    fillOptions('#filterSport', 'Sport · tous', [...new Set(state.bets.map((b) => b.sport).filter(Boolean))].sort());
    // Compétitions canoniques (dé-doublonnées), en respectant le filtre sport actif
    const compSport = $('#filterSport') ? $('#filterSport').value : '';
    const comps = [...new Set(state.bets
      .filter((b) => b.competition && (!compSport || b.sport === compSport))
      .map((b) => Analytics.canonComp(b.competition)))].sort((a, b) => a.localeCompare(b));
    fillOptions('#filterCompetition', 'Compétition · toutes', comps);
    fillOptions('#filterBookmaker', 'Bookmaker · tous', [...new Set(state.bets.map((b) => b.bookmaker).filter(Boolean))].sort());
    const tipsters = [...new Set(state.bets.map((b) => b.tipster).filter(Boolean))].sort();
    $('#filterTipster').parentElement && ($('#filterTipster').style.display = tipsters.length ? '' : 'none');
    fillOptions('#filterTipster', 'Tipster · tous', tipsters);
    $('#tipsterList').innerHTML = tipsters.map((t) => `<option>${escapeHTML(t)}</option>`).join('');
  }

  function fillOptions(sel, placeholder, values) {
    const el = $(sel);
    const current = el.value;
    el.innerHTML = `<option value="">${placeholder}</option>` + values.map((v) => `<option value="${escapeHTML(v)}">${escapeHTML(v)}</option>`).join('');
    if (values.includes(current)) el.value = current;
  }

  function filteredBets() {
    const status = $('#filterStatus').value;
    const sport = $('#filterSport').value;
    const competition = $('#filterCompetition').value;
    const bookmaker = $('#filterBookmaker').value;
    const type = $('#filterType').value;
    const tipster = $('#filterTipster').value;
    const q = $('#filterSearch').value.trim().toLowerCase();

    return state.bets.filter((b) =>
      (!status || b.status === status) &&
      (!sport || b.sport === sport) &&
      (!competition || Analytics.canonComp(b.competition) === competition) &&
      (!bookmaker || b.bookmaker === bookmaker) &&
      (!type || b.betType === type) &&
      (!tipster || b.tipster === tipster) &&
      (!q || `${b.event} ${b.selection} ${b.competition || ''} ${b.tipster || ''}`.toLowerCase().includes(q))
    );
  }

  const BETS_PER_PAGE = 20;

  /** Remonte les paris en attente (direct → imminent → à régler → à venir) en tête de liste. */
  function sortByPhase(list) {
    return list.map((b) => ({ b, p: betPhase(b) }))
      .sort((x, y) => {
        const d = PHASE_ORDER[x.p.phase] - PHASE_ORDER[y.p.phase];
        if (d) return d;
        if (x.p.phase !== 'settled' && x.p.ko && y.p.ko) return x.p.ko - y.p.ko;
        return 0;
      })
      .map((o) => o.b);
  }

  function renderBets() {
    refreshFilterOptions();
    const bets = sortByPhase(filteredBets());
    const k = Stats.kpis(bets, 0);
    const staked = bets.reduce((s, b) => s + Number(b.stake || 0), 0);
    const expected = bets.reduce((s, b) => s + Number(b.stake || 0) * Number(b.odds || 0), 0);
    $('#betsCount').innerHTML = `${bets.length} paris · ${Stats.fmtSigned(k.profit)} de profit`
      + `<span class="bets-totals"> · misé <strong>${Stats.fmtMoney(staked)}</strong> · retour si tout gagné <strong>${Stats.fmtMoney(expected)}</strong></span>`;

    const pages = Math.max(1, Math.ceil(bets.length / BETS_PER_PAGE));
    if (state.betsPage > pages) state.betsPage = pages;
    if (state.betsPage < 1) state.betsPage = 1;
    const start = (state.betsPage - 1) * BETS_PER_PAGE;
    const pageBets = bets.slice(start, start + BETS_PER_PAGE);

    $('#betsList').innerHTML = bets.length
      ? `<div class="col-headers"><span>Pari</span><span class="r hide-m">Date</span><span class="r hide-m">Cote</span><span class="r hide-m">Mise</span><span class="r">P/L</span><span></span></div>`
        + pageBets.map(betRowHTML).join('')
        + paginationHTML(bets.length, pages, start, pageBets.length)
      : '<div class="empty-state"><p>Aucun pari ne correspond à ces filtres.</p></div>';
    bindBetRowActions($('#betsList'));
    bindPagination(pages);

    // Bouton de vérification IA des résultats
    const overdue = pendingOverdue();
    $('#checkResults').hidden = overdue.length === 0;
    $('#checkResultsLabel').textContent = `Vérifier les résultats (${overdue.length})`;
  }

  function paginationHTML(total, pages, start, count) {
    if (pages <= 1) return '';
    return `<div class="pagination">
      <button class="btn-icon" data-page="prev" ${state.betsPage <= 1 ? 'disabled' : ''} aria-label="Page précédente"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
      <span class="pagination-info">${start + 1}–${start + count} sur ${total}</span>
      <button class="btn-icon" data-page="next" ${state.betsPage >= pages ? 'disabled' : ''} aria-label="Page suivante"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
    </div>`;
  }

  function bindPagination(pages) {
    const prev = $('#betsList [data-page="prev"]');
    const next = $('#betsList [data-page="next"]');
    if (prev) prev.addEventListener('click', () => { if (state.betsPage > 1) { state.betsPage--; renderBets(); scrollBetsTop(); } });
    if (next) next.addEventListener('click', () => { if (state.betsPage < pages) { state.betsPage++; renderBets(); scrollBetsTop(); } });
  }

  function scrollBetsTop() {
    const el = document.getElementById('view-bets');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** Paris en attente dont la date est aujourd'hui ou passée. */
  function pendingOverdue() {
    const today = new Date().toISOString().slice(0, 10);
    return state.bets.filter((b) => b.status === 'pending' && b.date <= today);
  }

  /* ---- Statut temporel des paris en cours (live / imminent / à venir / à régler) ---- */
  const liveStatusById = new Map(); // id -> { phase:'live'|'finished', score, min } (coteur/Gemini)
  const MATCH_DURATION_MS = 2.75 * 3600e3; // durée typique couverte par un match
  const PHASE_ORDER = { live: 0, soon: 1, awaiting: 2, upcoming: 3, unknown: 4, settled: 5 };

  /** Timestamp (ms) du coup d'envoi si connu : champ kickoff (pick) ou date + heure saisie. */
  function betKickoff(b) {
    if (b.kickoff) return Number(b.kickoff);
    if (b.date && b.time && /^\d{1,2}:\d{2}$/.test(b.time)) {
      const t = new Date(`${b.date}T${b.time.padStart(5, '0')}:00`);
      return isNaN(t.getTime()) ? null : t.getTime();
    }
    return null;
  }

  /** Phase d'un pari : le statut live réel (coteur/Gemini) prime, sinon heuristique horaire. */
  function betPhase(b) {
    if (b.status !== 'pending') return { phase: 'settled' };
    const ext = liveStatusById.get(String(b.id));
    if (ext && ext.phase === 'live') return { phase: 'live', score: ext.score, min: ext.min, ko: betKickoff(b) };
    if (ext && ext.phase === 'finished') return { phase: 'awaiting', finished: true, score: ext.score, ko: betKickoff(b) };
    const ko = betKickoff(b);
    if (!ko) return { phase: 'unknown', ko: null };
    const now = Date.now();
    if (now >= ko && now < ko + MATCH_DURATION_MS) return { phase: 'live', ko };
    if (now < ko && ko - now <= 2 * 3600e3) return { phase: 'soon', ko };
    if (now >= ko + MATCH_DURATION_MS) return { phase: 'awaiting', ko };
    return { phase: 'upcoming', ko };
  }

  function fmtCountdown(ms) {
    if (ms <= 0) return 'maintenant';
    const min = Math.round(ms / 60000);
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    if (h < 24) return `${h} h${m ? ' ' + String(m).padStart(2, '0') : ''}`;
    return `${Math.round(h / 24)} j`;
  }

  /** Petit badge de statut temporel affiché sur un pari en attente. */
  function phaseBadge(tm) {
    switch (tm.phase) {
      case 'live': return `<span class="badge live"><span class="live-dot"></span>DIRECT${tm.score ? ' ' + escapeHTML(tm.score) : ''}</span>`;
      case 'soon': return `<span class="badge soon">⏱ ${fmtCountdown(tm.ko - Date.now())}</span>`;
      case 'upcoming': return `<span class="badge upcoming">à venir${tm.ko ? ' · ' + new Date(tm.ko).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''}</span>`;
      case 'awaiting': return `<span class="badge awaiting">${tm.finished ? 'terminé · à régler' : 'à régler'}</span>`;
      default: return `<span class="badge pending">${STATUS_LABELS.pending}</span>`;
    }
  }

  function betRowHTML(b) {
    const p = Stats.profit(b);
    const tm = betPhase(b);
    const profitCls = b.status === 'pending' ? 'zero' : p > 0.001 ? 'pos' : p < -0.001 ? 'neg' : 'zero';
    const profitTxt = b.status === 'pending' ? '—' : Stats.fmtSigned(p);
    const dateTxt = new Date(b.date + 'T00:00:00').toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
    const typeTxt = b.betType !== 'simple' ? ` · ${TYPE_LABELS[b.betType]}${b.legs > 1 ? ` ×${b.legs}` : ''}` : '';

    const timingCls = b.status === 'pending' && tm.phase !== 'unknown' ? ` timing-${tm.phase}` : '';
    const liveScore = tm.phase === 'live' && tm.score ? `<span class="bet-live-score">${escapeHTML(tm.score)}</span>` : '';

    return `<div class="bet-row${timingCls}" data-id="${b.id}">
      <div class="bet-main">
        <div class="bet-event">${escapeHTML(b.event)}${liveScore}</div>
        <div class="bet-meta">${escapeHTML(b.selection)}<span class="sep">·</span>${escapeHTML(b.sport)}${typeTxt}<span class="sep">·</span>${escapeHTML(b.bookmaker)}</div>
      </div>
      <div class="bet-num hide-m">${dateTxt}</div>
      <div class="bet-num hide-m">${Number(b.odds).toFixed(2)}</div>
      <div class="bet-num strong hide-m">${Stats.fmtMoney(Number(b.stake))}</div>
      <div class="bet-profit ${profitCls}">${b.status === 'pending' ? phaseBadge(tm) : profitTxt}</div>
      <div class="bet-actions">
        ${b.status === 'pending' ? `
        <button class="btn-icon settle-won" data-action="won" aria-label="Marquer gagné" title="Gagné"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></button>
        <button class="btn-icon settle-lost" data-action="lost" aria-label="Marquer perdu" title="Perdu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>` : `
        <button class="btn-icon" data-action="edit" aria-label="Modifier"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg></button>`}
        <button class="btn-icon" data-action="delete" aria-label="Supprimer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button>
      </div>
    </div>`;
  }

  async function settleBet(id, status) {
    const bet = state.bets.find((b) => b.id === id);
    if (!bet) return;
    bet.status = status;
    const saved = await DB.saveBet(bet);
    state.bets = state.bets.map((b) => (b.id === saved.id ? saved : b));
    renderAll();
    toast(status === 'won' ? `Gagné ✓ ${Stats.fmtSigned(Stats.profit(saved))}` : status === 'lost' ? `Perdu · ${Stats.fmtSigned(Stats.profit(saved))}` : 'Pari annulé');
  }

  function bindBetRowActions(container) {
    container.querySelectorAll('.bet-row').forEach((row) => {
      const id = row.dataset.id;
      row.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;
          if (action === 'edit') openBetModal(state.bets.find((b) => b.id === id));
          else if (action === 'won' || action === 'lost') settleBet(id, action);
          else if (action === 'delete') {
            if (!confirm('Supprimer ce pari ?')) return;
            await DB.deleteBet(id);
            state.bets = state.bets.filter((b) => b.id !== id);
            renderAll();
            toast('Pari supprimé');
          }
        });
      });
      row.addEventListener('click', () => openBetModal(state.bets.find((b) => b.id === id)));
    });
  }

  /* ========================================================================
     Dépôts / retraits
     ======================================================================== */
  function bindTxModal() {
    $('#addMovement').addEventListener('click', () => openTxModal());
    $('#addMovementSettings').addEventListener('click', () => openTxModal());
    $('#closeTxModal').addEventListener('click', closeTxModal);
    $('#cancelTx').addEventListener('click', closeTxModal);
    $('#txModal').addEventListener('click', (e) => { if (e.target === $('#txModal')) closeTxModal(); });

    $('#txForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const t = {
        type: $('#txType').value,
        bookmaker: $('#txBookmaker').value.trim(),
        amount: parseFloat($('#txAmount').value),
        date: $('#txDate').value
      };
      if (!(t.amount > 0)) return;
      const saved = await DB.saveTransaction(t);
      state.txs.unshift(saved);
      state.txs.sort((a, b) => (a.date < b.date ? 1 : -1));
      closeTxModal();
      renderAll();
      renderTxList();
      toast(t.type === 'retrait' ? `Retrait de ${Stats.fmtMoney(t.amount)} enregistré` : `${t.type === 'depot' ? 'Dépôt' : 'Bonus'} de ${Stats.fmtMoney(t.amount)} enregistré`);
    });
  }

  function openTxModal() {
    refreshBookmakerDatalist();
    $('#txDate').value = new Date().toISOString().slice(0, 10);
    $('#txAmount').value = '';
    $('#txModal').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeTxModal() {
    $('#txModal').hidden = true;
    document.body.style.overflow = '';
  }

  function renderTxList() {
    const TYPE_TX = { depot: 'Dépôt', retrait: 'Retrait', bonus: 'Bonus' };
    $('#txList').innerHTML = state.txs.length
      ? state.txs.slice(0, 30).map((t) => {
          const sign = t.type === 'retrait' ? -1 : 1;
          const cls = sign > 0 ? 'pos' : 'neg';
          return `<div class="bet-row tx-grid" data-id="${t.id}">
            <div class="bet-main"><div class="bet-event">${TYPE_TX[t.type] || t.type} · ${escapeHTML(t.bookmaker || '—')}</div>
            <div class="bet-meta">${new Date(t.date + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}</div></div>
            <div class="bet-profit ${cls}">${Stats.fmtSigned(sign * t.amount)}</div>
            <div class="bet-actions"><button class="btn-icon" data-deltx aria-label="Supprimer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button></div>
          </div>`;
        }).join('')
      : '<p class="field-hint">Aucun mouvement enregistré. Les dépôts et retraits ajustent votre bankroll sans fausser le ROI.</p>';

    $$('#txList [data-deltx]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.bet-row').dataset.id;
        if (!confirm('Supprimer ce mouvement ?')) return;
        await DB.deleteTransaction(id);
        state.txs = state.txs.filter((t) => t.id !== id);
        renderAll();
        renderTxList();
        toast('Mouvement supprimé');
      });
    });
  }

  /* ========================================================================
     Premiers pas
     ======================================================================== */
  async function maybeOnboard() {
    const done = await DB.getSetting('onboarded', false);
    if (done || state.bets.length > 0) return;
    $('#onboardModal').hidden = false;
    document.body.style.overflow = 'hidden';

    // Devise dès l'onboarding (euro ou crypto d'un book type Stake)
    const obCur = $('#obCurrency');
    obCur.innerHTML = Object.entries(Money.CURRENCIES)
      .map(([code, m]) => `<option value="${code}">${m.label} (${code === 'EUR' ? '€' : m.symbol})</option>`).join('');
    obCur.value = state.settings.currency || 'EUR';
    obCur.addEventListener('change', () => {
      Money.setCurrency(obCur.value, state.settings.showEurEquiv);
      state.settings.currency = obCur.value;
      applyCurrencyUI();
    });

    $('#onboardForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      state.settings.currency = obCur.value || 'EUR';
      await DB.setSetting('currency', state.settings.currency);
      Money.setCurrency(state.settings.currency, state.settings.showEurEquiv);
      await Money.ensureRates([state.settings.currency]);
      state.settings.initialBankroll = parseFloat($('#obBankroll').value) || 0;
      await DB.setSetting('initialBankroll', state.settings.initialBankroll);
      const key = $('#obApiKey').value.trim();
      if (key) {
        state.settings.apiKey = key;
        await DB.setSetting('apiKey', key);
      }
      await DB.setSetting('onboarded', true);
      $('#onboardModal').hidden = true;
      document.body.style.overflow = '';
      bindSettingsValues();
      applyCurrencyUI();
      renderAll();
      toast('Bienvenue ! Ajoutez votre premier pari avec le bouton +');
    }, { once: true });
  }

  /* ========================================================================
     Vérification automatique des résultats (IA)
     ======================================================================== */
  function bindSettle() {
    $('#checkResults').addEventListener('click', runSettleCheck);
  }

  async function runSettleCheck() {
    if (!state.settings.apiKey) { toast('Ajoutez votre clé API Gemini dans les Réglages'); return; }
    const pending = pendingOverdue().slice(0, 15); // limite raisonnable par appel
    if (!pending.length) return;

    const btn = $('#checkResults');
    btn.disabled = true;
    $('#settleResults').innerHTML = '<div class="coach-loading"><span class="spinner"></span>Recherche des résultats en cours… (~30 s)</div>';

    try {
      const results = await Settle.check(state.settings.apiKey, state.settings.model, pending);
      renderSettleResults(results, pending);
    } catch (err) {
      $('#settleResults').innerHTML = `<div class="scan-error">Vérification impossible : ${escapeHTML(err.message)}</div>`;
    } finally {
      btn.disabled = false;
    }
  }

  function renderSettleResults(results, pending) {
    const actionable = results.filter((r) => ['won', 'lost', 'void'].includes(r.statut));
    const waiting = results.filter((r) => r.statut === 'not_played').length;
    const unknown = results.filter((r) => r.statut === 'unknown').length;

    if (!actionable.length) {
      $('#settleResults').innerHTML = `<div class="market-note">Aucun résultat exploitable pour l'instant${waiting ? ` — ${waiting} match(s) pas encore terminé(s)` : ''}${unknown ? `, ${unknown} introuvable(s)` : ''}.</div>`;
      return;
    }

    const label = { won: 'Gagné', lost: 'Perdu', void: 'Annulé' };
    $('#settleResults').innerHTML = `<div class="panel settle-panel">
      <div class="panel-head">
        <h2>Résultats trouvés — à confirmer</h2>
        <button class="btn-primary" id="settleAll">Tout confirmer (${actionable.length})</button>
      </div>
      ${actionable.map((r) => {
        const bet = pending.find((b) => b.id === r.id);
        return `<div class="settle-row" data-id="${r.id}" data-status="${r.statut}">
          <div class="bet-main">
            <div class="bet-event">${escapeHTML(bet.event)} ${r.score ? `<span class="settle-score">${escapeHTML(r.score)}</span>` : ''}</div>
            <div class="bet-meta">${escapeHTML(bet.selection)} · ${escapeHTML(r.explication || '')}${r.source ? ` · <em>${escapeHTML(r.source)}</em>` : ''}</div>
          </div>
          <span class="badge ${r.statut === 'void' ? 'void' : r.statut}">${label[r.statut]}</span>
          <button class="btn-secondary settle-confirm">Confirmer</button>
        </div>`;
      }).join('')}
      <p class="field-hint" style="margin-top:10px">Vérifiez le score avant de confirmer : l'IA peut se tromper sur un marché précis.</p>
    </div>`;

    $$('#settleResults .settle-confirm').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('.settle-row');
        await settleBet(row.dataset.id, row.dataset.status);
        row.remove();
        if (!$('#settleResults .settle-row')) $('#settleResults').innerHTML = '';
      });
    });
    $('#settleAll').addEventListener('click', async () => {
      for (const row of $$('#settleResults .settle-row')) {
        await settleBet(row.dataset.id, row.dataset.status);
      }
      $('#settleResults').innerHTML = '';
      toast(`${actionable.length} paris réglés ✓`);
    });
  }

  /* ========================================================================
     Modal : ajout / édition
     ======================================================================== */
  function bindModal() {
    $('#closeBetModal').addEventListener('click', closeBetModal);
    $('#cancelBet').addEventListener('click', closeBetModal);
    $('#betModal').addEventListener('click', (e) => { if (e.target === $('#betModal')) closeBetModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#betModal').hidden) closeBetModal(); });

    $('#fType').addEventListener('change', syncLegsField);
    $('#fStatus').addEventListener('change', () => {
      $('#payoutField').hidden = $('#fStatus').value !== 'cashout';
    });
    ['fOdds', 'fStake'].forEach((id) => $(`#${id}`).addEventListener('input', updatePotentialGain));
    // Saisie dans la devise du bookmaker (ex. Stake en BTC) → conversion à l'enregistrement
    $('#fBookmaker').addEventListener('input', updateStakeFxHint);
    $('#fStake').addEventListener('input', updateStakeFxHint);

    $('#betForm').addEventListener('submit', onSaveBet);

    // Dropzone
    const dz = $('#dropzone');
    dz.addEventListener('click', () => $('#fileInput').click());
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); } });
    $('#browseBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#fileInput').click(); });
    $('#photosBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#fileInput').click(); });
    $('#fileInput').addEventListener('change', (e) => {
      const files = [...e.target.files].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      state.scanQueue.push(...files.slice(1)); // les suivants seront traités après chaque validation
      if (files.length > 1) toast(`${files.length} tickets — scan un par un, validez entre chaque`);
      handleTicketImage(files[0]);
    });

    // Coller depuis le presse-papier via l'API Clipboard (indispensable sur
    // iOS/Android où l'événement "paste" ne se déclenche pas hors champ texte).
    $('#pasteBtn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!navigator.clipboard?.read) {
        showScanError('Collage non supporté par ce navigateur — utilisez "Depuis Photos" ou le glisser-déposer.');
        return;
      }
      try {
        const items = await navigator.clipboard.read(); // iOS affiche une bulle "Coller" à autoriser
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith('image/'));
          if (type) {
            const blob = await item.getType(type);
            handleTicketImage(new File([blob], 'capture.png', { type }));
            return;
          }
        }
        showScanError('Aucune image dans le presse-papier. Faites d\'abord une capture d\'écran de votre ticket, puis réessayez.');
      } catch (err) {
        showScanError(err.name === 'NotAllowedError'
          ? 'Collage refusé — appuyez sur "Coller" dans la bulle qui apparaît, ou autorisez l\'accès au presse-papier.'
          : `Collage impossible : ${err.message}`);
      }
    });

    ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
    dz.addEventListener('drop', (e) => {
      const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
      if (file) handleTicketImage(file);
    });
  }

  function bindPaste() {
    document.addEventListener('paste', (e) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      e.preventDefault();
      if ($('#betModal').hidden) openBetModal();
      handleTicketImage(file);
    });
  }

  function openBetModal(bet = null) {
    $('#betModal').hidden = false;
    document.body.style.overflow = 'hidden';
    refreshBookmakerDatalist();
    refreshCompetitionDatalist();
    $('#betModalTitle').textContent = bet ? 'Modifier le pari' : 'Nouveau pari';
    $('#saveBet').textContent = bet ? 'Enregistrer' : 'Valider le pari';
    resetScanUI();

    $('#betId').value = bet?.id || '';
    $('#fDate').value = bet?.date || new Date().toISOString().slice(0, 10);
    $('#fKickoff').value = bet?.kickoff || '';
    $('#fTime').value = bet?.time
      || (bet?.kickoff ? new Date(Number(bet.kickoff)).toTimeString().slice(0, 5) : '');
    $('#fBookmaker').value = bet?.bookmaker || '';
    $('#fSport').value = bet?.sport || '';
    $('#fCompetition').value = bet?.competition || '';
    $('#fEvent').value = bet?.event || '';
    $('#fSelection').value = bet?.selection || '';
    $('#fType').value = bet?.betType || 'simple';
    $('#fLegs').value = bet?.legs && bet.legs > 1 ? bet.legs : 2;
    syncLegsField();
    $('#fOdds').value = bet?.odds ?? '';
    $('#fStake').value = bet?.stake ?? '';
    $('#fTipster').value = bet?.tipster || '';
    $('#fStatus').value = bet?.status || 'pending';
    $('#fPayout').value = bet?.payout ?? '';
    $('#payoutField').hidden = $('#fStatus').value !== 'cashout';
    updatePotentialGain();
    updateStakeFxHint();
  }

  /** Vos books configurés apparaissent en tête des suggestions du formulaire. */
  function refreshBookmakerDatalist() {
    const mine = (state.settings.bookrolls || []).map((b) => b.name.trim()).filter(Boolean);
    const defaults = ['Winamax', 'Betclic', 'Unibet', 'ParionsSport', 'PMU', 'Zebet', 'Bwin', 'PokerStars Sports', 'Olybet'];
    const all = [...new Set([...mine, ...defaults])];
    $('#bookmakerList').innerHTML = all.map((n) => `<option>${escapeHTML(n)}</option>`).join('');
  }

  /** Un pari simple n'a qu'une sélection : on masque ET désactive le champ « Nb de
      sélections » (désactivé = exclu de la validation HTML, donc ne bloque plus l'envoi). */
  function syncLegsField() {
    const simple = $('#fType').value === 'simple';
    $('#legsField').hidden = simple;
    const legs = $('#fLegs');
    legs.disabled = simple;
    if (simple && !(parseInt(legs.value, 10) >= 2)) legs.value = 2;
  }

  /** Liste des compétitions : celles déjà saisies (les plus fréquentes en tête) + un socle courant. */
  const COMMON_COMPS = [
    'Ligue 1', 'Ligue 2', 'Premier League', 'Championship', 'LaLiga', 'Serie A', 'Bundesliga',
    'Eredivisie', 'Liga Portugal', 'Jupiler Pro League', 'Süper Lig', 'Ligue des Champions',
    'Ligue Europa', 'Ligue Conférence', 'Ligue des Nations', 'Coupe du Monde', 'Euro',
    'Copa America', 'MLS', 'Brasileirão', 'Liga Argentina', 'Allsvenskan', 'Eliteserien',
    'Veikkausliiga', 'K League 1', 'J1 League', 'Saudi Pro League',
    'Wimbledon', 'Roland-Garros', 'US Open', "Open d'Australie", 'Masters 1000', 'ATP 500', 'ATP 250', 'WTA 1000', 'WTA 500', 'WTA 250',
    'NBA', 'WNBA', 'EuroLigue', 'Betclic Élite', 'NHL', 'MLB', 'Top 14', 'Champions Cup', 'Tour de France'
  ];
  function refreshCompetitionDatalist() {
    const el = $('#competitionList');
    if (!el) return;
    // Compétitions déjà utilisées, triées par fréquence décroissante
    const freq = new Map();
    for (const b of state.bets) {
      const c = (b.competition || '').trim();
      if (c) freq.set(c, (freq.get(c) || 0) + 1);
    }
    const used = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const seen = new Set(used.map((c) => c.toLowerCase()));
    const extra = COMMON_COMPS.filter((c) => !seen.has(c.toLowerCase()));
    el.innerHTML = [...used, ...extra].map((c) => `<option value="${escapeHTML(c)}"></option>`).join('');
  }

  function closeBetModal() {
    $('#betModal').hidden = true;
    document.body.style.overflow = '';
  }

  /** Devise de saisie du formulaire : celle du book choisi, uniquement pour un NOUVEAU pari
      (un pari existant est déjà stocké dans la devise principale). */
  function entryCurrency() {
    if ($('#betId').value) return state.settings.currency || 'EUR';
    return bookCurrency($('#fBookmaker').value);
  }

  function updateStakeFxHint() {
    const el = $('#stakeFxHint');
    if (!el) return;
    const main = state.settings.currency || 'EUR';
    const code = entryCurrency();
    if (code === main) { el.hidden = true; return; }
    const v = parseFloat($('#fStake').value);
    const conv = isFinite(v) ? Money.convert(v, code, main) : null;
    el.hidden = false;
    el.innerHTML = `Ce bookmaker est en <strong>${escapeHTML(code)}</strong> — saisissez la mise en ${escapeHTML(code)}.`
      + (conv !== null && isFinite(conv) ? ` Enregistrée comme <strong>${escapeHTML(Money.fmt(conv, main))}</strong> (cours du jour).` : '');
  }

  function updatePotentialGain() {
    const odds = parseFloat($('#fOdds').value);
    const stake = parseFloat($('#fStake').value);
    const el = $('#potentialGain');
    if (odds > 1 && stake > 0) {
      el.hidden = false;
      el.innerHTML = `Gain potentiel : <strong>${Stats.fmtMoney(odds * stake)}</strong> (soit ${Stats.fmtSigned(stake * (odds - 1))} net)`;
    } else {
      el.hidden = true;
    }
  }

  async function onSaveBet(e) {
    e.preventDefault();
    const bet = {
      id: $('#betId').value || undefined,
      date: $('#fDate').value,
      time: $('#fTime').value || undefined,
      kickoff: Number($('#fKickoff').value) || undefined,
      bookmaker: $('#fBookmaker').value.trim(),
      sport: $('#fSport').value.trim(),
      competition: $('#fCompetition').value.trim(),
      event: $('#fEvent').value.trim(),
      selection: $('#fSelection').value.trim(),
      betType: $('#fType').value,
      legs: $('#fType').value === 'simple' ? 1 : Math.max(2, parseInt($('#fLegs').value, 10) || 2),
      odds: parseFloat($('#fOdds').value),
      stake: parseFloat($('#fStake').value),
      tipster: $('#fTipster').value.trim() || undefined,
      status: $('#fStatus').value,
      payout: $('#fStatus').value === 'cashout' ? (parseFloat($('#fPayout').value) || 0) : undefined
    };

    // Devise : les montants sont stockés dans la devise principale. Si le book est
    // dans une autre devise (ex. Stake en BTC), on convertit au cours du jour.
    const mainCur = state.settings.currency || 'EUR';
    const entryCur = entryCurrency();
    if (entryCur !== mainCur) {
      const cs = Money.convert(bet.stake, entryCur, mainCur);
      const cp = bet.payout != null ? Money.convert(bet.payout, entryCur, mainCur) : null;
      if (cs !== null && isFinite(cs)) {
        bet.stake = Math.round(cs * 1e6) / 1e6;
        bet.enteredAmount = parseFloat($('#fStake').value) || 0;   // trace de la saisie d'origine
        bet.enteredCurrency = entryCur;
        if (cp !== null && isFinite(cp)) bet.payout = Math.round(cp * 1e6) / 1e6;
      }
    }

    // Heure saisie prioritaire : elle définit le coup d'envoi (sinon on garde le kickoff hérité d'un pick).
    if (bet.time && /^\d{1,2}:\d{2}$/.test(bet.time)) {
      const t = new Date(`${bet.date}T${bet.time.padStart(5, '0')}:00`);
      if (!isNaN(t.getTime())) bet.kickoff = t.getTime();
    }

    const existing = bet.id ? state.bets.find((b) => b.id === bet.id) : null;
    if (existing) bet.createdAt = existing.createdAt;

    // Garde-fou anti-tilt : mise anormale après des pertes consécutives
    if (!existing) {
      const warning = Stats.tiltCheck(state.bets, bet);
      if (warning && !confirm(`⚠️ ${warning}\n\nEnregistrer quand même ?`)) return;
    }

    // Garde anti-corrélation : deux paris en cours sur le même match ne sont pas indépendants
    if (!existing && bet.event) {
      const nrm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
      const ev = nrm(bet.event);
      const corr = ev && state.bets.find((b) => (b.status === 'pending' || !b.status) && nrm(b.event) === ev);
      if (corr && !confirm(`⚠️ Tu as déjà un pari en cours sur ce match (« ${corr.selection} »). Deux paris sur la même rencontre sont corrélés : le risque se cumule au lieu de se diversifier.\n\nEnregistrer quand même ?`)) return;
    }

    const saved = await DB.saveBet(bet);
    if (existing) {
      state.bets = state.bets.map((b) => (b.id === saved.id ? saved : b));
    } else {
      state.bets.unshift(saved);
      state.bets.sort((a, b) => (a.date < b.date ? 1 : -1));
    }
    closeBetModal();
    renderAll();
    if (typeof refreshLive === 'function') refreshLive(false);
    toast(existing ? 'Pari mis à jour' : 'Pari enregistré ✓');

    // File de scans multiples : on enchaîne sur le ticket suivant
    if (state.scanQueue.length) {
      const next = state.scanQueue.shift();
      openBetModal();
      toast(`Ticket suivant (${state.scanQueue.length + 1} restants)…`);
      handleTicketImage(next);
    }
  }

  /* ========================================================================
     Smart Scan
     ======================================================================== */
  function resetScanUI() {
    $('#dropzoneIdle').hidden = false;
    $('#dropzoneScanning').hidden = true;
    $('#scanError').hidden = true;
    $('#fileInput').value = '';
  }

  async function handleTicketImage(file) {
    $('#scanError').hidden = true;

    if (!state.settings.apiKey) {
      showScanError('Ajoutez votre clé API Gemini dans les Réglages pour activer le Smart Scan. Vous pouvez saisir le pari manuellement ci-dessous.');
      return;
    }

    // Preview + état "analyse"
    $('#scanPreview').src = URL.createObjectURL(file);
    $('#dropzoneIdle').hidden = true;
    $('#dropzoneScanning').hidden = false;

    try {
      const base64 = await Gemini.fileToBase64(file);
      const data = await Gemini.scanTicket(state.settings.apiKey, state.settings.model, base64, file.type || 'image/png');
      applyScanResult(data);
      toast('Ticket analysé — vérifiez et validez');
    } catch (err) {
      showScanError(`Analyse impossible : ${err.message}`);
    } finally {
      $('#dropzoneIdle').hidden = false;
      $('#dropzoneScanning').hidden = true;
    }
  }

  function showScanError(msg) {
    const el = $('#scanError');
    el.textContent = msg;
    el.hidden = false;
  }

  function applyScanResult(d) {
    const setField = (sel, value) => {
      if (value === null || value === undefined || value === '') return;
      const el = $(sel);
      el.value = value;
      el.classList.remove('ai-filled');
      void el.offsetWidth; // relance l'animation
      el.classList.add('ai-filled');
    };

    setField('#fBookmaker', d.bookmaker);
    setField('#fSport', d.sport);
    setField('#fCompetition', d.competition);
    setField('#fEvent', d.event);
    setField('#fSelection', d.selection);
    if (['simple', 'combine', 'systeme'].includes(d.betType)) {
      setField('#fType', d.betType);
      if (d.legs > 1) setField('#fLegs', d.legs);
      syncLegsField();
    }
    if (typeof d.odds === 'number' && d.odds > 1) setField('#fOdds', d.odds);
    if (typeof d.stake === 'number' && d.stake > 0) setField('#fStake', d.stake);
    if (d.date && /^\d{4}-\d{2}-\d{2}$/.test(d.date)) setField('#fDate', d.date);
    if (['pending', 'won', 'lost'].includes(d.status)) setField('#fStatus', d.status);
    updatePotentialGain();

    if (typeof d.confidence === 'number' && d.confidence < 0.6) {
      showScanError('Lecture incertaine (image floue ?) — vérifiez bien chaque champ avant de valider.');
    }
  }

  /* ========================================================================
     Coach IA
     ======================================================================== */
  function bindCoach() {
    $('#runCoach').addEventListener('click', runCoach);
  }

  async function runCoach() {
    const settled = state.bets.filter(Stats.isCounted);
    const container = $('#coachContent');

    if (!state.settings.apiKey) {
      container.innerHTML = '<div class="empty-state"><p>Ajoutez votre clé API Gemini dans les <strong>Réglages</strong> pour activer le Coach.</p></div>';
      return;
    }
    if (settled.length < 5) {
      container.innerHTML = `<div class="empty-state"><p>Le Coach a besoin d'au moins <strong>5 paris terminés</strong> pour produire une analyse fiable (actuellement : ${settled.length}).</p></div>`;
      return;
    }

    const btn = $('#runCoach');
    btn.disabled = true;
    container.innerHTML = '<div class="coach-loading"><span class="spinner"></span>Gemini analyse votre historique…</div>';

    try {
      const summary = Stats.coachSummary(state.bets, effInitial(), state.txs);
      const insights = await Gemini.coach(state.settings.apiKey, state.settings.model, summary);
      container.innerHTML = insights.map(insightHTML).join('')
        + `<p class="empty-hint" style="text-align:center;margin-top:16px">Analyse générée le ${new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} · ${settled.length} paris analysés</p>`;
    } catch (err) {
      container.innerHTML = `<div class="empty-state"><p>Analyse impossible : ${escapeHTML(err.message)}</p></div>`;
    } finally {
      btn.disabled = false;
    }
  }

  function insightHTML(ins) {
    const icons = {
      alerte: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4m0 4h.01"/></svg>',
      conseil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z"/></svg>',
      positif: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="M22 4L12 14l-3-3"/></svg>'
    };
    const type = ['alerte', 'conseil', 'positif'].includes(ins.type) ? ins.type : 'conseil';
    return `<div class="insight type-${type}">
      <div class="insight-icon">${icons[type]}</div>
      <div class="insight-body"><h3>${escapeHTML(ins.titre)}</h3><p>${escapeHTML(ins.message)}</p></div>
    </div>`;
  }

  /* ========================================================================
     Radar IA v2 (suggestions de value bets, avec mémoire)
     ======================================================================== */
  function bindAdvisor() {
    $('#runAdvisor').addEventListener('click', runAdvisor);
    $('#analyzeMatch').addEventListener('click', runMatchAnalysis);
    $('#matchQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runMatchAnalysis(); } });
    // Analyse depuis une capture d'écran : bouton d'import + collage direct dans le champ
    $('#analyzeImg').addEventListener('click', () => $('#matchImgInput').click());
    $('#matchImgInput').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) handleMatchImage(f); e.target.value = ''; });
    $('#matchQuery').addEventListener('paste', (e) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
      if (!item) return; // collage de texte normal
      const f = item.getAsFile();
      if (!f) return;
      e.preventDefault(); e.stopPropagation();
      handleMatchImage(f);
    });
    $('#settlePicks').addEventListener('click', settleRadarPicks);
    $('#loadComparator').addEventListener('click', loadComparator);
    $('#loadFixtures').addEventListener('click', loadFixtureCalendar);
    // Quota Gemini Pro épuisé (free tier) → bascule automatique sur Flash
    Advisor.setFallbackHandler((from, to, reason) => toast(reason === 'gone'
      ? `Modèle ${from} retiré par Google — bascule sur ${to}`
      : `Quota ${from} atteint — analyse poursuivie avec ${to}`));
    // Attente volontaire pour rester sous la limite (5 req/min) plutôt que d'échouer
    Advisor.setWaitHandler((sec) => toast(`Quota Gemini : attente de ${sec} s avant la requête suivante…`));
    renderQuotaInfo();
    setInterval(renderQuotaInfo, 30000);
    // Clic sur « Analyser par le Radar » d'une ligne du comparateur → analyse approfondie du match
    $('#comparatorContent').addEventListener('click', (ev) => {
      const b = ev.target.closest('.cmp-analyze');
      if (!b) return;
      $('#matchQuery').value = b.dataset.q || '';
      lastAnalyzeSport = $('#comparatorSport').value || null; // sport connu → aide le matching des faits
      lastAnalyzeComp = b.dataset.comp || null;               // compétition → surface (tennis)
      $('#advisorContent').scrollIntoView({ behavior: 'smooth', block: 'center' });
      runMatchAnalysis();
    });
    renderRadarPerf();
    restoreLastRadar();
  }

  /* ---- Comparateur de cotes en direct (coteur.com) ---- */
  async function loadComparator() {
    const sport = $('#comparatorSport').value;
    const container = $('#comparatorContent');
    const btn = $('#loadComparator');
    btn.disabled = true;
    container.innerHTML = '<div class="coach-loading"><span class="spinner"></span>Récupération des cotes en direct depuis coteur.com…</div>';

    try {
      const books = state.settings.onlyMyBooks !== false ? userBookNames() : null;
      const events = await Coteur.getUpcomingEvents(sport, { limit: 20, books });
      if (!events.length) {
        container.innerHTML = `<div class="empty-state"><p>Aucun match avec cotes pour ${escapeHTML(sport)} sur coteur en ce moment.</p><p class="empty-hint">Essayez « Calendrier IA » ci-dessus pour lister les matchs à venir (sans cotes) et les analyser.</p></div>`;
        return;
      }
      const withOdds = events.filter((e) => e.odds && (e.odds.home || e.odds.away));
      container.innerHTML = `<div class="col-headers comparator-grid"><span>Match</span><span class="r">1</span><span class="r hide-m">N</span><span class="r">2</span></div>`
        + events.map((e) => {
          const cell = (o) => o ? `<div class="cmp-odd${o.notMine ? ' notmine' : ''}"><span class="v">${o.price.toFixed(2)}</span><span class="b">${escapeHTML(o.book)}</span></div>` : '<div class="cmp-odd empty">—</div>';
          const dateTxt = e.date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) + ' ' + e.date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
          return `<div class="bet-row comparator-grid">
            <div class="bet-main">
              <div class="bet-event">${escapeHTML(e.teamA)} – ${escapeHTML(e.teamB)}</div>
              <div class="bet-meta">${escapeHTML(e.league)} · ${dateTxt}</div>
              <button class="cmp-analyze" data-q="${escapeHTML(e.teamA + ' – ' + e.teamB)}" data-comp="${escapeHTML(e.league || '')}">◎ Analyser par le Radar</button>
            </div>
            ${cell(e.odds?.home)}${(() => { const c = cell(e.odds?.draw); return c.replace('cmp-odd', 'cmp-odd hide-m'); })()}${cell(e.odds?.away)}
          </div>`;
        }).join('')
        + `<p class="field-hint" style="margin-top:10px">${withOdds.length}/${events.length} matchs avec cotes · meilleure cote du marché FR affichée · source coteur.com</p>`;
    } catch (err) {
      container.innerHTML = `<div class="empty-state"><p>Comparateur indisponible : ${escapeHTML(err.message)}</p></div>`;
    } finally {
      btn.disabled = false;
    }
  }

  /** Calendrier « via IA » (sans cotes) : liste des vrais matchs à venir d'un sport,
      utile quand coteur ne le couvre pas (badminton…). Chaque ligne → « Analyser ». */
  async function loadFixtureCalendar() {
    const sport = $('#comparatorSport').value;
    const container = $('#comparatorContent');
    const btn = $('#loadFixtures');
    if (!state.settings.apiKey) { toast('Ajoutez votre clé API Gemini dans les Réglages pour le calendrier IA'); return; }
    btn.disabled = true;
    container.innerHTML = `<div class="coach-loading"><span class="spinner"></span>Recherche des matchs de ${escapeHTML(sport)} à venir (IA + Google, ~15 s)…</div>`;
    try {
      const now = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
      const matches = await Advisor.listFixtures(state.settings.apiKey, state.settings.model, { sport, horizon: 48, now });
      if (!matches.length) {
        container.innerHTML = `<div class="empty-state"><p>Aucun match de ${escapeHTML(sport)} trouvé dans les 48 prochaines heures.</p></div>`;
        return;
      }
      container.innerHTML = `<div class="col-headers comparator-grid"><span>Match</span><span class="r">Quand</span></div>`
        + matches.map((m) => {
          const when = [m.date, m.heure].filter(Boolean).join(' · ');
          return `<div class="bet-row comparator-grid fixture-row">
            <div class="bet-main">
              <div class="bet-event">${escapeHTML(m.match)}</div>
              <div class="bet-meta">${escapeHTML(m.competition || sport)}</div>
              <button class="cmp-analyze" data-q="${escapeHTML(m.match)}" data-comp="${escapeHTML(m.competition || '')}">◎ Analyser</button>
            </div>
            <div class="r bet-meta fixture-when">${escapeHTML(when || '—')}</div>
          </div>`;
        }).join('')
        + `<p class="field-hint" style="margin-top:10px">Calendrier via recherche IA — <strong>sans cotes</strong>. Vérifiez avant de miser : cliquez « Analyser », puis saisissez votre cote (« ta cote ») pour la value et la mise.</p>`;
    } catch (err) {
      container.innerHTML = `<div class="empty-state"><p>Calendrier indisponible : ${escapeHTML(err.message)}</p></div>`;
    } finally {
      btn.disabled = false;
    }
  }

  function buildAdvisorCtx() {
    const k = Stats.kpis(state.bets, effInitial(), state.txs);
    const perf = Stats.groupBy(state.bets, 'sport')
      .filter((g) => g.count >= 3)
      .map((g) => `${g.name}: ROI ${g.roi.toFixed(0)} % sur ${g.count} paris`)
      .join(' ; ') || 'pas encore d\'historique significatif';
    const bookmakers = [...new Set([
      ...(state.settings.bookrolls || []).map((b) => b.name.trim()).filter(Boolean),
      ...state.bets.map((b) => b.bookmaker).filter(Boolean)
    ])].slice(0, 4).join(', ') || 'Winamax, Betclic, Unibet';

    const pending = state.bets.filter((b) => b.status === 'pending');
    return {
      now: new Date().toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' }),
      horizon: $('#advHorizon').value,
      sports: $('#advSports').value,
      bookmakers,
      bankroll: Math.round(k.bankroll),
      riskProfile: Advisor.PROFILES[$('#advProfile').value].label,
      userPerf: perf,
      excluded: pending.map((b) => `${b.event} (${b.date})`).slice(0, 20),
      exposure: pending.length
        ? `${pending.length} paris en attente pour ${Stats.fmtMoney(pending.reduce((s, b) => s + Number(b.stake || 0), 0))} au total`
        : 'aucun pari en cours',
      feedback: Advisor.feedbackBlock(state.picks),
      deepModel: $('#advDeep').checked ? (state.geminiModels?.pro || null) : null
    };
  }

  /** Rassemble TOUS les marchés réels de coteur pour les matchs de la fenêtre. */
  async function gatherCoteurMarkets(ctx) {
    const sports = ctx.sports.split(',').map((s) => s.trim()).filter(Boolean);
    const books = state.settings.onlyMyBooks !== false ? userBookNames() : null;
    const allowed = books && books.length ? new Set(books.map((b) => b.toLowerCase().replace(/\s+/g, ' ').trim())) : null;
    const horizonMs = Number(ctx.horizon) * 3600e3;
    const now = Date.now();
    const excluded = new Set(state.bets.filter((b) => b.status === 'pending').map((b) => (b.event || '').toLowerCase().replace(/\s+/g, ' ').trim()));

    // 1) Liste des matchs (sans cotes) pour chaque sport, filtrée par fenêtre
    const perSport = Math.max(3, Math.floor(9 / sports.length));
    const matchList = [];
    for (const sport of sports) {
      let events = [];
      try { events = await Coteur.getUpcomingEvents(sport, { limit: 30, withOdds: false }); } catch (_) { continue; }
      const picked = events
        .filter((e) => e.rencId && e.date.getTime() <= now + horizonMs && e.date.getTime() > now + 5 * 60e3)
        .filter((e) => !excluded.has(`${e.teamA} – ${e.teamB}`.toLowerCase()))
        // Niveaux exclus : ils gonflent artificiellement les bilans et les stats
        // n'y sont pas fiables (cf. protocole : ATP 250+/WTA Tour uniquement).
        .filter((e) => !/challenger|\bitf\b|qualif|amical|friendly|r[ée]serve|\bu\d{2}\b|espoirs?/i.test(`${e.league || ''}`))
        .sort((a, b) => a.date - b.date)
        .slice(0, perSport);
      picked.forEach((e) => matchList.push({ ...e, sport }));
    }
    if (!matchList.length) return { candidates: [], index: {} };

    // 2) Pour chaque match, tous les marchés + cotes réelles
    const candidates = [];
    const index = {}; // option_id -> détail complet du pick
    for (const m of matchList.slice(0, 10)) {
      let mk = null;
      try { mk = await Coteur.getMatchMarkets(m.rencId, { allowed }); } catch (_) { continue; }
      if (!mk || !mk.markets.length) continue;
      // Snapshot historique (cron) pour détecter le mouvement de ligne (steam)
      let snap = null;
      try { snap = Cloud.getOddsSnapshot ? await Cloud.getOddsSnapshot(m.rencId) : null; } catch (_) {}
      const label = `${mk.home} – ${mk.away}`;
      const marches = mk.markets.map((mrk) => ({
        marche: mrk.label,
        options: mrk.options.map((o) => {
          const uid = `${m.rencId}:${o.id}`; // identifiant unique GLOBAL (match + option)
          const steam = steamFor(snap, o.id, o.fairProb); // points de proba gagnés depuis le snapshot
          index[uid] = {
            sport: m.sport, competition: m.league, match: label,
            date_match: m.date.toISOString().slice(0, 10),
            heure_match: m.date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
            marche: mrk.label, selection: o.selection, cote: o.cote, bookmaker: o.book, mine: o.mine,
            fairProb: o.fairProb, marketEdge: o.marketEdge, steam,
            rencId: m.rencId, optionId: o.id, kickoff: m.date.getTime()
          };
          // PHASE A — l'IA travaille à l'aveugle : ni cote, ni probabilité de
          // marché, ni mouvement de ligne ne lui sont transmis. L'edge est
          // calculé par l'app après coup (phase B). Bonus : prompt bien plus court.
          return { id: uid, selection: o.selection };
        })
      }));
      candidates.push({ match: label, sport: m.sport, competition: m.league, date: m.date.toISOString().slice(0, 10), marches });
    }
    return { candidates, index };
  }

  /** Poids du marché dans la proba finale, ajusté par la calibration réalisée.
      Sur-confiance passée (gap positif) → on fait davantage confiance au marché. */
  function marketBlendWeight() {
    const s = Advisor.radarStats(state.picks);
    if (!s || s.settled < 10) return 0.4; // pas assez d'historique : blend par défaut
    const gap = s.calibrationGap; // > 0 = le Radar surestime ses probas
    // Ancrage marché modéré : la calibration n'est appliquée QU'ICI (le prompt
    // ne demande plus au modèle de réduire lui-même ses probas → plus de double comptage).
    return Math.min(0.6, Math.max(0.3, 0.4 + gap * 0.012));
  }

  /** Mouvement de ligne (steam) : évolution de la proba juste depuis le dernier
      snapshot (cron). Positif = le marché s'est déplacé vers cette issue (cote
      qui baisse, argent qui rentre) = signal fort de value avant correction. */
  function steamFor(snap, optionId, currentFairProb) {
    if (!snap || !snap.markets || currentFairProb == null) return null;
    const cut = optionId.lastIndexOf('_');
    const prefix = optionId.slice(0, cut);
    const key = optionId.slice(cut + 1);
    const marketKey = prefix === '1n2' ? '1n2' : prefix === '12' ? '12' : prefix === 'OU2-5' ? 'OU2-5' : null;
    if (!marketKey) return null;
    const prev = snap.markets[marketKey]?.[key];
    if (prev == null) return null;
    return Math.round((currentFairProb - prev) * 1000) / 10; // points de probabilité
  }

  /** Reconstruit des picks complets à partir des option_id choisis par Gemini. */
  function mapCoteurMarketPicks(rawResult, index, marketWeight = 0.65) {
    const picks = (rawResult.picks || [])
      .map((p) => {
        const info = index[p.option_id];
        if (!info) return null;

        // PHASE B — l'app confronte l'estimation aveugle aux cotes réelles.
        // Edge CONSERVATEUR : on retient la BORNE BASSE de la fourchette. Une
        // conviction mal étayée (fourchette large) est donc écartée d'office.
        const low = Number(p.proba_basse);
        const med = Number(p.proba_mediane ?? p.probabilite);
        const gProb = (low > 0 && low < 1) ? low : med;
        if (!(gProb > 0 && gProb < 1)) return null;
        // Qualité de dossier : A/B seulement (D = information insuffisante)
        const grade = String(p.qualite || 'B').toUpperCase();
        if (grade === 'C' || grade === 'D') return null;

        // Probabilité finale = ancrage sur le marché (dévig sharp) + apport
        // de l'analyse Gemini. Le poids du marché est ajusté par la calibration
        // réalisée du Radar (plus il a surestimé, plus le marché pèse).
        const fair = info.fairProb;
        const prob = (fair != null) ? (marketWeight * fair + (1 - marketWeight) * gProb) : gProb;
        const value = prob * info.cote - 1;

        return {
          qualite: grade,
          probaBasse: low > 0 ? low : null,
          probaMediane: med > 0 ? med : null,
          probaHaute: Number(p.proba_haute) > 0 ? Number(p.proba_haute) : null,
          sport: info.sport, competition: info.competition, match: info.match,
          date_match: info.date_match, heure_match: info.heure_match,
          marche: info.marche, selection: info.selection,
          cote: info.cote, cote_verifiee: true, bookmaker: info.bookmaker,
          probabilite: prob, probaGemini: gProb, probaMarche: fair,
          value_pct: Math.round(value * 1000) / 10,
          marketEdge: info.marketEdge, steam: info.steam,
          coteurRef: { rencId: info.rencId, optionId: info.optionId }, kickoff: info.kickoff,
          confiance: p.confiance || 3, analyse: p.analyse || '', risques: p.risques || '',
          sources: p.sources || [],
          live: info.mine === false
            ? { status: 'not_my_book', best: { book: info.bookmaker, price: info.cote } }
            : { prices: [{ book: info.bookmaker, price: info.cote }] }
        };
      })
      // Garde-fous de base : cote jouable, confiance minimale, et on écarte les
      // paris clairement -EV (value < -2 %). La marge des books FR (TRJ 90-95 %)
      // rend le vrai +EV rare : plutôt que de tout rejeter, on classe et on garde
      // les meilleurs angles (mode opportunités).
      .filter((p) => p && p.cote >= 1.4 && p.cote <= 5 && p.confiance >= 3 && p.value_pct >= -2)
      .map((p) => ({
        ...p,
        // Niveau de conviction affiché à l'utilisateur
        conviction: (p.value_pct >= 3 && p.confiance >= 4) ? 'forte'
          : p.value_pct >= 2 ? 'correcte'
          : 'moderee',
        marginal: p.value_pct < 2
      }))
      .sort((a, b) => (b.value_pct * b.confiance + (b.steam > 0 ? b.steam : 0)) - (a.value_pct * a.confiance + (a.steam > 0 ? a.steam : 0)));

    // Un seul pick par match (garde le meilleur)
    const seen = new Set();
    const unique = picks.filter((p) => {
      const key = p.match.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Mode opportunités : s'il existe de vrais +EV (≥ 2 %), on les privilégie (jusqu'à 5) ;
    // sinon on présente les 2-4 meilleurs angles du moment, étiquetés « conviction modérée ».
    const strong = unique.filter((p) => p.value_pct >= 2);
    const finalPicks = strong.length ? strong.slice(0, 5) : unique.slice(0, 4);
    const marginalOnly = strong.length === 0 && finalPicks.length > 0;

    return { analyse_marche: rawResult.analyse_marche || '', picks: finalPicks, coteurMarkets: true, marketWeight, marginalOnly };
  }

  function renderRadarProgress(step) {
    const steps = [
      ['inventory', 'Inventaire des matchs de la fenêtre'],
      ['research', 'Enquête approfondie : blessures, forme, cotes'],
      ['done', 'Sélection des value bets']
    ];
    const idx = steps.findIndex(([s]) => s === step);
    $('#advisorContent').innerHTML = `<div class="radar-progress">
      ${steps.map(([s, label], i) => `<div class="radar-step ${i < idx ? 'done' : i === idx ? 'active' : ''}">
        <span class="dot">${i < idx ? '✓' : ''}</span><span>${label}</span>
      </div>`).join('')}
      <p class="empty-hint" style="margin-top:8px">${idx === 0 ? '~15 s' : '~30-40 s'} — Gemini interroge Google en temps réel</p>
    </div>`;
  }

  async function runAdvisor() {
    const container = $('#advisorContent');
    if (!state.settings.apiKey) {
      container.innerHTML = '<div class="empty-state"><p>Ajoutez votre clé API Gemini dans les <strong>Réglages</strong> pour activer le Radar.</p></div>';
      return;
    }

    const btn = $('#runAdvisor');
    btn.disabled = true;
    const ctx = buildAdvisorCtx();
    renderRadarProgress('inventory');

    try {
      let result;
      // Source coteur : tous les marchés réels de coteur → Gemini analyse et choisit.
      if (state.settings.oddsSource === 'coteur') {
        const { candidates, index } = await gatherCoteurMarkets(ctx);
        if (candidates.length) {
          const rawResult = await Advisor.suggestFromCoteurMarkets(state.settings.apiKey, state.settings.model, ctx, candidates, (step) => renderRadarProgress(step));
          result = mapCoteurMarketPicks(rawResult, index, marketBlendWeight());
        }
      }
      // Repli : inventaire Gemini classique (autres sources, ou coteur indisponible)
      if (!result) {
        result = await Advisor.suggest(state.settings.apiKey, state.settings.model, ctx, (step) => renderRadarProgress(step));
      }

      // Mémorisation des picks (traçabilité + apprentissage)
      const savedIds = [];
      for (const p of result.picks) {
        const saved = await DB.savePick({ ...p, followed: false, result: null, profile: $('#advProfile').value });
        savedIds.push(saved.id);
        state.picks.unshift(saved);
      }
      result.picks = result.picks.map((p, i) => ({ ...p, id: savedIds[i] }));

      const at = Date.now();
      await DB.setSetting('lastRadar', { result, profileKey: $('#advProfile').value, bankroll: ctx.bankroll, at });
      renderAdvisorResult(result, $('#advProfile').value, ctx.bankroll, at);
      renderRadarPerf();
      // Alerte : nouveaux picks à value détectés
      if (result.picks.length) {
        const top = result.picks[0];
        Notify.send(
          `Radar : ${result.picks.length} value${result.picks.length > 1 ? 's' : ''} détectée${result.picks.length > 1 ? 's' : ''}`,
          `${top.match || ''} — ${top.selection || ''}${top.value_pct != null ? ' (+' + Number(top.value_pct).toFixed(1) + '%)' : ''}`,
          'radar-' + at
        );
      }
      // Les picks « tous marchés » portent déjà la cote coteur réelle → pas de re-vérification.
      if (!result.coteurMarkets) {
        verifyLiveOdds(result, $('#advProfile').value, ctx.bankroll, at); // en arrière-plan
      }
    } catch (err) {
      container.innerHTML = `<div class="empty-state"><p>Radar indisponible : ${escapeHTML(err.message)}</p><p class="empty-hint">La recherche Google (grounding) nécessite une clé API dont le quota le permet. Réessayez dans une minute.</p></div>`;
    } finally {
      btn.disabled = false;
      renderQuotaInfo();
    }
  }

  async function restoreLastRadar() {
    const last = await DB.getSetting('lastRadar');
    if (!last || !last.result) return;
    renderAdvisorResult(last.result, last.profileKey, last.bankroll, last.at);
  }

  /* ---- Provider de cotes unifié (Coteur / The Odds API) ---- */
  function oddsProviderReady() {
    const src = state.settings.oddsSource;
    if (src === 'coteur') return true;               // aucune clé requise
    if (src === 'oddsapi') return !!state.settings.oddsApiKey;
    return false;                                     // 'none'
  }

  /** Noms des books configurés par l'utilisateur (répartition de la bankroll). */
  function userBookNames() {
    return (state.settings.bookrolls || []).map((b) => (b.name || '').trim()).filter(Boolean);
  }

  async function verifyPickLive(pick) {
    const src = state.settings.oddsSource;
    const books = state.settings.onlyMyBooks !== false ? userBookNames() : null;

    if (src === 'coteur') return Coteur.verifyPick(null, pick, { books });

    if (src === 'oddsapi') {
      const v = await Odds.verifyPick(state.settings.oddsApiKey, pick);
      // Filtre les cotes aux books configurés (The Odds API donne le détail par book)
      if (v.status === 'ok' && books && books.length) {
        const set = new Set(books.map((b) => b.toLowerCase().replace(/\s+/g, '')));
        const mine = v.prices.filter((p) => set.has(p.book.toLowerCase().replace(/\s+/g, '')));
        if (!mine.length) return { status: 'not_my_book', event: v.event, best: v.best };
        return { status: 'ok', event: v.event, prices: mine, best: mine[0], market: v.market, source: 'oddsapi' };
      }
      return v;
    }
    return { status: 'disabled' };
  }

  /* ---- Vérification des cotes en temps réel (provider sélectionné) ---- */
  async function verifyLiveOdds(result, profileKey, bankroll, at) {
    if (!oddsProviderReady() || !result.picks.length) return;

    let touched = false;
    for (const p of result.picks) {
      try {
        const v = await verifyPickLive(p);
        if (v.status === 'not_my_book') { p.live = { status: 'not_my_book', best: v.best }; continue; }
        if (v.status !== 'ok') { p.live = { status: v.status }; continue; }

        p.live = { prices: v.prices, checkedAt: Date.now() };
        p.cote = v.best.price;
        p.bookmaker = v.best.book;
        p.cote_verifiee = true;
        p.value_pct = Math.round((p.probabilite * p.cote - 1) * 1000) / 10;
        touched = true;

        const stored = state.picks.find((x) => x.id === p.id);
        if (stored) {
          Object.assign(stored, { cote: p.cote, bookmaker: p.bookmaker, cote_verifiee: true, value_pct: p.value_pct, live: p.live });
          await DB.savePick(stored);
        }
      } catch (err) {
        p.live = { status: 'error', message: err.message };
        break; // quota ou clé invalide : inutile d'insister
      }
    }

    await DB.setSetting('lastRadar', { result, profileKey, bankroll, at });
    renderAdvisorResult(result, profileKey, bankroll, at);
    if (touched) {
      const src = state.settings.oddsSource;
      const note = src === 'coteur' ? ' via coteur.com' : (Odds.quota() ? ` · ${Odds.quota()} crédits restants` : '');
      toast(`Cotes vérifiées en direct${note}`);
    }
  }

  /* ---- Analyse d'un match précis ---- */
  let lastMatchAnalysis = null; // { r, ctx } — pour recalculer les mises quand on change de profil Kelly
  let lastAnalyzeSport = null;  // sport du dernier match analysé (via comparateur) → matching des faits
  let lastAnalyzeComp = null;   // compétition du dernier match (surface tennis)

  /** Capture d'écran d'une rencontre → extraction Gemini → champ d'analyse pré-rempli + lancement. */
  async function handleMatchImage(file) {
    const status = $('#matchImgStatus');
    if (!state.settings.apiKey) { toast('Ajoutez votre clé API Gemini dans les Réglages pour lire une capture'); return; }
    const show = (msg, err) => { if (status) { status.textContent = msg; status.hidden = false; status.classList.toggle('err', !!err); } };
    show('Lecture de la capture…');
    try {
      const base64 = await Gemini.fileToBase64(file);
      const d = await Gemini.scanMatch(state.settings.apiKey, state.settings.model, base64, file.type || 'image/png');
      const q = (d && (d.query || [d.home, d.away].filter(Boolean).join(' – '))) || '';
      if (!q || (!d.home && !d.away)) { show('Aucune rencontre reconnue sur l\'image — saisis le match à la main.', true); return; }
      $('#matchQuery').value = d.time && !/\d{1,2}:\d{2}/.test(q) ? `${q} ${d.time}` : q;
      lastAnalyzeSport = d.sport || null;      // route les faits (Elo tennis / api-sports / Poisson)
      lastAnalyzeComp = d.competition || null; // surface tennis
      show(`Reconnu : ${$('#matchQuery').value}${d.sport ? ' · ' + d.sport : ''}`);
      setTimeout(() => { if (status) status.hidden = true; }, 4000);
      runMatchAnalysis();
    } catch (err) {
      show(`Lecture impossible : ${err.message}`, true);
    }
  }

  async function runMatchAnalysis() {
    const query = $('#matchQuery').value.trim();
    if (!query) return;
    if (!state.settings.apiKey) { toast('Ajoutez votre clé API Gemini dans les Réglages'); return; }

    const btn = $('#analyzeMatch');
    btn.disabled = true;
    $('#advisorContent').innerHTML = `<div class="coach-loading"><span class="spinner"></span>Récupération des données réelles (SofaScore) puis analyse de « ${escapeHTML(query)} »… (~30 s)</div>`;

    try {
      const ctx = buildAdvisorCtx();
      // Faits réels et récents (forme, buts, H2H, classement) → base factuelle du prompt (anti-invention)
      const parts = query.split(/\s+[–—-]\s+|\s+vs\.?\s+/i);
      const home = (parts[0] || '').trim(), away = (parts[1] || '').trim();
      let facts = null;
      const sportN = (lastAnalyzeSport || '').toLowerCase();
      if (home && away) {
        if (/tennis/.test(sportN) && typeof TennisElo !== 'undefined') {
          // Tennis → modèle Elo (Sackmann) au lieu d'api-sports (non couvert)
          try { facts = await TennisElo.matchFacts({ home, away, competition: lastAnalyzeComp || query }); } catch (_) {}
        } else if (state.settings.apiFootballKey && typeof Facts !== 'undefined') {
          try { facts = await Facts.matchFacts({ home, away, sport: lastAnalyzeSport, apiKey: state.settings.apiFootballKey }); } catch (_) {}
        }
      }
      ctx.matchFacts = (facts && facts.text) ? facts.text : '';

      const r = await Advisor.analyzeMatch(state.settings.apiKey, state.settings.model, ctx, query);
      r.facts = facts; // pour l'encart « Données réelles » de l'UI
      // Vérification des marchés au prix réel avant affichage
      if (oddsProviderReady() && r.trouve && r.marches?.length) {
        for (const m of r.marches) {
          try {
            const v = await verifyPickLive({
              sport: r.sport, competition: r.competition, match: r.match,
              date_match: r.date_match, selection: m.selection, marche: m.marche
            });
            if (v.status === 'ok') {
              m.live = v.prices;
              m.cote = v.best.price;
              m.bookmaker = v.best.book;
              m.cote_verifiee = true;
              m.notMyBook = false;
              m.value_pct = Math.round((m.probabilite * m.cote - 1) * 1000) / 10;
            } else if (v.status === 'not_my_book' && v.best) {
              // Vraie cote du marché FR, mais chez un book non configuré : on la prend quand même
              // (bien plus fiable qu'une cote inventée par le modèle) en le signalant.
              m.cote = v.best.price;
              m.bookmaker = v.best.book;
              m.cote_verifiee = true;
              m.notMyBook = true;
              m.value_pct = Math.round((m.probabilite * m.cote - 1) * 1000) / 10;
            } else {
              // Marché non vérifiable au prix réel (handicap, marché exotique, match introuvable)
              // → on NE fait PAS confiance à la cote du modèle : marquée « non vérifiée » (pas de value/mise trompeuse).
              m.cote_verifiee = false;
            }
          } catch (_) { break; } // quota : on garde les cotes estimées
        }
      }
      lastMatchAnalysis = { r, ctx };
      renderMatchAnalysis(r, ctx);
    } catch (err) {
      $('#advisorContent').innerHTML = `<div class="empty-state"><p>Analyse impossible : ${escapeHTML(err.message)}</p></div>`;
    } finally {
      btn.disabled = false;
    }
  }

  /** Puce de forme colorée (V/N/D) pour l'encart données réelles. */
  function formPills(streak) {
    if (!streak) return '';
    return streak.split(' ').map((c) => {
      const cls = c === 'V' ? 'w' : c === 'D' ? 'l' : 'd';
      return `<span class="form-pill ${cls}">${c}</span>`;
    }).join('');
  }

  /* ---- Notifications locales (alertes value, coup d'envoi) ---- */
  const Notify = {
    supported: () => typeof Notification !== 'undefined',
    enabled: () => Notify.supported() && Notification.permission === 'granted' && state.settings.notifyAlerts !== false,
    async ask() {
      if (!Notify.supported()) return false;
      if (Notification.permission === 'granted') return true;
      if (Notification.permission === 'denied') return false;
      try { return (await Notification.requestPermission()) === 'granted'; } catch (_) { return false; }
    },
    send(title, body, tag) {
      if (!Notify.enabled()) return;
      try {
        const n = new Notification(title, { body, tag: tag || 'betsmart', icon: './icons/icon-192.png', badge: './icons/icon-192.png' });
        n.onclick = () => { try { window.focus(); } catch (_) {} n.close(); };
      } catch (_) {}
    }
  };
  const _notified = new Set(); // évite les doublons d'alerte dans une session
  let _prevLive = new Set();   // matchs en live au dernier rafraîchissement
  let _liveSeeded = false;     // on n'alerte pas au tout premier poll (matchs déjà en cours)

  /* ---- Line shopping : comparaison des cotes par bookmaker (meilleur prix) ---- */
  function lineShopHTML(prices) {
    if (!Array.isArray(prices) || prices.length < 2) return '';
    const sorted = [...prices].sort((a, b) => b.price - a.price);
    const best = sorted[0].price, worst = sorted[sorted.length - 1].price;
    const gain = worst > 0 ? Math.round((best / worst - 1) * 1000) / 10 : 0;
    const cells = sorted.map((p, i) => `<span class="ls-book${i === 0 ? ' ls-best' : ''}">${escapeHTML(p.book)} <strong>${Number(p.price).toFixed(2)}</strong></span>`).join('');
    return `<div class="lineshop">
      <span class="ls-head">Line shopping</span>
      <div class="ls-books">${cells}</div>
      ${gain > 0 ? `<span class="ls-gain">+${gain.toFixed(1)} % en jouant chez ${escapeHTML(sorted[0].book)}</span>` : ''}
    </div>`;
  }

  /** Encart « Données réelles » (API-Football) affiché dans l'analyse d'un match. */
  function matchFactsHTML(facts) {
    if (facts && facts.tennis) {
      const bar = Math.round(facts.prob1);
      return `<div class="facts-box">
        <div class="facts-head">Données réelles · <span>Elo tennis</span> · surface : ${escapeHTML(facts.surface)}${facts.updated ? ' · maj ' + escapeHTML(facts.updated) : ''}</div>
        <div class="facts-teams">
          <div class="facts-team"><div class="facts-team-name">${escapeHTML(facts.p1.name)}</div><div class="facts-form"><span class="facts-goals">Elo ${facts.p1.elo} · ${escapeHTML(facts.p1.rank || '')}</span></div></div>
          <div class="facts-team"><div class="facts-team-name">${escapeHTML(facts.p2.name)}</div><div class="facts-form"><span class="facts-goals">Elo ${facts.p2.elo} · ${escapeHTML(facts.p2.rank || '')}</span></div></div>
        </div>
        <div class="elo-prob"><div class="elo-bar"><span style="width:${bar}%"></span></div>
          <div class="elo-prob-labels"><strong>${facts.prob1} %</strong> ${escapeHTML(facts.p1.name)} · ${escapeHTML(facts.p2.name)} <strong>${facts.prob2} %</strong></div>
          <span class="facts-xg-sub">probabilité modèle Elo (ancrage statistique)</span></div>
      </div>`;
    }
    if (!facts || facts.noData) {
      let hint;
      if (facts && facts.noData) {
        hint = `Données factuelles indisponibles pour ce match — ${escapeHTML(facts.reason || 'raison inconnue')}.`;
      } else if (!state.settings.apiFootballKey) {
        hint = 'Ajoutez votre clé api-sports.io dans les Réglages pour des faits réels (forme, buts, xG au foot, H2H).';
      } else {
        hint = 'Données api-sports indisponibles pour ce match.';
      }
      return `<div class="facts-box empty"><span class="facts-none">${hint} Analyse basée sur la recherche web ; l'IA a pour consigne de ne rien inventer.</span></div>`;
    }
    const teamRow = (name, f, stand) => {
      if (!f) return `<div class="facts-team"><div class="facts-team-name">${escapeHTML(name)}</div><div class="facts-form-muted">forme indisponible</div></div>`;
      const pos = stand ? `<span class="facts-standing">${stand.position}ᵉ · ${stand.points} pts</span>` : '';
      const xg = (f.xgFor != null)
        ? `<div class="facts-xg">xG <strong>${f.xgFor}</strong> pour · <strong>${f.xgAg}</strong> contre <span class="facts-xg-sub">(3 derniers)</span></div>` : '';
      return `<div class="facts-team">
        <div class="facts-team-name">${escapeHTML(name)} ${pos}</div>
        <div class="facts-form">${formPills(f.streak)}<span class="facts-goals">${f.gf} bp / ${f.ga} bc</span></div>
        ${xg}
      </div>`;
    };
    const h2h = (facts.h2h && facts.h2h.n)
      ? `<div class="facts-h2h">Face-à-face (${facts.h2h.n}) : <strong>${facts.h2h.t1Wins}</strong> V ${escapeHTML(facts.homeName)} · <strong>${facts.h2h.draws}</strong> nuls · <strong>${facts.h2h.t2Wins}</strong> V ${escapeHTML(facts.awayName)}</div>`
      : '';
    const injCol = (name, list) => {
      if (!list || !list.length) return `<div class="facts-inj-col"><div class="facts-inj-team">${escapeHTML(name)}</div><span class="facts-inj-none">aucune absence signalée</span></div>`;
      const items = list.slice(0, 5).map((i) => `<li>${escapeHTML(i.player)}${i.reason ? ` <span class="facts-inj-reason">${escapeHTML(i.reason)}</span>` : ''}</li>`).join('');
      return `<div class="facts-inj-col"><div class="facts-inj-team">${escapeHTML(name)}</div><ul class="facts-inj-list">${items}</ul></div>`;
    };
    const injBlock = (facts.homeInjuries || facts.awayInjuries)
      ? `<div class="facts-inj"><div class="facts-inj-head">⚠ Absences / incertains</div><div class="facts-inj-cols">${injCol(facts.homeName, facts.homeInjuries)}${injCol(facts.awayName, facts.awayInjuries)}</div></div>`
      : '';
    const luLine = (name, l) => l ? `<div class="facts-lineup-row"><strong>${escapeHTML(name)}</strong>${l.formation ? ` · ${escapeHTML(l.formation)}` : ''}${l.xi && l.xi.length ? ` · <span class="facts-lineup-xi">${escapeHTML(l.xi.join(', '))}</span>` : ''}</div>` : '';
    const lineups = (facts.homeLineup || facts.awayLineup)
      ? `<div class="facts-lineups"><div class="facts-inj-head">Compositions annoncées</div>${luLine(facts.homeName, facts.homeLineup)}${luLine(facts.awayName, facts.awayLineup)}</div>`
      : '';
    let model = '';
    if (facts.model) {
      const m = facts.model;
      model = `<div class="facts-model">
        <div class="facts-inj-head">Modèle Poisson · buts attendus ${m.lambdaHome} – ${m.lambdaAway}</div>
        <div class="facts-model-bar" title="Probabilités du modèle (1N2)">
          <span class="fm-h" style="width:${m.p1}%">${m.p1 >= 12 ? m.p1 + '%' : ''}</span>
          <span class="fm-d" style="width:${m.pX}%">${m.pX >= 12 ? m.pX + '%' : ''}</span>
          <span class="fm-a" style="width:${m.p2}%">${m.p2 >= 12 ? m.p2 + '%' : ''}</span>
        </div>
        <div class="facts-model-legend"><span>${escapeHTML(facts.homeName)} ${m.p1}%</span><span>Nul ${m.pX}%</span><span>${escapeHTML(facts.awayName)} ${m.p2}%</span></div>
        <div class="facts-model-sub">Over 2.5 : <strong>${m.over25}%</strong> · Under <strong>${m.under25}%</strong> · Les deux marquent <strong>${m.btts}%</strong> <span class="facts-xg-sub">(sur ${m.sample} matchs/équipe)</span></div>
      </div>`;
    }
    return `<div class="facts-box">
      <div class="facts-head">Données réelles · <span>api-sports</span>${facts.league ? ' · ' + escapeHTML(facts.league) : ''}</div>
      <div class="facts-teams">${teamRow(facts.homeName, facts.homeForm, facts.homeStanding)}${teamRow(facts.awayName, facts.awayForm, facts.awayStanding)}</div>
      ${h2h}
      ${model}
      ${injBlock}
      ${lineups}
    </div>`;
  }

  function renderMatchAnalysis(r, ctx) {
    const container = $('#advisorContent');
    if (!r.trouve) {
      container.innerHTML = `<div class="market-note">Match introuvable ou ambigu — précisez les équipes et la date (ex : « Lyon – Lille samedi »).</div>`;
      return;
    }
    const dateTxt = r.date_match ? new Date(r.date_match + 'T00:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) + (r.heure_match ? ` · ${r.heure_match}` : '') : '';
    const profileKey = $('#advProfile').value;
    const mode = state.settings.stakingMode || 'kelly';
    const k = Stats.kpis(state.bets, effInitial(), state.txs);
    // Verdict basé sur les cotes RÉELLES vérifiées (pas sur les cotes estimées par le modèle)
    const hasRealValue = (r.marches || []).some((m) => m.cote_verifiee !== false && Number(m.value_pct) >= 2);
    const factsHTML = matchFactsHTML(r.facts);

    container.innerHTML = `<div class="pick-card">
      <div class="pick-top">
        <div class="pick-title">
          <h3>${escapeHTML(r.match)}</h3>
          <div class="pick-meta">${escapeHTML(r.sport || '')} · ${escapeHTML(r.competition || '')}${dateTxt ? ' · ' + dateTxt : ''}</div>
        </div>
        <span class="verdict-badge ${hasRealValue ? 'play' : 'avoid'}">${hasRealValue ? 'Value détectée' : 'Pas de +EV net'}</span>
      </div>
      <p class="pick-analysis">${escapeHTML(r.resume || '')}</p>
      ${factsHTML}
      <div class="stake-profile-bar">
        <span>Mise Kelly :</span>
        <select id="matchProfile" class="select-mini" aria-label="Profil de mise Kelly">
          <option value="prudent"${profileKey === 'prudent' ? ' selected' : ''}>prudent · ≤ 1 %</option>
          <option value="equilibre"${profileKey === 'equilibre' ? ' selected' : ''}>normal · ≤ 2 %</option>
          <option value="agressif"${profileKey === 'agressif' ? ' selected' : ''}>agressif · ≤ 3 %</option>
        </select>
        <span class="stake-profile-hint">${mode === 'flat' ? 'mode mise à plat' : 'les mises s\'ajustent au profil'}</span>
      </div>
      <div class="markets-table">
        ${(r.marches || []).map((m, i) => {
          const verified = m.cote_verifiee !== false;   // cote confrontée à un vrai book FR
          const good = verified && m.value_pct >= 2;      // vraie value (+EV net)
          const playable = verified && m.value_pct >= 0;  // pas -EV + cote réelle → mise Kelly
          const stake = verified ? Advisor.stakeFor(k.bankroll, m, profileKey, mode).stake : 0;
          const bookTxt = m.live ? ' · ✓ direct' : m.notMyBook ? ` · ${escapeHTML(m.bookmaker || '')} (hors de vos books)` : verified ? '' : ' · cote estimée, non vérifiée';
          return `<div class="market-row">
            <div><strong>${escapeHTML(m.selection)}</strong><div class="pick-meta">${escapeHTML(m.marche || '')}${verified ? ' · ' + escapeHTML(m.bookmaker || '') : ''}${bookTxt}</div></div>
            <div class="bet-num">${Number(m.cote).toFixed(2)}</div>
            <div class="bet-num hide-m">${Math.round(m.probabilite * 100)} %</div>
            ${verified
              ? `<div class="bet-profit market-val ${good ? 'pos' : m.value_pct >= 0 ? 'zero' : 'neg'}">
                  <span>${m.value_pct >= 0 ? '+' : ''}${Number(m.value_pct).toFixed(1)} %</span>
                  <span class="market-stake">${stake > 0 ? 'mise ' + Stats.fmtMoney(stake) : '—'}</span>
                </div>`
              : `<div class="bet-profit market-val zero"><span class="market-unverified">non vérifiée</span></div>`}
            <div class="avis">
              <div class="avis-text">${escapeHTML(m.avis || '')}</div>
              <div class="mycote-row">
                <span class="mycote-lbl">Ta cote</span>
                <input type="number" class="mycote-input" data-idx="${i}" min="1.01" step="0.01" placeholder="${Number(m.cote).toFixed(2)}" inputmode="decimal">
                <span class="mycote-res" data-idx="${i}"></span>
                <button class="link-btn mycote-bet" data-idx="${i}">parier${stake > 0 ? ' ' + Stats.fmtMoney(stake) : ''}</button>
              </div>
            </div>
            ${lineShopHTML(m.live)}
          </div>`;
        }).join('')}
      </div>
      ${r.risques ? `<p class="pick-risks" style="margin-top:12px"><strong>Risques :</strong> ${escapeHTML(r.risques)}</p>` : ''}
      <div class="pick-footer"><span class="pick-sources">${(r.sources || []).slice(0, 3).map(escapeHTML).join(' · ')}</span></div>
    </div>`;

    // Changement de profil Kelly → on ré-affiche l'analyse avec les mises recalculées (sans rappeler l'IA)
    const profSel = container.querySelector('#matchProfile');
    if (profSel) {
      profSel.addEventListener('change', () => {
        $('#advProfile').value = profSel.value;         // profil = source unique, réutilisé par le Radar
        renderMatchAnalysis(r, ctx);                     // recalcul instantané des mises
      });
    }

    // Saisie manuelle de TA cote sur chaque marché → recalcul value + mise Kelly en direct
    const baseStake = (m) => (m.cote_verifiee !== false ? Advisor.stakeFor(k.bankroll, m, profileKey, mode).stake : 0);
    container.querySelectorAll('.mycote-input').forEach((inp) => {
      const idx = Number(inp.dataset.idx);
      const m = r.marches[idx];
      const res = container.querySelector(`.mycote-res[data-idx="${idx}"]`);
      const betBtn = container.querySelector(`.mycote-bet[data-idx="${idx}"]`);
      inp.addEventListener('input', () => {
        const c = parseFloat(inp.value);
        if (!(c > 1)) {
          m.myCote = null; res.textContent = ''; res.className = 'mycote-res';
          const bs = baseStake(m);
          betBtn.textContent = `parier${bs > 0 ? ' ' + Stats.fmtMoney(bs) : ''}`;
          return;
        }
        m.myCote = c;
        const vp = (m.probabilite * c - 1) * 100;
        const st = Advisor.stakeFor(k.bankroll, { ...m, cote: c, cote_verifiee: true }, profileKey, mode).stake;
        res.className = `mycote-res ${vp >= 2 ? 'pos' : vp >= 0 ? 'zero' : 'neg'}`;
        res.innerHTML = `value <strong>${vp >= 0 ? '+' : ''}${vp.toFixed(1)} %</strong> · mise <strong>${Stats.fmtMoney(st > 0 ? st : 0)}</strong>`;
        betBtn.textContent = `parier${st > 0 ? ' ' + Stats.fmtMoney(st) : ''}`;
      });
    });

    container.querySelectorAll('.mycote-bet').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = r.marches[Number(btn.dataset.idx)];
        const cote = m.myCote || m.cote;
        const stake = Advisor.stakeFor(k.bankroll, { ...m, cote, cote_verifiee: true }, profileKey, mode).stake;
        prefillBetFromPick({
          date_match: r.date_match, bookmaker: m.myCote ? '' : m.bookmaker, sport: r.sport,
          competition: r.competition, match: r.match, selection: m.selection, cote
        }, stake);
      });
    });
  }

  function renderAdvisorResult(result, profileKey, bankroll, at) {
    const container = $('#advisorContent');
    let html = '';

    if (at) {
      html += `<p class="empty-hint" style="margin-bottom:10px">Analyse du ${new Date(at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</p>`;
    }
    if (result.analyse_marche) {
      html += `<div class="market-note">${escapeHTML(result.analyse_marche)}</div>`;
    }

    if (!result.picks.length) {
      html += '<div class="empty-state"><p><strong>Aucun angle exploitable</strong> sur la période — aucun match n\'offrait de piste suffisamment solide.</p><p class="empty-hint">Relancez plus tard ou élargissez la fenêtre à 72 h (plus de matchs à analyser).</p></div>';
      container.innerHTML = html;
      return;
    }

    if (result.marginalOnly) {
      html += `<div class="market-note" style="border-left-color:var(--amber)">Pas de <strong>+EV net</strong> sur la période (la marge des books FR est élevée). Voici les <strong>meilleurs angles du moment</strong>, à conviction modérée — des pistes à évaluer, pas des certitudes.</div>`;
    }

    // Staking : mode + plafond d'exposition simultanée
    const mode = state.settings.stakingMode || 'kelly';
    const rawStakes = result.picks.map((p) => Advisor.stakeFor(bankroll, p, profileKey, mode).stake);
    const pendingStake = state.bets.filter((b) => b.status === 'pending').reduce((s, b) => s + Number(b.stake || 0), 0);
    const maxExp = (Number(state.settings.maxExposurePct) || 25) / 100 * bankroll;
    const budget = Math.max(0, maxExp - pendingStake);
    const sumStakes = rawStakes.reduce((a, b) => a + b, 0);
    const expFactor = (sumStakes > budget && sumStakes > 0) ? budget / sumStakes : 1;
    const stakeOf = (i) => Math.max(0, Math.floor(rawStakes[i] * expFactor * 2) / 2);
    if (expFactor < 1) {
      html += `<div class="market-note" style="border-left-color:var(--amber)">Mises réduites : plafond d'exposition de ${state.settings.maxExposurePct || 25} % atteint (${Stats.fmtMoney(pendingStake)} déjà engagés sur vos paris en cours).</div>`;
    }

    html += result.picks.map((p, i) => {
      const m = { stake: stakeOf(i) };
      const dateTxt = p.date_match
        ? new Date(p.date_match + 'T00:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) + (p.heure_match ? ` · ${p.heure_match}` : '')
        : '';
      const conf = [1, 2, 3, 4, 5].map((n) => `<i class="${n <= (p.confiance || 0) ? 'on' : ''}"></i>`).join('');
      const sources = (p.sources || []).slice(0, 3).map(escapeHTML).join(' · ');
      const coteBadge = p.live?.prices ? '<span class="pick-value-badge live">✓ cotes en direct</span>'
        : p.cote_verifiee === false ? '<span class="pick-value-badge est">cote estimée</span>' : '';
      const liveLine = p.live?.prices
        ? `<div class="live-odds">${p.live.prices.map((x, j) => `<span class="live-chip ${j === 0 ? 'best' : ''}">${escapeHTML(x.book)} <strong>${x.price.toFixed(2)}</strong></span>`).join('')}${p.value_pct < 5 ? '<span class="live-warn">value réduite au prix réel — pick moins intéressant</span>' : ''}</div>`
        : p.live?.status === 'not_my_book'
          ? `<div class="live-odds"><span class="live-warn">meilleure cote FR chez ${escapeHTML(p.live.best?.book || 'un autre book')} (${p.live.best?.price ? p.live.best.price.toFixed(2) : '?'}) — pas dans vos bookmakers.</span></div>
             <div class="manual-odds" data-pick="${i}">
               <label>Votre meilleure cote chez vos books :</label>
               <input type="number" class="input mono manual-odds-input" data-idx="${i}" min="1.01" step="0.01" placeholder="ex ${p.live.best?.price ? (p.live.best.price - 0.15).toFixed(2) : '2.00'}">
               <span class="manual-odds-result" data-idx="${i}">saisissez une cote →</span>
             </div>`
          : p.live?.status === 'no_match' || p.live?.status === 'no_league' || p.live?.status === 'no_events'
            ? '<div class="live-odds"><span class="live-warn">cotes live indisponibles pour ce match</span></div>' : '';

      return `<div class="pick-card" data-pick="${i}">
        <div class="pick-top">
          <div class="pick-title">
            <h3>${escapeHTML(p.match)}</h3>
            <div class="pick-meta">${escapeHTML(p.sport)} · ${escapeHTML(p.competition || '')}${dateTxt ? ' · ' + dateTxt : ''}</div>
          </div>
          <div>
            <span class="pick-value-badge ${p.marginal ? 'est' : ''}">value ${Number(p.value_pct) >= 0 ? '+' : ''}${Number(p.value_pct).toFixed(1)} %</span>
            ${p.conviction ? `<span class="pick-value-badge ${p.conviction === 'forte' ? 'live' : p.conviction === 'correcte' ? '' : 'est'}" title="Niveau de conviction du Radar">${p.conviction === 'forte' ? 'conviction forte' : p.conviction === 'correcte' ? 'value confirmée' : 'conviction modérée'}</span>` : ''}
            ${p.qualite ? `<span class="pick-value-badge ${p.qualite === 'A' ? 'live' : ''}" title="Qualité du dossier : A = données complètes confirmées par 2+ sources indépendantes, B = une incertitude mineure">dossier ${escapeHTML(p.qualite)}${p.probaBasse && p.probaHaute ? ` · ${Math.round(p.probaBasse * 100)}–${Math.round(p.probaHaute * 100)} %` : ''}</span>` : ''}
            ${typeof p.steam === 'number' && Math.abs(p.steam) >= 1.5 ? `<span class="pick-value-badge ${p.steam > 0 ? 'steam-up' : 'steam-down'}" title="Mouvement de la ligne depuis le dernier relevé">${p.steam > 0 ? '↑ cote qui baisse' : '↓ cote qui monte'} ${p.steam > 0 ? '+' : ''}${p.steam.toFixed(1)} pts</span>` : ''}
            ${coteBadge}
          </div>
        </div>
        <div class="pick-selection">
          <div class="sel">${escapeHTML(p.selection)}<small>${escapeHTML(p.marche || '')} · ${escapeHTML(p.bookmaker || '')}</small></div>
          <div class="pick-numbers">
            <div class="pick-num"><span class="l">Cote</span><span class="v">${Number(p.cote).toFixed(2)}</span></div>
            <div class="pick-num"><span class="l">Proba. estimée</span><span class="v">${Math.round(p.probabilite * 100)} %</span></div>
            <div class="pick-num"><span class="l">Mise conseillée</span><span class="v accent">${m.stake > 0 ? Stats.fmtMoney(m.stake) : '—'}</span></div>
          </div>
        </div>
        ${liveLine}
        <p class="pick-analysis">${escapeHTML(p.analyse || '')}</p>
        ${p.risques ? `<p class="pick-risks"><strong>Risques :</strong> ${escapeHTML(p.risques)}</p>` : ''}
        <div class="pick-footer">
          <span class="pick-sources">${sources ? 'Sources : ' + sources : ''}</span>
          <span>
            <span class="confidence" title="Confiance ${p.confiance}/5">${conf}</span>
            <button class="btn-secondary" data-add-pick="${i}">Ajouter à mes paris</button>
          </span>
        </div>
      </div>`;
    }).join('');

    const wNote = result.coteurMarkets && result.marketWeight
      ? ` Probabilités calées à ${Math.round(result.marketWeight * 100)} % sur le marché${result.marketWeight > 0.66 ? ' (renforcé car le Radar a surestimé par le passé)' : ''}.`
      : '';
    const modeLabel = mode === 'flat' ? 'mise à plat' : 'Kelly fractionné';
    html += `<p class="empty-hint" style="text-align:center;margin-top:12px">Mises en ${modeLabel} (profil ${escapeHTML(Advisor.PROFILES[profileKey].label.toLowerCase())}), plafond d'exposition ${state.settings.maxExposurePct || 25} %, sur une bankroll de ${Stats.fmtMoney(bankroll)}.${wNote}</p>`;
    container.innerHTML = html;

    container.querySelectorAll('[data-add-pick]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.addPick);
        const p = result.picks[idx];
        // Si une cote manuelle a été saisie (pick hors books), on l'utilise
        const cote = p.manualCote || p.cote;
        // Mise = mode + plafond d'exposition (sauf cote manuelle → recalcul dédié)
        const m = p.manualCote
          ? { stake: Math.floor(Advisor.stakeFor(bankroll, { ...p, cote, cote_verifiee: true }, profileKey, mode).stake * expFactor * 2) / 2 }
          : { stake: stakeOf(idx) };
        if (p.id) {
          const stored = state.picks.find((x) => x.id === p.id);
          if (stored && !stored.followed) {
            stored.followed = true;
            await DB.savePick(stored);
          }
        }
        prefillBetFromPick({ ...p, cote, bookmaker: p.manualCote ? '' : p.bookmaker }, m.stake);
      });
    });

    // Saisie manuelle de cote pour les picks hors books : value + Kelly instantanés
    container.querySelectorAll('.manual-odds-input').forEach((input) => {
      input.addEventListener('input', () => {
        const p = result.picks[Number(input.dataset.idx)];
        const res = container.querySelector(`.manual-odds-result[data-idx="${input.dataset.idx}"]`);
        const cote = parseFloat(input.value);
        if (!(cote > 1)) { p.manualCote = null; res.textContent = 'saisissez une cote →'; res.className = 'manual-odds-result'; return; }
        p.manualCote = cote;
        const value = p.probabilite * cote - 1;
        const m = Advisor.stakeFor(bankroll, { ...p, cote, cote_verifiee: true }, profileKey, mode);
        const valPct = (value * 100);
        const good = valPct >= 5, ok = valPct >= 0;
        res.className = `manual-odds-result ${good ? 'pos' : ok ? 'amber' : 'neg'}`;
        res.innerHTML = ok
          ? `value <strong>+${valPct.toFixed(1)} %</strong> · mise <strong>${Stats.fmtMoney(m.stake > 0 ? m.stake : 0)}</strong>${good ? '' : ' (value faible)'}`
          : `pas de value (<strong>${valPct.toFixed(1)} %</strong>) — à éviter`;
      });
    });
  }

  /** Pré-remplit le formulaire de pari depuis un pick du Radar. */
  function prefillBetFromPick(p, stake) {
    openBetModal();
    $('#fDate').value = p.date_match && /^\d{4}-\d{2}-\d{2}$/.test(p.date_match) ? p.date_match : new Date().toISOString().slice(0, 10);
    if (p.kickoff) $('#fKickoff').value = p.kickoff;
    if (p.heure_match && /^\d{1,2}:\d{2}$/.test(p.heure_match)) $('#fTime').value = p.heure_match;
    else if (p.kickoff) $('#fTime').value = new Date(Number(p.kickoff)).toTimeString().slice(0, 5);
    $('#fBookmaker').value = p.bookmaker || '';
    $('#fSport').value = p.sport || '';
    $('#fCompetition').value = p.competition || '';
    $('#fEvent').value = p.match || '';
    $('#fSelection').value = p.selection || '';
    $('#fType').value = 'simple';
    syncLegsField();
    $('#fOdds').value = p.cote || '';
    $('#fStake').value = stake || '';
    $('#fTipster').value = 'Radar IA';
    $('#fStatus').value = 'pending';
    updatePotentialGain();
    toast('Pari pré-rempli — vérifiez la cote chez votre bookmaker');
  }

  /* ---- CLV : capture de la cote de clôture au coup d'envoi ---- */
  let clvBusy = false;
  async function captureCLV() {
    if (clvBusy || state.settings.oddsSource !== 'coteur') return;
    const now = Date.now();
    // Picks avec réf coteur dont le coup d'envoi est passé (< 6 h), CLV non encore captée
    const targets = state.picks.filter((p) => p.coteurRef && p.kickoff && !p.clvChecked && now >= p.kickoff && (now - p.kickoff) < 6 * 3600e3).slice(0, 6);
    if (!targets.length) return;
    clvBusy = true;
    let changed = false;
    for (const p of targets) {
      try {
        const snap = await Coteur.optionSnapshot(p.coteurRef.rencId, p.coteurRef.optionId);
        p.clvChecked = true;
        if (snap && snap.cote > 1) {
          p.closingOdds = snap.cote;
          p.clv = Math.round((p.cote / snap.cote - 1) * 1000) / 10; // % ; > 0 = cote prise meilleure que la clôture
        }
        await DB.savePick(p);
        changed = true;
      } catch (_) { /* réessai à la prochaine ouverture */ }
    }
    clvBusy = false;
    if (changed) renderRadarPerf();
  }

  /* ---- Performance & calibration du Radar ---- */
  function renderRadarPerf() {
    captureCLV(); // en arrière-plan
    const stats = Advisor.radarStats(state.picks);
    const panel = $('#radarPerfPanel');
    const openOverdue = radarPicksOverdue().length;
    if (!stats && !openOverdue) { panel.hidden = true; return; }
    panel.hidden = false;
    $('#settlePicks').style.display = openOverdue ? '' : 'none';

    if (!stats) {
      $('#radarPerfContent').innerHTML = `<p class="field-hint">${openOverdue} pick(s) en attente de résultat — cliquez sur « Mettre à jour les résultats ».</p>`;
      return;
    }

    const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
    $('#radarPerfContent').innerHTML = `
      <div class="perf-kpis">
        <div class="perf-kpi"><span class="v">${stats.settled}</span><span class="l">Picks réglés</span></div>
        <div class="perf-kpi"><span class="v">${stats.hitRate} %</span><span class="l">Réussite</span></div>
        <div class="perf-kpi"><span class="v ${cls(stats.flatRoi)}">${stats.flatRoi >= 0 ? '+' : ''}${stats.flatRoi} %</span><span class="l">ROI mise constante</span></div>
        ${stats.followedRoi !== null ? `<div class="perf-kpi"><span class="v ${cls(stats.followedRoi)}">${stats.followedRoi >= 0 ? '+' : ''}${stats.followedRoi} %</span><span class="l">ROI picks suivis (${stats.followedCount})</span></div>` : ''}
        ${stats.avgClv !== null ? `<div class="perf-kpi"><span class="v ${cls(stats.avgClv)}">${stats.avgClv >= 0 ? '+' : ''}${stats.avgClv} %</span><span class="l">CLV moyenne (${stats.clvCount})</span></div>` : ''}
        ${stats.clvPositivePct !== null ? `<div class="perf-kpi"><span class="v ${stats.clvPositivePct >= 50 ? 'pos' : 'neg'}">${stats.clvPositivePct} %</span><span class="l">Picks CLV positive</span></div>` : ''}
        <div class="perf-kpi"><span class="v">${stats.openCount}</span><span class="l">En cours</span></div>
      </div>
      ${stats.avgClv !== null ? `<p class="calib-note" style="margin-top:0"><strong>CLV (Closing Line Value)</strong> : compare la cote prise à la cote de clôture. Une CLV moyenne <strong>positive</strong> et &gt; 50 % de picks à CLV positive = le Radar bat le marché, le meilleur signe d'un edge réel (avant même les résultats).</p>` : ''}
      ${stats.buckets.length ? `
      <div class="col-headers calib-grid"><span>Proba annoncée</span><span class="r">Picks</span><span class="r">Prédit</span><span class="r">Réel</span></div>
      ${stats.buckets.map((b) => `<div class="bet-row calib-grid">
        <div class="bet-event">${b.label}</div>
        <div class="bet-num">${b.n}</div>
        <div class="bet-num">${b.predicted} %</div>
        <div class="bet-profit ${b.actual >= b.predicted ? 'pos' : 'neg'}">${b.actual} %</div>
      </div>`).join('')}` : ''}
      <p class="calib-note">${Math.abs(stats.calibrationGap) > 5
        ? `<strong>Écart de calibration : ${stats.calibrationGap > 0 ? '+' : ''}${stats.calibrationGap} pts</strong> — le Radar ${stats.calibrationGap > 0 ? 'surestime' : 'sous-estime'} ses probabilités. Ce bilan lui est réinjecté à chaque analyse pour qu'il se corrige.`
        : 'Calibration correcte : les probabilités annoncées collent aux résultats réels. Ce bilan est réinjecté à chaque analyse.'}</p>`;
  }

  function radarPicksOverdue() {
    const today = new Date().toISOString().slice(0, 10);
    return state.picks.filter((p) => !p.result && p.date_match && p.date_match <= today);
  }

  async function settleRadarPicks() {
    if (!state.settings.apiKey) { toast('Ajoutez votre clé API Gemini dans les Réglages'); return; }
    const overdue = radarPicksOverdue().slice(0, 15);
    if (!overdue.length) { toast('Aucun pick à régler'); return; }

    const btn = $('#settlePicks');
    btn.disabled = true;
    btn.textContent = 'Vérification…';

    try {
      // Réutilise le vérificateur de résultats en mappant les picks en pseudo-paris
      const pseudo = overdue.map((p) => ({
        id: p.id, sport: p.sport, competition: p.competition,
        event: p.match, date: p.date_match, selection: p.selection,
        betType: 'simple', odds: p.cote
      }));
      const results = await Settle.check(state.settings.apiKey, state.settings.model, pseudo);

      let settled = 0;
      for (const r of results) {
        if (!['won', 'lost', 'void'].includes(r.statut)) continue;
        const pick = state.picks.find((p) => p.id === r.id);
        if (!pick) continue;
        pick.result = r.statut;
        pick.score = r.score || null;
        pick.settledAt = Date.now();
        await DB.savePick(pick);
        settled++;
      }
      renderRadarPerf();
      toast(settled ? `${settled} pick(s) réglés — calibration mise à jour` : 'Résultats pas encore disponibles');
    } catch (err) {
      toast(`Vérification impossible : ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Mettre à jour les résultats';
    }
  }

  /* ========================================================================
     Réglages
     ======================================================================== */
  function bindSettings() {
    bindSettingsValues();
    renderBookrollRows();

    $('#setInitial').addEventListener('change', async () => {
      state.settings.initialBankroll = parseFloat($('#setInitial').value) || 0;
      await DB.setSetting('initialBankroll', state.settings.initialBankroll);
      renderAll();
      toast('Capital initial mis à jour');
    });

    $('#addBookroll').addEventListener('click', () => {
      state.settings.bookrolls = state.settings.bookrolls || [];
      state.settings.bookrolls.push({ name: '', initial: 0 });
      renderBookrollRows();
      const inputs = $$('#bookrollRows .bookroll-name');
      inputs[inputs.length - 1]?.focus();
    });

    $('#setApiKey').addEventListener('change', async () => {
      state.settings.apiKey = $('#setApiKey').value.trim();
      await DB.setSetting('apiKey', state.settings.apiKey);
      Gemini.clearModelCache();
      const m = await syncGeminiModels({ force: true });
      toast(m ? `Clé enregistrée — modèle ${m.flash}` : 'Clé API enregistrée');
    });

    $('#setApiFootballKey').addEventListener('change', async () => {
      state.settings.apiFootballKey = $('#setApiFootballKey').value.trim();
      await DB.setSetting('apiFootballKey', state.settings.apiFootballKey);
      toast(state.settings.apiFootballKey ? 'Clé API-Football enregistrée — faits réels activés ✓' : 'Clé API-Football retirée');
    });

    $('#setOddsKey').addEventListener('change', async () => {
      state.settings.oddsApiKey = $('#setOddsKey').value.trim();
      await DB.setSetting('oddsApiKey', state.settings.oddsApiKey);
      if (state.settings.oddsApiKey) {
        try { await Odds.test(state.settings.oddsApiKey); toast('Cotes en temps réel activées ✓'); }
        catch (err) { toast(err.message); }
      }
    });

    $('#setOddsSource').addEventListener('change', async () => {
      state.settings.oddsSource = $('#setOddsSource').value;
      await DB.setSetting('oddsSource', state.settings.oddsSource);
      syncOddsSourceUI();
      toast('Source des cotes mise à jour');
    });

    $('#setOnlyMyBooks').addEventListener('change', async () => {
      state.settings.onlyMyBooks = $('#setOnlyMyBooks').checked;
      await DB.setSetting('onlyMyBooks', state.settings.onlyMyBooks);
      toast(state.settings.onlyMyBooks ? 'Value limitée à vos bookmakers' : 'Tous les bookmakers considérés');
    });

    // Devise principale : tout le site s'affiche dedans
    const curSel = $('#setCurrency');
    curSel.innerHTML = Object.entries(Money.CURRENCIES)
      .map(([code, m]) => `<option value="${code}">${m.label} (${code === 'EUR' ? '€' : m.symbol})</option>`).join('');
    curSel.addEventListener('change', async () => {
      const code = curSel.value;
      state.settings.currency = code;
      await DB.setSetting('currency', code);
      Money.setCurrency(code, state.settings.showEurEquiv);
      await Money.ensureRates(bookCurrencies());
      applyCurrencyUI();
      renderBookrollRows();
      renderAll();
      renderTxList();
      toast(`Devise : ${Money.CURRENCIES[code].label}`);
    });
    $('#setEurEquiv').addEventListener('change', async () => {
      state.settings.showEurEquiv = $('#setEurEquiv').checked;
      await DB.setSetting('showEurEquiv', state.settings.showEurEquiv);
      Money.setCurrency(state.settings.currency, state.settings.showEurEquiv);
      renderBookrollRows();
      renderAll();
    });

    $('#setFreeTierGuard').addEventListener('change', async () => {
      state.settings.freeTierGuard = $('#setFreeTierGuard').checked;
      await DB.setSetting('freeTierGuard', state.settings.freeTierGuard);
      applyQuotaLimits();
      renderQuotaInfo();
      toast(state.settings.freeTierGuard ? 'Garde-fous free tier activés' : 'Garde-fous retirés — aucune limite de débit');
    });

    $('#setNotifyAlerts').addEventListener('change', async () => {
      const on = $('#setNotifyAlerts').checked;
      if (on) {
        const ok = await Notify.ask();
        if (!ok) {
          $('#setNotifyAlerts').checked = false;
          toast(Notify.supported() ? 'Autorisation des notifications refusée par le navigateur' : 'Notifications non supportées sur cet appareil');
          return;
        }
        Notify.send('Alertes activées ✓', 'Tu seras prévenu des values du Radar et des coups d\'envoi.', 'welcome');
      }
      state.settings.notifyAlerts = on;
      await DB.setSetting('notifyAlerts', on);
      toast(on ? 'Alertes activées' : 'Alertes désactivées');
    });

    $('#setStaking').addEventListener('change', async () => {
      state.settings.stakingMode = $('#setStaking').value;
      await DB.setSetting('stakingMode', state.settings.stakingMode);
      toast(state.settings.stakingMode === 'flat' ? 'Mise à plat activée' : 'Kelly fractionné activé');
    });

    $('#setMaxExposure').addEventListener('change', async () => {
      const v = Math.max(5, Math.min(100, parseFloat($('#setMaxExposure').value) || 25));
      state.settings.maxExposurePct = v;
      $('#setMaxExposure').value = v;
      await DB.setSetting('maxExposurePct', v);
      toast(`Exposition max : ${v} %`);
    });

    $('#setModel').addEventListener('change', async () => {
      state.settings.model = $('#setModel').value;
      await DB.setSetting('model', state.settings.model);
    });

    $('#testApi').addEventListener('click', async () => {
      const el = $('#apiTestResult');
      el.className = 'api-test';
      if (!state.settings.apiKey) { el.textContent = 'Renseignez d\'abord une clé.'; el.classList.add('ko'); return; }
      el.textContent = 'Test en cours…';
      try {
        await Gemini.test(state.settings.apiKey, state.settings.model);
        el.textContent = '✓ Connexion réussie';
        el.classList.add('ok');
      } catch (err) {
        el.textContent = `✗ ${err.message}`;
        el.classList.add('ko');
      }
    });

    $('#exportData').addEventListener('click', async () => {
      const data = await DB.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `betsmart-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Export téléchargé');
    });

    $('#importDataBtn').addEventListener('click', () => $('#importData').click());
    $('#importData').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const n = await DB.importAll(data);
        const saved = await DB.getAllSettings();
        Object.assign(state.settings, saved);
        state.bets = await DB.getBets();
        bindSettingsValues();
        renderBookrollRows();
        renderAll();
        toast(`${n} paris importés`);
      } catch (err) {
        toast(`Import impossible : ${err.message}`);
      }
      e.target.value = '';
    });

    $('#wipeData').addEventListener('click', async () => {
      if (!confirm('Effacer définitivement tous les paris et réglages ?')) return;
      await DB.wipe();
      state.bets = [];
      state.settings = DEFAULT_SETTINGS();
      bindSettingsValues();
      renderBookrollRows();
      renderAll();
      toast('Données effacées');
    });
  }

  function bindSettingsValues() {
    $('#setApiKey').value = state.settings.apiKey;
    $('#setApiFootballKey').value = state.settings.apiFootballKey || '';
    $('#setOddsKey').value = state.settings.oddsApiKey || '';
    $('#setOddsSource').value = state.settings.oddsSource || 'coteur';
    $('#setOnlyMyBooks').checked = state.settings.onlyMyBooks !== false;
    $('#setFreeTierGuard').checked = state.settings.freeTierGuard === true;
    $('#setNotifyAlerts').checked = state.settings.notifyAlerts === true && Notify.supported() && Notification.permission === 'granted';
    $('#setCurrency').value = state.settings.currency || 'EUR';
    $('#setEurEquiv').checked = state.settings.showEurEquiv !== false;
    applyCurrencyUI();
    $('#setStaking').value = state.settings.stakingMode || 'kelly';
    $('#setMaxExposure').value = state.settings.maxExposurePct || 25;
    renderModelOptions();
    $('#setModel').value = state.settings.model;
    syncInitialField();
    syncOddsSourceUI();
  }

  function syncOddsSourceUI() {
    const src = state.settings.oddsSource || 'coteur';
    $('#oddsKeyField').hidden = src !== 'oddsapi';
    const hints = {
      coteur: 'Coteur agrège les cotes réelles de tous les books FR (Winamax, Betclic, Unibet, PMU…) sur de nombreux marchés. Aucune clé requise. Réservé à un usage privé (scraping non déployable publiquement).',
      oddsapi: 'API officielle : Winamax, Betclic, Unibet, PMU, NetBet. Nécessite une clé (500 crédits/mois gratuits).',
      none: 'Les cotes restent celles estimées par l\'IA (non vérifiées).'
    };
    $('#oddsSourceHint').textContent = hints[src];
    $('#comparatorPanel').style.display = src === 'coteur' ? '' : 'none';
  }

  /** Le capital global devient la somme des books dès qu'au moins un est défini. */
  function syncInitialField() {
    const hasBooks = (state.settings.bookrolls || []).some((b) => b.name && b.name.trim());
    const input = $('#setInitial');
    input.disabled = hasBooks;
    input.value = hasBooks ? effInitial() : state.settings.initialBankroll;
    $('#setInitialHint').textContent = hasBooks
      ? 'Calculé automatiquement : somme des capitaux par bookmaker.'
      : 'Point de départ du calcul du ROC et du graphique d\'évolution.';
  }

  /** Répercute la devise principale sur les libellés « (€) » et les blocs liés. */
  function applyCurrencyUI() {
    const code = state.settings.currency || 'EUR';
    const sym = code === 'EUR' ? '€' : Money.info(code).symbol;
    $$('.cur-label').forEach((el) => { el.textContent = sym; });
    const f = $('#eurEquivField');
    if (f) f.hidden = !Money.isCrypto(code);
  }

  function renderBookrollRows() {
    const rows = state.settings.bookrolls || [];
    $('#bookrollRows').innerHTML = rows.length
      ? rows.map((b, i) => {
        const cur = b.currency || state.settings.currency || 'EUR';
        const opts = Object.entries(Money.CURRENCIES)
          .map(([code, m]) => `<option value="${code}"${code === cur ? ' selected' : ''}>${code === 'EUR' ? '€' : m.symbol}</option>`).join('');
        const eq = Money.isCrypto(cur) ? Money.eurHint(Number(b.initial) || 0, cur) : '';
        return `<div class="bookroll-row" data-i="${i}">
          <input type="text" class="input bookroll-name" list="bookmakerList" placeholder="Winamax" value="${escapeHTML(b.name)}">
          <input type="number" class="input mono bookroll-amount" min="0" step="any" placeholder="200" value="${b.initial || ''}">
          <select class="select bookroll-cur" aria-label="Devise du bookmaker">${opts}</select>
          <button type="button" class="btn-icon bookroll-del" aria-label="Retirer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
          ${eq ? `<span class="bookroll-eq">${escapeHTML(eq)}</span>` : ''}
        </div>`;
      }).join('')
      : '<p class="field-hint">Aucun bookmaker défini — le capital global ci-dessous sert de point de départ.</p>';

    $$('#bookrollRows .bookroll-row').forEach((row) => {
      const i = Number(row.dataset.i);
      const save = debounce(async () => {
        state.settings.bookrolls[i] = {
          name: row.querySelector('.bookroll-name').value.trim(),
          initial: parseFloat(row.querySelector('.bookroll-amount').value) || 0,
          currency: row.querySelector('.bookroll-cur').value || 'EUR'
        };
        await DB.setSetting('bookrolls', state.settings.bookrolls);
        await Money.ensureRates(bookCurrencies());
        syncInitialField();
        renderBookrollRows();
        renderAll();
      }, 400);
      row.querySelector('.bookroll-name').addEventListener('input', save);
      row.querySelector('.bookroll-amount').addEventListener('input', save);
      row.querySelector('.bookroll-cur').addEventListener('change', save);
      row.querySelector('.bookroll-del').addEventListener('click', async () => {
        state.settings.bookrolls.splice(i, 1);
        await DB.setSetting('bookrolls', state.settings.bookrolls);
        renderBookrollRows();
        syncInitialField();
        renderAll();
        toast('Bookmaker retiré');
      });
    });
  }

  /* ========================================================================
     Analyse — page statistique complète
     ======================================================================== */
  const AN_TABS = [
    ['overview', 'Vue d\'ensemble'], ['clv', 'CLV'], ['sport', 'Sport'], ['competition', 'Compétition'],
    ['bookmaker', 'Bookmaker'], ['type', 'Type & Tipster'], ['period', 'Période'],
    ['discipline', 'Discipline'], ['calendar', 'Calendrier'], ['ai', 'Bilan IA']
  ];
  const anState = { tab: 'overview', period: 'byMonth', sort: { key: 'count', dir: 'desc' }, page: 1, topN: 10, cal: new Date(), review: null };
  const AN_PAGE_SIZE = 12;
  const cls = (n) => (n > 0.001 ? 'pos' : n < -0.001 ? 'neg' : 'zero');

  function destroyAnCharts() {
    Object.keys(state.charts).filter((k) => k.startsWith('an_')).forEach(destroyChart);
  }

  function renderAnalytics() {
    $('#analyticsTabs').innerHTML = AN_TABS.map(([k, l]) => `<button class="an-tab ${anState.tab === k ? 'active' : ''}" data-antab="${k}">${escapeHTML(l)}</button>`).join('');
    $$('#analyticsTabs .an-tab').forEach((b) => b.addEventListener('click', () => {
      anState.tab = b.dataset.antab; anState.page = 1; anState.sort = { key: 'count', dir: 'desc' }; renderAnalytics();
    }));

    destroyAnCharts();
    const a = Analytics.compute(state.bets, state.txs, effInitial());
    const c = $('#analyticsContent');
    if (!a.general.count) { c.innerHTML = '<div class="empty-state"><p>Ajoutez des paris pour voir vos statistiques ici.</p></div>'; return; }

    ({
      overview: renderAnOverview, clv: renderAnClv, sport: renderAnSport, competition: renderAnCompetition,
      bookmaker: renderAnBookmaker, type: renderAnType, period: renderAnPeriod,
      discipline: renderAnDiscipline, calendar: renderAnCalendar, ai: renderAnAI
    })[anState.tab](c, a);
  }

  /* ---- Vue d'ensemble ---- */
  function renderAnOverview(c, a) {
    const g = a.general;
    c.innerHTML = `
      <div class="kpi-grid">
        ${anKpi('Bénéfice net', Stats.fmtSigned(g.totalProfit), cls(g.totalProfit), `${g.settled} paris réglés`)}
        ${anKpi('ROI', Stats.fmtPct(g.roi), cls(g.roi), `${Stats.fmtMoney(g.totalStake)} misés`)}
        ${anKpi('ROC', Stats.fmtPct(g.roc), cls(g.roc), `Capital investi ${Stats.fmtMoney(g.invested)}`)}
        ${anKpi('Profit factor', isFinite(g.profitFactor) ? g.profitFactor.toFixed(2) : '∞', g.profitFactor >= 1 ? 'pos' : 'neg', 'Gains bruts / pertes brutes')}
        ${anKpi('Réussite', `${g.hitRate.toFixed(0)} %`, '', `${g.won} G · ${g.lost} P`)}
        ${anKpi('Drawdown max', a.drawdown.amount > 0 ? `−${Stats.fmtMoney(a.drawdown.amount)}` : '—', a.drawdown.amount > 0 ? 'neg' : '', 'Pire chute de profit')}
        ${anKpi('Cote moyenne', g.avgOdds ? g.avgOdds.toFixed(2) : '—', '', `Mise moy. ${Stats.fmtMoney(g.avgStake || 0)}`)}
        ${anKpi('Gains / pertes bruts', `${Stats.fmtMoney(g.grossWin)}`, 'pos', `Pertes ${Stats.fmtMoney(g.grossLoss)}`)}
      </div>
      <div class="panel-row">
        <div class="panel"><div class="panel-head"><h2>Profit cumulé</h2></div><div class="chart-wrap"><canvas id="an_curve"></canvas></div></div>
        <div class="panel"><div class="panel-head"><h2>Répartition des états</h2></div><div class="chart-wrap sm"><canvas id="an_outcome"></canvas></div></div>
      </div>
      <div class="panel-row">
        <div class="panel"><div class="panel-head"><h2>Bénéfice par tranche de cote</h2></div><div class="chart-wrap sm"><canvas id="an_oddsProfit"></canvas></div></div>
        <div class="panel"><div class="panel-head"><h2>Bénéfice par tranche de mise</h2></div><div class="chart-wrap sm"><canvas id="an_stakeProfit"></canvas></div></div>
      </div>
      <div class="panel"><div class="panel-head"><h2>Détail par tranche de cote</h2></div>${anTableHTML(a.byOddsRange, false)}</div>
      <div class="panel"><div class="panel-head"><h2>Détail par tranche de mise</h2></div>${anTableHTML(a.byStakeRange, false)}</div>`;

    anProfitCurve('an_curve', a.curve);
    anDoughnut('an_outcome', a.outcomeDist);
    anProfitBar('an_oddsProfit', a.byOddsRange);
    anProfitBar('an_stakeProfit', a.byStakeRange);
  }

  /* ---- Onglets par dimension (chart + tableau triable paginé) ---- */
  function renderAnDimension(c, rows, label, nameFmt) {
    const sorted = anSort(rows);
    const top = sorted.slice(0, anState.topN === Infinity ? sorted.length : anState.topN);
    c.innerHTML = `
      <div class="panel-row">
        <div class="panel">
          <div class="panel-head"><h2>Répartition par ${escapeHTML(label.toLowerCase())}</h2>${anTopSelect()}</div>
          <div class="chart-wrap sm"><canvas id="an_dist"></canvas></div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Bénéfice par ${escapeHTML(label.toLowerCase())}</h2></div>
          <div class="chart-wrap sm"><canvas id="an_prof"></canvas></div>
        </div>
      </div>
      <div class="panel"><div class="panel-head"><h2>Détail par ${escapeHTML(label.toLowerCase())}</h2></div>${anTableHTML(sorted, true, nameFmt)}</div>`;
    anDoughnut('an_dist', top.map((r, i) => ({ name: r.sport ? `${r.name} ${Analytics.sportIcon(r.sport)}` : r.name, value: r.count, color: PALETTE[i % PALETTE.length] })));
    anProfitBar('an_prof', top);
    bindAnTable();
    bindAnTopSelect();
  }

  const sportNameFmt = (name) => `<span class="an-flag">${Analytics.sportIcon(name)}</span><span class="an-comp-name">${escapeHTML(name)}</span>`;
  const compNameFmt = (name, row) => {
    const sport = row && row.sport ? row.sport : '';
    const sIcon = sport ? `<span class="an-flag an-sport-ico" title="${escapeHTML(sport)}">${Analytics.sportIcon(sport)}</span>` : '';
    const flag = row && row.flag ? `<span class="an-flag">${row.flag}</span>` : '<span class="an-flag an-flag-none">•</span>';
    const region = row && row.region ? `<span class="an-region">${escapeHTML(row.region)}</span>` : '';
    return `${sIcon}${flag}<span class="an-comp-name">${escapeHTML(name)}</span>${region}`;
  };
  const renderAnSport = (c, a) => renderAnDimension(c, a.bySport, 'Sport', sportNameFmt);
  const renderAnCompetition = (c, a) => renderAnDimension(c, a.byCompetition, 'Compétition', compNameFmt);
  const renderAnBookmaker = (c, a) => renderAnDimension(c, a.byBookmaker, 'Bookmaker');

  function renderAnType(c, a) {
    c.innerHTML = `
      <div class="panel-row">
        <div class="panel"><div class="panel-head"><h2>Par type de pari</h2></div><div class="chart-wrap sm"><canvas id="an_typeProf"></canvas></div></div>
        <div class="panel"><div class="panel-head"><h2>Répartition des types</h2></div><div class="chart-wrap sm"><canvas id="an_typeDist"></canvas></div></div>
      </div>
      <div class="panel"><div class="panel-head"><h2>Détail par type</h2></div>${anTableHTML(a.byType, false)}</div>
      <div class="panel"><div class="panel-head"><h2>Par tipster</h2></div>${a.byTipster.length ? anTableHTML(a.byTipster, false) : '<div class="empty-state"><p>Renseignez le champ « tipster » sur vos paris pour comparer vos pronostiqueurs.</p></div>'}</div>`;
    anProfitBar('an_typeProf', a.byType);
    anDoughnut('an_typeDist', a.byType.map((r, i) => ({ name: r.name, value: r.count, color: PALETTE[i % PALETTE.length] })));
  }

  function renderAnPeriod(c, a) {
    const tabs = [['byDay', 'Jours'], ['byWeek', 'Semaines'], ['byMonth', 'Mois'], ['byYear', 'Années']];
    const data = a[anState.period];
    c.innerHTML = `
      <div class="period-picker" style="margin-bottom:16px">${tabs.map(([k, l]) => `<button class="period-btn ${anState.period === k ? 'active' : ''}" data-anperiod="${k}">${l}</button>`).join('')}</div>
      <div class="panel-row">
        <div class="panel"><div class="panel-head"><h2>Bénéfice</h2></div><div class="chart-wrap sm"><canvas id="an_perProf"></canvas></div></div>
        <div class="panel"><div class="panel-head"><h2>ROI &amp; réussite</h2></div><div class="chart-wrap sm"><canvas id="an_perRoi"></canvas></div></div>
      </div>
      <div class="panel"><div class="panel-head"><h2>Détail</h2></div>${anTableHTML(data, false)}</div>`;
    $$('#analyticsContent [data-anperiod]').forEach((b) => b.addEventListener('click', () => { anState.period = b.dataset.anperiod; renderAnalytics(); }));
    anProfitBar('an_perProf', data);
    anRoiWinBar('an_perRoi', data);
  }

  function renderAnDiscipline(c, a) {
    const g = a.general;
    const t = a.tilt;
    c.innerHTML = `
      <div class="kpi-grid">
        ${anKpi('Profit factor', isFinite(g.profitFactor) ? g.profitFactor.toFixed(2) : '∞', g.profitFactor >= 1 ? 'pos' : 'neg', g.profitFactor >= 1 ? 'Rentable' : 'À redresser')}
        ${anKpi('Drawdown max', a.drawdown.amount > 0 ? `−${Stats.fmtMoney(a.drawdown.amount)}` : '—', a.drawdown.amount > 0 ? 'neg' : '', `${a.drawdown.pct} % du pic`)}
        ${anKpi('Taux de tilt', `${t.rate.toFixed(0)} %`, t.rate > 30 ? 'neg' : '', `${t.events} mises gonflées après perte`)}
        ${anKpi('Inflation moy. (tilt)', t.avgInflation ? `×${t.avgInflation.toFixed(1)}` : '—', t.avgInflation >= 1.8 ? 'neg' : '', 'Mise vs moyenne après une perte')}
      </div>
      <div class="market-note">Le <strong>profit factor</strong> (gains bruts ÷ pertes brutes) doit rester &gt; 1. Le <strong>tilt</strong> mesure votre tendance à sur-miser après une perte — le facteur n°1 de ruine. La <strong>calibration</strong> ci-dessous compare votre réussite réelle à la probabilité implicite des cotes que vous jouez.</div>
      <div class="panel"><div class="panel-head"><h2>Calibration par tranche de cote</h2></div>
        <div class="col-headers calib-grid"><span>Cotes</span><span class="r">Paris</span><span class="r">Proba implicite</span><span class="r">Réussite réelle</span></div>
        ${a.byOddsRange.map((r) => {
          const implied = r.avgOdds > 0 ? (100 / r.avgOdds) : 0;
          const good = r.hitRate >= implied;
          return `<div class="bet-row calib-grid"><div class="bet-event">${escapeHTML(r.name)}</div><div class="bet-num">${r.count}</div><div class="bet-num">${implied.toFixed(0)} %</div><div class="bet-profit ${good ? 'pos' : 'neg'}">${r.hitRate.toFixed(0)} %</div></div>`;
        }).join('')}
        <p class="calib-note">Une réussite réelle durablement <strong>supérieure</strong> à la proba implicite = vous battez le marché sur cette tranche.</p>
      </div>`;
  }

  function renderAnCalendar(c, a) {
    const ref = anState.cal;
    const y = ref.getFullYear(), m = ref.getMonth();
    const monthLabel = ref.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    // profit net par jour du mois
    const byDay = {};
    for (const b of state.bets.filter(Stats.isCounted)) {
      const d = new Date(b.date + 'T12:00:00');
      if (d.getFullYear() === y && d.getMonth() === m) {
        const day = d.getDate();
        byDay[day] = (byDay[day] || 0) + Stats.profit(b);
      }
    }
    const first = new Date(y, m, 1);
    const startDow = (first.getDay() + 6) % 7; // lundi = 0
    const days = new Date(y, m + 1, 0).getDate();
    const maxAbs = Math.max(1, ...Object.values(byDay).map((v) => Math.abs(v)));
    let cells = '';
    for (let i = 0; i < startDow; i++) cells += '<div class="cal-cell empty"></div>';
    for (let d = 1; d <= days; d++) {
      const v = byDay[d];
      let style = '';
      if (v !== undefined) {
        const intensity = Math.min(0.85, 0.15 + Math.abs(v) / maxAbs * 0.7);
        const col = v >= 0 ? `52,211,153` : `240,101,95`;
        style = `background: rgba(${col}, ${intensity.toFixed(2)});`;
      }
      cells += `<div class="cal-cell ${v !== undefined ? 'has' : ''}" style="${style}" title="${v !== undefined ? Stats.fmtSigned(v) : ''}"><span class="cal-day">${d}</span>${v !== undefined ? `<span class="cal-val">${v >= 0 ? '+' : ''}${Math.round(v)}</span>` : ''}</div>`;
    }
    const monthTotal = Object.values(byDay).reduce((s, v) => s + v, 0);
    c.innerHTML = `
      <div class="panel">
        <div class="panel-head">
          <div class="cal-nav"><button class="btn-icon" id="calPrev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg></button><h2 style="text-transform:capitalize">${escapeHTML(monthLabel)}</h2><button class="btn-icon" id="calNext"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg></button></div>
          <span class="bet-profit ${cls(monthTotal)}">${Stats.fmtSigned(monthTotal)}</span>
        </div>
        <div class="cal-grid-head">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d) => `<span>${d}</span>`).join('')}</div>
        <div class="cal-grid">${cells}</div>
      </div>`;
    $('#calPrev').addEventListener('click', () => { anState.cal = new Date(y, m - 1, 1); renderAnalytics(); });
    $('#calNext').addEventListener('click', () => { anState.cal = new Date(y, m + 1, 1); renderAnalytics(); });
  }

  /* ---- Onglet CLV : la boussole (battre la cote de clôture) ---- */
  /** Détail des picks dont la CLV a été mesurée : cote prise vs cote de clôture. */
  function clvRows(picks) {
    const RES = { won: ['Gagné', 'pos'], lost: ['Perdu', 'neg'], void: ['Annulé', ''] };
    return picks
      .slice()
      .sort((a, b) => (b.kickoff || 0) - (a.kickoff || 0))
      .map((p) => {
        const when = p.kickoff
          ? new Date(p.kickoff).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })
          : (p.date_match || '').slice(5).split('-').reverse().join('/');
        const [rLbl, rCls] = RES[p.result] || ['En cours', ''];
        const clvCls = p.clv > 0 ? 'pos' : p.clv < 0 ? 'neg' : '';
        const proba = typeof p.probabilite === 'number' ? Math.round(p.probabilite * 100) + ' %' : '—';
        const meta = [p.sport, p.competition, when].filter(Boolean).join(' · ');
        return `<div class="bet-row clv-grid">
          <div class="bet-main">
            <div class="bet-event">${escapeHTML(p.match || '—')}${p.followed ? ' <span class="clv-followed" title="Pari suivi">✓ suivi</span>' : ''}</div>
            <div class="bet-meta">${escapeHTML(p.selection || '')}${meta ? ' — ' + escapeHTML(meta) : ''}</div>
          </div>
          <div class="bet-num r hide-m">${Number(p.cote).toFixed(2)}</div>
          <div class="bet-num r hide-m">${p.closingOdds ? Number(p.closingOdds).toFixed(2) : '—'}</div>
          <div class="bet-num r ${clvCls}"><strong>${p.clv >= 0 ? '+' : ''}${p.clv} %</strong></div>
          <div class="bet-num r hide-m">${proba}</div>
          <div class="bet-num r ${rCls}">${rLbl}</div>
        </div>`;
      }).join('');
  }

  function renderAnClv(c) {
    const picks = (state.picks || []).filter((p) => typeof p.clv === 'number');
    if (picks.length < 1) {
      c.innerHTML = `<div class="empty-state">
        <p><strong>Pas encore de CLV mesurée.</strong> La CLV (Closing Line Value) compare la cote que tu as prise à la cote de clôture du marché — elle se calcule automatiquement au coup d'envoi de chaque pick du Radar (source coteur).</p>
        <p class="empty-hint">Suis des picks du Radar et reviens ici après leurs coups d'envoi. Une CLV moyenne <strong>positive</strong> = tu bats le marché, le meilleur indicateur d'un edge réel — avant même les résultats.</p></div>`;
      return;
    }
    const clvs = picks.map((p) => p.clv);
    const n = clvs.length;
    const r1 = (x) => Math.round(x * 10) / 10;
    const avg = r1(clvs.reduce((a, b) => a + b, 0) / n);
    const posPct = Math.round(clvs.filter((v) => v > 0).length / n * 100);
    const sorted = [...clvs].sort((a, b) => a - b);
    const median = r1(sorted[Math.floor(n / 2)]);
    const cls = (x) => (x > 0.001 ? 'pos' : x < -0.001 ? 'neg' : '');
    const wr = (arr) => { const s = arr.filter((p) => p.result === 'won' || p.result === 'lost'); return s.length ? Math.round(s.filter((p) => p.result === 'won').length / s.length * 100) : null; };
    const wrPos = wr(picks.filter((p) => p.clv > 0)), wrNeg = wr(picks.filter((p) => p.clv <= 0));
    const edge = avg > 0 && posPct >= 50;

    const bySport = {};
    picks.forEach((p) => { const s = p.sport || 'Autre'; (bySport[s] = bySport[s] || []).push(p.clv); });
    const sportRows = Object.entries(bySport).map(([s, arr]) => ({ name: s, n: arr.length, avg: r1(arr.reduce((a, b) => a + b, 0) / arr.length), pos: Math.round(arr.filter((v) => v > 0).length / arr.length * 100) })).sort((a, b) => b.n - a.n);

    const buckets = [['≤ −5 %', (v) => v <= -5], ['−5 à −2', (v) => v > -5 && v <= -2], ['−2 à 0', (v) => v > -2 && v < 0], ['0 à +2', (v) => v >= 0 && v < 2], ['+2 à +5', (v) => v >= 2 && v < 5], ['≥ +5 %', (v) => v >= 5]];
    const dist = buckets.map(([, f]) => clvs.filter(f).length);

    c.innerHTML = `
      <div class="market-note" style="border-left-color:${edge ? 'var(--accent)' : 'var(--amber)'}">
        ${edge
        ? `<strong>Signal d'edge réel.</strong> CLV moyenne positive (+${avg} %) et ${posPct} % de tes picks battent la clôture. Sur la durée, c'est le meilleur prédicteur de rentabilité — continue ainsi.`
        : `CLV moyenne de ${avg >= 0 ? '+' : ''}${avg} % sur ${n} picks. Pour battre le marché durablement, vise une CLV moyenne positive et plus de 50 % de picks à CLV positive.`}
      </div>
      <div class="kpi-grid" style="margin-bottom:16px">
        ${kpiCard('CLV moyenne', (avg >= 0 ? '+' : '') + avg + ' %', cls(avg), `sur ${n} picks mesurés`)}
        ${kpiCard('Picks CLV positive', posPct + ' %', posPct >= 50 ? 'pos' : 'neg', 'battent la cote de clôture')}
        ${kpiCard('CLV médiane', (median >= 0 ? '+' : '') + median + ' %', cls(median), 'moitié au-dessus / en dessous')}
        ${kpiCard('Réussite CLV+ / CLV−', (wrPos != null ? wrPos + '%' : '—') + ' / ' + (wrNeg != null ? wrNeg + '%' : '—'), '', 'taux de gain selon la CLV')}
      </div>
      <div class="panel-row">
        <div class="panel"><div class="panel-head"><h2>Distribution de la CLV</h2></div><div class="chart-wrap sm"><canvas id="an_clvDist"></canvas></div></div>
        <div class="panel"><div class="panel-head"><h2>CLV par sport</h2></div>
          <div class="col-headers" style="grid-template-columns:1fr 56px 88px 84px"><span>Sport</span><span class="r">Picks</span><span class="r">CLV moy.</span><span class="r">% pos.</span></div>
          ${sportRows.map((r) => `<div class="bet-row" style="grid-template-columns:1fr 56px 88px 84px"><div class="bet-main"><div class="bet-event">${escapeHTML(r.name)}</div></div><div class="bet-num r">${r.n}</div><div class="bet-num r ${cls(r.avg)}">${r.avg >= 0 ? '+' : ''}${r.avg} %</div><div class="bet-num r">${r.pos} %</div></div>`).join('')}
        </div>
      </div>
      <div class="panel"><div class="panel-head"><h2>Détail des picks mesurés</h2><span class="field-hint" style="margin:0">${n} pick${n > 1 ? 's' : ''} · triés du plus récent</span></div>
        <div class="col-headers clv-grid">
          <span>Match</span><span class="r hide-m">Prise</span><span class="r hide-m">Clôture</span><span class="r">CLV</span><span class="r hide-m">Proba</span><span class="r">Résultat</span>
        </div>
        ${clvRows(picks)}
      </div>
      <p class="calib-note"><strong>Pourquoi la CLV est ta vraie boussole ?</strong> Battre la cote de clôture veut dire que tu as parié à un meilleur prix que le marché final. C'est mathématiquement corrélé au profit long terme, même quand un pari isolé perd. Un bon parieur se juge d'abord à sa CLV, pas à ses résultats de court terme.</p>`;

    const colors = dist.map((_, i) => (i < 3 ? 'rgba(240,101,95,0.78)' : 'rgba(52,211,153,0.82)'));
    state.charts['an_clvDist'] = new Chart($('#an_clvDist'), {
      type: 'bar',
      data: { labels: buckets.map((b) => b[0]), datasets: [{ data: dist, backgroundColor: colors, borderRadius: 5, maxBarThickness: 46 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1d212a', borderColor: '#2e3340', borderWidth: 1, padding: 9, displayColors: false, callbacks: { label: (i) => `${i.parsed.y} pick${i.parsed.y > 1 ? 's' : ''}` } } }, scales: { x: { grid: { display: false }, ticks: { color: chartDefaults.color, font: chartDefaults.font }, border: { color: chartDefaults.borderColor } }, y: { grid: { color: 'rgba(34,38,47,0.6)' }, ticks: { color: chartDefaults.color, font: chartDefaults.font, precision: 0 }, border: { display: false } } } }
    });
  }

  async function renderAnAI(c, a) {
    if (!state.settings.apiKey) { c.innerHTML = '<div class="empty-state"><p>Ajoutez votre clé API Gemini dans les <strong>Réglages</strong> pour générer votre bilan personnalisé.</p></div>'; return; }
    if (a.general.settled < 5) { c.innerHTML = `<div class="empty-state"><p>Le bilan IA nécessite au moins <strong>5 paris réglés</strong> (actuellement ${a.general.settled}).</p></div>`; return; }

    if (anState.review) { c.innerHTML = anReviewHTML(anState.review); bindAnReviewBtn(a); return; }

    c.innerHTML = `<div class="empty-state">
      <p>Laissez l'IA analyser en profondeur votre historique pour révéler vos zones rentables, vos erreurs coûteuses et des recommandations concrètes.</p>
      <button class="btn-primary" id="runReview" style="margin-top:14px">Générer mon bilan</button>
    </div>`;
    bindAnReviewBtn(a);
  }

  function bindAnReviewBtn(a) {
    const btn = $('#runReview') || $('#rerunReview');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = 'Analyse en cours…';
      try {
        anState.review = await Gemini.review(state.settings.apiKey, state.settings.model, Analytics.reviewSummary(a));
        anState.review.generatedAt = Date.now();
        renderAnalytics();
      } catch (err) {
        btn.disabled = false; btn.textContent = prev;
        toast(`Bilan impossible : ${err.message}`);
      }
    });
  }

  function anReviewHTML(r) {
    const items = (arr, cl) => arr.map((it) => `<div class="review-item ${cl}"><h4>${escapeHTML(it.titre)}</h4><p>${escapeHTML(it.detail)}</p></div>`).join('');
    return `
      <div class="market-note">${escapeHTML(r.resume)}</div>
      <div class="panel-row">
        <div class="panel"><div class="panel-head"><h2 style="color:var(--accent)">Vos points forts</h2></div>${items(r.forces || [], 'pos')}</div>
        <div class="panel"><div class="panel-head"><h2 style="color:var(--red)">Vos points faibles</h2></div>${items(r.faiblesses || [], 'neg')}</div>
      </div>
      <div class="panel"><div class="panel-head"><h2>Recommandations</h2></div>
        ${(r.recommandations || []).map((rec) => `<div class="review-reco">→ ${escapeHTML(rec)}</div>`).join('')}
      </div>
      <div style="text-align:center;margin-top:10px"><button class="btn-secondary" id="rerunReview">Régénérer le bilan</button>
      <p class="empty-hint" style="margin-top:8px">Généré le ${new Date(r.generatedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</p></div>`;
  }

  /* ---- Helpers Analyse ---- */
  function anKpi(label, value, klass, sub) {
    return `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value ${klass}">${value}</div><div class="kpi-sub">${sub}</div></div>`;
  }

  const AN_COLS = [
    { key: 'name', name: 'Nom' },
    { key: 'count', name: 'Paris', num: true },
    { key: 'totalStake', name: 'Mise', num: true, fmt: (v) => Stats.fmtMoney(v) },
    { key: 'totalProfit', name: 'Bénéfice', num: true, fmt: (v) => Stats.fmtSigned(v), color: true },
    { key: 'roi', name: 'ROI', num: true, fmt: (v) => Stats.fmtPct(v), color: true },
    { key: 'hitRate', name: 'Réussite', num: true, fmt: (v) => `${v.toFixed(0)} %` },
    { key: 'avgOdds', name: 'Cote moy.', num: true, fmt: (v) => v ? v.toFixed(2) : '—' }
  ];

  function anTableHTML(rows, sortable, nameFmt) {
    const paged = sortable ? rows.slice((anState.page - 1) * AN_PAGE_SIZE, anState.page * AN_PAGE_SIZE) : rows;
    const pages = Math.ceil(rows.length / AN_PAGE_SIZE);
    const head = AN_COLS.map((col) => {
      const arrow = sortable && anState.sort.key === col.key ? (anState.sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
      return `<span class="${col.num ? 'r' : ''}${sortable ? ' an-sort' : ''}" ${sortable ? `data-sortkey="${col.key}"` : ''}>${col.name}${arrow}</span>`;
    }).join('');
    const body = paged.map((row) => AN_COLS.map((col) => {
      let v = row[col.key];
      let disp = col.key === 'name' && nameFmt ? nameFmt(v, row) : (col.fmt ? col.fmt(v) : v);
      const colorCls = col.color ? cls(v) : '';
      return `<span class="${col.num ? 'r ' : ''}${col.key === 'name' ? 'an-name' : ''} ${colorCls}">${disp}</span>`;
    }).join('')).join('</div><div class="an-row">');
    const pag = sortable && pages > 1
      ? `<div class="pagination"><button class="btn-icon" data-anpage="prev" ${anState.page <= 1 ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg></button><span class="pagination-info">Page ${anState.page}/${pages}</span><button class="btn-icon" data-anpage="next" ${anState.page >= pages ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg></button></div>`
      : '';
    return `<div class="an-table"><div class="an-row an-head">${head}</div><div class="an-row">${body}</div></div>${pag}`;
  }

  function anSort(rows) {
    const { key, dir } = anState.sort;
    return rows.slice().sort((x, y) => {
      const a = x[key], b = y[key];
      if (typeof a === 'string') return dir === 'asc' ? a.localeCompare(b) : b.localeCompare(a);
      return dir === 'asc' ? a - b : b - a;
    });
  }

  function bindAnTable() {
    $$('#analyticsContent .an-sort').forEach((el) => el.addEventListener('click', () => {
      const key = el.dataset.sortkey;
      anState.sort = { key, dir: anState.sort.key === key && anState.sort.dir === 'desc' ? 'asc' : 'desc' };
      renderAnalytics();
    }));
    const prev = $('#analyticsContent [data-anpage="prev"]');
    const next = $('#analyticsContent [data-anpage="next"]');
    if (prev) prev.addEventListener('click', () => { if (anState.page > 1) { anState.page--; renderAnalytics(); } });
    if (next) next.addEventListener('click', () => { anState.page++; renderAnalytics(); });
  }

  function anTopSelect() {
    return `<select class="select" id="anTop">${[['5', 5], ['10', 10], ['20', 20], ['Tous', Infinity]].map(([l, v]) => `<option value="${v}" ${anState.topN === v ? 'selected' : ''}>Top ${l}</option>`).join('')}</select>`;
  }
  function bindAnTopSelect() {
    const s = $('#anTop');
    if (s) s.addEventListener('change', () => { anState.topN = s.value === 'Infinity' ? Infinity : Number(s.value); renderAnalytics(); });
  }

  /* ---- Graphiques Analyse ---- */
  function anDoughnut(id, items) {
    if (!items.length) return;
    state.charts['an_' + id] = new Chart($(`#${id}`), {
      type: 'doughnut',
      data: { labels: items.map((i) => i.name), datasets: [{ data: items.map((i) => i.value), backgroundColor: items.map((i) => i.color || PALETTE[0]), borderColor: '#111318', borderWidth: 3, hoverOffset: 5 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '66%', plugins: { legend: { position: 'right', labels: { color: chartDefaults.color, font: chartDefaults.font, boxWidth: 9, boxHeight: 9, padding: 8, usePointStyle: true } }, tooltip: { backgroundColor: '#1d212a', borderColor: '#2e3340', borderWidth: 1, padding: 9 } } }
    });
  }

  function anProfitBar(id, rows) {
    state.charts['an_' + id] = new Chart($(`#${id}`), {
      type: 'bar',
      data: { labels: rows.map((r) => r.name), datasets: [{ data: rows.map((r) => Math.round(r.totalProfit * 100) / 100), backgroundColor: rows.map((r) => r.totalProfit >= 0 ? 'rgba(52,211,153,0.75)' : 'rgba(240,101,95,0.75)'), borderRadius: 5, maxBarThickness: 30 }] },
      options: { responsive: true, maintainAspectRatio: false, indexAxis: rows.length > 6 ? 'y' : 'x', plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1d212a', borderColor: '#2e3340', borderWidth: 1, padding: 9, displayColors: false, callbacks: { label: (i) => `Bénéfice : ${Stats.fmtSigned(rows.length > 6 ? i.parsed.x : i.parsed.y)}` } } }, scales: { x: { grid: { display: false }, ticks: { color: chartDefaults.color, font: chartDefaults.font, callback: rows.length > 6 ? ((v) => Stats.fmtMoney(v)) : undefined }, border: { color: chartDefaults.borderColor } }, y: { grid: { color: 'rgba(34,38,47,0.6)' }, ticks: { color: chartDefaults.color, font: chartDefaults.font, callback: rows.length > 6 ? undefined : ((v) => Stats.fmtMoney(v)) }, border: { display: false } } } }
    });
  }

  function anRoiWinBar(id, rows) {
    state.charts['an_' + id] = new Chart($(`#${id}`), {
      type: 'bar',
      data: { labels: rows.map((r) => r.name), datasets: [
        { label: 'ROI %', data: rows.map((r) => Math.round(r.roi * 10) / 10), backgroundColor: 'rgba(91,141,239,0.8)', borderRadius: 4, maxBarThickness: 20 },
        { label: 'Réussite %', data: rows.map((r) => Math.round(r.hitRate * 10) / 10), backgroundColor: 'rgba(232,180,90,0.8)', borderRadius: 4, maxBarThickness: 20 }
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: chartDefaults.color, font: chartDefaults.font, boxWidth: 9, usePointStyle: true } }, tooltip: { backgroundColor: '#1d212a', borderColor: '#2e3340', borderWidth: 1, padding: 9 } }, scales: { x: { grid: { display: false }, ticks: { color: chartDefaults.color, font: chartDefaults.font }, border: { color: chartDefaults.borderColor } }, y: { grid: { color: 'rgba(34,38,47,0.6)' }, ticks: { color: chartDefaults.color, font: chartDefaults.font }, border: { display: false } } } }
    });
  }

  function anProfitCurve(id, curve) {
    const ctx = $(`#${id}`).getContext('2d');
    const pts = [{ x: 'Départ', y: 0 }, ...curve.map((p) => ({ x: p.x, y: p.y }))];
    const up = pts[pts.length - 1].y >= 0;
    const color = up ? '#34d399' : '#f0655f';
    const grad = ctx.createLinearGradient(0, 0, 0, 260);
    grad.addColorStop(0, up ? 'rgba(52,211,153,0.18)' : 'rgba(240,101,95,0.18)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    state.charts['an_' + id] = new Chart(ctx, {
      type: 'line',
      data: { labels: pts.map((p) => p.x), datasets: [{ data: pts.map((p) => p.y), borderColor: color, backgroundColor: grad, fill: true, borderWidth: 2, pointRadius: pts.length > 40 ? 0 : 2, tension: 0.3 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1d212a', borderColor: '#2e3340', borderWidth: 1, padding: 9, displayColors: false, callbacks: { label: (i) => Stats.fmtSigned(i.parsed.y) } } }, scales: { x: { grid: { display: false }, ticks: { color: chartDefaults.color, font: chartDefaults.font, maxTicksLimit: 8 }, border: { color: chartDefaults.borderColor } }, y: { grid: { color: 'rgba(34,38,47,0.6)' }, ticks: { color: chartDefaults.color, font: chartDefaults.font, callback: (v) => Stats.fmtMoney(v) }, border: { display: false } } } }
    });
  }

  /* ========================================================================
     Scores en direct (paris en cours du jour)
     ======================================================================== */
  let liveTimer = null;

  function bindLive() {
    $('#liveRefresh').addEventListener('click', () => refreshLive(true));
    // Rafraîchissement auto toutes les 90 s quand l'onglet est visible
    liveTimer = setInterval(() => { if (!document.hidden) refreshLive(false); }, 180000);
    // Rafraîchissement léger des comptes à rebours / transitions (imminent → en cours) toutes les 30 s
    setInterval(() => {
      if (document.hidden) return;
      renderLiveStrip();
      if ($('#view-bets').classList.contains('active')) renderBets();
    }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshLive(false); });
    refreshLive(false);
  }

  /** Paris en attente dont le match est aujourd'hui (candidats au live). */
  function todaysPendingBets() {
    const today = new Date().toISOString().slice(0, 10);
    const seen = new Set();
    return state.bets.filter((b) => {
      if (b.status !== 'pending' || b.date !== today) return false;
      const key = `${b.event}`.toLowerCase();
      if (seen.has(key)) return false; // dédoublonne les matchs (plusieurs paris même match)
      seen.add(key);
      return true;
    });
  }

  async function refreshLive(manual) {
    const matches = todaysPendingBets();
    const show = matches.length > 0;
    $('#liveBox').hidden = !show;
    $('#liveBoxMobile').hidden = !show;
    if (!show) { liveStatusById.clear(); renderLiveStrip(); return; }

    if (manual) $('#liveRefresh').classList.add('spinning');
    try {
      // Scores 100 % sans IA : coteur (gratuit) puis api-sports (1 appel « live »
      // par sport, quel que soit le nombre de matchs). Aucun jeton consommé.
      const statuses = await Scores.forBets(matches, { apiFootballKey: state.settings.apiFootballKey });

      liveStatusById.clear();
      for (const [id, s] of statuses) liveStatusById.set(id, s);

      renderLive(statuses, matches);
      renderLiveStrip();
      if ($('#view-bets').classList.contains('active')) renderBets();
    } catch (err) {
      const msg = '<p class="live-empty">Live indisponible.</p>';
      $('#liveBoxList').innerHTML = msg;
      $('#liveBoxListMobile').innerHTML = msg;
    } finally {
      setTimeout(() => $('#liveRefresh').classList.remove('spinning'), 600);
    }
  }

  function renderLive(statuses, matches) {
    const liveNow = new Map(); // id → nom lisible, pour l'alerte coup d'envoi

    const rows = matches.map((m) => {
      const teams = escapeHTML((m.event || '').replace(/\s*[–—-]\s*/g, ' – '));
      const plain = (m.event || '').replace(/\s*[–—-]\s*/g, ' – ');
      const s = statuses.get(String(m.id));
      if (!s) return liveRow(teams, null, 'à venir', 'done');

      const cls = s.phase === 'finished' ? 'done' : /mi-?temps|^MT$/i.test(s.min || '') ? 'ht' : '';
      const min = s.phase === 'finished' ? 'Fin' : (s.min || 'live');
      if (s.phase !== 'finished') liveNow.set(String(m.id), plain);
      return liveRow(teams, s.score, min, cls);
    });

    // Alerte « coup d'envoi » : match qui passe en live entre deux rafraîchissements
    if (_liveSeeded) {
      for (const [id, name] of liveNow) {
        if (!_prevLive.has(id) && !_notified.has('ko-' + id)) {
          _notified.add('ko-' + id);
          Notify.send('⚽ Coup d\'envoi', `${name} — c'est parti, tu as un pari sur ce match.`, 'ko-' + id);
        }
      }
    }
    _prevLive = new Set(liveNow.keys());
    _liveSeeded = true;

    const html = rows.join('') || '<p class="live-empty">Aucun match en cours.</p>';
    $('#liveBoxList').innerHTML = html;
    $('#liveBoxListMobile').innerHTML = html;
  }

  function liveRow(teams, score, min, cls) {
    return `<div class="live-row"><span class="live-teams">${teams}</span>${score ? `<span class="live-score">${escapeHTML(score)}</span>` : ''}<span class="live-min ${cls}">${escapeHTML(min)}</span></div>`;
  }

  /* ========================================================================
     Utilitaires
     ======================================================================== */
  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function escapeHTML(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  document.addEventListener('DOMContentLoaded', init);
})();
