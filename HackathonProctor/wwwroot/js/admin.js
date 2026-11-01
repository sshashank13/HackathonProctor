(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = HP.esc;

  let token = sessionStorage.getItem('hp_admin_token') || '';
  let rows = [];
  let settings = null;
  let refreshTimer = null;
  let openId = null;

  // ------------------------------------------------------------------ api
  async function call(url, method, body) {
    const r = await HP.req(url, method || 'GET', body === undefined ? null : body, { 'X-Admin-Token': token });
    if (r.status === 401) logout();
    return r;
  }

  // ------------------------------------------------------------------ auth
  function showLogin() {
    $('dashView').classList.add('hidden');
    $('loginView').classList.remove('hidden');
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  function logout() {
    token = '';
    sessionStorage.removeItem('hp_admin_token');
    showLogin();
  }

  async function showDashboard() {
    $('loginView').classList.add('hidden');
    $('dashView').classList.remove('hidden');
    $('origin').textContent = location.origin;

    const s = await call('/api/admin/settings');
    if (!s.ok) return;
    settings = s.data;
    $('sCut').value = settings.cutoffPercent;
    $('sMin').value = settings.minIntegrity;
    $('sNat').value = settings.nationalSeats;
    $('sInt').value = settings.internationalSeats;
    $('demoTools').classList.toggle('hidden', !settings.demoTools);

    await loadRows();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (!document.hidden && $('detailOverlay').classList.contains('hidden')) loadRows(); }, 20000);
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('loginError');
    err.classList.add('hidden');
    const r = await HP.req('/api/auth/admin', 'POST', { password: $('pw').value });
    if (r.ok && r.data && r.data.token) {
      token = r.data.token;
      sessionStorage.setItem('hp_admin_token', token);
      $('pw').value = '';
      showDashboard();
    } else {
      err.textContent = (r.data && r.data.error) || 'Could not sign in.';
      err.classList.remove('hidden');
    }
  });

  // ------------------------------------------------------------------ data
  async function loadRows() {
    const r = await call('/api/admin/candidates');
    if (!r.ok) return;
    rows = r.data || [];
    renderTiles();
    renderTable();
  }

  const isFinished = (r) => r.status === 'Submitted' || r.status === 'AutoSubmitted';
  const isFlagged = (r) => isFinished(r) && (r.strikes >= 3 || r.integrity < (settings ? settings.minIntegrity : 60));

  function ranking() {
    const map = {};
    ['National', 'International'].forEach((track) => {
      rows.filter((r) => r.track === track && isFinished(r))
        .sort(compare)
        .forEach((r, i) => { map[r.id] = i + 1; });
    });
    return map;
  }

  function compare(a, b) {
    return (b.percentage - a.percentage) || (b.integrity - a.integrity) || (a.timeTakenSeconds - b.timeTakenSeconds);
  }

  // ------------------------------------------------------------------ rendering
  function renderTiles() {
    const finished = rows.filter(isFinished);
    const avg = finished.length ? (finished.reduce((s, r) => s + r.percentage, 0) / finished.length) : 0;
    const tiles = [
      ['lav', rows.length, 'Registered'],
      ['sky', rows.filter((r) => r.status === 'InProgress').length, 'In exam now'],
      ['mint', finished.length, 'Submitted'],
      ['peach', avg.toFixed(1) + '%', 'Average score'],
      ['rose', rows.filter(isFlagged).length, 'Flagged'],
      ['butter', rows.filter((r) => r.decision === 'Shortlisted').length, 'Shortlisted']
    ];
    $('tiles').innerHTML = tiles.map((t) => `<div class="tile tile-${t[0]}"><b>${t[1]}</b><span>${t[2]}</span></div>`).join('');
  }

  function decisionChip(d) {
    const map = { Shortlisted: 'mint', Waitlisted: 'butter', Rejected: 'rose', Pending: 'grey' };
    return `<span class="chip chip-${map[d] || 'grey'}">${esc(d)}</span>`;
  }

  function integrityChip(r) {
    if (!isFinished(r) && r.status !== 'InProgress') return '<span class="muted">—</span>';
    const c = r.integrity >= 80 ? 'mint' : (r.integrity >= 60 ? 'butter' : 'rose');
    return `<span class="chip chip-${c}">${r.integrity}</span>`;
  }

  function statusText(r) {
    if (r.status === 'InProgress') return '<span class="chip chip-sky">In exam</span>';
    if (r.status === 'Registered') return '<span class="chip chip-grey">Not started</span>';
    if (r.status === 'AutoSubmitted') return '<span class="chip chip-peach">Auto-submitted</span>';
    return '';
  }

  function fmtDuration(sec) {
    if (!sec) return '—';
    return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
  }

  function renderTable() {
    const q = $('search').value.trim().toLowerCase();
    const track = $('fTrack').value;
    const status = $('fStatus').value;
    const rankOf = ranking();

    const order = { Submitted: 0, AutoSubmitted: 0, InProgress: 1, Registered: 2 };
    const list = rows
      .filter((r) => !track || r.track === track)
      .filter((r) => {
        if (!status) return true;
        if (status === 'InProgress') return r.status === 'InProgress';
        if (status === 'Flagged') return isFlagged(r);
        return r.decision === status;
      })
      .filter((r) => !q || (r.name + ' ' + r.email + ' ' + r.college).toLowerCase().indexOf(q) >= 0)
      .sort((a, b) => ((order[a.status] - order[b.status]) || compare(a, b)));

    $('emptyMsg').classList.toggle('hidden', list.length > 0);

    $('tbody').innerHTML = list.map((r) => {
      const trackChip = r.track === 'National' ? 'sky' : 'lav';
      const scoreCell = isFinished(r)
        ? `<div class="score-cell"><b>${r.percentage}%</b> <small>(${r.score}/${r.totalPoints})</small><div class="bar"><span style="width:${r.percentage}%"></span></div></div>`
        : '<span class="muted">—</span>';
      const warn = r.strikes > 0 ? `<span class="chip chip-rose">${r.strikes}</span>` : '<span class="chip chip-mint">0</span>';
      return `
        <tr>
          <td class="rank">${rankOf[r.id] ? '#' + rankOf[r.id] : '—'}</td>
          <td class="cand"><b>${esc(r.name)}${r.isDemo ? ' <span class="chip chip-peach">demo</span>' : ''}</b><span>${esc(r.email)} · ${esc(r.college)}</span></td>
          <td><span class="chip chip-${trackChip}">${esc(r.track)}</span></td>
          <td>${scoreCell}</td>
          <td>${integrityChip(r)}</td>
          <td>${warn}</td>
          <td>${fmtDuration(r.timeTakenSeconds)}</td>
          <td>${isFinished(r) ? decisionChip(r.decision) : statusText(r)} ${r.decisionOverride ? '<span class="chip chip-lav" title="Set manually">manual</span>' : ''}</td>
          <td><div class="row-actions">
            <button class="btn btn-soft btn-sm" data-act="view" data-id="${r.id}">View</button>
            ${isFinished(r) ? `<button class="btn btn-mint btn-sm" data-act="Shortlisted" data-id="${r.id}">✓</button>
            <button class="btn btn-rose btn-sm" data-act="Rejected" data-id="${r.id}">✕</button>` : ''}
          </div></td>
        </tr>`;
    }).join('');
  }

  // ------------------------------------------------------------------ detail modal
  async function openDetail(id) {
    const r = await call(`/api/admin/candidates/${encodeURIComponent(id)}`);
    if (!r.ok || !r.data) { HP.toast('Could not load that candidate.', 'warn'); return; }
    openId = id;
    const d = r.data;
    const row = d.row;
    const finished = isFinished(row);

    const cats = d.categories.length
      ? d.categories.map((c) => `
          <div class="cat">
            <div class="cat-top"><span>${esc(c.category)}</span><b>${c.correct}/${c.total}</b></div>
            <div class="bar"><span style="width:${c.total ? (100 * c.correct / c.total) : 0}%"></span></div>
          </div>`).join('')
      : '<p class="muted">No questions assigned yet.</p>';

    const vio = d.violations.length
      ? d.violations.map((v) => `
          <li>
            <span class="chip ${v.isStrike ? 'chip-rose' : 'chip-butter'}">${esc(v.type)}</span>
            <span>${esc(v.detail || '')}</span>
            <span class="muted">${new Date(v.timestamp).toLocaleTimeString()}</span>
            <span class="v-w">−${v.weight}</span>
          </li>`).join('')
      : '<p class="muted">No violations recorded.</p>';

    const shown = d.snapshots.slice(-30);
    const snaps = shown.length
      ? `<div class="snap-grid">${shown.map((f) => {
          const src = `/api/admin/snapshot/${encodeURIComponent(id)}/${encodeURIComponent(f)}?t=${encodeURIComponent(token)}`;
          return `<img loading="lazy" src="${src}" data-full="${src}" alt="Webcam snapshot">`;
        }).join('')}</div>${d.snapshots.length > shown.length ? `<p class="muted">Showing the latest ${shown.length} of ${d.snapshots.length} snapshots.</p>` : ''}`
      : '<p class="muted">No snapshots captured.</p>';

    $('detailBody').innerHTML = `
      <div class="modal-head">
        <div>
          <h2>${esc(row.name)} ${decisionChip(row.decision)}</h2>
          <div class="muted">${esc(row.email)} · ${esc(row.college)} · <span class="chip chip-${row.track === 'National' ? 'sky' : 'lav'}">${esc(row.track)}</span></div>
          ${row.submitReason ? `<div class="muted" style="margin-top:4px">${esc(row.submitReason)}</div>` : ''}
        </div>
        <button class="close-x" id="closeDetail" type="button" aria-label="Close">✕</button>
      </div>

      <div class="detail-grid">
        <div class="tile tile-mint"><b>${finished ? row.percentage + '%' : '—'}</b><span>Score ${finished ? `(${row.score}/${row.totalPoints})` : ''}</span></div>
        <div class="tile tile-${row.integrity >= 80 ? 'mint' : (row.integrity >= 60 ? 'butter' : 'rose')}"><b>${row.integrity}</b><span>Integrity</span></div>
        <div class="tile tile-peach"><b>${row.violations}</b><span>Events (${row.strikes} warnings)</span></div>
        <div class="tile tile-sky"><b>${fmtDuration(row.timeTakenSeconds)}</b><span>Time taken</span></div>
      </div>

      <div class="detail-cols">
        <div>
          <div class="section-title">Score by category</div>${cats}
          <div class="section-title">Webcam snapshots</div>${snaps}
        </div>
        <div>
          <div class="section-title">Proctoring log</div>
          <ul class="vlist">${vio}</ul>
          <div class="section-title">Reviewer remark</div>
          <textarea class="input" id="remark" placeholder="Optional note visible only to organisers…">${esc(d.remark || '')}</textarea>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
            <button class="btn btn-mint" data-dec="Shortlisted" type="button">Shortlist</button>
            <button class="btn btn-sky" data-dec="Waitlisted" type="button">Waitlist</button>
            <button class="btn btn-rose" data-dec="Rejected" type="button">Reject</button>
            <button class="btn btn-ghost" data-dec="Pending" type="button">Reset</button>
          </div>
        </div>
      </div>`;

    $('detailOverlay').classList.remove('hidden');
  }

  function closeDetail() {
    $('detailOverlay').classList.add('hidden');
    openId = null;
  }

  async function decide(id, decision, remark) {
    const r = await call(`/api/admin/candidates/${encodeURIComponent(id)}/decision`, 'POST', { decision, remark: remark === undefined ? null : remark });
    if (r.ok) { HP.toast(`Marked as ${decision}.`, 'ok'); await loadRows(); return true; }
    HP.toast('Could not save the decision.', 'warn');
    return false;
  }

  // ------------------------------------------------------------------ events
  $('tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const act = btn.getAttribute('data-act');
    if (act === 'view') openDetail(id);
    else decide(id, act);
  });

  $('detailOverlay').addEventListener('click', async (e) => {
    if (e.target === $('detailOverlay') || e.target.id === 'closeDetail') { closeDetail(); return; }
    const img = e.target.closest('img[data-full]');
    if (img) { window.open(img.getAttribute('data-full'), '_blank'); return; }
    const btn = e.target.closest('button[data-dec]');
    if (btn && openId) {
      const remark = $('remark') ? $('remark').value : undefined;
      const ok = await decide(openId, btn.getAttribute('data-dec'), remark);
      if (ok) closeDetail();
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openId) closeDetail(); });

  ['search', 'fTrack', 'fStatus'].forEach((id) => $(id).addEventListener('input', renderTable));
  $('refreshBtn').addEventListener('click', () => { loadRows(); HP.toast('Refreshed.', 'info', 1500); });
  $('logoutBtn').addEventListener('click', logout);

  $('runShortlist').addEventListener('click', async () => {
    const body = {
      cutoffPercent: parseFloat($('sCut').value) || 0,
      minIntegrity: parseFloat($('sMin').value) || 0,
      nationalSeats: parseInt($('sNat').value, 10) || 0,
      internationalSeats: parseInt($('sInt').value, 10) || 0
    };
    const r = await call('/api/admin/shortlist', 'POST', body);
    if (r.ok) {
      HP.toast(`Shortlisted ${r.data.shortlisted} · Waitlisted ${r.data.waitlisted} · Rejected ${r.data.rejected}`, 'ok', 6000);
      loadRows();
    } else {
      HP.toast('Shortlisting failed.', 'warn');
    }
  });

  $('exportBtn').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/admin/export', { headers: { 'X-Admin-Token': token } });
      if (!res.ok) throw new Error('export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'hackathon-shortlist.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      HP.toast('Could not export the CSV.', 'warn');
    }
  });

  $('seedBtn').addEventListener('click', async () => {
    const r = await call('/api/admin/demo/seed', 'POST');
    if (r.ok) { HP.toast(`Added ${r.data.created} demo candidates.`, 'ok'); loadRows(); }
    else HP.toast((r.data && r.data.error) || 'Could not add demo data.', 'warn');
  });

  $('clearDemoBtn').addEventListener('click', async () => {
    const r = await call('/api/admin/demo', 'DELETE');
    if (r.ok) { HP.toast(`Removed ${r.data.removed} demo candidates.`, 'ok'); loadRows(); }
  });

  // ------------------------------------------------------------------ boot
  if (token) showDashboard(); else showLogin();
})();
