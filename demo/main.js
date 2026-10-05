import { LEVELS } from './levels.js';

const T = 40;
const W = 960, H = 480;
const cv = document.getElementById('game');
const ctx = cv.getContext('2d');

// ---------- input ----------
const keys = {};
const pressed = {};
const GAME_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'];
addEventListener('keydown', e => {
  if (!keys[e.code]) pressed[e.code] = true;
  keys[e.code] = true;
  if (GAME_KEYS.includes(e.code)) e.preventDefault();
  initAudio();
});
addEventListener('keyup', e => { keys[e.code] = false; });
// ---------- touch controls ----------
const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
if (isTouch) document.body.classList.add('touch');
document.querySelectorAll('.btn').forEach(btn => {
  const code = btn.dataset.key;
  const down = e => {
    e.preventDefault(); initAudio();
    btn.setPointerCapture?.(e.pointerId);
    if (!keys[code]) pressed[code] = true;
    keys[code] = true; btn.classList.add('down');
  };
  const up = e => { e.preventDefault(); keys[code] = false; btn.classList.remove('down'); };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('lostpointercapture', up);
});
// tap the screen to start / play again
cv.addEventListener('pointerdown', e => { e.preventDefault(); initAudio(); pressed.Enter = true; });
addEventListener('contextmenu', e => e.preventDefault());

const left = () => keys.ArrowLeft || keys.KeyA;
const right = () => keys.ArrowRight || keys.KeyD;
const jumpHeld = () => keys.Space || keys.ArrowUp || keys.KeyW;
const jumpPressed = () => pressed.Space || pressed.ArrowUp || pressed.KeyW;

// ---------- audio ----------
let actx = null;
function initAudio() { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); }
function tone(freq, dur, type = 'square', vol = 0.08, slide = 0) {
  if (!actx) return;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, actx.currentTime);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, actx.currentTime + dur);
  g.gain.setValueAtTime(vol, actx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
  o.connect(g).connect(actx.destination);
  o.start(); o.stop(actx.currentTime + dur);
}
const sfx = {
  coin: () => { tone(988, 0.08); setTimeout(() => tone(1319, 0.15), 70); },
  jump: () => tone(380, 0.15, 'square', 0.06, 1.8),
  stomp: () => tone(220, 0.15, 'square', 0.09, 0.5),
  jump2: () => tone(560, 0.18, 'triangle', 0.08, 2),
  die: () => tone(300, 0.4, 'sawtooth', 0.08, 0.3),
  win: () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.18, 'triangle', 0.1), i * 110)),
};

// ---------- physics constants ----------
const ENEMY_SPEED = 70;
const GRAVITY = 2000, JUMP_V = 760, RUN = 270, ACCEL = 2400, AIR_ACCEL = 1600, MAX_FALL = 900;

// ---------- state ----------
const game = {
  state: 'title', level: 0, totalCoins: 0, deaths: 0, timer: 0,
  grid: [], gw: 0, gh: 0, coins: [], spikes: [], enemies: [], flag: null, start: { x: 0, y: 0 },
  camX: 0, shake: 0, particles: [], time: 0,
};
const p = { x: 0, y: 0, w: 26, h: 30, vx: 0, vy: 0, onGround: false, facing: 1, coyote: 0, buffer: 0, anim: 0, airJumps: 1, flip: 0 };
window.__game = game; window.__player = p;

function loadLevel(i) {
  const L = LEVELS[i];
  game.level = i;
  game.gh = L.map.length;
  game.gw = Math.max(...L.map.map(r => r.length));
  game.grid = []; game.coins = []; game.spikes = []; game.enemies = []; game.flag = null;
  L.map.forEach((row, ty) => {
    const r = [];
    for (let tx = 0; tx < game.gw; tx++) {
      const c = row[tx] || '.';
      r.push(c === '#' ? 1 : 0);
      if (c === 'o') game.coins.push({ x: tx * T + T / 2, y: ty * T + T / 2, got: false });
      if (c === '^') game.spikes.push({ x: tx * T, y: ty * T });
      if (c === 'E') game.enemies.push({ sx: tx * T + 5, sy: (ty + 1) * T - 24, x: 0, y: 0, w: 30, h: 24, dir: -1, alive: true, squash: 0 });
      if (c === 'P') game.start = { x: tx * T + (T - p.w) / 2, y: (ty + 1) * T - p.h };
      if (c === 'F') game.flag = { x: tx * T + T / 2, y: (ty + 1) * T };
    }
    game.grid.push(r);
  });
  respawn();
  game.camX = 0;
}

