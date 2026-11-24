/*
 * Pixel renderer for Bahnhof Bad Homburg.
 * The scene is 360 px high and as wide as the screen needs (>= 640); it is
 * enlarged by a whole factor so pixels stay square, then fitted by CSS. The station itself sits in a 640 px wide
 * core that is centred; streets, tracks and platforms stretch to fill the rest.
 * View: looking from the track side towards the station building, town at the top.
 */
(function () {
  'use strict';
  const B = (window.Bahn = window.Bahn || {});
  const { hash, APPROACH_MS, EXIT_MS, MIN } = B;

  const H = 360;
  // The rows of the scene that are shown; trimming the empty top and bottom lets everything be drawn larger.
  const VIEW_Y = 27;
  const VIEW_H = 325;
  const CORE = 640;
  const TRAIN_H = 26;

  // Scene geometry, set by layout(): total width, core offset, platform ends.
  let W = CORE;
  let OX = 0;
  let PX0 = 70;
  let PX1 = 570;

  // bed = top of the ballast strip; waitY = where passengers for that track stand;
  // display = departure display position relative to the core.
  const TRACKS = {
    1: { bed: 130, waitY: [110, 119], display: [196, 105] },
    2: { bed: 158, waitY: [189, 191], display: [196, 194] },
    3: { bed: 210, waitY: [199, 201], display: [392, 194] },
    4: { bed: 238, waitY: [269, 271], display: [196, 274] },
    5: { bed: 290, waitY: [279, 281], display: [392, 274] },
  };
  const TRACK_NUMBERS = [1, 2, 3, 4, 5];
  const PLATFORMS = [
    { y0: 106, y1: 130, top: false, bottom: true, lampY: 112 },
    { y0: 186, y1: 210, top: true, bottom: true, lampY: 197 },
    { y0: 266, y1: 290, top: true, bottom: true, lampY: 277 },
  ];

  const RED = '#ec0016';
  const RED_DARK = '#b9000f';
  const WIN = '#1d2636';
  const WIN_LIT = '#f6d27a';
  const SAND = '#e4d2a4';
  const SAND_HI = '#f2e4bd';
  const SAND_LO = '#c4b081';
  const SLATE = '#555c6b';

  const TRAIN_SPECS = {
    sbahn: { cars: 4, carW: 62, length: 4 * 62 + 3 },
    regio: { cars: 2, carW: 68, length: 2 * 68 + 1 },
  };

  /** S-Bahn trains run as two coupled units when the platform is long enough to show it. */
  const unitsOf = (type) => (type === 'sbahn' && PX1 - PX0 >= 2 * TRAIN_SPECS.sbahn.length + 80 ? 2 : 1);
  const trainLength = (type) => unitsOf(type) * (TRAIN_SPECS[type].length + 2) - 2;

  function layout(width) {
    W = Math.max(CORE, Math.round(width));
    OX = Math.floor((W - CORE) / 2);
    const ext = Math.max(0, Math.min(OX - 70, 420));
    PX0 = OX + 70 - ext;
    PX1 = OX + 570 + ext;
  }

  // ---------------------------------------------------------------- helpers

  const FONT = {
    A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110',
    E: '111100110100111', F: '111100110100100', G: '011100101101011', H: '101101111101101',
    I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
    M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100',
    Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
    U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
    Y: '101101010010010', Z: '111001010100111',
    0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
    4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010',
    8: '111101111101111', 9: '111101111001110',
    '-': '000000111000000', ':': '000010000010000', '.': '000000000000010', '+': '000010111010000',
  };

  function rect(g, x, y, w, h, c) {
    g.fillStyle = c;
    g.fillRect(Math.round(x), Math.round(y), w, h);
  }

  function text(g, str, x, y, c) {
    g.fillStyle = c;
    const s = String(str).toUpperCase().replace(/Ä/g, 'A').replace(/Ö/g, 'O').replace(/Ü/g, 'U');
    for (const ch of s) {
      const glyph = FONT[ch];
      if (glyph) {
        for (let i = 0; i < 15; i++) {
          if (glyph[i] === '1') g.fillRect(x + (i % 3), y + ((i / 3) | 0), 1, 1);
        }
      }
      x += 4;
    }
  }
  const textW = (s) => String(s).length * 4 - 1;

  function disc(g, cx, cy, r, c) {
    g.fillStyle = c;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r + r * 0.6) g.fillRect(cx + dx, cy + dy, 1, 1);
      }
    }
  }

  function line(g, x0, y0, x1, y1, c) {
    g.fillStyle = c;
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) {
      g.fillRect(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), 1, 1);
    }
  }

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function tree(g, x, y, r) {
    disc(g, x + 1, y + 2, r, 'rgba(0,0,0,0.25)');
    disc(g, x, y, r, '#2f6b2f');
    disc(g, x - 1, y - 1, r - 2, '#3f8a3a');
    disc(g, x - 2, y - 2, Math.max(r - 4, 1), '#58a64a');
  }

  function car(g, x, y, c, vertical) {
    if (vertical) {
      rect(g, x, y, 8, 13, c);
      rect(g, x + 1, y + 3, 6, 2, '#1b2230');
      rect(g, x + 1, y + 9, 6, 2, '#1b2230');
      rect(g, x + 1, y + 5, 6, 4, 'rgba(255,255,255,0.18)');
    } else {
      rect(g, x, y, 13, 7, c);
      rect(g, x + 3, y + 1, 2, 5, '#1b2230');
      rect(g, x + 9, y + 1, 2, 5, '#1b2230');
      rect(g, x + 5, y + 1, 4, 5, 'rgba(255,255,255,0.18)');
    }
  }

  function bus(g, x, y) {
    rect(g, x, y, 28, 9, '#f3f4f2');
    rect(g, x, y + 3, 28, 3, '#19a39a');
    rect(g, x + 2, y + 1, 24, 1, '#c9cdd2');
    rect(g, x + 2, y + 7, 24, 1, '#c9cdd2');
    rect(g, x + 25, y + 1, 2, 7, '#1b2230');
  }

  // ------------------------------------------------------------ background

  let litWindows = []; // [x, y, w, h] glowing at night
  let lamps = []; // [x, y]

  function platform(g, p) {
    const w = PX1 - PX0;
    const h = p.y1 - p.y0;
    rect(g, PX0, p.y0, w, h, '#b5b3ab');
    for (let x = PX0 + 4; x < PX1; x += 8) rect(g, x, p.y0, 1, h, '#aba9a1');
    rect(g, PX0 - 6, p.y0, 6, h, '#9a988f'); // ramps
    rect(g, PX1, p.y0, 6, h, '#9a988f');
    if (p.top) {
      rect(g, PX0, p.y0, w, 1, '#77756e');
      rect(g, PX0, p.y0 + 2, w, 1, '#efeee9');
    }
    if (p.bottom) {
      rect(g, PX0, p.y1 - 1, w, 1, '#77756e');
      rect(g, PX0, p.y1 - 3, w, 1, '#efeee9');
    }
    for (let x = PX0 + 30; x <= PX1 - 30; x += 88) {
      rect(g, x, p.lampY + 1, 1, 3, '#3d4046');
      rect(g, x - 1, p.lampY, 3, 1, '#f4f1e2');
      lamps.push([x, p.lampY]);
      const bx = x + 36;
      if (bx + 9 < PX1 && (bx + 9 < OX + 300 || bx > OX + 340)) rect(g, bx, p.lampY + 4, 9, 2, '#7a5536'); // bench
    }
  }

  function trackBed(g, y, rand) {
    rect(g, 0, y, W, 28, '#6b6257');
    for (let i = 0; i < W * 0.8; i++) {
      rect(g, Math.floor(rand() * W), y + Math.floor(rand() * 28), 1, 1, rand() < 0.5 ? '#7c7366' : '#5a5248');
    }
    for (let x = 1; x < W; x += 6) rect(g, x, y + 16, 2, 11, '#4a3f35');
    for (const ry of [y + 18, y + 24]) {
      rect(g, 0, ry, W, 1, '#c3c6cc');
      rect(g, 0, ry + 1, W, 1, '#3d3a36');
    }
  }

  function stairs(g, x, y, w, h) {
    rect(g, x - 1, y - 1, w + 2, h + 2, '#8d9096');
    rect(g, x, y, w, h, '#2f3036');
    for (let sx = x + 2; sx < x + w; sx += 3) rect(g, sx, y, 1, h, '#4b4d55');
  }

  /** Glass canopy; drawn on the overlay so people and platform show through. */
  function canopy(g, x, y, w, h) {
    rect(g, x + 1, y + 2, w, h, 'rgba(0,0,0,0.18)');
    rect(g, x, y, w, h, 'rgba(134,173,189,0.62)');
    rect(g, x + 1, y + 1, w - 2, 1, 'rgba(200,225,235,0.7)');
    rect(g, x, y, w, 1, '#46565f');
    rect(g, x, y + h - 1, w, 1, '#46565f');
    for (let sx = x; sx < x + w; sx += 12) rect(g, sx, y, 1, h, '#46565f');
    rect(g, x + w - 1, y, 1, h, '#46565f');
  }

  function nameSign(g, x, y) {
    rect(g, x, y, 47, 9, '#0b2a7a');
    rect(g, x, y, 47, 1, '#ffffff');
    rect(g, x, y + 8, 47, 1, '#ffffff');
    text(g, 'BAD HOMBURG', x + 2, y + 2, '#ffffff');
  }

  function trackSign(g, x, y, n) {
    rect(g, x, y, 7, 9, '#0b2a7a');
    text(g, n, x + 2, y + 2, '#ffffff');
  }

  function archWindow(g, x, y) {
    rect(g, x, y + 1, 8, 17, SAND_LO);
    rect(g, x + 1, y, 6, 1, SAND_LO);
    rect(g, x + 1, y + 2, 6, 15, WIN);
    rect(g, x + 2, y + 1, 4, 1, WIN);
    rect(g, x + 4, y + 1, 1, 16, '#6f7c93');
    rect(g, x + 1, y + 8, 6, 1, '#6f7c93');
    litWindows.push([x + 1, y + 2, 6, 15]);
  }

  function drawBuilding(g) {
    const BX = OX + 190;
    const BW = 260;
    const cxHall = OX + 320;

    // forecourt
    rect(g, OX + 150, 30, 340, 12, '#c2bdb0');
    for (let x = OX + 152; x < OX + 490; x += 6) rect(g, x, 30, 1, 12, '#b6b1a4');

    // wing roofs (slate mansard)
    rect(g, BX - 3, 42, BW + 6, 25, SLATE);
    for (let y = 46; y < 66; y += 4) rect(g, BX - 3, y, BW + 6, 1, '#4a5060');
    rect(g, BX - 3, 42, BW + 6, 2, '#717a8b');
    for (let x = BX + 12; x < BX + BW - 12; x += 30) {
      if (x > OX + 268 && x < OX + 392) continue;
      rect(g, x - 1, 49, 10, 2, '#3f4553');
      rect(g, x, 51, 8, 9, SAND);
      rect(g, x + 2, 53, 4, 6, WIN);
      litWindows.push([x + 2, 53, 4, 6]);
    }

    // wing facade
    rect(g, BX, 66, BW, 40, SAND);
    rect(g, BX, 66, BW, 2, SAND_HI);
    rect(g, BX, 68, BW, 1, SAND_LO);
    rect(g, BX, 100, BW, 6, '#b9a577');
    for (let x = BX; x < BX + BW; x += 20) rect(g, x, 69, 2, 31, '#d8c594');
    for (let x = BX + 7; x < BX + BW - 8; x += 20) {
      if (x > OX + 274 && x < OX + 392) continue;
      archWindow(g, x, 76);
    }
    rect(g, BX, 66, 2, 40, SAND_HI);
    rect(g, BX + BW - 2, 66, 2, 40, SAND_LO);

    // central hall with gable and the big arched window
    for (let i = 0; i < 20; i++) rect(g, cxHall - 40 + i * 2, 46 - i, 80 - i * 4, 1, '#474d5b');
    rect(g, cxHall - 40, 46, 80, 20, '#474d5b');
    for (let i = 0; i < 17; i++) rect(g, cxHall - 36 + i * 2, 46 - i, 72 - i * 4, 1, SAND);
    rect(g, cxHall - 36, 46, 72, 60, SAND);
    rect(g, cxHall - 36, 46, 2, 60, SAND_HI);
    rect(g, cxHall + 34, 46, 2, 60, SAND_LO);
    rect(g, cxHall - 38, 46, 76, 2, SAND_LO);
    disc(g, cxHall, 37, 2, WIN); // oculus in the gable
    const cy = 72;
    for (let dy = -19; dy <= 20; dy++) {
      for (let dx = -19; dx <= 19; dx++) {
        if (dy <= 0 && dx * dx + dy * dy > 19 * 19) continue;
        const inner = dy <= 0 ? dx * dx + dy * dy <= 17 * 17 : Math.abs(dx) <= 17 && dy <= 18;
        const mullion = dx % 6 === 0 || dy === 0 || dy === 10;
        rect(g, cxHall + dx, cy + dy, 1, 1, inner ? (mullion ? '#7f8da6' : '#2a3a58') : SAND_LO);
      }
    }
    litWindows.push([cxHall - 17, 60, 35, 30]);
    rect(g, cxHall - 9, 94, 18, 12, '#5a3d2b');
    rect(g, cxHall - 7, 96, 6, 10, '#2a3a58');
    rect(g, cxHall + 1, 96, 6, 10, '#2a3a58');
    litWindows.push([cxHall - 7, 96, 6, 10], [cxHall + 1, 96, 6, 10]);
    rect(g, cxHall - 30, 96, 11, 7, RED);
    text(g, 'DB', cxHall - 28, 97, '#ffffff');

    // clock tower with copper dome
    const tx = OX + 366;
    rect(g, tx, 44, 20, 62, SAND);
    rect(g, tx, 44, 2, 62, SAND_HI);
    rect(g, tx + 18, 44, 2, 62, SAND_LO);
    rect(g, tx - 2, 42, 24, 3, '#cdb98a');
    rect(g, tx - 2, 68, 24, 2, '#cdb98a');
    [22, 20, 18, 16, 12, 8, 4, 2].forEach((w, i) => {
      rect(g, tx + 10 - w / 2, 41 - i, w, 1, '#5d9c88');
      rect(g, tx + 10 - w / 2, 41 - i, Math.max(1, Math.floor(w / 4)), 1, '#86c2ad');
    });
    rect(g, tx + 9, 28, 2, 6, '#35443e');
    rect(g, tx + 7, 78, 6, 10, WIN);
    litWindows.push([tx + 7, 78, 6, 10]);
  }

  function drawBackground() {
    litWindows = [];
    lamps = [];
    const c = makeCanvas(W, H);
    const g = c.getContext('2d');
    const rand = rng(8000);
    const carColors = ['#c9ccd1', '#2b3038', '#8c1d22', '#2c4f8c', '#e9e9e6', '#55606e', '#3a6b4a', '#b98a2c'];
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];

    // grass base with texture
    rect(g, 0, 0, W, H, '#4f8a3c');
    for (let i = 0; i < W * 4; i++) {
      rect(g, Math.floor(rand() * W), Math.floor(rand() * H), 1, 1, rand() < 0.5 ? '#5a9845' : '#457b35');
    }

    // town houses along the top
    for (let x = -4; x < W; ) {
      const w = 18 + Math.floor(rand() * 22);
      rect(g, x, 0, w, 9, pick(['#9c4a3a', '#7d3b30', '#6b6f78', '#8a5a3c']));
      rect(g, x, 4, w, 1, 'rgba(0,0,0,0.18)');
      rect(g, x, 9, w, 5, pick(['#efe6d2', '#e3d3b8', '#d9d4c8']));
      for (let wx = x + 3; wx < x + w - 3; wx += 6) {
        rect(g, wx, 10, 3, 3, WIN);
        if (rand() < 0.6) litWindows.push([wx, 10, 3, 3]);
      }
      x += w + 1;
    }

    // Bahnhofstraße
    rect(g, 0, 14, W, 16, '#4a4d55');
    for (let x = 4; x < W; x += 14) rect(g, x, 22, 7, 1, '#d8d8d0');
    rect(g, 0, 14, W, 1, '#8d8b84');
    rect(g, 0, 30, W, 1, '#8d8b84');
    rect(g, 0, 31, W, 5, '#b9b4a8');

    // beyond the station on both sides: houses with gardens, trees
    const sides = [[0, OX + 4], [OX + 636, W]];
    for (const [x0, x1] of sides) {
      for (let x = x0 + 8; x + 44 < x1; x += 58 + Math.floor(rand() * 30)) {
        const y = 42 + Math.floor(rand() * 26);
        const w = 26 + Math.floor(rand() * 16);
        rect(g, x + 2, y + 3, w, 26, 'rgba(0,0,0,0.22)');
        rect(g, x, y, w, 26, pick(['#9c4a3a', '#7d3b30', '#6b6f78', '#8a5a3c']));
        rect(g, x, y + 12, w, 2, 'rgba(0,0,0,0.25)');
        rect(g, x, y, w, 1, 'rgba(255,255,255,0.18)');
      }
      for (let i = 0; i < (x1 - x0) / 16; i++) {
        tree(g, x0 + 6 + Math.floor(rand() * Math.max(1, x1 - x0 - 12)), 44 + Math.floor(rand() * 54), 5 + Math.floor(rand() * 4));
        tree(g, x0 + 6 + Math.floor(rand() * Math.max(1, x1 - x0 - 12)), 330 + Math.floor(rand() * 26), 5 + Math.floor(rand() * 4));
      }
    }

    // bus station (left of the building)
    rect(g, OX + 34, 40, 146, 62, '#50535b');
    rect(g, OX + 34, 40, 146, 1, '#8d8b84');
    for (let i = 0; i < 3; i++) {
      const y = 46 + i * 19;
      rect(g, OX + 44, y + 10, 126, 4, '#b9b4a8');
      rect(g, OX + 60 + i * 20, y + 10, 34, 4, '#86adbd');
      rect(g, OX + 60 + i * 20, y + 10, 34, 1, '#46565f');
    }
    bus(g, OX + 62, 46);
    bus(g, OX + 118, 65);
    rect(g, OX + 38, 43, 7, 7, '#1c8a3c');
    text(g, 'H', OX + 40, 44, '#f6e64a');

    // taxi rank, bike racks and trees (right of the building)
    rect(g, OX + 458, 44, 136, 58, '#aaa69b');
    for (let x = OX + 460; x < OX + 594; x += 6) rect(g, x, 44, 1, 58, '#9f9b90');
    for (let i = 0; i < 3; i++) car(g, OX + 464 + i * 16, 48, '#f1e6b4', false);
    for (let x = OX + 468; x < OX + 540; x += 3) {
      rect(g, x, 84, 1, 4, '#3b3f47');
      if (rand() < 0.7) rect(g, x, 85, 2, 2, pick(carColors));
    }
    rect(g, OX + 466, 82, 76, 1, '#70757d');
    for (const [x, y, r] of [[560, 58, 7], [580, 80, 8], [606, 52, 8], [622, 84, 7], [16, 54, 8], [20, 86, 9]]) tree(g, OX + x, y, r);

    drawBuilding(g);

    for (const n of TRACK_NUMBERS) trackBed(g, TRACKS[n].bed, rand);
    for (const p of PLATFORMS) platform(g, p);

    stairs(g, OX + 304, 194, 32, 8);
    stairs(g, OX + 304, 274, 32, 8);
    nameSign(g, OX + 86, 109);
    nameSign(g, OX + 500, 109);
    for (const y of [194, 274]) {
      nameSign(g, OX + 86, y);
      nameSign(g, OX + 470, y);
    }
    for (const x of [PX0 + 26, PX1 - 34]) {
      trackSign(g, x, 118, 1);
      trackSign(g, x, 189, 2);
      trackSign(g, x, 200, 3);
      trackSign(g, x, 269, 4);
      trackSign(g, x, 280, 5);
    }

    // fence, P+R car park, trees
    rect(g, 0, 321, W, 1, '#39443a');
    for (let x = 0; x < W; x += 6) rect(g, x, 320, 1, 3, '#39443a');
    rect(g, OX + 60, 325, 384, 27, '#4c4f57');
    for (let x = OX + 66; x < OX + 440; x += 12) {
      rect(g, x, 327, 1, 14, '#c9c9c0');
      if (rand() < 0.68 && x + 12 < OX + 440) car(g, x + 3, 328, pick(carColors), true);
    }
    rect(g, OX + 48, 327, 9, 9, '#0b4ea2');
    text(g, 'P', OX + 51, 329, '#ffffff');
    for (let i = 0; i < 12; i++) tree(g, OX + 458 + Math.floor(rand() * 176), 330 + Math.floor(rand() * 26), 5 + Math.floor(rand() * 4));
    for (let i = 0; i < 4; i++) tree(g, OX + 8 + Math.floor(rand() * 34), 330 + Math.floor(rand() * 26), 5 + Math.floor(rand() * 4));

    return c;
  }

  /** Everything that sits above the trains: canopies, overhead wires and their masts. */
  function drawOverlay() {
    const c = makeCanvas(W, H);
    const g = c.getContext('2d');
    canopy(g, OX + 178, 103, 284, 10);
    for (const y of [192, 272]) {
      canopy(g, OX + 188, y, 110, 13);
      canopy(g, OX + 342, y, 110, 13);
    }
    for (const n of TRACK_NUMBERS) rect(g, 0, TRACKS[n].bed + 4, W, 1, 'rgba(25,27,33,0.5)');
    for (let mx = (OX + 24) % 120; mx < W; mx += 120) {
      for (const [y, h] of [[129, 58], [209, 58], [289, 30]]) {
        rect(g, mx, y, 1, h, 'rgba(40,44,52,0.9)');
        rect(g, mx - 1, y - 1, 3, 3, '#2a2d34');
        rect(g, mx - 1, y + h - 2, 3, 3, '#2a2d34');
      }
    }
    return c;
  }

  // ----------------------------------------------------------------- trains

  const spriteCache = new Map();

  /** Train sprite; `dir` 1 = heading right. Both ends have a cab, the head end shows white lights. */
  function trainSprite(type, dir, line, open, night) {
    const units = unitsOf(type);
    const key = [type, dir, line, open, night, units].join('|');
    if (spriteCache.has(key)) return spriteCache.get(key);
    if (units > 1) {
      const unit = unitSprite(type, dir, line, open, night);
      const both = makeCanvas(trainLength(type), TRAIN_H);
      const bg = both.getContext('2d');
      for (let i = 0; i < units; i++) bg.drawImage(unit, i * (unit.width + 2), 0);
      for (let i = 1; i < units; i++) rect(bg, i * (unit.width + 2) - 2, 19, 2, 3, '#22242a'); // coupling
      spriteCache.set(key, both);
      return both;
    }
    const single = unitSprite(type, dir, line, open, night);
    spriteCache.set(key, single);
    return single;
  }

  function unitSprite(type, dir, line, open, night) {
    const key = [type, dir, line, open, night, 'unit'].join('|');
    if (spriteCache.has(key)) return spriteCache.get(key);

    const spec = TRAIN_SPECS[type];
    const L = spec.length;
    const cw = spec.carW;
    const c = makeCanvas(L, TRAIN_H);
    const g = c.getContext('2d');
    const mx = (x, w) => (dir > 0 ? x : L - x - w);
    const R = (x, y, w, h, col) => rect(g, mx(x, w), y, w, h, col);
    const C = (x, y, w, h) => g.clearRect(mx(x, w), y, w, h);
    const win = night ? WIN_LIT : WIN;

    for (let i = 0; i < spec.cars; i++) {
      const cx = i * (cw + 1);
      // roof
      R(cx, 0, cw, 8, '#b4b8c0');
      R(cx, 0, cw, 1, '#d4d7dc');
      R(cx, 7, cw, 1, '#878b93');
      // body
      R(cx, 8, cw, 15, RED);
      R(cx, 8, cw, 1, '#ff4d57');
      R(cx, 21, cw, 2, RED_DARK);
      R(cx + 1, 23, cw - 2, 1, '#3a3d44');
      R(cx + 5, 24, 11, 2, '#1f2126');
      R(cx + cw - 16, 24, 11, 2, '#1f2126');
      if (i < spec.cars - 1) R(cx + cw, 9, 1, 14, '#22242a');

      let doors;
      if (type === 'sbahn') {
        R(cx + 10, 2, 14, 4, '#9a9fa8');
        R(cx + 38, 2, 14, 4, '#9a9fa8');
        R(cx + 2, 10, cw - 4, 5, win);
        for (let k = cx + 6; k < cx + cw - 3; k += 9) R(k, 10, 1, 5, night ? '#a3813c' : '#343c4e');
        doors = [9, 27, 45].map((o) => [cx + o, 8]);
      } else {
        R(cx + 28, 1, 10, 5, '#6d7178');
        R(cx + 29, 2, 8, 1, '#4b4e55');
        for (const [o, w] of [[4, 8], [26, 8], [36, 8], [58, 6]]) R(cx + o, 10, w, 5, win);
        doors = [14, 46].map((o) => [cx + o, 10]);
      }
      for (const [dx, dw] of doors) {
        if (open) {
          R(dx, 9, dw, 14, '#ffe9a8');
          R(dx, 20, dw, 3, '#b89a55');
        } else {
          R(dx, 9, dw, 14, type === 'sbahn' ? '#c90013' : '#dcdee3');
          R(dx + 1, 10, dw / 2 - 1, 6, win);
          R(dx + dw / 2, 10, dw / 2 - 1, 6, win);
          R(dx + dw / 2 - 1, 9, 1, 14, 'rgba(0,0,0,0.35)');
        }
      }
    }

    // cabs: tail at x = 0, head at x = L
    R(1, 10, 4, 6, '#0d1220');
    R(L - 5, 10, 4, 6, '#0d1220');
    R(0, 8, 1, 15, '#9c000d');
    R(L - 1, 8, 1, 15, '#9c000d');
    const round = type === 'sbahn' ? [[2, 0, 2], [1, 2, 2]] : [[3, 0, 2], [2, 2, 2], [1, 4, 2]];
    for (const [w, y, h] of round) {
      C(0, y, w, h);
      C(L - w, y, w, h);
    }
    R(0, 18, 1, 2, '#ff2020');
    R(1, 18, 1, 2, '#ff6a6a');
    R(L - 1, 18, 1, 2, '#ffffff');
    R(L - 2, 18, 1, 2, '#fff3b0');

    // DB logo and line display (never mirrored, only repositioned)
    const lead = (spec.cars - 1) * (cw + 1);
    const logoX = type === 'sbahn' ? lead + 18 : lead + 27;
    R(logoX, 15, 9, 7, '#ffffff');
    text(g, 'DB', mx(logoX, 9) + 1, 16, RED);
    const label = String(line).replace(/\s/g, '').slice(0, 4);
    const labelW = textW(label) + 2;
    const labelX = type === 'sbahn' ? lead + 36 : 26;
    R(labelX, 10, labelW, 5, '#000000');
    text(g, label, mx(labelX, labelW) + 1, 10, '#ffb000');

    if (type === 'sbahn') {
      const px = cw + 1 + 27;
      R(px, 3, 9, 1, '#2c2f36');
      R(px + 4, 1, 1, 5, '#2c2f36');
    }

    spriteCache.set(key, c);
    return c;
  }

  /** Left edge of the train at time `now`, or null while it is outside the map. */
  function trainX(t, now) {
    const L = trainLength(t.type);
    const stop = Math.round(W / 2 - L / 2);
    if (now <= t.arrival - APPROACH_MS || now >= t.departure + EXIT_MS) return null;
    if (now < t.arrival) {
      const u = (now - (t.arrival - APPROACH_MS)) / APPROACH_MS;
      const dist = t.dirIn > 0 ? stop + L + 12 : W + 12 - stop;
      return stop - t.dirIn * dist * (1 - u) * (1 - u); // braking to a halt exactly at `arrival`
    }
    if (now <= t.departure) return stop;
    const u = (now - t.departure) / EXIT_MS;
    const dist = t.dirOut > 0 ? W + 12 - stop : stop + L + 12;
    return stop + t.dirOut * dist * u * u; // pulling away from `departure`
  }

  // ----------------------------------------------------------------- people

  const SKIN = ['#f1c9a5', '#d9a57b', '#8d5a3b', '#f6d7bb'];
  const CLOTHES = ['#2d5fa8', '#b3262d', '#3d8a4a', '#e2b53c', '#4a4f5c', '#7d3f98', '#e8e8e4', '#1f2a44', '#d9722e'];

  function person(g, x, y, seed, bob) {
    const yy = Math.round(y) - (bob ? 1 : 0);
    const xx = Math.round(x);
    rect(g, xx, yy + 6, 2, 1, 'rgba(0,0,0,0.25)');
    rect(g, xx, yy, 2, 2, SKIN[Math.floor(hash(seed + 's') * SKIN.length)]);
    rect(g, xx, yy + 2, 2, 3, CLOTHES[Math.floor(hash(seed + 'c') * CLOTHES.length)]);
    rect(g, xx, yy + 5, 2, 1, '#20232a');
  }

  function drawPeople(g, board, now) {
    const mid = W / 2;
    for (const t of board) {
      const tr = TRACKS[t.track];
      if (!tr) continue;
      const L = trainLength(t.type);
      const [y0, y1] = tr.waitY;

      // waiting passengers drift onto the platform over the 8 minutes before departure
      if (t.destination && now < t.departure && now > t.departure - 10 * MIN) {
        const n = 5 + Math.floor(hash(t.id + 'n') * 9);
        const boardFrom = Math.max(t.arrival, t.departure - 60000);
        for (let i = 0; i < n; i++) {
          const k = t.id + 'w' + i;
          const from = boardFrom - 20000 - hash(k + 'a') * 8 * MIN;
          const until = boardFrom + 3000 + hash(k + 'b') * Math.max(t.departure - boardFrom - 9000, 1000);
          if (now < from || now > until) continue;
          const x = mid + (hash(k + 'x') * 2 - 1) * (L / 2 - 6);
          person(g, x, y0 + hash(k + 'y') * (y1 - y0), k, false);
        }
      }

      // passengers getting off walk to the underpass / the station hall
      if (!t.startsHere && now > t.arrival && now < t.arrival + 40000) {
        const m = 3 + Math.floor(hash(t.id + 'm') * 7);
        for (let i = 0; i < m; i++) {
          const k = t.id + 'o' + i;
          const start = t.arrival + 2000 + hash(k + 'a') * 10000;
          const x0 = mid + (hash(k + 'x') * 2 - 1) * (L / 2 - 8);
          const walked = ((now - start) / 1000) * 9;
          if (now < start || walked >= Math.abs(x0 - mid)) continue;
          const x = x0 + Math.sign(mid - x0) * walked;
          person(g, x, y0 + hash(k + 'y') * (y1 - y0), k, Math.floor(walked / 3) % 2 === 0);
        }
      }
    }
  }

  /** The car park regular: long blond hair, always walking, always smoking. Runs on wall-clock time. */
  function drawSmoker(g) {
    const t = performance.now() / 1000;
    const x0 = OX + 68;
    const span = 366;
    const lap = (t * 7) % (span * 2); // 7 px per second, back and forth
    const dir = lap < span ? 1 : -1;
    const x = Math.round(x0 + (dir > 0 ? lap : span * 2 - lap));
    const y = 343;
    const step = Math.floor(t * 4) % 2;
    const BLOND = '#f2d15c';

    rect(g, x - 1, y + 7, 4, 1, 'rgba(0,0,0,0.3)');
    // long hair: over the head and down the back
    rect(g, x, y - 1, 2, 1, BLOND);
    rect(g, dir > 0 ? x - 1 : x + 2, y - 1, 1, 5, BLOND);
    rect(g, dir > 0 ? x : x + 1, y, 1, 1, '#d9b63f');
    rect(g, dir > 0 ? x + 1 : x, y, 1, 2, '#f1c9a5'); // face
    rect(g, dir > 0 ? x : x + 1, y + 1, 1, 1, BLOND);
    rect(g, x, y + 2, 2, 3, '#2b2b33'); // jacket
    rect(g, x + step, y + 5, 1, 2, '#3b5a8c'); // legs
    rect(g, x + 1 - step, y + 5, 1, 1, '#3b5a8c');

    // cigarette with glowing tip
    const cx = dir > 0 ? x + 2 : x - 1;
    rect(g, cx, y + 1, 1, 1, '#f4f4f0');
    rect(g, cx + dir, y + 1, 1, 1, Math.floor(t * 3) % 3 ? '#ff7a1a' : '#ffd24a');
    // smoke rising and trailing behind him
    for (let i = 0; i < 5; i++) {
      const age = (t * 0.7 + i / 5) % 1;
      const sx = cx + dir - dir * age * 7 + Math.sin(t * 2 + i * 1.7) * 1.2;
      const size = age > 0.55 ? 2 : 1;
      rect(g, sx, y - age * 10, size, size, `rgba(225,225,225,${(0.6 * (1 - age)).toFixed(2)})`);
    }
  }

  // ---------------------------------------------------------------- dynamic

  /** 0 = full daylight, 1 = night. Sunrise / sunset follow the season roughly. */
  function darkness(now) {
    const d = new Date(now);
    const doy = (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 864e5;
    const season = Math.cos((2 * Math.PI * (doy + 10)) / 365); // 1 in midwinter
    const sunrise = 6.8 + 1.5 * season;
    const sunset = 19 - 2.6 * season;
    const h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
    const ss = (a, b, x) => {
      const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return u * u * (3 - 2 * u);
    };
    return h < 12 ? 1 - ss(sunrise - 0.7, sunrise + 0.3, h) : ss(sunset - 0.3, sunset + 0.7, h);
  }

  function drawClock(g, now) {
    const d = new Date(now);
    const cx = OX + 376;
    const cy = 55;
    disc(g, cx, cy, 7, '#2b2f38');
    disc(g, cx, cy, 6, '#fbfaf2');
    for (let i = 0; i < 12; i += 3) {
      const a = (i / 12) * Math.PI * 2;
      rect(g, cx + Math.sin(a) * 5.4, cy - Math.cos(a) * 5.4, 1, 1, '#2b2f38');
    }
    const m = (d.getMinutes() + d.getSeconds() / 60) / 60;
    const h = ((d.getHours() % 12) + m) / 12;
    line(g, cx, cy, cx + Math.sin(h * 2 * Math.PI) * 3, cy - Math.cos(h * 2 * Math.PI) * 3, '#15171c');
    line(g, cx, cy, cx + Math.sin(m * 2 * Math.PI) * 5, cy - Math.cos(m * 2 * Math.PI) * 5, '#15171c');
    const s = d.getSeconds() / 60;
    rect(g, cx + Math.sin(s * 2 * Math.PI) * 5, cy - Math.cos(s * 2 * Math.PI) * 5, 1, 1, RED);
  }

  function hhmm(ms) {
    const d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function signal(g, x, y, green) {
    if (x < 2 || x > W - 4) return;
    rect(g, x, y, 2, 9, '#2b2e35');
    rect(g, x - 1, y - 7, 4, 8, '#0c0d10');
    rect(g, x, y - 6, 2, 2, green ? '#123a1c' : '#ff2a2a');
    rect(g, x, y - 2, 2, 2, green ? '#3dff6e' : '#3a1212');
  }

  function drawDisplaysAndSignals(g, board, now) {
    for (const n of TRACK_NUMBERS) {
      const tr = TRACKS[n];
      const next = board.find((t) => t.track === n);
      const x = OX + tr.display[0];
      const y = tr.display[1];
      rect(g, x, y, 54, 9, '#05070c');
      rect(g, x, y, 7, 9, '#0b2a7a');
      text(g, n, x + 2, y + 2, '#ffffff');
      if (next) {
        const atPlatform = now >= next.arrival && now < next.departure;
        const showDeparture = (atPlatform || next.startsHere) && !next.endsHere;
        const blink = atPlatform && Math.floor(performance.now() / 500) % 2 === 0;
        const label = String(next.line).replace(/\s/g, '').slice(0, 5);
        if (!blink) text(g, label + ' ' + hhmm(showDeparture ? next.departure : next.arrival), x + 9, y + 2, next.late >= MIN ? '#ff6b5e' : '#ffb000');
      } else {
        text(g, '--:--', x + 9, y + 2, '#6b5a2a');
      }

      // exit signals at both platform ends: green shortly before and while a train pulls out
      const leaving = board.find((t) => t.track === n && now >= t.departure - 8000 && now < t.departure + EXIT_MS * 0.6);
      signal(g, PX0 - 30, tr.bed + 8, Boolean(leaving && leaving.dirOut < 0));
      signal(g, PX1 + 28, tr.bed + 8, Boolean(leaving && leaving.dirOut > 0));
    }
  }

  function createRenderer(canvas) {
    const out = canvas.getContext('2d');
    let scene; // the 1:1 pixel scene, blown up onto `canvas` by a whole factor
    let g;
    let background;
    let overlay;
    let zoom = 0;

    /** Fits the scene to the canvas's on-screen shape. */
    function resize() {
      const cw = canvas.clientWidth || CORE;
      const ch = canvas.clientHeight || H;
      const width = Math.min(8000, Math.max(CORE, Math.round((VIEW_H * cw) / ch)));
      const k = Math.max(1, Math.min(6, Math.floor(16000 / width), Math.ceil(((window.devicePixelRatio || 1) * ch) / VIEW_H - 0.01)));
      if (background && width === W && k === zoom) return;
      zoom = k;
      if (!background || width !== W) {
        layout(width);
        scene = makeCanvas(W, H);
        g = scene.getContext('2d');
        background = drawBackground();
        overlay = drawOverlay();
      }
      canvas.width = W * zoom;
      canvas.height = VIEW_H * zoom;
    }

    function draw(now, board) {
      const dark = darkness(now);
      const night = dark > 0.5;

      g.globalCompositeOperation = 'source-over';
      g.drawImage(background, 0, 0);
      drawPeople(g, board, now);
      drawSmoker(g);

      if (dark > 0.01) {
        rect(g, 0, 0, W, H, `rgba(8,12,40,${(0.62 * dark).toFixed(3)})`);
        g.globalCompositeOperation = 'lighter';
        for (const [x, y, w, h] of litWindows) rect(g, x, y, w, h, `rgba(255,196,90,${(0.75 * dark).toFixed(3)})`);
        for (const [x, y] of lamps) {
          const grad = g.createRadialGradient(x, y + 2, 0, x, y + 2, 26);
          grad.addColorStop(0, `rgba(255,224,160,${(0.42 * dark).toFixed(3)})`);
          grad.addColorStop(1, 'rgba(255,224,160,0)');
          g.fillStyle = grad;
          g.fillRect(x - 26, y - 24, 52, 52);
        }
        g.globalCompositeOperation = 'source-over';
      }

      const visible = board
        .filter((t) => TRACKS[t.track])
        .map((t) => ({ t, x: trainX(t, now) }))
        .filter((v) => v.x !== null)
        .sort((a, b) => a.t.track - b.t.track);
      for (const { t, x } of visible) {
        const open = now >= t.arrival + 1500 && now < t.departure - 3000;
        const dir = now < (t.arrival + t.departure) / 2 ? t.dirIn : t.dirOut;
        const y = TRACKS[t.track].bed + 1;
        const L = trainLength(t.type);
        rect(g, x + 2, y + TRAIN_H - 1, L - 4, 2, 'rgba(0,0,0,0.3)');
        g.drawImage(trainSprite(t.type, dir, t.line, open, night), Math.round(x), y);
        if (dark > 0.3) {
          // headlight beam on the rails ahead
          const hx = dir > 0 ? Math.round(x) + L : Math.round(x) - 22;
          const grad = g.createLinearGradient(dir > 0 ? hx : hx + 22, 0, dir > 0 ? hx + 22 : hx, 0);
          grad.addColorStop(0, `rgba(255,244,190,${(0.45 * dark).toFixed(3)})`);
          grad.addColorStop(1, 'rgba(255,244,190,0)');
          g.fillStyle = grad;
          g.fillRect(hx, y + 15, 22, 9);
        }
      }

      g.drawImage(overlay, 0, 0);
      drawDisplaysAndSignals(g, board, now);
      drawClock(g, now);

      out.imageSmoothingEnabled = false;
      out.drawImage(scene, 0, VIEW_Y, W, VIEW_H, 0, 0, canvas.width, canvas.height);
    }

    resize();
    return { draw, resize };
  }

  Object.assign(B, { createRenderer, trainX, TRAIN_SPECS });
})();
