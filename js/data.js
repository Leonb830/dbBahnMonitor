/*
 * Data layer: providers (live DB data via the local server, mock fallback)
 * and the schedule resolver.
 *
 * A provider has `fetchTrains(stationId, fromMs, toMs)` returning a Promise of
 * visits, one per train stopping at the station:
 *
 *   { id, line, type ('sbahn' | 'regio'), origin, destination, track,
 *     dirIn, dirOut            1 = moving left→right, -1 = right→left
 *     plannedArrival, expectedArrival, plannedDeparture, expectedDeparture }  (epoch ms)
 *
 * Arrival times are null for a train that starts here, departure times are null
 * for a train that ends here.
 */
(function () {
  'use strict';
  const B = (window.Bahn = window.Bahn || {});

  const MIN = 60000;
  const APPROACH_MS = 30000; // train is visible rolling in for 30 s before it stops
  const EXIT_MS = 30000; // ... and for 30 s after it starts moving again
  const MIN_DWELL = 30000;
  const TRACK_GAP = MIN; // a track must be clear this long before the next train stops on it
  const START_LEAD = 3 * MIN; // a train starting here is put at the platform this early
  const END_STAY = 2 * MIN; // a train ending here is driven away after this long
  const BOARD_SIZE = 5;

  // Left edge of the map is the Oberursel / Frankfurt side, right edge is Friedrichsdorf.
  const MOCK_SERVICES = [
    { line: 'S5', type: 'sbahn', destination: 'Frankfurt Süd', origin: 'Friedrichsdorf', track: 3, dir: -1, minutes: [4, 19, 34, 49] },
    { line: 'S5', type: 'sbahn', destination: 'Friedrichsdorf', origin: 'Frankfurt Süd', track: 4, dir: 1, minutes: [11, 26, 41, 56] },
    { line: 'RB15', type: 'regio', destination: 'Frankfurt Hbf', origin: 'Brandoberndorf', track: 2, dir: -1, minutes: [23, 53] },
    { line: 'RB15', type: 'regio', destination: 'Brandoberndorf', origin: 'Frankfurt Hbf', track: 5, dir: 1, minutes: [8, 38] },
  ];

  /** Deterministic string hash -> [0, 1). */
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }

  function mockDelay(id) {
    const r = hash(id + ':a');
    const s = hash(id + ':b');
    if (r < 0.5) return 0;
    if (r < 0.75) return 1 + Math.floor(s * 3); // 1-3 min
    if (r < 0.9) return 4 + Math.floor(s * 6); // 4-9 min
    return 10 + Math.floor(s * 14); // 10-23 min
  }

  const MockProvider = {
    label: 'Mock timetable',
    fetchTrains(stationId, fromMs, toMs) {
      const out = [];
      const hour = new Date(fromMs);
      hour.setMinutes(0, 0, 0);
      for (let t = hour.getTime(); t <= toMs; t += 60 * MIN) {
        for (const svc of MOCK_SERVICES) {
          for (const m of svc.minutes) {
            const dep = t + m * MIN;
            if (dep < fromMs || dep > toMs) continue;
            const d = new Date(dep);
            const hm = d.getHours() + d.getMinutes() / 60;
            if (hm >= 1 && hm < 4.5) continue; // night break
            const id = `${svc.line}-${svc.track}-${dep / MIN}`;
            const delay = mockDelay(id);
            const extra = hash(id + ':d') < 0.2 ? 1 + Math.floor(hash(id + ':e') * 2) : 0;
            out.push({
              id,
              line: svc.line,
              type: svc.type,
              destination: svc.destination,
              origin: svc.origin,
              track: svc.track,
              dirIn: svc.dir,
              dirOut: svc.dir,
              plannedArrival: dep - MIN,
              expectedArrival: dep - MIN + delay * MIN,
              plannedDeparture: dep,
              expectedDeparture: dep + (delay + extra) * MIN,
            });
          }
        }
      }
      return Promise.resolve(out);
    },
  };

  /** Real DB data through the local server (server.js). */
  const LiveProvider = {
    label: 'Live DB data',
    async fetchTrains(stationId, fromMs, toMs) {
      const res = await fetch(`api/trains?station=${encodeURIComponent(stationId)}&from=${Math.round(fromMs)}&to=${Math.round(toMs)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      LiveProvider.label = `Live · ${body.source}`;
      return body.trains;
    },
  };

  /**
   * Turns visits into the times the trains really stop and leave.
   * When two trains would need the same track at once, the more punctual one
   * keeps its slot and the later-running one is held back until the track is clear.
   */
  function resolveSchedule(raw) {
    const trains = raw.map((r) => {
      const startsHere = r.plannedArrival == null;
      const endsHere = r.plannedDeparture == null;
      let arrival = startsHere ? null : r.expectedArrival ?? r.plannedArrival;
      let departure = endsHere ? null : r.expectedDeparture ?? r.plannedDeparture;
      if (arrival == null) arrival = departure - START_LEAD;
      if (departure == null) departure = arrival + END_STAY;
      departure = Math.max(departure, arrival + MIN_DWELL);
      const late = startsHere ? departure - r.plannedDeparture : arrival - r.plannedArrival;
      return Object.assign({}, r, { arrival, departure, startsHere, endsHere, late, heldBehind: null });
    });

    const byTrack = new Map();
    for (const t of trains) {
      if (t.track == null) continue;
      if (!byTrack.has(t.track)) byTrack.set(t.track, []);
      byTrack.get(t.track).push(t);
    }

    for (const list of byTrack.values()) {
      for (let guard = 0; guard < 1000; guard++) {
        list.sort((a, b) => a.arrival - b.arrival);
        let changed = false;
        for (let i = 0; i < list.length - 1; i++) {
          const a = list[i];
          const b = list[i + 1];
          if (b.arrival >= a.departure + TRACK_GAP) continue;
          const winner = a.late > b.late ? b : a;
          const loser = winner === a ? b : a;
          const dwell = Math.max(loser.departure - loser.arrival, MIN);
          const shift = winner.departure + TRACK_GAP - loser.arrival;
          loser.arrival += shift;
          loser.departure = loser.arrival + dwell;
          loser.late += shift;
          loser.heldBehind = `${winner.line} → ${winner.destination || 'ends here'}`;
          changed = true;
          break;
        }
        if (!changed) break;
      }
    }

    trains.sort((a, b) => a.arrival - b.arrival || a.track - b.track);
    return trains;
  }

  /** The (at most five) trains shown on the board and the map, in the order they really arrive. */
  function boardAt(trains, now) {
    const out = [];
    for (const t of trains) {
      if (now >= t.departure + EXIT_MS) continue;
      out.push(t);
      if (out.length === BOARD_SIZE) break;
    }
    return out;
  }

  function phaseOf(t, now) {
    if (now < t.arrival - APPROACH_MS) return 'expected';
    if (now < t.arrival) return 'arriving';
    if (now < t.departure) return 'boarding';
    if (now < t.departure + EXIT_MS) return 'departing';
    return 'gone';
  }

  Object.assign(B, { MIN, APPROACH_MS, EXIT_MS, BOARD_SIZE, MockProvider, LiveProvider, resolveSchedule, boardAt, phaseOf, hash });
})();