function respawn() {
  p.x = game.start.x; p.y = game.start.y; p.vx = 0; p.vy = 0; p.facing = 1; p.flip = 0;
  game.coins.forEach(c => c.got = false);
  game.enemies.forEach(e => { e.x = e.sx; e.y = e.sy; e.dir = -1; e.alive = true; e.squash = 0; });
  game.state = 'play';
}

const levelCoins = () => game.coins.filter(c => c.got).length;

function solid(tx, ty) {
  if (tx < 0 || tx >= game.gw) return true;
  if (ty < 0 || ty >= game.gh) return false;
  return game.grid[ty][tx] === 1;
}

function collide(axis) {
  const x0 = Math.floor(p.x / T), x1 = Math.floor((p.x + p.w - 0.01) / T);
  const y0 = Math.floor(p.y / T), y1 = Math.floor((p.y + p.h - 0.01) / T);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    if (!solid(tx, ty)) continue;
    if (axis === 'x') {
      if (p.vx > 0) p.x = tx * T - p.w; else if (p.vx < 0) p.x = (tx + 1) * T;
      p.vx = 0; return;
    } else {
      if (p.vy > 0) { p.y = ty * T - p.h; p.onGround = true; } else if (p.vy < 0) p.y = (ty + 1) * T;
      p.vy = 0; return;
    }
  }
}

function burst(x, y, color, n, speed = 200) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = speed * (0.4 + Math.random() * 0.8);
    game.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 100, life: 0.6 + Math.random() * 0.4, color });
  }
}

function die() {
  game.state = 'dead'; game.timer = 0.9; game.deaths++; game.shake = 12;
  burst(p.x + p.w / 2, p.y + p.h / 2, '#e8742a', 24, 260);
  sfx.die();
}

function step(dt) {
  // horizontal
  const dir = (right() ? 1 : 0) - (left() ? 1 : 0);
  const acc = p.onGround ? ACCEL : AIR_ACCEL;
  if (dir) { p.vx += dir * acc * dt; p.facing = dir; }
  else { const f = acc * dt; p.vx = Math.abs(p.vx) <= f ? 0 : p.vx - Math.sign(p.vx) * f; }
  p.vx = Math.max(-RUN, Math.min(RUN, p.vx));

  // jumping with coyote time + buffer
  p.coyote = p.onGround ? 0.1 : p.coyote - dt;
  p.buffer -= dt;
  if (p.onGround) p.airJumps = 1;
  if (p.buffer > 0 && p.coyote > 0) {
    p.vy = -JUMP_V; p.buffer = 0; p.coyote = 0; sfx.jump();
    burst(p.x + p.w / 2, p.y + p.h, '#f4e6c8', 6, 80);
  } else if (p.buffer > 0 && p.airJumps > 0) {
    p.vy = -JUMP_V * 0.9; p.buffer = 0; p.airJumps--; p.flip = 1; sfx.jump2();
    burst(p.x + p.w / 2, p.y + p.h, '#ffffff', 12, 140);
  }
  if (p.flip > 0) p.flip = Math.max(0, p.flip - dt * 3);
  let g = GRAVITY;
  if (p.vy < 0 && !jumpHeld()) g *= 2.6; // short hop when released
  p.vy = Math.min(MAX_FALL, p.vy + g * dt);

  p.x += p.vx * dt; collide('x');
  p.onGround = false;
  p.y += p.vy * dt; collide('y');
  if (p.onGround && Math.abs(p.vx) > 10) p.anim += dt * Math.abs(p.vx) / 25;
}

