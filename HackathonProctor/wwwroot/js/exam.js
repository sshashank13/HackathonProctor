(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const sid = new URLSearchParams(location.search).get('s');

  // ------------------------------------------------------------------ state
  let state = null;
  let qs = [];
  let answers = {};
  const marked = new Set();
  let cur = 0;

  let remaining = 0;
  let lastTick = 0;
  let examActive = false;
  let finished = false;

  let stream = null;
  let camOk = false;
  let detector = null;
  let detectorName = '';
  let detectorErrors = 0;
  let noFaceStreak = 0;
  let multiFaceStreak = 0;
  let darkStreak = 0;
  const timers = [];

  const lastFired = {};
  const COOLDOWN = {
    TabSwitch: 2000, WindowBlur: 6000, FullscreenExit: 2000, CopyPaste: 3000, RightClick: 5000,
    BlockedShortcut: 4000, ScreenshotKey: 5000, NoFace: 30000, MultipleFaces: 30000,
    CameraBlocked: 30000, CameraLost: 30000, MultipleDisplays: 30000
  };
  const SNAPSHOT_ON = ['NoFace', 'MultipleFaces', 'CameraBlocked'];

  const smallCanvas = document.createElement('canvas');
  smallCanvas.width = 32; smallCanvas.height = 24;
  const smallCtx = smallCanvas.getContext('2d', { willReadFrequently: true });
  const snapCanvas = document.createElement('canvas');
  snapCanvas.width = 320; snapCanvas.height = 240;
  const snapCtx = snapCanvas.getContext('2d');

  // ------------------------------------------------------------------ fullscreen helpers
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  function enterFs() {
    const el = document.documentElement;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen;
    return fn ? fn.call(el) : Promise.reject(new Error('Fullscreen not supported'));
  }
  function exitFs() {
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (fsElement() && fn) { try { fn.call(document); } catch (e) { /* ignore */ } }
  }

  // ------------------------------------------------------------------ small UI helpers
  function setChip(el, color, text) {
    el.className = 'chip chip-' + color;
    el.textContent = text;
  }
  function showGateError(msg) {
    const g = $('gateError');
    g.textContent = msg;
    g.classList.remove('hidden');
  }
  function showFatal(msg) {
    $('gate').classList.add('hidden');
    $('fatalText').textContent = msg;
    $('fatalScreen').classList.remove('hidden');
  }
  function updateStrikes(strikes, max) {
    $('strikes').textContent = strikes;
    $('maxStrikes').textContent = max;
  }

  // ------------------------------------------------------------------ init / gate
  async function init() {
    if (!sid) { location.href = '/'; return; }

    const r = await HP.req(`/api/exam/${encodeURIComponent(sid)}`);
    if (!r.ok) {
      showFatal(r.networkError ? 'Cannot reach the server. Check your connection and refresh.' : 'This exam session was not found. Please register again.');
      return;
    }
    state = r.data;
    $('examTitle').textContent = state.title;
    $('candName').textContent = state.name;
    document.title = state.title;
    updateStrikes(state.strikes, state.maxStrikes);

    if (state.status === 'Submitted' || state.status === 'AutoSubmitted') {
      showDone(state.status, state.submitReason, state.score, state.total);
      return;
    }
    setupGate();
  }

  function setupGate() {
    $('gateName').textContent = state.name;
    $('gateTitle').textContent = state.title;
    $('gateMeta').textContent = `${state.track} track · ${Math.round(state.durationSeconds / 60)} minutes`;

    if (state.status === 'InProgress') {
      $('beginBtn').textContent = 'Enter fullscreen & resume';
      const g = $('gateResume');
      g.textContent = `Your attempt is already running - ${HP.fmtTime(state.remainingSeconds)} left. The clock did not stop while you were away.`;
      g.classList.remove('hidden');
    }

    $('camBtn').addEventListener('click', enableCamera);
    $('agree').addEventListener('change', updateBegin);
    $('beginBtn').addEventListener('click', beginExam);
    checkDisplays();
    if (window.screen && window.screen.addEventListener) window.screen.addEventListener('change', checkDisplays);

    loadDetector().then((d) => {
      detector = d;
      if (d) setChip($('chipFace'), 'mint', 'Ready');
      else setChip($('chipFace'), 'butter', 'Unavailable - snapshots only');
    });
  }

  function displaysExtended() { return !!(window.screen && window.screen.isExtended); }

  function checkDisplays() {
    if (displaysExtended()) setChip($('chipDisplay'), 'rose', 'Multiple screens');
    else setChip($('chipDisplay'), 'mint', 'Single screen');
    updateBegin();
  }

  function updateBegin() {
    $('beginBtn').disabled = !(camOk && $('agree').checked && !displaysExtended());
  }

  async function enableCamera() {
    const chip = $('chipCam');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setChip(chip, 'rose', 'Not supported');
      showGateError('Camera access needs Chrome or Edge on a desktop, opened via http://localhost or https.');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
      });
      $('gateCam').srcObject = stream;
      $('cam').srcObject = stream;
      stream.getVideoTracks()[0].addEventListener('ended', () => report('CameraLost', 'Camera stream ended'));
      camOk = true;
      setChip(chip, 'mint', 'Ready');
      $('camBtn').textContent = 'Camera enabled ✓';
      $('camBtn').disabled = true;
      $('gateError').classList.add('hidden');
    } catch (e) {
      setChip(chip, 'rose', 'Blocked');
      showGateError('We could not access your camera. Click the camera icon in the address bar, allow access, then try again.');
    }
    updateBegin();
  }

  async function beginExam() {
    const btn = $('beginBtn');
    btn.disabled = true;

    // requestFullscreen must be called straight from the click handler (user gesture).
    let fsError = null;
    try { await enterFs(); } catch (e) { fsError = e; }
    if (!fsElement()) {
      showGateError('Fullscreen is required to take this exam. Please use a desktop browser (Chrome / Edge) and try again.');
      btn.disabled = false;
      return;
    }

    const b = await HP.req(`/api/exam/${encodeURIComponent(sid)}/begin`, 'POST');
    if (!b.ok) {
      exitFs();
      showGateError((b.data && b.data.error) || 'Could not start the exam. Please try again.');
      btn.disabled = false;
      return;
    }

    const r = await HP.req(`/api/exam/${encodeURIComponent(sid)}`);
    if (!r.ok) { exitFs(); showGateError('Could not load the exam. Please try again.'); btn.disabled = false; return; }
    state = r.data;
    if (state.status !== 'InProgress') {
      exitFs();
      showDone(state.status, state.submitReason, state.score, state.total);
      return;
    }
    startExam();
  }

  // ------------------------------------------------------------------ exam lifecycle
  function startExam() {
    qs = state.questions;
    answers = Object.assign({}, state.answers);
    cur = 0;
    remaining = state.remainingSeconds;
    lastTick = performance.now();
    examActive = true;
    updateStrikes(state.strikes, state.maxStrikes);

    $('gate').classList.add('hidden');
    buildPalette();
    renderQuestion();
    bindExamControls();
    attachGuards();
    startProctoring();

    tick();
    timers.push(setInterval(tick, 500));
    timers.push(setInterval(syncState, 30000));
  }

  function tick() {
    if (!examActive) return;
    const now = performance.now();
    remaining = Math.max(0, remaining - (now - lastTick) / 1000);
    lastTick = now;
    $('timer').textContent = HP.fmtTime(remaining);
    $('timerPill').classList.toggle('urgent', remaining <= 300);
    if (remaining <= 0) finish('Time is up - submitted automatically');
  }

  async function syncState() {
    const r = await HP.req(`/api/exam/${encodeURIComponent(sid)}`);
    if (!r.ok || !r.data) return;
    state = r.data;
    if (state.status === 'InProgress') {
      remaining = state.remainingSeconds;
      lastTick = performance.now();
      updateStrikes(state.strikes, state.maxStrikes);
    } else if (!finished) {
      finish(state.submitReason || 'The exam has ended', true);
    }
  }

  async function finish(reason, serverAlreadyDone) {
    if (finished) return;
    finished = true;
    examActive = false;
    timers.forEach(clearInterval);
    $('fsOverlay').classList.add('hidden');
    $('confirmModal').classList.add('hidden');

    let result = null;
    if (serverAlreadyDone) {
      const r = await HP.req(`/api/exam/${encodeURIComponent(sid)}`);
      if (r.ok) result = { status: r.data.status, reason: r.data.submitReason, score: r.data.score, total: r.data.total };
    } else {
      for (let attempt = 0; attempt < 5 && !result; attempt++) {
        const r = await HP.req(`/api/exam/${encodeURIComponent(sid)}/submit`, 'POST', { answers, reason });
        if (r.ok && r.data) result = r.data;
        else await new Promise((res) => setTimeout(res, 1500));
      }
    }

    exitFs();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    result = result || { status: 'Submitted', reason };
    showDone(result.status, result.reason || reason, result.score, result.total);
  }

  function showDone(status, reason, score, total) {
    $('gate').classList.add('hidden');
    const auto = status === 'AutoSubmitted';
    const ended = auto && /warning/i.test(reason || '');
    $('doneIcon').textContent = ended ? '⚠' : '✅';
    $('doneIcon').classList.toggle('warn', ended);
    $('doneTitle').textContent = ended ? 'Exam ended' : (auto ? 'Time is up' : 'Exam submitted');
    let text = reason || 'Your answers were recorded.';
    if (score !== null && score !== undefined && total) text += `  Score: ${score} / ${total}.`;
    $('doneText').textContent = text;
    $('doneScreen').classList.remove('hidden');
  }

  // ------------------------------------------------------------------ questions UI
  function buildPalette() {
    const grid = $('palette');
    grid.innerHTML = '';
    qs.forEach((q, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pal-btn';
      b.textContent = String(i + 1);
      b.setAttribute('aria-label', `Go to question ${i + 1}`);
      b.addEventListener('click', () => go(i));
      grid.appendChild(b);
    });
    updatePalette();
  }

  function updatePalette() {
    const buttons = $('palette').children;
    for (let i = 0; i < buttons.length; i++) {
      const q = qs[i];
      buttons[i].classList.toggle('answered', answers[q.id] !== undefined);
      buttons[i].classList.toggle('marked', marked.has(q.id));
      buttons[i].classList.toggle('current', i === cur);
    }
    const n = qs.filter((q) => answers[q.id] !== undefined).length;
    $('progressBar').style.width = (qs.length ? (100 * n) / qs.length : 0) + '%';
    $('answeredCount').textContent = `${n} of ${qs.length} answered`;
  }

  function renderQuestion() {
    const q = qs[cur];
    $('qNum').textContent = `Question ${cur + 1} of ${qs.length}`;
    $('qCat').textContent = q.category;
    $('qPts').textContent = `${q.points} point${q.points > 1 ? 's' : ''}`;
    $('qText').textContent = q.text;

    const box = $('options');
    box.innerHTML = '';
    q.options.forEach((text, i) => {
      const label = document.createElement('label');
      label.className = 'opt' + (answers[q.id] === i ? ' selected' : '');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'opt';
      input.value = String(i);
      input.checked = answers[q.id] === i;
      const key = document.createElement('span');
      key.className = 'opt-key';
      key.textContent = String.fromCharCode(65 + i);
      const body = document.createElement('span');
      body.textContent = text;
      label.append(input, key, body);
      label.addEventListener('click', (e) => { e.preventDefault(); select(i); });
      input.addEventListener('change', () => select(i));
      box.appendChild(label);
    });

    $('btnPrev').disabled = cur === 0;
    $('btnNext').disabled = cur === qs.length - 1;
    $('btnMark').textContent = marked.has(q.id) ? '⚑ Unmark' : '⚑ Mark for review';
    $('saveState').textContent = '';
    updatePalette();
  }

  function go(i) {
    if (i < 0 || i >= qs.length) return;
    cur = i;
    renderQuestion();
  }

  async function select(i) {
    if (!examActive) return;
    const q = qs[cur];
    if (answers[q.id] === i) return;
    answers[q.id] = i;
    renderQuestion();
    await saveAnswer(q.id, i);
  }

  async function clearAnswer() {
    const q = qs[cur];
    if (answers[q.id] === undefined) return;
    delete answers[q.id];
    renderQuestion();
    await saveAnswer(q.id, -1);
  }

  async function saveAnswer(questionId, optionIndex) {
    const el = $('saveState');
    el.textContent = 'Saving…';
    const r = await HP.req(`/api/exam/${encodeURIComponent(sid)}/answer`, 'POST', { questionId, optionIndex });
    if (r.ok) { el.textContent = 'Saved ✓'; return; }
    if (r.status === 400) { await syncState(); return; }
    el.textContent = 'Offline - will be saved when you submit';
  }

  function bindExamControls() {
    $('btnPrev').addEventListener('click', () => go(cur - 1));
    $('btnNext').addEventListener('click', () => go(cur + 1));
    $('btnClear').addEventListener('click', clearAnswer);
    $('btnMark').addEventListener('click', () => {
      const q = qs[cur];
      if (marked.has(q.id)) marked.delete(q.id); else marked.add(q.id);
      renderQuestion();
    });
    $('submitBtn').addEventListener('click', () => {
      const n = qs.filter((q) => answers[q.id] !== undefined).length;
      const unanswered = qs.length - n;
      $('confirmText').textContent = unanswered > 0
        ? `You have answered ${n} of ${qs.length} questions. ${unanswered} unanswered question${unanswered > 1 ? 's' : ''} will score zero. Submit anyway?`
        : `You have answered all ${qs.length} questions. Submit your exam now?`;
      $('confirmModal').classList.remove('hidden');
    });
    $('confirmNo').addEventListener('click', () => $('confirmModal').classList.add('hidden'));
    $('confirmYes').addEventListener('click', () => finish('Submitted by candidate'));
    $('fsReturn').addEventListener('click', () => { enterFs().catch(() => { /* needs another click */ }); });
  }

  // ------------------------------------------------------------------ violations
  async function report(type, detail) {
    if (!examActive || finished) return;
    const now = Date.now();
    if (lastFired[type] && now - lastFired[type] < (COOLDOWN[type] || 3000)) return;
    lastFired[type] = now;

    if (SNAPSHOT_ON.indexOf(type) >= 0) takeSnapshot();

    const r = await HP.req(`/api/exam/${encodeURIComponent(sid)}/violation`, 'POST', { type, detail: detail || '' });
    if (!r.ok || !r.data) return;
    updateStrikes(r.data.strikes, r.data.maxStrikes);
    if (r.data.autoSubmitted) {
      finish(r.data.message, true);
      return;
    }
    HP.toast(r.data.message, 'warn', 6000);
  }

  function attachGuards() {
    // Tab switch / minimise
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) report('TabSwitch', 'Tab hidden or window minimised');
    });
    // Another window took focus while this tab is still visible
    window.addEventListener('blur', () => {
      setTimeout(() => {
        if (examActive && !document.hidden && !document.hasFocus()) report('WindowBlur', 'Exam window lost focus');
      }, 400);
    });
    // Fullscreen exit
    const onFs = () => {
      if (!examActive) return;
      if (!fsElement()) {
        $('fsOverlay').classList.remove('hidden');
        report('FullscreenExit', 'Left fullscreen mode');
      } else {
        $('fsOverlay').classList.add('hidden');
      }
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);

    // Clipboard, context menu, selection, drag
    ['copy', 'cut', 'paste'].forEach((ev) => document.addEventListener(ev, (e) => {
      e.preventDefault();
      report('CopyPaste', `Attempted ${ev}`);
    }));
    document.addEventListener('contextmenu', (e) => { e.preventDefault(); report('RightClick', 'Right-click blocked'); });
    document.addEventListener('selectstart', (e) => e.preventDefault());
    document.addEventListener('dragstart', (e) => e.preventDefault());

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (!examActive) return;
      const k = (e.key || '').toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && ['c', 'v', 'x'].indexOf(k) >= 0) {
        e.preventDefault();
        report('CopyPaste', 'Shortcut Ctrl+' + k.toUpperCase());
        return;
      }
      const devtools = e.key === 'F12' || (ctrl && e.shiftKey && ['i', 'j', 'c'].indexOf(k) >= 0);
      const other = ctrl && ['u', 's', 'p', 'a', 'f'].indexOf(k) >= 0;
      if (devtools || other) {
        e.preventDefault();
        report('BlockedShortcut', 'Blocked shortcut: ' + (ctrl ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + e.key);
        return;
      }

      // Convenience: A-D / 1-4 pick an option, arrows navigate
      if (!ctrl && !e.altKey && qs.length) {
        const idx = 'abcd'.indexOf(k) >= 0 && k.length === 1 ? 'abcd'.indexOf(k) : ('1234'.indexOf(k) >= 0 && k.length === 1 ? '1234'.indexOf(k) : -1);
        if (idx >= 0 && idx < qs[cur].options.length) select(idx);
        if (e.key === 'ArrowRight') go(cur + 1);
        if (e.key === 'ArrowLeft') go(cur - 1);
      }
    });
    document.addEventListener('keyup', (e) => {
      if (examActive && e.key === 'PrintScreen') {
        report('ScreenshotKey', 'Print Screen pressed');
        try { navigator.clipboard.writeText(''); } catch (err) { /* ignore */ }
      }
    });

    window.addEventListener('beforeunload', (e) => {
      if (examActive) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  // ------------------------------------------------------------------ webcam proctoring
  function loadScript(src, timeoutMs) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      const timer = setTimeout(() => { s.remove(); reject(new Error('timeout')); }, timeoutMs);
      s.src = src;
      s.async = true;
      s.onload = () => { clearTimeout(timer); resolve(); };
      s.onerror = () => { clearTimeout(timer); reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
  }

  // Native FaceDetector (Chrome with "Experimental Web Platform features") -> face-api.js from CDN -> none.
  async function loadDetector() {
    if ('FaceDetector' in window) {
      try {
        const fd = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 4 });
        detectorName = 'native';
        return { count: async (video) => (await fd.detect(video)).length };
      } catch (e) { /* fall through */ }
    }
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.js', 15000);
      const base = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
      await window.faceapi.nets.tinyFaceDetector.loadFromUri(base);
      const opts = new window.faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.45 });
      detectorName = 'face-api';
      return { count: async (video) => (await window.faceapi.detectAllFaces(video, opts)).length };
    } catch (e) {
      return null;
    }
  }

  function startProctoring() {
    const interval = Math.max(10, state.snapshotIntervalSeconds || 30) * 1000;
    timers.push(setInterval(takeSnapshot, interval));
    setTimeout(takeSnapshot, 4000);
    timers.push(setInterval(proctorTick, 4000));
    if (!detector) setChip($('faceChip'), 'butter', 'Snapshots only');
  }

  function videoReady() {
    const v = $('cam');
    return stream && v && v.readyState >= 2 && v.videoWidth > 0;
  }

  async function proctorTick() {
    if (!examActive || !videoReady()) return;
    const v = $('cam');

    if (displaysExtended()) report('MultipleDisplays', 'Extended display detected');

    // Camera covered / black frame
    smallCtx.drawImage(v, 0, 0, 32, 24);
    const px = smallCtx.getImageData(0, 0, 32, 24).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    const avg = sum / (px.length / 4);
    if (avg < 12) {
      darkStreak++;
      setChip($('camChip'), 'rose', 'Camera dark');
      if (darkStreak >= 2) report('CameraBlocked', 'Camera feed is almost completely dark');
      return;
    }
    darkStreak = 0;
    setChip($('camChip'), 'mint', 'Camera live');

    if (!detector) return;
    try {
      const n = await detector.count(v);
      detectorErrors = 0;
      if (n === 0) {
        noFaceStreak++; multiFaceStreak = 0;
        setChip($('faceChip'), 'rose', 'No face seen');
        if (noFaceStreak >= 3) report('NoFace', 'No face visible for ~12 seconds');
      } else if (n > 1) {
        multiFaceStreak++; noFaceStreak = 0;
        setChip($('faceChip'), 'rose', n + ' faces');
        if (multiFaceStreak >= 2) report('MultipleFaces', n + ' faces detected');
      } else {
        noFaceStreak = 0; multiFaceStreak = 0;
        setChip($('faceChip'), 'mint', 'Face detected');
      }
    } catch (e) {
      if (++detectorErrors >= 5) {
        detector = null;
        setChip($('faceChip'), 'butter', 'Snapshots only');
      }
    }
  }

  async function takeSnapshot() {
    if (!examActive || !videoReady()) return;
    try {
      snapCtx.drawImage($('cam'), 0, 0, 320, 240);
      const image = snapCanvas.toDataURL('image/jpeg', 0.6);
      await HP.req(`/api/exam/${encodeURIComponent(sid)}/snapshot`, 'POST', { image });
    } catch (e) { /* a missed snapshot is not fatal */ }
  }

  // ------------------------------------------------------------------ go
  init();
})();
