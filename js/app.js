/* App shell: simulation clock, data refresh (live with mock fallback), train board. */
(function () {
  'use strict';
  const B = window.Bahn;
  const { MIN, APPROACH_MS } = B;

  const stationId = 'bad-homburg';
  const $ = (id) => document.getElementById(id);
  const renderer = B.createRenderer($('map'));
  window.addEventListener('resize', () => renderer.resize());

  // --- simulation clock: real time by default, can be sped up or jumped forward
  const clock = { base: Date.now(), realBase: performance.now(), speed: 1 };
  const simNow = () => clock.base + (performance.now() - clock.realBase) * clock.speed;
  const isLive = () => clock.speed === 1 && Math.abs(simNow() - Date.now()) < 2000;
  function setClock(time, speed) {
    clock.base = time;
    clock.realBase = performance.now();
    clock.speed = speed;
    document.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === speed));
    $('live').classList.toggle('active', isLive());
  }

  // --- data: live DB data through server.js, mock timetable if that is unavailable
  let trains = [];
  let fetchedAtSim = -Infinity;
  let fetchedAtReal = -Infinity;
  let fetching = false;
  let liveRetryAt = 0;

  async function refreshData(now) {
    if (fetching) return;
    fetching = true;
    let raw = null;
    let label = '';
    let live = false;
    if (performance.now() >= liveRetryAt) {
      try {
        raw = await B.LiveProvider.fetchTrains(stationId, now - 60 * MIN, now + 5 * 60 * MIN);
        label = B.LiveProvider.label;
        live = true;
      } catch (err) {
        console.warn('Live data unavailable, using the mock timetable:', err.message);
        liveRetryAt = performance.now() + 60000;
      }
    }
    if (!raw) {
      raw = await B.MockProvider.fetchTrains(stationId, now - 90 * MIN, now + 8 * 60 * MIN);
      label = B.MockProvider.label + ' (no live data)';
    }
    trains = B.resolveSchedule(raw);
    fetchedAtSim = now;
    fetchedAtReal = performance.now();
    fetching = false;
    $('source').textContent = label;
    $('source').classList.toggle('mock', !live);
  }

  // --- board
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (ms) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const mmss = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  function timeCell(label, planned, actual, missing) {
    if (planned == null) return `<span class="t"><i>${label}</i><span class="muted">${missing}</span></span>`;
    const late = Math.floor((actual - planned) / MIN);
    if (late < 1) return `<span class="t"><i>${label}</i><b>${fmt(planned)}</b></span>`;
    return `<span class="t"><i>${label}</i><s>${fmt(planned)}</s><b class="late">${fmt(actual)}</b><span class="late">+${late}</span></span>`;
  }

  function statusCell(t, now) {
    switch (B.phaseOf(t, now)) {
      case 'arriving':
        return '<span class="chip arriving">Arriving</span>';
      case 'boarding':
        return `<span class="chip boarding">At platform</span><span class="sub">leaves in ${mmss(t.departure - now)}</span>`;
      case 'departing':
        return '<span class="chip departing">Departing</span>';
      default: {
        const mins = Math.ceil((t.arrival - now) / MIN);
        return `<span class="eta">${mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`}</span>`;
      }
    }
  }

  function renderBoard(board, now) {
    $('board-rows').innerHTML = board.length
      ? board
          .map((t) => {
            const notes = [t.origin ? `from ${esc(t.origin)}` : 'starts here'];
            if (t.heldBehind) notes.push(`<span class="late">held back, ${esc(t.heldBehind)} goes first</span>`);
            return `
        <div class="row ${B.phaseOf(t, now)}">
          <span class="line ${esc(t.type)}">${esc(t.line)}</span>
          <div class="dest">${esc(t.destination || 'Ends here')}<span class="sub">${notes.join(' · ')}</span></div>
          <div class="status">${statusCell(t, now)}</div>
          <div class="track"><i>Gl.</i>${esc(t.track ?? '–')}</div>
          <div class="times">${timeCell('Arr', t.plannedArrival, t.arrival, 'starts here')}${timeCell('Dep', t.plannedDeparture, t.departure, 'ends here')}</div>
        </div>`;
          })
          .join('')
      : '<div class="row empty">No trains in the next hours.</div>';
    const d = new Date(now);
    $('clock').textContent = d.toLocaleTimeString('de-DE');
    $('date').textContent = d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    $('live').classList.toggle('active', isLive());
  }

  // --- controls
  document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => setClock(simNow(), Number(b.dataset.speed))));
  $('live').addEventListener('click', () => setClock(Date.now(), 1));
  $('skip').addEventListener('click', () => {
    const now = simNow();
    const next = trains.find((t) => t.arrival - APPROACH_MS - 5000 > now);
    if (next) setClock(next.arrival - APPROACH_MS - 5000, 1);
  });

  // --- main loop
  let lastBoardPaint = 0;
  function frame() {
    const now = simNow();
    if (Math.abs(now - fetchedAtSim) > 10 * MIN || performance.now() - fetchedAtReal > 15000) refreshData(now);
    renderer.resize();
    const board = B.boardAt(trains, now);
    renderer.draw(now, board);
    if (performance.now() - lastBoardPaint > 200) {
      lastBoardPaint = performance.now();
      renderBoard(board, now);
    }
    requestAnimationFrame(frame);
  }

  setClock(Date.now(), 1);
  refreshData(simNow());
  requestAnimationFrame(frame);
})();