function update(dt) {
  game.time += dt;
  if (game.state === 'title' || game.state === 'win') {
    if (pressed.Enter || pressed.Space) {
      game.totalCoins = 0; game.deaths = 0; loadLevel(0);
    }
  } else if (game.state === 'play') {
    if (jumpPressed()) p.buffer = 0.12;
    const n = 4;
    for (let i = 0; i < n && game.state === 'play'; i++) step(dt / n);

    for (const c of game.coins) {
      if (!c.got && Math.hypot(c.x - (p.x + p.w / 2), c.y - (p.y + p.h / 2)) < 26) {
        c.got = true; sfx.coin(); burst(c.x, c.y, '#ffd34d', 10, 150);
      }
    }
    for (const e of game.enemies) {
      if (!e.alive) { e.squash -= dt; continue; }
      // patrol: turn around at walls and ledges
      const nx = e.x + e.dir * ENEMY_SPEED * dt;
      const front = e.dir > 0 ? nx + e.w : nx;
      const ftx = Math.floor(front / T), fty = Math.floor((e.y + e.h / 2) / T);
      const footY = Math.floor((e.y + e.h + 2) / T);
      if (solid(ftx, fty) || !solid(ftx, footY)) e.dir *= -1; else e.x = nx;
      // touch the fox
      if (p.x + p.w > e.x + 2 && p.x < e.x + e.w - 2 && p.y + p.h > e.y + 4 && p.y < e.y + e.h) {
        if (p.vy > 0 && p.y + p.h - e.y < 16) {
          e.alive = false; e.squash = 0.4;
          p.vy = -JUMP_V * 0.65; p.airJumps = 1;
          burst(e.x + e.w / 2, e.y + e.h / 2, '#8a5cc2', 14, 180); sfx.stomp(); game.shake = 5;
        } else { die(); break; }
      }
    }
    if (game.state === 'play') for (const s of game.spikes) {
      if (p.x + p.w > s.x + 8 && p.x < s.x + T - 8 && p.y + p.h > s.y + 16 && p.y < s.y + T) { die(); break; }
    }
    if (game.state === 'play' && p.y > game.gh * T + 60) die();
    if (game.state === 'play' && game.flag && p.x + p.w > game.flag.x - 6 && p.y + p.h > game.flag.y - 3 * T) {
      game.totalCoins += levelCoins();
      game.state = game.level === LEVELS.length - 1 ? 'win' : 'clear';
      game.timer = 1.8; sfx.win();
      burst(game.flag.x, game.flag.y - 2.5 * T, '#ff5a5a', 30, 250);
    }
  } else if (game.state === 'dead') {
    game.timer -= dt;
    if (game.timer <= 0) respawn();
  } else if (game.state === 'clear') {
    game.timer -= dt;
    if (game.timer <= 0) loadLevel(game.level + 1);
  }

  // camera
  const target = Math.max(0, Math.min(game.gw * T - W, p.x - W * 0.4));
  game.camX += (target - game.camX) * Math.min(1, dt * 8);
  game.shake *= 0.88;

  for (const q of game.particles) { q.vy += 900 * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.life -= dt; }
  game.particles = game.particles.filter(q => q.life > 0);
  for (const k in pressed) delete pressed[k];
}

// ---------- drawing ----------
function drawBackground(th) {
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, th.sky[0]); grad.addColorStop(1, th.sky[1]);
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  if (game.level === 2) { // dusk sun
    ctx.fillStyle = 'rgba(255,200,120,0.85)';
    ctx.beginPath(); ctx.arc(720 - game.camX * 0.05, 330, 70, 0, Math.PI * 2); ctx.fill();
  }
  // clouds
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  for (let i = 0; i < 6; i++) {
    const x = ((i * 260 - game.camX * 0.15 + game.time * 8) % 1560 + 1560) % 1560 - 200;
    const y = 50 + (i * 37) % 90;
    ctx.beginPath(); ctx.ellipse(x, y, 50, 16, 0, 0, Math.PI * 2); ctx.ellipse(x + 30, y - 10, 34, 16, 0, 0, Math.PI * 2); ctx.fill();
  }
  // hills
  const hill = (color, par, amp, base, freq) => {
    ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 16) {
      const wx = x + game.camX * par;
      ctx.lineTo(x, base - Math.sin(wx * freq) * amp - Math.sin(wx * freq * 2.3) * amp * 0.4);
    }
    ctx.lineTo(W, H); ctx.fill();
  };
  hill(th.hills2, 0.25, 40, 300, 0.006);
  hill(th.hills, 0.45, 30, 350, 0.009);
}

