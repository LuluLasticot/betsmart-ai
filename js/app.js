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
    settings: { initialBankroll: 500, apiKey: '', model: 'gemini-2.5-flash', bookrolls: [] },
    period: 'all',
    view: 'dashboard',
    charts: {}
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
    state.bets = await DB.getBets();

    bindNav();
    bindModal();
    bindFilters();
    bindSettings();
    bindCoach();
    bindAdvisor();
    bindPaste();

    renderAll();

    // Synchronisation cloud (chargée en arrière-plan, sans bloquer l'affichage)
    bindCloud();
    Cloud.init({
      onChange: async () => {
        const saved = await DB.getAllSettings();
        Object.assign(state.settings, saved);
        state.bets = await DB.getBets();
        bindSettingsValues();
        renderBookrollRows();
        renderAll();
      },
      onStatus: updateCloudPanel
    });

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  /* ========================================================================
     Compte & synchronisation cloud
     ======================================================================== */
  function updateCloudPanel(status) {
    $('#cloudUnconfigured').hidden = status.state !== 'unconfigured' && status.state !== 'error';
    $('#cloudSignedOut').hidden = status.state !== 'signedout';
    $('#cloudSignedIn').hidden = status.state !== 'connected';
    if (status.state === 'connected') {
      $('#cloudUserEmail').textContent = status.email;
      toast('Synchronisation cloud active');
    }
    if (status.state === 'error') {
      const el = $('#cloudError');
      el.textContent = `Initialisation impossible : ${status.message}`;
      el.className = 'api-test ko';
    }
  }

  function bindCloud() {
    const errEl = $('#cloudError');
    const showErr = (err) => { errEl.textContent = Cloud.friendlyError(err); errEl.className = 'api-test ko'; };
    const clearErr = () => { errEl.textContent = ''; };

    const withBusy = (btn, fn) => async () => {
      clearErr();
      const email = $('#cloudEmail').value.trim();
      const password = $('#cloudPassword').value;
      if (!email || !password) { showErr({ code: 'auth/invalid-credential' }); return; }
      btn.disabled = true;
      try { await fn(email, password); } catch (err) { showErr(err); } finally { btn.disabled = false; }
    };

    $('#cloudSignIn').addEventListener('click', withBusy($('#cloudSignIn'), Cloud.signIn));
    $('#cloudSignUp').addEventListener('click', withBusy($('#cloudSignUp'), Cloud.signUp));
    $('#cloudSignOut').addEventListener('click', async () => {
      clearErr();
      await Cloud.signOutUser();
      toast('Déconnecté — les données restent sur cet appareil');
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
    const k = Stats.kpis(bets, effInitial());

    $('#dashboardSub').textContent = state.period === 'all'
      ? `${k.count} paris enregistrés · ${k.pendingCount} en attente (${Stats.fmtMoney(k.pendingStake)} engagés)`
      : `${k.count} paris sur les ${state.period} derniers jours`;

    const cls = (n) => (n > 0.001 ? 'pos' : n < -0.001 ? 'neg' : '');
    $('#kpiGrid').innerHTML = [
      kpiCard('Bankroll', Stats.fmtMoney(k.bankroll), cls(k.profit), `Départ : ${Stats.fmtMoney(effInitial())}`),
      kpiCard('Bénéfice net', Stats.fmtSigned(k.profit), cls(k.profit), `${Stats.fmtMoney(k.totalStaked)} misés`),
      kpiCard('ROI', Stats.fmtPct(k.roi), cls(k.roi), 'Profit / total misé'),
      kpiCard('ROC', Stats.fmtPct(k.roc), cls(k.roc), 'Croissance du capital'),
      kpiCard('Hit rate', `${k.hitRate.toFixed(0)} %`, '', `${k.won} gagnés · ${k.lost} perdus`),
      kpiCard('Cote moy.', k.avgOdds ? k.avgOdds.toFixed(2) : '—', '', `Mise moy. ${Stats.fmtMoney(k.avgStake || 0)}`)
    ].join('');

    renderBankrollChart(bets);
    renderDoughnut('sportChart', Stats.groupBy(bets, 'sport'));
    renderBarChart('bookmakerChart', Stats.groupBy(bets, 'bookmaker'));
    renderBookrollPanel();
    renderRecentBets(bets);
    renderSidebarBankroll();
  }

  /** Détail de bankroll par bookmaker (toujours sur l'ensemble de l'historique). */
  function renderBookrollPanel() {
    const rows = Stats.bookmakerBreakdown(state.bets, state.settings.bookrolls || []);
    const panel = $('#bookrollPanel');
    if (!rows.length) { panel.hidden = true; return; }
    panel.hidden = false;

    $('#bookrollList').innerHTML =
      `<div class="col-headers bookroll-grid"><span>Bookmaker</span><span class="r hide-m">Paris</span><span class="r hide-m">Départ</span><span class="r">P/L</span><span class="r hide-m">ROI</span><span class="r">Bankroll</span></div>`
      + rows.map((r) => {
        const cls = r.profit > 0.001 ? 'pos' : r.profit < -0.001 ? 'neg' : 'zero';
        return `<div class="bet-row bookroll-grid">
          <div class="bet-main"><div class="bet-event">${escapeHTML(r.name)}</div>${!r.hasInitial ? '<div class="bet-meta">capital de départ non renseigné</div>' : (r.pendingStake > 0 ? `<div class="bet-meta">${Stats.fmtMoney(r.pendingStake)} en attente</div>` : '')}</div>
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
    const k = Stats.kpis(state.bets, effInitial());
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

  function renderBankrollChart(bets) {
    destroyChart('bankroll');
    const ctx = $('#bankrollChart').getContext('2d');
    const points = Stats.bankrollSeries(bets, effInitial());
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
  function bindFilters() {
    ['filterStatus', 'filterSport', 'filterBookmaker', 'filterType'].forEach((id) =>
      $(`#${id}`).addEventListener('change', renderBets));
    $('#filterSearch').addEventListener('input', debounce(renderBets, 180));
  }

  function refreshFilterOptions() {
    fillOptions('#filterSport', 'Sport · tous', [...new Set(state.bets.map((b) => b.sport).filter(Boolean))].sort());
    fillOptions('#filterBookmaker', 'Bookmaker · tous', [...new Set(state.bets.map((b) => b.bookmaker).filter(Boolean))].sort());
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
    const q = $('#filterSearch').value.trim().toLowerCase();

    return state.bets.filter((b) =>
      (!status || b.status === status) &&
      (!sport || b.sport === sport) &&
      (!bookmaker || b.bookmaker === bookmaker) &&
      (!type || b.betType === type) &&
      (!q || `${b.event} ${b.selection} ${b.competition || ''}`.toLowerCase().includes(q))
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
        <button class="btn-icon" data-action="edit" aria-label="Modifier"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg></button>
        <button class="btn-icon" data-action="delete" aria-label="Supprimer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button>
      </div>
    </div>`;
  }

  function bindBetRowActions(container) {
    container.querySelectorAll('.bet-row').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('[data-action="edit"]').addEventListener('click', (e) => { e.stopPropagation(); openBetModal(state.bets.find((b) => b.id === id)); });
      row.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Supprimer ce pari ?')) return;
        await DB.deleteBet(id);
        state.bets = state.bets.filter((b) => b.id !== id);
        renderAll();
        toast('Pari supprimé');
      });
      row.addEventListener('click', () => openBetModal(state.bets.find((b) => b.id === id)));
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
    $('#fileInput').addEventListener('change', (e) => { if (e.target.files[0]) handleTicketImage(e.target.files[0]); });

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
      status: $('#fStatus').value,
      payout: $('#fStatus').value === 'cashout' ? (parseFloat($('#fPayout').value) || 0) : undefined
    };

    const existing = bet.id ? state.bets.find((b) => b.id === bet.id) : null;
    if (existing) bet.createdAt = existing.createdAt;

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
      const summary = Stats.coachSummary(state.bets, effInitial());
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
     Radar IA (suggestions de value bets)
     ======================================================================== */
  function bindAdvisor() {
    $('#runAdvisor').addEventListener('click', runAdvisor);
  }

  async function runAdvisor() {
    const container = $('#advisorContent');
    if (!state.settings.apiKey) {
      container.innerHTML = '<div class="empty-state"><p>Ajoutez votre clé API Gemini dans les <strong>Réglages</strong> pour activer le Radar.</p></div>';
      return;
    }

    const btn = $('#runAdvisor');
    btn.disabled = true;
    container.innerHTML = '<div class="coach-loading"><span class="spinner"></span>Recherche Google en cours : matchs, blessures, forme, cotes… (~30 s)</div>';

    const k = Stats.kpis(state.bets, effInitial());
    const perf = Stats.groupBy(state.bets, 'sport')
      .filter((g) => g.count >= 3)
      .map((g) => `${g.name}: ROI ${g.roi.toFixed(0)} % sur ${g.count} paris`)
      .join(' ; ') || 'pas encore d\'historique significatif';
    const bookmakers = [...new Set([
      ...(state.settings.bookrolls || []).map((b) => b.name.trim()).filter(Boolean),
      ...state.bets.map((b) => b.bookmaker).filter(Boolean)
    ])].slice(0, 4).join(', ') || 'Winamax, Betclic, Unibet';

    const ctx = {
      now: new Date().toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' }),
      horizon: $('#advHorizon').value,
      sports: $('#advSports').value,
      bookmakers,
      bankroll: Math.round(k.bankroll),
      riskProfile: Advisor.PROFILES[$('#advProfile').value].label,
      userPerf: perf
    };

    try {
      const result = await Advisor.suggest(state.settings.apiKey, state.settings.model, ctx);
      renderAdvisorResult(result, $('#advProfile').value, k.bankroll);
    } catch (err) {
      container.innerHTML = `<div class="empty-state"><p>Radar indisponible : ${escapeHTML(err.message)}</p><p class="empty-hint">La recherche Google (grounding) nécessite une clé API dont le quota le permet. Réessayez ou changez de modèle dans les Réglages.</p></div>`;
    } finally {
      btn.disabled = false;
    }
  }

  function renderAdvisorResult(result, profileKey, bankroll) {
    const container = $('#advisorContent');
    let html = '';

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
      btn.addEventListener('click', () => {
        const p = result.picks[Number(btn.dataset.addPick)];
        const m = Advisor.stakeFor(bankroll, p, profileKey);
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
        $('#fStake').value = m.stake || '';
        $('#fStatus').value = 'pending';
        updatePotentialGain();
        toast('Pari pré-rempli — vérifiez la cote chez votre bookmaker');
      });
    });
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
