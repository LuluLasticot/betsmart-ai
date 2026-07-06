/* ==========================================================================
   BetSmart AI — Application
   ========================================================================== */
'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  /* ---- État ---- */
  const state = {
    bets: [],
    txs: [],
    picks: [],
    settings: { initialBankroll: 500, apiKey: '', model: 'gemini-2.5-flash', bookrolls: [] },
    period: 'all',
    view: 'dashboard',
    charts: {},
    scanQueue: []
  };

  /** Capital initial effectif : somme des capitaux par bookmaker si définis, sinon le capital global. */
  function effInitial() {
    const br = (state.settings.bookrolls || []).filter((b) => b.name && b.name.trim());
    return br.length ? br.reduce((s, b) => s + (Number(b.initial) || 0), 0) : (Number(state.settings.initialBankroll) || 0);
  }

  const STATUS_LABELS = { pending: 'En attente', won: 'Gagné', lost: 'Perdu', void: 'Annulé', cashout: 'Cash out' };
  const TYPE_LABELS = { simple: 'Simple', combine: 'Combiné', systeme: 'Système' };

  /* ========================================================================
     Initialisation
     ======================================================================== */
  async function init() {
    const saved = await DB.getAllSettings();
    Object.assign(state.settings, saved);
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
    maybeOnboard();

    renderAll();
    renderTxList();

    // Synchronisation cloud (chargée en arrière-plan, sans bloquer l'affichage)
    bindCloud();
    Cloud.init({
      onChange: async () => {
        const saved = await DB.getAllSettings();
        Object.assign(state.settings, saved);
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
    $('#sidebarBankroll').textContent = Stats.fmtMoney(k.bankroll);
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
  const FILTER_IDS = ['filterStatus', 'filterSport', 'filterBookmaker', 'filterType', 'filterTipster'];

  function bindFilters() {
    FILTER_IDS.forEach((id) =>
      $(`#${id}`).addEventListener('change', () => { persistFilters(); renderBets(); }));
    $('#filterSearch').addEventListener('input', debounce(renderBets, 180));
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
    const bookmaker = $('#filterBookmaker').value;
    const type = $('#filterType').value;
    const tipster = $('#filterTipster').value;
    const q = $('#filterSearch').value.trim().toLowerCase();

    return state.bets.filter((b) =>
      (!status || b.status === status) &&
      (!sport || b.sport === sport) &&
      (!bookmaker || b.bookmaker === bookmaker) &&
      (!type || b.betType === type) &&
      (!tipster || b.tipster === tipster) &&
      (!q || `${b.event} ${b.selection} ${b.competition || ''} ${b.tipster || ''}`.toLowerCase().includes(q))
    );
  }

  function renderBets() {
    refreshFilterOptions();
    const bets = filteredBets();
    const k = Stats.kpis(bets, 0);
    $('#betsCount').textContent = `${bets.length} paris · ${Stats.fmtSigned(k.profit)} de profit sur la sélection`;

    $('#betsList').innerHTML = bets.length
      ? `<div class="col-headers"><span>Pari</span><span class="r hide-m">Date</span><span class="r hide-m">Cote</span><span class="r hide-m">Mise</span><span class="r">P/L</span><span></span></div>`
        + bets.map(betRowHTML).join('')
      : '<div class="empty-state"><p>Aucun pari ne correspond à ces filtres.</p></div>';
    bindBetRowActions($('#betsList'));

    // Bouton de vérification IA des résultats
    const overdue = pendingOverdue();
    $('#checkResults').hidden = overdue.length === 0;
    $('#checkResultsLabel').textContent = `Vérifier les résultats (${overdue.length})`;
  }

  /** Paris en attente dont la date est aujourd'hui ou passée. */
  function pendingOverdue() {
    const today = new Date().toISOString().slice(0, 10);
    return state.bets.filter((b) => b.status === 'pending' && b.date <= today);
  }

  function betRowHTML(b) {
    const p = Stats.profit(b);
    const profitCls = b.status === 'pending' ? 'zero' : p > 0.001 ? 'pos' : p < -0.001 ? 'neg' : 'zero';
    const profitTxt = b.status === 'pending' ? '—' : Stats.fmtSigned(p);
    const dateTxt = new Date(b.date + 'T00:00:00').toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
    const typeTxt = b.betType !== 'simple' ? ` · ${TYPE_LABELS[b.betType]}${b.legs > 1 ? ` ×${b.legs}` : ''}` : '';

    return `<div class="bet-row" data-id="${b.id}">
      <div class="bet-main">
        <div class="bet-event">${escapeHTML(b.event)}</div>
        <div class="bet-meta">${escapeHTML(b.selection)}<span class="sep">·</span>${escapeHTML(b.sport)}${typeTxt}<span class="sep">·</span>${escapeHTML(b.bookmaker)}</div>
      </div>
      <div class="bet-num hide-m">${dateTxt}</div>
      <div class="bet-num hide-m">${Number(b.odds).toFixed(2)}</div>
      <div class="bet-num strong hide-m">${Stats.fmtMoney(Number(b.stake))}</div>
      <div class="bet-profit ${profitCls}">${b.status === 'pending' ? `<span class="badge pending">${STATUS_LABELS.pending}</span>` : profitTxt}</div>
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

    $('#onboardForm').addEventListener('submit', async (e) => {
      e.preventDefault();
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

    $('#fType').addEventListener('change', () => {
      $('#legsField').hidden = $('#fType').value === 'simple';
    });
    $('#fStatus').addEventListener('change', () => {
      $('#payoutField').hidden = $('#fStatus').value !== 'cashout';
    });
    ['fOdds', 'fStake'].forEach((id) => $(`#${id}`).addEventListener('input', updatePotentialGain));

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
    $('#betModalTitle').textContent = bet ? 'Modifier le pari' : 'Nouveau pari';
    $('#saveBet').textContent = bet ? 'Enregistrer' : 'Valider le pari';
    resetScanUI();

    $('#betId').value = bet?.id || '';
    $('#fDate').value = bet?.date || new Date().toISOString().slice(0, 10);
    $('#fBookmaker').value = bet?.bookmaker || '';
    $('#fSport').value = bet?.sport || '';
    $('#fCompetition').value = bet?.competition || '';
    $('#fEvent').value = bet?.event || '';
    $('#fSelection').value = bet?.selection || '';
    $('#fType').value = bet?.betType || 'simple';
    $('#fLegs').value = bet?.legs || 2;
    $('#legsField').hidden = ($('#fType').value === 'simple');
    $('#fOdds').value = bet?.odds ?? '';
    $('#fStake').value = bet?.stake ?? '';
    $('#fTipster').value = bet?.tipster || '';
    $('#fStatus').value = bet?.status || 'pending';
    $('#fPayout').value = bet?.payout ?? '';
    $('#payoutField').hidden = $('#fStatus').value !== 'cashout';
    updatePotentialGain();
  }

  /** Vos books configurés apparaissent en tête des suggestions du formulaire. */
  function refreshBookmakerDatalist() {
    const mine = (state.settings.bookrolls || []).map((b) => b.name.trim()).filter(Boolean);
    const defaults = ['Winamax', 'Betclic', 'Unibet', 'ParionsSport', 'PMU', 'Zebet', 'Bwin', 'PokerStars Sports', 'Olybet'];
    const all = [...new Set([...mine, ...defaults])];
    $('#bookmakerList').innerHTML = all.map((n) => `<option>${escapeHTML(n)}</option>`).join('');
  }

  function closeBetModal() {
    $('#betModal').hidden = true;
    document.body.style.overflow = '';
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

    const existing = bet.id ? state.bets.find((b) => b.id === bet.id) : null;
    if (existing) bet.createdAt = existing.createdAt;

    // Garde-fou anti-tilt : mise anormale après des pertes consécutives
    if (!existing) {
      const warning = Stats.tiltCheck(state.bets, bet);
      if (warning && !confirm(`⚠️ ${warning}\n\nEnregistrer quand même ?`)) return;
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
      $('#legsField').hidden = d.betType === 'simple';
      if (d.legs > 1) setField('#fLegs', d.legs);
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
    $('#settlePicks').addEventListener('click', settleRadarPicks);
    renderRadarPerf();
    restoreLastRadar();
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
      deepModel: $('#advDeep').checked ? 'gemini-2.5-pro' : null
    };
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
      const result = await Advisor.suggest(state.settings.apiKey, state.settings.model, ctx, (step) => renderRadarProgress(step));

      // Mémorisation des picks (traçabilité + apprentissage)
      const savedIds = [];
      for (const p of result.picks) {
        const saved = await DB.savePick({ ...p, followed: false, result: null, profile: $('#advProfile').value });
        savedIds.push(saved.id);
        state.picks.unshift(saved);
      }
      result.picks = result.picks.map((p, i) => ({ ...p, id: savedIds[i] }));

      await DB.setSetting('lastRadar', { result, profileKey: $('#advProfile').value, bankroll: ctx.bankroll, at: Date.now() });
      renderAdvisorResult(result, $('#advProfile').value, ctx.bankroll, Date.now());
      renderRadarPerf();
    } catch (err) {
      container.innerHTML = `<div class="empty-state"><p>Radar indisponible : ${escapeHTML(err.message)}</p><p class="empty-hint">La recherche Google (grounding) nécessite une clé API dont le quota le permet. Réessayez dans une minute.</p></div>`;
    } finally {
      btn.disabled = false;
    }
  }

  async function restoreLastRadar() {
    const last = await DB.getSetting('lastRadar');
    if (!last || !last.result) return;
    renderAdvisorResult(last.result, last.profileKey, last.bankroll, last.at);
  }

  /* ---- Analyse d'un match précis ---- */
  async function runMatchAnalysis() {
    const query = $('#matchQuery').value.trim();
    if (!query) return;
    if (!state.settings.apiKey) { toast('Ajoutez votre clé API Gemini dans les Réglages'); return; }

    const btn = $('#analyzeMatch');
    btn.disabled = true;
    $('#advisorContent').innerHTML = `<div class="coach-loading"><span class="spinner"></span>Analyse approfondie de « ${escapeHTML(query)} »… (~30 s)</div>`;

    try {
      const ctx = buildAdvisorCtx();
      const r = await Advisor.analyzeMatch(state.settings.apiKey, state.settings.model, ctx, query);
      renderMatchAnalysis(r, ctx);
    } catch (err) {
      $('#advisorContent').innerHTML = `<div class="empty-state"><p>Analyse impossible : ${escapeHTML(err.message)}</p></div>`;
    } finally {
      btn.disabled = false;
    }
  }

  function renderMatchAnalysis(r, ctx) {
    const container = $('#advisorContent');
    if (!r.trouve) {
      container.innerHTML = `<div class="market-note">Match introuvable ou ambigu — précisez les équipes et la date (ex : « Lyon – Lille samedi »).</div>`;
      return;
    }
    const dateTxt = r.date_match ? new Date(r.date_match + 'T00:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) + (r.heure_match ? ` · ${r.heure_match}` : '') : '';
    const profileKey = $('#advProfile').value;
    const k = Stats.kpis(state.bets, effInitial(), state.txs);

    container.innerHTML = `<div class="pick-card">
      <div class="pick-top">
        <div class="pick-title">
          <h3>${escapeHTML(r.match)}</h3>
          <div class="pick-meta">${escapeHTML(r.sport || '')} · ${escapeHTML(r.competition || '')}${dateTxt ? ' · ' + dateTxt : ''}</div>
        </div>
        <span class="verdict-badge ${r.verdict === 'a_jouer' ? 'play' : 'avoid'}">${r.verdict === 'a_jouer' ? 'Value détectée' : 'À éviter'}</span>
      </div>
      <p class="pick-analysis">${escapeHTML(r.resume || '')}</p>
      <div class="markets-table">
        ${(r.marches || []).map((m, i) => {
          const pos = m.value_pct >= 5;
          return `<div class="market-row">
            <div><strong>${escapeHTML(m.selection)}</strong><div class="pick-meta">${escapeHTML(m.marche || '')} · ${escapeHTML(m.bookmaker || '')}${m.cote_verifiee === false ? ' · cote estimée' : ''}</div></div>
            <div class="bet-num">${Number(m.cote).toFixed(2)}</div>
            <div class="bet-num hide-m">${Math.round(m.probabilite * 100)} %</div>
            <div class="bet-profit ${pos ? 'pos' : 'neg'}">${m.value_pct >= 0 ? '+' : ''}${Number(m.value_pct).toFixed(1)} %</div>
            <div class="avis">${escapeHTML(m.avis || '')}${pos ? ` · <button class="link-btn" data-add-market="${i}">parier</button>` : ''}</div>
          </div>`;
        }).join('')}
      </div>
      ${r.risques ? `<p class="pick-risks" style="margin-top:12px"><strong>Risques :</strong> ${escapeHTML(r.risques)}</p>` : ''}
      <div class="pick-footer"><span class="pick-sources">${(r.sources || []).slice(0, 3).map(escapeHTML).join(' · ')}</span></div>
    </div>`;

    container.querySelectorAll('[data-add-market]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = r.marches[Number(btn.dataset.addMarket)];
        const stake = Advisor.stakeFor(k.bankroll, m, profileKey).stake;
        prefillBetFromPick({
          date_match: r.date_match, bookmaker: m.bookmaker, sport: r.sport,
          competition: r.competition, match: r.match, selection: m.selection, cote: m.cote
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
      html += '<div class="empty-state"><p><strong>Aucun value bet détecté</strong> sur la période — le Radar préfère s\'abstenir plutôt que de proposer des paris sans avantage statistique.</p><p class="empty-hint">Relancez demain ou élargissez la fenêtre à 72 h.</p></div>';
      container.innerHTML = html;
      return;
    }

    html += result.picks.map((p, i) => {
      const m = Advisor.stakeFor(bankroll, p, profileKey);
      const dateTxt = p.date_match
        ? new Date(p.date_match + 'T00:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) + (p.heure_match ? ` · ${p.heure_match}` : '')
        : '';
      const conf = [1, 2, 3, 4, 5].map((n) => `<i class="${n <= (p.confiance || 0) ? 'on' : ''}"></i>`).join('');
      const sources = (p.sources || []).slice(0, 3).map(escapeHTML).join(' · ');
      const coteBadge = p.cote_verifiee === false ? '<span class="pick-value-badge est">cote estimée</span>' : '';

      return `<div class="pick-card" data-pick="${i}">
        <div class="pick-top">
          <div class="pick-title">
            <h3>${escapeHTML(p.match)}</h3>
            <div class="pick-meta">${escapeHTML(p.sport)} · ${escapeHTML(p.competition || '')}${dateTxt ? ' · ' + dateTxt : ''}</div>
          </div>
          <div>
            <span class="pick-value-badge">value +${Number(p.value_pct).toFixed(1)} %</span>
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

    html += `<p class="empty-hint" style="text-align:center;margin-top:12px">Mises calculées par Kelly fractionné (profil ${escapeHTML(Advisor.PROFILES[profileKey].label.toLowerCase())}) sur une bankroll de ${Stats.fmtMoney(bankroll)}.</p>`;
    container.innerHTML = html;

    container.querySelectorAll('[data-add-pick]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const p = result.picks[Number(btn.dataset.addPick)];
        const m = Advisor.stakeFor(bankroll, p, profileKey);
        // Trace le pick comme "suivi" pour comparer picks suivis vs ignorés
        if (p.id) {
          const stored = state.picks.find((x) => x.id === p.id);
          if (stored && !stored.followed) {
            stored.followed = true;
            await DB.savePick(stored);
          }
        }
        prefillBetFromPick(p, m.stake);
      });
    });
  }

  /** Pré-remplit le formulaire de pari depuis un pick du Radar. */
  function prefillBetFromPick(p, stake) {
    openBetModal();
    $('#fDate').value = p.date_match && /^\d{4}-\d{2}-\d{2}$/.test(p.date_match) ? p.date_match : new Date().toISOString().slice(0, 10);
    $('#fBookmaker').value = p.bookmaker || '';
    $('#fSport').value = p.sport || '';
    $('#fCompetition').value = p.competition || '';
    $('#fEvent').value = p.match || '';
    $('#fSelection').value = p.selection || '';
    $('#fType').value = 'simple';
    $('#legsField').hidden = true;
    $('#fOdds').value = p.cote || '';
    $('#fStake').value = stake || '';
    $('#fTipster').value = 'Radar IA';
    $('#fStatus').value = 'pending';
    updatePotentialGain();
    toast('Pari pré-rempli — vérifiez la cote chez votre bookmaker');
  }

  /* ---- Performance & calibration du Radar ---- */
  function renderRadarPerf() {
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
        <div class="perf-kpi"><span class="v">${stats.openCount}</span><span class="l">En cours</span></div>
      </div>
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
      toast('Clé API enregistrée');
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
      state.settings = { initialBankroll: 500, apiKey: '', model: 'gemini-2.5-flash', bookrolls: [] };
      bindSettingsValues();
      renderBookrollRows();
      renderAll();
      toast('Données effacées');
    });
  }

  function bindSettingsValues() {
    $('#setApiKey').value = state.settings.apiKey;
    $('#setModel').value = state.settings.model;
    syncInitialField();
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

  function renderBookrollRows() {
    const rows = state.settings.bookrolls || [];
    $('#bookrollRows').innerHTML = rows.length
      ? rows.map((b, i) => `<div class="bookroll-row" data-i="${i}">
          <input type="text" class="input bookroll-name" list="bookmakerList" placeholder="Winamax" value="${escapeHTML(b.name)}">
          <input type="number" class="input mono bookroll-amount" min="0" step="0.01" placeholder="200" value="${b.initial || ''}">
          <button type="button" class="btn-icon bookroll-del" aria-label="Retirer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
        </div>`).join('')
      : '<p class="field-hint">Aucun bookmaker défini — le capital global ci-dessous sert de point de départ.</p>';

    $$('#bookrollRows .bookroll-row').forEach((row) => {
      const i = Number(row.dataset.i);
      const save = debounce(async () => {
        state.settings.bookrolls[i] = {
          name: row.querySelector('.bookroll-name').value.trim(),
          initial: parseFloat(row.querySelector('.bookroll-amount').value) || 0
        };
        await DB.setSetting('bookrolls', state.settings.bookrolls);
        syncInitialField();
        renderAll();
      }, 400);
      row.querySelector('.bookroll-name').addEventListener('input', save);
      row.querySelector('.bookroll-amount').addEventListener('input', save);
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