function drawTiles(th) {
  const x0 = Math.floor(game.camX / T), x1 = x0 + Math.ceil(W / T) + 1;
  for (let ty = 0; ty < game.gh; ty++) for (let tx = x0; tx <= x1; tx++) {
    if (tx >= game.gw || !game.grid[ty][tx]) continue;
    const x = tx * T, y = ty * T;
    ctx.fillStyle = th.dirt; ctx.fillRect(x, y, T, T);
    ctx.fillStyle = th.dirtDark;
    ctx.fillRect(x + ((tx * 7) % 3) * 10 + 6, y + 14 + ((tx + ty) % 2) * 10, 6, 6);
    ctx.fillRect(x + 24 - ((ty * 5) % 3) * 6, y + 28, 5, 5);
    if (!solid(tx, ty - 1) && ty > 0 || ty === 0) {
      ctx.fillStyle = th.grass; ctx.fillRect(x, y, T, 10);
      ctx.fillRect(x + 4, y + 10, 6, 4); ctx.fillRect(x + 22, y + 10, 8, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(x, y, T, 3);
    }
  }
}

function drawSpike(s) {
  ctx.fillStyle = '#9aa3b5'; ctx.strokeStyle = '#4b5263'; ctx.lineWidth = 2;
  for (let i = 0; i < 2; i++) {
    const bx = s.x + i * 20;
    ctx.beginPath(); ctx.moveTo(bx + 1, s.y + T); ctx.lineTo(bx + 10, s.y + 14); ctx.lineTo(bx + 19, s.y + T); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#d6dbe6'; ctx.beginPath(); ctx.moveTo(bx + 10, s.y + 16); ctx.lineTo(bx + 13, s.y + T - 2); ctx.lineTo(bx + 10, s.y + T - 2); ctx.fill();
    ctx.fillStyle = '#9aa3b5';
  }
}

function drawCoin(c) {
  const sx = Math.abs(Math.cos(game.time * 4 + c.x * 0.05));
  const bob = Math.sin(game.time * 3 + c.x) * 3;
  ctx.save(); ctx.translate(c.x, c.y + bob); ctx.scale(Math.max(0.15, sx), 1);
  ctx.fillStyle = '#c98a12'; ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffd34d'; ctx.beginPath(); ctx.arc(0, 0, 8.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff3b0'; ctx.fillRect(-2, -6, 3, 12);
  ctx.restore();
}

function drawFlag(f) {
  ctx.fillStyle = '#6b4a2e'; ctx.fillRect(f.x - 3, f.y - 3 * T, 6, 3 * T);
  ctx.fillStyle = '#ffd34d'; ctx.beginPath(); ctx.arc(f.x, f.y - 3 * T, 6, 0, Math.PI * 2); ctx.fill();
  const wave = Math.sin(game.time * 6) * 4;
  ctx.fillStyle = '#ff5a5a'; ctx.beginPath();
  ctx.moveTo(f.x + 3, f.y - 3 * T + 6); ctx.quadraticCurveTo(f.x + 25, f.y - 3 * T + 10 + wave, f.x + 46, f.y - 3 * T + 20 + wave);
  ctx.lineTo(f.x + 3, f.y - 3 * T + 36); ctx.fill();
}

function drawEnemy(e) {
  if (!e.alive && e.squash <= 0) return;
  ctx.save(); ctx.translate(e.x + e.w / 2, e.y + e.h);
  if (!e.alive) { ctx.scale(1.3, 0.3); ctx.globalAlpha = Math.max(0, e.squash / 0.4); }
  ctx.scale(e.dir, 1);
  const step = Math.sin(game.time * 14 + e.sx);
  ctx.strokeStyle = '#2b1d1a'; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath();
  for (const lx of [-8, 0, 8]) { ctx.moveTo(lx, -6); ctx.lineTo(lx + step * 3 * (lx === 0 ? -1 : 1), 0); }
  ctx.stroke();
  ctx.fillStyle = '#5b3a8c'; ctx.beginPath(); ctx.ellipse(-2, -12, 15, 11, 0, Math.PI, 0); ctx.lineTo(13, -6); ctx.lineTo(-17, -6); ctx.fill();
  ctx.strokeStyle = '#3d2563'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-2, -23); ctx.lineTo(-2, -7); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.beginPath(); ctx.ellipse(-8, -17, 4, 2.5, -0.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#2b1d1a'; ctx.beginPath(); ctx.arc(14, -10, 6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(16, -12, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#2b1d1a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(16, -15); ctx.quadraticCurveTo(20, -22, 24, -20); ctx.stroke();
  ctx.restore();
}

// ---------- fox sprite (auto-cropped to its visible pixels) ----------
const foxSprite = { img: null, sx: 0, sy: 0, sw: 0, sh: 0 };
{
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const cc = c.getContext('2d'); cc.drawImage(img, 0, 0);
    const d = cc.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    Object.assign(foxSprite, { img, sx: x0, sy: y0, sw: x1 - x0 + 1, sh: y1 - y0 + 1 });
  };
  img.src = 'assets/fox.png';
}
const FOX_H = 54; // drawn height in pixels

