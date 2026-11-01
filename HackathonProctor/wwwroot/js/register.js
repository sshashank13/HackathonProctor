(async function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  // Fill the hero from server configuration
  const cfg = await HP.req('/api/config');
  if (cfg.ok && cfg.data) {
    document.title = cfg.data.title;
    $('heroTitle').textContent = cfg.data.title;
    $('statDuration').textContent = cfg.data.durationMinutes + ' min';
    $('statQuestions').textContent = cfg.data.questions;
    $('statStrikes').textContent = cfg.data.maxViolations;
    $('rulesStrikes').textContent = cfg.data.maxViolations;
  }

  // Highlight the selected track card
  const radios = document.querySelectorAll('input[name="track"]');
  const syncTracks = () => radios.forEach((r) => r.parentElement.classList.toggle('active', r.checked));
  radios.forEach((r) => r.addEventListener('change', syncTracks));
  syncTracks();

  $('regForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('formError');
    err.classList.add('hidden');

    const checked = document.querySelector('input[name="track"]:checked');
    const body = {
      name: $('name').value,
      email: $('email').value,
      college: $('college').value,
      track: checked ? checked.value : ''
    };

    const btn = $('startBtn');
    btn.disabled = true;
    btn.textContent = 'Preparing…';

    const r = await HP.req('/api/exam/register', 'POST', body);
    if (r.ok && r.data && r.data.sessionId) {
      location.href = '/exam.html?s=' + encodeURIComponent(r.data.sessionId);
      return;
    }

    err.textContent = (r.data && r.data.error) || 'Could not reach the server. Please try again.';
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Continue to system check';
  });
})();