function drawFoxSprite() {
  const s = foxSprite;
  const dh = FOX_H, dw = dh * s.sw / s.sh;
  const moving = p.onGround && Math.abs(p.vx) > 10;
  const bob = moving ? -Math.abs(Math.sin(p.anim)) * 4 : 0;
  // squash & stretch: stretch while rising, squash on run steps
  let sxs = 1, sys = 1, tilt = 0;
  if (!p.onGround) { const k = Math.max(-1, Math.min(1, -p.vy / JUMP_V)); sys = 1 + k * 0.1; sxs = 1 - k * 0.06; tilt = -k * 0.18; }
  else if (moving) { const k = Math.sin(p.anim * 2) * 0.04; sys = 1 + k; sxs = 1 - k; tilt = Math.sin(p.anim) * 0.04; }
  else { sys = 1 + Math.sin(game.time * 3) * 0.015; }
  ctx.save();
  ctx.translate(p.x + p.w / 2, p.y + p.h + bob + 2);
  if (p.flip > 0) { ctx.translate(0, -dh / 2); ctx.rotate(-p.facing * (1 - p.flip) * Math.PI * 2); ctx.translate(0, dh / 2); }
  ctx.scale(p.facing * sxs, sys);
  ctx.rotate(tilt);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(s.img, s.sx, s.sy, s.sw, s.sh, -dw * 0.55, -dh, dw, dh);
  ctx.restore();
}

function drawFox() {
  if (foxSprite.img) return drawFoxSprite();
  const cx = p.x + p.w / 2, by = p.y + p.h;
  const moving = p.onGround && Math.abs(p.vx) > 10;
  const run = moving ? Math.sin(p.anim) : 0;
  const bounce = moving ? Math.abs(Math.sin(p.anim)) * -2 : 0;
  ctx.save(); ctx.translate(cx, by + bounce);
  if (p.flip > 0) { ctx.translate(0, -15); ctx.rotate(-p.facing * (1 - p.flip) * Math.PI * 2); ctx.translate(0, 15); }
  ctx.scale(p.facing, 1);
  const O = '#e8742a', D = '#b8541a', C = '#fbeedd', K = '#2b1d1a';
  // tail
  const tw = Math.sin(game.time * 8) * 0.15 + (p.onGround ? 0 : -0.3);
  ctx.save(); ctx.translate(-12, -14); ctx.rotate(-0.4 + tw);
  ctx.fillStyle = O; ctx.beginPath(); ctx.ellipse(-12, 0, 15, 7, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = C; ctx.beginPath(); ctx.ellipse(-23, 0, 6, 5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // legs
  ctx.strokeStyle = K; ctx.lineWidth = 4; ctx.lineCap = 'round';
  const legs = p.onGround ? [run * 5, -run * 5] : [6, -4];
  ctx.beginPath(); ctx.moveTo(-7, -8); ctx.lineTo(-7 + legs[0], -1); ctx.moveTo(7, -8); ctx.lineTo(7 + legs[1], -1); ctx.stroke();
  // body
  ctx.fillStyle = O; ctx.beginPath(); ctx.ellipse(0, -14, 14, 9, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = C; ctx.beginPath(); ctx.ellipse(3, -10, 8, 4.5, 0, 0, Math.PI * 2); ctx.fill();
  // head
  ctx.fillStyle = O; ctx.beginPath(); ctx.arc(12, -26, 9, 0, Math.PI * 2); ctx.fill();
  // ears
  ctx.fillStyle = D;
  ctx.beginPath(); ctx.moveTo(6, -31); ctx.lineTo(7, -42); ctx.lineTo(13, -33); ctx.fill();
  ctx.beginPath(); ctx.moveTo(12, -33); ctx.lineTo(17, -42); ctx.lineTo(19, -30); ctx.fill();
  // snout
  ctx.fillStyle = C; ctx.beginPath(); ctx.moveTo(14, -27); ctx.lineTo(27, -23); ctx.lineTo(14, -19); ctx.closePath(); ctx.fill();
  ctx.fillStyle = K; ctx.beginPath(); ctx.arc(26, -23, 2.2, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(15, -28, 1.8, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function text(str, x, y, size, color = '#fff', align = 'center') {
  ctx.font = `bold ${size}px "Trebuchet MS", sans-serif`; ctx.textAlign = align;
  ctx.lineWidth = Math.max(3, size / 6); ctx.strokeStyle = 'rgba(30,20,40,0.85)';
  ctx.strokeText(str, x, y); ctx.fillStyle = color; ctx.fillText(str, x, y);
}

function draw() {
  const th = LEVELS[game.level].theme;
  drawBackground(th);
  ctx.save();
  const sh = game.shake;
  ctx.translate(-Math.round(game.camX) + (Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);
  drawTiles(th);
  game.spikes.forEach(drawSpike);
  if (game.flag) drawFlag(game.flag);
  game.coins.forEach(c => { if (!c.got) drawCoin(c); });
  game.enemies.forEach(drawEnemy);
  if (game.state !== 'dead' && game.state !== 'title') drawFox();
  for (const q of game.particles) { ctx.globalAlpha = Math.min(1, q.life * 2); ctx.fillStyle = q.color; ctx.fillRect(q.x - 3, q.y - 3, 6, 6); }
  ctx.globalAlpha = 1;
  ctx.restore();

  if (game.state === 'title') {
    ctx.fillStyle = 'rgba(20,10,30,0.45)'; ctx.fillRect(0, 0, W, H);
    text('FOX RUN', W / 2, 170, 72, '#ffb35a');
    text('Collect coins, dodge spikes, reach the flag!', W / 2, 230, 24);
    text(isTouch ? 'Arrow buttons to move    JUMP to jump (tap twice to double jump)' : '← → / A D  move     Space / ↑ / W  jump (twice to double jump)', W / 2, 280, 20, '#ffe9c4');
    if (Math.floor(game.time * 2) % 2 === 0) text(isTouch ? 'Tap to start' : 'Press Enter to start', W / 2, 350, 28, '#ffd34d');
    return;
  }
  // HUD
  text(`Level ${game.level + 1}/3 · ${LEVELS[game.level].name}`, 20, 36, 22, '#fff', 'left');
  text(`● ${levelCoins()}/${game.coins.length}`, W / 2, 36, 24, '#ffd34d');
  text(`Total ${game.totalCoins}   Deaths ${game.deaths}`, W - 20, 36, 22, '#fff', 'right');

  if (game.state === 'clear') text('Level Clear!', W / 2, H / 2, 56, '#ffd34d');
  if (game.state === 'win') {
    ctx.fillStyle = 'rgba(20,10,30,0.5)'; ctx.fillRect(0, 0, W, H);
    const all = LEVELS.reduce((n, L) => n + L.map.join('').split('o').length - 1, 0);
    text('You Win!', W / 2, 170, 72, '#ffb35a');
    text(`Coins: ${game.totalCoins} / ${all}     Deaths: ${game.deaths}`, W / 2, 240, 28);
    if (Math.floor(game.time * 2) % 2 === 0) text(isTouch ? 'Tap to play again' : 'Press Enter to play again', W / 2, 320, 26, '#ffd34d');
  }
}

// ---------- loop ----------
loadLevel(0);
game.state = 'title';
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.033, (now - last) / 1000); last = now;
  update(dt); draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
