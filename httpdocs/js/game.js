/* ==========================================================================
   Cave Jump
   A small procedurally-generated cave endless-runner. No dependencies.
   ========================================================================== */

(() => {
  "use strict";

  // ------------------------------------------------------------------ //
  // Config / constants
  // ------------------------------------------------------------------ //

  const GAME_W = 960;
  const GAME_H = 480;
  const GROUND_Y = 400;          // baseline feet level
  const CEIL_Y = 60;             // cave roof surface

  const GRAVITY = 2600;          // px/s^2
  const JUMP_VY = -900;          // px/s impulse
  const FASTFALL_ACCEL = 3200;   // extra px/s^2 while holding down in the air

  const PLAYER_X = 150;          // fixed screen x
  const STAND_W = 30, STAND_H = 68;
  const DUCK_W = 40, DUCK_H = 32;

  const CLIMB_RATE_CAP = 150;    // px/s of *world* travel per px of climb height (ramp shallowness)
  const CLIMB_TOLERANCE = 10;    // px of slack before a missed climb counts as a hit

  const START_SPEED = 300;       // px/s
  const MAX_SPEED = 620;
  const SPEED_RAMP = 3.1;        // px/s gained per second survived

  const INVULN_TIME = 1.2;       // seconds of invulnerability after a hit
  const MAX_LIVES = 5;
  const START_LIVES = 3;

  const HIGH_SCORE_KEY = "caveJumpHighScore";

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // ------------------------------------------------------------------ //
  // Art assets (Crystal Caves tileset)
  // ------------------------------------------------------------------ //

  const IMAGE_PATHS = {
    bgFar: "assets/bg-far.png",
    bgNear: "assets/bg-near.png",
    ground: "assets/ground.png",
    spikeCrystal: "assets/spike-crystal.png",
    spikeStone: "assets/spike-stone.png",
    spikeBasic: "assets/spike-basic.png",
    gem: "assets/gem.png",
    heart: "assets/heart.png",
    rockpile: "assets/rockpile.png",
    rockSmall1: "assets/rock-small-1.png",
    rockSmall2: "assets/rock-small-2.png",
  };

  const FRAME_SET_PATHS = {
    batA: [0, 1, 2, 3, 4, 5].map((i) => `assets/monsters/bat-a/f${i}.png`),
    batB: [0, 1, 2, 3, 4, 5].map((i) => `assets/monsters/bat-b/f${i}.png`),
    crawler: [0, 1, 2, 3, 4, 5].map((i) => `assets/monsters/crawler/f${i}.png`),
    dangler: [0, 1, 2, 3, 4, 5].map((i) => `assets/monsters/dangler/f${i}.png`),
  };

  const Assets = { images: {}, frames: {}, ready: null };
  Assets.ready = Promise.all([
    ...Object.entries(IMAGE_PATHS).map(
      ([key, src]) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve();
          img.onerror = () => resolve(); // degrade gracefully rather than block the game
          img.src = src;
          Assets.images[key] = img;
        })
    ),
    ...Object.entries(FRAME_SET_PATHS).map(([key, paths]) => {
      Assets.frames[key] = paths.map(() => null);
      return Promise.all(
        paths.map(
          (src, i) =>
            new Promise((resolve) => {
              const img = new Image();
              img.onload = () => resolve();
              img.onerror = () => resolve();
              img.src = src;
              Assets.frames[key][i] = img;
            })
        )
      );
    }),
  ]);

  function drawAnimFrame(ctx, key, t, fps, x, y, w, flip) {
    const frames = Assets.frames[key];
    const frame = frames && frames[Math.floor(t * fps) % frames.length];
    if (!frame || !frame.naturalWidth) return false;
    const h = w * (frame.naturalHeight / frame.naturalWidth);
    ctx.save();
    ctx.translate(x, y);
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(frame, -w / 2, -h / 2, w, h);
    ctx.restore();
    return true;
  }

  // ------------------------------------------------------------------ //
  // DOM references
  // ------------------------------------------------------------------ //

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  const scoreEl = document.getElementById("score");
  const highscoreEl = document.getElementById("highscore");
  const livesEl = document.getElementById("lives");
  const muteBtn = document.getElementById("muteBtn");

  const startOverlay = document.getElementById("startOverlay");
  const pauseOverlay = document.getElementById("pauseOverlay");
  const gameOverOverlay = document.getElementById("gameOverOverlay");
  const startBtn = document.getElementById("startBtn");
  const resumeBtn = document.getElementById("resumeBtn");
  const restartBtn = document.getElementById("restartBtn");
  const finalScoreEl = document.getElementById("finalScore");
  const finalHighEl = document.getElementById("finalHigh");
  const gameOverMsg = document.getElementById("gameOverMsg");

  const touchJumpBtn = document.getElementById("touchJump");
  const touchDuckBtn = document.getElementById("touchDuck");

  const landingView = document.getElementById("landingView");
  const gameView = document.getElementById("gameView");
  const goToGameBtn = document.getElementById("goToGameBtn");
  const backToLandingBtn = document.getElementById("backToLanding");

  // ------------------------------------------------------------------ //
  // Canvas resize (crisp on high-DPI screens, fixed logical coord space)
  // ------------------------------------------------------------------ //

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const scale = (rect.width / GAME_W) * dpr;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }
  window.addEventListener("resize", resizeCanvas);

  // ------------------------------------------------------------------ //
  // Sound (tiny WebAudio beeps, no assets)
  // ------------------------------------------------------------------ //

  class SoundManager {
    constructor() {
      this.ctx = null;
      this.muted = false;
    }
    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.ctx = new AC();
      }
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    }
    tone(freq, dur, type = "square", gain = 0.06, delay = 0) {
      if (this.muted) return;
      this.ensure();
      if (!this.ctx) return;
      const t0 = this.ctx.currentTime + delay;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      osc.connect(g).connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }
    jump() { this.tone(520, 0.12, "square", 0.05); this.tone(760, 0.08, "square", 0.04, 0.05); }
    duck() { this.tone(180, 0.08, "sine", 0.04); }
    gem() { this.tone(880, 0.08, "square", 0.05); this.tone(1320, 0.1, "square", 0.05, 0.06); }
    heart() { this.tone(660, 0.1, "sine", 0.05); this.tone(990, 0.14, "sine", 0.05, 0.08); }
    hit() { this.tone(140, 0.25, "sawtooth", 0.08); this.tone(90, 0.3, "sawtooth", 0.07, 0.05); }
    gameover() { this.tone(220, 0.2, "sawtooth", 0.07); this.tone(160, 0.2, "sawtooth", 0.07, 0.15); this.tone(100, 0.35, "sawtooth", 0.07, 0.3); }
  }
  const sound = new SoundManager();

  // ------------------------------------------------------------------ //
  // Input
  // ------------------------------------------------------------------ //

  const keys = { up: false, down: false };
  let jumpPressedEdge = false;

  function onKeyDown(e) {
    if (["ArrowUp", "KeyW", "Space"].includes(e.code)) {
      if (!keys.up) jumpPressedEdge = true;
      keys.up = true;
      e.preventDefault();
    } else if (["ArrowDown", "KeyS"].includes(e.code)) {
      keys.down = true;
      e.preventDefault();
    } else if (e.code === "KeyP" || e.code === "Escape") {
      game.togglePause();
    }
  }
  function onKeyUp(e) {
    if (["ArrowUp", "KeyW", "Space"].includes(e.code)) keys.up = false;
    else if (["ArrowDown", "KeyS"].includes(e.code)) keys.down = false;
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  function bindHold(el, onDown, onUp) {
    if (!el) return;
    const down = (e) => { e.preventDefault(); onDown(); };
    const up = (e) => { e.preventDefault(); onUp(); };
    el.addEventListener("touchstart", down, { passive: false });
    el.addEventListener("touchend", up, { passive: false });
    el.addEventListener("touchcancel", up, { passive: false });
    el.addEventListener("mousedown", down);
    el.addEventListener("mouseup", up);
    el.addEventListener("mouseleave", up);
  }
  bindHold(touchJumpBtn, () => { if (!keys.up) jumpPressedEdge = true; keys.up = true; }, () => { keys.up = false; });
  bindHold(touchDuckBtn, () => { keys.down = true; }, () => { keys.down = false; });

  canvas.addEventListener("pointerdown", () => {
    canvas.focus();
    if (!keys.up) jumpPressedEdge = true;
    keys.up = true;
  });
  canvas.addEventListener("pointerup", () => { keys.up = false; });

  // ------------------------------------------------------------------ //
  // Particles
  // ------------------------------------------------------------------ //

  class Particles {
    constructor() { this.list = []; }
    burst(x, y, count, opts = {}) {
      for (let i = 0; i < count; i++) {
        this.list.push({
          x, y,
          vx: rand(opts.vxMin ?? -60, opts.vxMax ?? 60),
          vy: rand(opts.vyMin ?? -140, opts.vyMax ?? -20),
          life: rand(0.3, opts.lifeMax ?? 0.6),
          age: 0,
          size: rand(opts.sizeMin ?? 2, opts.sizeMax ?? 4),
          color: opts.color || "#c9b8de",
        });
      }
    }
    update(dt) {
      for (let i = this.list.length - 1; i >= 0; i--) {
        const p = this.list[i];
        p.age += dt;
        if (p.age >= p.life) { this.list.splice(i, 1); continue; }
        p.vy += 500 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
    }
    draw(ctx) {
      for (const p of this.list) {
        const a = 1 - p.age / p.life;
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
      ctx.globalAlpha = 1;
    }
  }

  // ------------------------------------------------------------------ //
  // Parallax background
  // ------------------------------------------------------------------ //

  class Background {
    constructor() {
      this.offsets = [0, 0];
      this.flicker = 0;
    }
    update(dt, speed) {
      this.flicker += dt;
      const far = Assets.images.bgFar;
      const near = Assets.images.bgNear;
      if (far && far.naturalWidth) {
        const w = far.naturalWidth * (GAME_H / far.naturalHeight);
        this.offsets[0] = (this.offsets[0] + speed * 0.12 * dt) % w;
      }
      if (near && near.naturalWidth) {
        const w = near.naturalWidth * (GAME_H / near.naturalHeight);
        this.offsets[1] = (this.offsets[1] + speed * 0.32 * dt) % w;
      }
    }
    drawTiled(ctx, img, offset) {
      if (!img || !img.naturalWidth) return;
      const scale = GAME_H / img.naturalHeight;
      const w = img.naturalWidth * scale;
      let startX = -offset - w;
      for (let x = startX; x < GAME_W + w; x += w) {
        ctx.drawImage(img, x, 0, w, GAME_H);
      }
    }
    draw(ctx) {
      // cave void base (shows through any gaps while images load)
      const g = ctx.createLinearGradient(0, 0, 0, GAME_H);
      g.addColorStop(0, "#171233");
      g.addColorStop(0.5, "#181136");
      g.addColorStop(1, "#0e0a22");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, GAME_W, GAME_H);

      this.drawTiled(ctx, Assets.images.bgFar, this.offsets[0]);
      this.drawTiled(ctx, Assets.images.bgNear, this.offsets[1]);

      // ambient dust motes
      ctx.fillStyle = "rgba(255,255,255,0.05)";
      for (let i = 0; i < 18; i++) {
        const mx = (i * 137.5 + this.flicker * 12) % GAME_W;
        const my = (i * 53.7) % (GROUND_Y - CEIL_Y) + CEIL_Y;
        ctx.beginPath();
        ctx.arc(mx, my, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ------------------------------------------------------------------ //
  // Terrain (ground height modifiers: rock walls to climb, pits to fall in)
  // ------------------------------------------------------------------ //

  // A terrain feature exposes: xLeft, xRight, heightAt(worldX) -> offset above GROUND_Y (0 = flat)
  // and requiresClimb(worldX) -> true if the player must be actively climbing there.

  class RockWall {
    constructor(x, speed) {
      this.type = "rockwall";
      this.climbHeight = rand(70, 110);
      this.rampUp = Math.max(140, (this.climbHeight * speed) / CLIMB_RATE_CAP);
      this.plateau = rand(70, 130);
      this.rampDown = this.rampUp * rand(0.7, 0.9);
      this.x = x; // left edge (world space, decreases over time)
      this.width = this.rampUp + this.plateau + this.rampDown;
      this.hitFlagged = false;
      this.passed = false;
    }
    get xRight() { return this.x + this.width; }
    heightAt(worldX) {
      const lx = worldX - this.x;
      if (lx < 0 || lx > this.width) return 0;
      if (lx < this.rampUp) return (lx / this.rampUp) * this.climbHeight;
      if (lx < this.rampUp + this.plateau) return this.climbHeight;
      const dx = lx - this.rampUp - this.plateau;
      return this.climbHeight * (1 - dx / this.rampDown);
    }
    inAscendZone(worldX) {
      const lx = worldX - this.x;
      return lx >= 0 && lx < this.rampUp;
    }
    update(dt, speed) { this.x -= speed * dt; }
    offscreen() { return this.xRight < -20; }
    draw(ctx) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(this.x, GROUND_Y + 2);
      const steps = 24;
      for (let i = 0; i <= steps; i++) {
        const lx = (this.width * i) / steps;
        ctx.lineTo(this.x + lx, GROUND_Y - this.heightAt(this.x + lx));
      }
      ctx.lineTo(this.xRight, GROUND_Y + 2);
      ctx.closePath();

      const tex = Assets.images.rockpile;
      if (tex && tex.naturalWidth) {
        ctx.clip();
        const topY = GROUND_Y - this.climbHeight - 14;
        const h = GROUND_Y - topY;
        for (let x = this.x - 20; x < this.xRight + 20; x += h * (tex.naturalWidth / tex.naturalHeight)) {
          ctx.drawImage(tex, x, topY, h * (tex.naturalWidth / tex.naturalHeight), h);
        }
      } else {
        ctx.fillStyle = "#3a2c46";
        ctx.fill();
      }
      ctx.restore();

      ctx.strokeStyle = "#5a4568";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(this.x, GROUND_Y + 2);
      for (let i = 0; i <= steps; i++) {
        const lx = (this.width * i) / steps;
        ctx.lineTo(this.x + lx, GROUND_Y - this.heightAt(this.x + lx));
      }
      ctx.lineTo(this.xRight, GROUND_Y + 2);
      ctx.stroke();

      // handholds
      ctx.fillStyle = "#ffe08a";
      ctx.globalAlpha = 0.8;
      for (let i = 0; i < 6; i++) {
        const lx = this.rampUp * ((i + 0.5) / 6);
        const hx = this.x + lx;
        const hy = GROUND_Y - this.heightAt(hx) + 8;
        ctx.beginPath();
        ctx.arc(hx, hy, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  class Pit {
    constructor(x, width) {
      this.type = "pit";
      this.x = x;
      this.width = width;
      this.passed = false;
    }
    get xRight() { return this.x + this.width; }
    update(dt, speed) { this.x -= speed * dt; }
    offscreen() { return this.xRight < -20; }
    draw(ctx) {
      ctx.fillStyle = "#050308";
      ctx.fillRect(this.x, GROUND_Y, this.width, GAME_H - GROUND_Y);

      const rocks = [Assets.images.rockSmall1, Assets.images.rockSmall2];
      for (const [edge, dir] of [[this.x, -1], [this.xRight, 1]]) {
        const r = rocks[(edge | 0) % 2];
        if (!r || !r.naturalWidth) continue;
        const size = 22;
        for (let i = 0; i < 3; i++) {
          const rx = edge + dir * (6 + i * 12) - size / 2;
          const ry = GROUND_Y - 4 - (i % 2) * 6;
          ctx.drawImage(r, rx, ry, size, size);
        }
      }
    }
  }

  // ------------------------------------------------------------------ //
  // Player
  // ------------------------------------------------------------------ //

  const PSTATE = { RUN: "run", JUMP: "jump", DUCK: "duck", CLIMB: "climb", HIT: "hit" };

  class Player {
    constructor() {
      this.reset();
    }
    reset() {
      this.y = GROUND_Y; // feet position
      this.vy = 0;
      this.grounded = true;
      this.state = PSTATE.RUN;
      this.animT = 0;
      this.invuln = 0;
      this.headlampFlicker = 0;
    }
    get rect() {
      const ducking = this.state === PSTATE.DUCK;
      const w = ducking ? DUCK_W : STAND_W;
      const h = ducking ? DUCK_H : STAND_H;
      return { x: PLAYER_X - w / 2, y: this.y - h, w, h };
    }
    update(dt, terrainGroundYFn) {
      this.animT += dt;
      this.headlampFlicker += dt;

      if (this.invuln > 0) this.invuln = Math.max(0, this.invuln - dt);

      const groundHere = terrainGroundYFn(PLAYER_X); // absolute Y of ground at player's x
      const wantsDuck = keys.down && this.grounded;

      if (jumpPressedEdge && this.grounded && !wantsDuck) {
        this.vy = JUMP_VY;
        this.grounded = false;
        sound.jump();
      }
      jumpPressedEdge = false;

      if (!this.grounded) {
        let g = GRAVITY;
        if (keys.down && this.vy > 0) g += FASTFALL_ACCEL;
        this.vy += g * dt;
        this.y += this.vy * dt;
        if (this.y >= groundHere && this.vy >= 0) {
          this.y = groundHere;
          this.vy = 0;
          this.grounded = true;
        }
      } else {
        // follow terrain height smoothly when grounded
        this.y = groundHere;
      }

      if (this.grounded) {
        this.state = wantsDuck ? PSTATE.DUCK : PSTATE.RUN;
      } else {
        this.state = PSTATE.JUMP;
      }
    }
    hit() {
      if (this.invuln > 0) return false;
      this.invuln = INVULN_TIME;
      sound.hit();
      return true;
    }
    draw(ctx) {
      const flashOff = this.invuln > 0 && Math.floor(this.invuln * 14) % 2 === 0;
      if (flashOff) return;

      ctx.save();
      ctx.translate(PLAYER_X, this.y);

      // headlamp glow
      const flick = 0.85 + Math.sin(this.headlampFlicker * 18) * 0.08;
      const beamLen = 130;
      const grad = ctx.createRadialGradient(18, -40, 4, 18, -40, beamLen);
      grad.addColorStop(0, `rgba(255,230,150,${0.35 * flick})`);
      grad.addColorStop(1, "rgba(255,230,150,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(18, -40, beamLen, 0, Math.PI * 2);
      ctx.fill();

      const ducking = this.state === PSTATE.DUCK;
      const jumping = this.state === PSTATE.JUMP;
      const bob = ducking || jumping ? 0 : Math.sin(this.animT * 16) * 3;
      const legSwing = Math.sin(this.animT * 16);

      ctx.strokeStyle = "#e8c9a0";
      ctx.lineCap = "round";
      ctx.lineWidth = 5;

      if (ducking) {
        // crouched crawling pose
        ctx.fillStyle = "#8a5a3b";
        ctx.beginPath();
        ctx.ellipse(0, -18, 20, 12, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#c98a52";
        ctx.beginPath();
        ctx.arc(16, -22, 8, 0, Math.PI * 2);
        ctx.fill();
        // crawling limbs
        const swing = Math.sin(this.animT * 20) * 6;
        ctx.beginPath();
        ctx.moveTo(-14, -10); ctx.lineTo(-14 - swing, -2);
        ctx.moveTo(10, -10); ctx.lineTo(10 + swing, -2);
        ctx.stroke();
      } else {
        // torso
        ctx.fillStyle = "#8a5a3b";
        ctx.beginPath();
        ctx.moveTo(-9, -30 + bob);
        ctx.lineTo(9, -30 + bob);
        ctx.lineTo(7, -2 + bob);
        ctx.lineTo(-7, -2 + bob);
        ctx.closePath();
        ctx.fill();

        // head + helmet
        ctx.fillStyle = "#c98a52";
        ctx.beginPath();
        ctx.arc(0, -42 + bob, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#3d6b52";
        ctx.beginPath();
        ctx.arc(0, -44 + bob, 10.5, Math.PI, 0);
        ctx.fill();
        ctx.fillStyle = "#ffe08a";
        ctx.beginPath();
        ctx.arc(6, -43 + bob, 2.6, 0, Math.PI * 2);
        ctx.fill();

        // legs
        ctx.strokeStyle = "#3d3050";
        ctx.lineWidth = 6;
        const runCycle = jumping ? 0.6 : legSwing;
        ctx.beginPath();
        ctx.moveTo(-3, -2 + bob); ctx.lineTo(-3 + runCycle * 12, 22);
        ctx.moveTo(3, -2 + bob); ctx.lineTo(3 - runCycle * 12, 22);
        ctx.stroke();

        // arms
        ctx.strokeStyle = "#c98a52";
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(-6, -26 + bob); ctx.lineTo(-6 - runCycle * 10, -8 + bob);
        ctx.moveTo(6, -26 + bob); ctx.lineTo(6 + runCycle * 10, -8 + bob);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  // ------------------------------------------------------------------ //
  // Obstacles & creatures
  // ------------------------------------------------------------------ //

  function pickSpikeImg() {
    return pick(["spikeCrystal", "spikeStone", "spikeBasic"]);
  }

  class Stalagmite {
    constructor(x, speed) {
      this.type = "stalagmite";
      this.x = x;
      this.w = rand(30, 44);
      this.h = rand(46, 72);
      this.speed = speed;
      this.imgKey = pickSpikeImg();
      this.dead = false;
    }
    get rect() {
      const hitW = this.w * 0.7, hitH = this.h * 0.85;
      return { x: this.x - hitW / 2, y: GROUND_Y - hitH, w: hitW, h: hitH };
    }
    update(dt, speed) { this.x -= speed * dt; }
    offscreen() { return this.x + this.w < -20; }
    draw(ctx) {
      const img = Assets.images[this.imgKey];
      if (img && img.naturalWidth) {
        const drawH = this.h;
        const drawW = this.w;
        ctx.drawImage(img, this.x - drawW / 2, GROUND_Y - drawH, drawW, drawH);
      } else {
        const r = this.rect;
        ctx.fillStyle = "#6b5480";
        ctx.beginPath();
        ctx.moveTo(r.x, r.y + r.h);
        ctx.lineTo(r.x + r.w / 2, r.y);
        ctx.lineTo(r.x + r.w, r.y + r.h);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  class Stalactite {
    constructor(x) {
      this.type = "stalactite";
      this.x = x;
      this.w = rand(32, 46);
      this.bottom = rand(336, 356);
      this.imgKey = pickSpikeImg();
      this.dead = false;
    }
    get rect() {
      const h = this.bottom - CEIL_Y;
      const hitW = this.w * 0.7, hitH = h * 0.85;
      return { x: this.x - hitW / 2, y: CEIL_Y + (h - hitH), w: hitW, h: hitH };
    }
    update(dt, speed) { this.x -= speed * dt; }
    offscreen() { return this.x + this.w < -20; }
    draw(ctx) {
      const img = Assets.images[this.imgKey];
      const totalH = this.bottom - CEIL_Y;
      if (img && img.naturalWidth) {
        // Draw the (short, stubby) sprite near-native-aspect at the tip, and a
        // thin tapered rock root joining it to the ceiling -- stretching the
        // whole sprite over the full ceiling-to-tip span would distort it badly.
        const tipH = clamp(this.w * (img.naturalHeight / img.naturalWidth) * 1.2, 55, 100);
        const rootH = Math.max(0, totalH - tipH);
        if (rootH > 0) {
          ctx.fillStyle = "#332950";
          ctx.beginPath();
          ctx.moveTo(this.x - this.w * 0.42, CEIL_Y);
          ctx.lineTo(this.x + this.w * 0.42, CEIL_Y);
          ctx.lineTo(this.x + this.w * 0.16, CEIL_Y + rootH);
          ctx.lineTo(this.x - this.w * 0.16, CEIL_Y + rootH);
          ctx.closePath();
          ctx.fill();
        }
        ctx.save();
        ctx.translate(this.x, CEIL_Y + rootH + tipH / 2);
        ctx.scale(1, -1);
        ctx.drawImage(img, -this.w / 2, -tipH / 2, this.w, tipH);
        ctx.restore();
      } else {
        ctx.fillStyle = "#6b5480";
        ctx.beginPath();
        ctx.moveTo(this.x - this.w / 2, CEIL_Y);
        ctx.lineTo(this.x, this.bottom);
        ctx.lineTo(this.x + this.w / 2, CEIL_Y);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  class GroundSpider {
    constructor(x) {
      this.type = "groundspider";
      this.x = x;
      this.w = 40;
      this.h = 24;
      this.t = rand(0, 10);
      this.dead = false;
    }
    get rect() { return { x: this.x - this.w / 2, y: GROUND_Y - this.h, w: this.w, h: this.h }; }
    update(dt, speed) { this.x -= speed * dt; this.t += dt; }
    offscreen() { return this.x + this.w < -20; }
    draw(ctx) {
      const drawn = drawAnimFrame(ctx, "crawler", this.t, 10, this.x, GROUND_Y - 16, 60, true);
      if (!drawn) {
        ctx.save();
        ctx.translate(this.x, GROUND_Y - this.h / 2);
        ctx.fillStyle = "#241a2e";
        ctx.beginPath();
        ctx.ellipse(0, -2, 14, 9, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  class HangingSpider {
    constructor(x) {
      this.type = "hangingspider";
      this.x = x;
      this.w = 26;
      this.bottom = rand(338, 352);
      this.sway = rand(0, 10);
      this.dead = false;
    }
    get rect() { return { x: this.x - this.w / 2, y: this.bottom - 22, w: this.w, h: 22 }; }
    update(dt, speed) { this.x -= speed * dt; this.sway += dt * 1.4; this.t = (this.t || 0) + dt; }
    offscreen() { return this.x + this.w < -20; }
    draw(ctx) {
      const sx = Math.sin(this.sway) * 6;
      const bodyY = this.bottom - 20;
      ctx.strokeStyle = "rgba(220,220,235,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.x, CEIL_Y);
      ctx.lineTo(this.x + sx, bodyY - 14);
      ctx.stroke();

      const drawn = drawAnimFrame(ctx, "dangler", this.t, 6, this.x + sx, bodyY, 40);
      if (!drawn) {
        ctx.save();
        ctx.translate(this.x + sx, bodyY);
        ctx.fillStyle = "#1a1520";
        ctx.beginPath();
        ctx.ellipse(0, 0, 9, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  class Bat {
    constructor(x, variant) {
      this.type = "bat";
      this.x = x;
      this.variant = variant; // 'duck' (mid height) or 'jump' (low height)
      this.baseY = variant === "duck" ? 316 : 366;
      this.amp = 10;
      this.t = rand(0, 10);
      this.w = 30;
      this.h = 18;
      this.frameSet = variant === "duck" ? "batA" : "batB";
      this.dead = false;
    }
    get y() { return this.baseY + Math.sin(this.t * 3) * this.amp; }
    get rect() { return { x: this.x - this.w / 2, y: this.y - this.h / 2, w: this.w, h: this.h }; }
    update(dt, speed) { this.x -= speed * dt; this.t += dt; }
    offscreen() { return this.x + this.w < -20; }
    draw(ctx) {
      const drawn = drawAnimFrame(ctx, this.frameSet, this.t, 12, this.x, this.y, 52, true);
      if (!drawn) {
        const flap = Math.sin(this.t * 22) * 12;
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.fillStyle = "#2a2038";
        ctx.beginPath();
        ctx.ellipse(0, 0, 6, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#2a2038";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.quadraticCurveTo(-14, -8 - flap, -22, -2 + flap * 0.3);
        ctx.moveTo(0, 0); ctx.quadraticCurveTo(14, -8 - flap, 22, -2 + flap * 0.3);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  class Gem {
    constructor(x, high) {
      this.type = "gem";
      this.x = x;
      this.y = high ? 230 : 382;
      this.w = 16; this.h = 16;
      this.t = rand(0, 10);
      this.dead = false;
      this.collected = false;
    }
    get rect() { return { x: this.x - this.w / 2, y: this.y - this.h / 2, w: this.w, h: this.h }; }
    update(dt, speed) { this.x -= speed * dt; this.t += dt; }
    offscreen() { return this.x + this.w < -20; }
    draw(ctx) {
      const bob = Math.sin(this.t * 4) * 4;
      const img = Assets.images.gem;
      const glow = 0.5 + Math.sin(this.t * 5) * 0.25;
      ctx.save();
      ctx.translate(this.x, this.y + bob);
      if (img && img.naturalWidth) {
        const glowGrad = ctx.createRadialGradient(0, 0, 2, 0, 0, 18);
        glowGrad.addColorStop(0, `rgba(200,170,255,${glow * 0.5})`);
        glowGrad.addColorStop(1, "rgba(200,170,255,0)");
        ctx.fillStyle = glowGrad;
        ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.fill();
        const s = 26;
        ctx.drawImage(img, -s / 2, -s / 2, s, s);
      } else {
        ctx.fillStyle = "#5be3c9";
        ctx.beginPath();
        ctx.moveTo(0, -8); ctx.lineTo(7, 0); ctx.lineTo(0, 8); ctx.lineTo(-7, 0);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  class HeartPickup {
    constructor(x) {
      this.type = "heart";
      this.x = x;
      this.y = 382;
      this.w = 18; this.h = 16;
      this.t = rand(0, 10);
      this.dead = false;
      this.collected = false;
    }
    get rect() { return { x: this.x - this.w / 2, y: this.y - this.h / 2, w: this.w, h: this.h }; }
    update(dt, speed) { this.x -= speed * dt; this.t += dt; }
    offscreen() { return this.x + this.w < -20; }
    draw(ctx) {
      const bob = Math.sin(this.t * 4) * 4;
      const img = Assets.images.heart;
      ctx.save();
      ctx.translate(this.x, this.y + bob);
      if (img && img.naturalWidth) {
        const s = 26;
        ctx.drawImage(img, -s / 2, -s / 2, s, s);
      } else {
        ctx.fillStyle = "#ff5c6a";
        ctx.beginPath();
        ctx.moveTo(0, 6);
        ctx.bezierCurveTo(-10, -4, -6, -10, 0, -3);
        ctx.bezierCurveTo(6, -10, 10, -4, 0, 6);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // ------------------------------------------------------------------ //
  // Spawner
  // ------------------------------------------------------------------ //

  class Spawner {
    constructor() {
      this.obstacles = [];   // stalagmite, stalactite, groundspider, hangingspider, bat
      this.terrain = [];     // rockwall, pit
      this.pickups = [];     // gem, heart
      this.nextSpawnX = GAME_W + 200;
      this.nextRockWallScore = 900;
      this.lastEdge = GAME_W + 200;
    }

    reset() {
      this.obstacles.length = 0;
      this.terrain.length = 0;
      this.pickups.length = 0;
      this.nextSpawnX = GAME_W + 300;
      this.nextRockWallScore = 900;
      this.lastEdge = GAME_W + 300;
    }

    difficultyTier(score) {
      if (score < 300) return 0;
      if (score < 900) return 1;
      if (score < 2000) return 2;
      return 3;
    }

    maybeSpawn(speed, score) {
      if (this.lastEdge > GAME_W) return; // still plenty queued off-screen ahead
      const tier = this.difficultyTier(score);
      const minGap = speed * rand(0.85, 1.1);
      const x = this.lastEdge + minGap;

      let width = 34;
      const roll = Math.random();

      if (tier >= 3 && score > this.nextRockWallScore) {
        const rw = new RockWall(x, speed);
        this.terrain.push(rw);
        width = rw.width;
        this.nextRockWallScore = score + rand(1400, 2200);
      } else if (tier >= 1 && roll < 0.12) {
        const pitW = clamp(speed * 0.62, 70, 150);
        this.terrain.push(new Pit(x, pitW));
        width = pitW;
      } else {
        const choices = ["stalagmite", "stalactite"];
        if (tier >= 1) choices.push("groundspider", "bat-duck");
        if (tier >= 2) choices.push("hangingspider", "bat-jump");
        const kind = pick(choices);
        switch (kind) {
          case "stalagmite": { const o = new Stalagmite(x, speed); this.obstacles.push(o); width = o.w; break; }
          case "stalactite": { const o = new Stalactite(x); this.obstacles.push(o); width = o.w; break; }
          case "groundspider": { const o = new GroundSpider(x); this.obstacles.push(o); width = o.w; break; }
          case "hangingspider": { const o = new HangingSpider(x); this.obstacles.push(o); width = o.w; break; }
          case "bat-duck": { const o = new Bat(x, "duck"); this.obstacles.push(o); width = o.w; break; }
          case "bat-jump": { const o = new Bat(x, "jump"); this.obstacles.push(o); width = o.w; break; }
        }
      }

      // occasional pickup, offset so it doesn't overlap the obstacle we just placed
      if (Math.random() < 0.5) {
        const gx = x + width + rand(60, 140);
        if (Math.random() < 0.12) this.pickups.push(new HeartPickup(gx));
        else this.pickups.push(new Gem(gx, Math.random() < 0.4));
      }

      this.lastEdge = x + width + rand(40, 120);
    }

    update(dt, speed, score) {
      this.maybeSpawn(speed, score);
      this.lastEdge -= speed * dt;

      for (const list of [this.obstacles, this.terrain, this.pickups]) {
        for (const o of list) o.update(dt, speed);
      }
      this.obstacles = this.obstacles.filter((o) => !o.offscreen());
      this.terrain = this.terrain.filter((o) => !o.offscreen());
      this.pickups = this.pickups.filter((o) => !o.offscreen() && !o.collected);
    }

    groundYAt(worldX) {
      let best = GROUND_Y;
      for (const t of this.terrain) {
        if (t.type === "rockwall" && worldX >= t.x && worldX <= t.xRight) {
          best = Math.min(best, GROUND_Y - t.heightAt(worldX));
        } else if (t.type === "pit" && worldX >= t.x && worldX <= t.xRight) {
          best = Math.max(best, GAME_H + 200); // no floor
        }
      }
      return best;
    }

    activeAscendWall(worldX) {
      for (const t of this.terrain) {
        if (t.type === "rockwall" && t.inAscendZone(worldX)) return t;
      }
      return null;
    }

    activePit(worldX) {
      for (const t of this.terrain) {
        if (t.type === "pit" && worldX >= t.x && worldX <= t.xRight) return t;
      }
      return null;
    }

    draw(ctx) {
      for (const o of this.terrain) o.draw(ctx);
      for (const o of this.pickups) o.draw(ctx);
      for (const o of this.obstacles) o.draw(ctx);
    }
  }

  // ------------------------------------------------------------------ //
  // Game
  // ------------------------------------------------------------------ //

  const STATE = { START: "start", PLAYING: "playing", PAUSED: "paused", OVER: "over" };

  class Game {
    constructor() {
      this.state = STATE.START;
      this.player = new Player();
      this.bg = new Background();
      this.spawner = new Spawner();
      this.particles = new Particles();
      this.score = 0;
      this.highScore = Number(localStorage.getItem(HIGH_SCORE_KEY) || 0);
      this.lives = START_LIVES;
      this.speed = START_SPEED;
      this.shake = 0;
      this.groundScroll = 0;
      this.lastTime = performance.now();
      this.assetsReady = false;
      Assets.ready.then(() => {
        this.assetsReady = true;
        startBtn.disabled = false;
        startBtn.textContent = "Start Game";
      });
      startBtn.disabled = true;
      startBtn.textContent = "Loading…";
      this.gameOverMessages = [
        "The cave got the better of you this time.",
        "So close! The dark claims another explorer.",
        "Watch out for the next one's stalactites.",
        "A valiant descent. Try again?",
      ];
      highscoreEl.textContent = this.highScore;
      this.renderLives();
      this.bindUI();
      requestAnimationFrame(this.loop.bind(this));
    }

    bindUI() {
      startBtn.addEventListener("click", () => this.start());
      restartBtn.addEventListener("click", () => this.start());
      resumeBtn.addEventListener("click", () => this.togglePause());
      muteBtn.addEventListener("click", () => {
        sound.muted = !sound.muted;
        muteBtn.textContent = sound.muted ? "🔇" : "🔊";
      });
    }

    start() {
      this.player.reset();
      this.spawner.reset();
      this.score = 0;
      this.lives = START_LIVES;
      this.speed = START_SPEED;
      this.shake = 0;
      this.state = STATE.PLAYING;
      startOverlay.classList.add("hidden");
      gameOverOverlay.classList.add("hidden");
      pauseOverlay.classList.add("hidden");
      this.renderLives();
      sound.ensure();
      canvas.focus();
    }

    togglePause() {
      if (this.state === STATE.PLAYING) {
        this.state = STATE.PAUSED;
        pauseOverlay.classList.remove("hidden");
      } else if (this.state === STATE.PAUSED) {
        this.state = STATE.PLAYING;
        pauseOverlay.classList.add("hidden");
        this.lastTime = performance.now();
      }
    }

    renderLives() {
      livesEl.innerHTML = "";
      for (let i = 0; i < MAX_LIVES; i++) {
        const span = document.createElement("span");
        span.textContent = "❤";
        if (i >= this.lives) span.classList.add("heart-lost");
        livesEl.appendChild(span);
      }
    }

    loseLife() {
      this.lives -= 1;
      this.renderLives();
      this.shake = 0.35;
      if (this.lives <= 0) {
        this.gameOver();
      }
    }

    gameOver() {
      this.state = STATE.OVER;
      sound.gameover();
      const isNew = this.score > this.highScore;
      if (isNew) {
        this.highScore = Math.floor(this.score);
        localStorage.setItem(HIGH_SCORE_KEY, String(this.highScore));
      }
      finalScoreEl.textContent = Math.floor(this.score);
      finalHighEl.textContent = this.highScore;
      highscoreEl.textContent = this.highScore;
      gameOverMsg.textContent = isNew ? "New best! The cave has never been tamed like this." : pick(this.gameOverMessages);
      gameOverOverlay.classList.remove("hidden");
    }

    checkCollisions() {
      const p = this.player;
      const pr = p.rect;
      const inset = 5;
      const pRectTight = { x: pr.x + inset, y: pr.y + inset, w: pr.w - inset * 2, h: pr.h - inset * 2 };

      for (const o of this.spawner.obstacles) {
        if (o.dead) continue;
        if (overlap(pRectTight, o.rect)) {
          if (p.hit()) this.loseLife();
          this.particles.burst(PLAYER_X, p.y - 30, 10, { color: "#ff5c6a" });
        }
      }

      for (const o of this.spawner.pickups) {
        if (o.collected) continue;
        if (overlap(pr, o.rect)) {
          o.collected = true;
          if (o.type === "gem") {
            this.score += 25;
            sound.gem();
            this.particles.burst(o.x, o.y, 8, { color: "#c8aaff", lifeMax: 0.4 });
          } else if (o.type === "heart") {
            if (this.lives < MAX_LIVES) {
              this.lives += 1;
              this.renderLives();
            }
            sound.heart();
            this.particles.burst(o.x, o.y, 10, { color: "#ff5c6a", lifeMax: 0.5 });
          }
        }
      }
    }

    checkClimbFailure() {
      const p = this.player;
      if (!p.grounded) return;
      const wall = this.spawner.activeAscendWall(PLAYER_X);
      if (!wall) return;
      const requiredY = GROUND_Y - wall.heightAt(PLAYER_X);
      const behind = p.y - requiredY; // positive if player hasn't risen enough
      if (behind > CLIMB_TOLERANCE && !keys.up) {
        if (p.hit()) this.loseLife();
        this.particles.burst(PLAYER_X, p.y - 20, 8, { color: "#ff5c6a" });
      }
    }

    checkPitFall() {
      const p = this.player;
      if (p.y > GAME_H + 40) {
        if (p.hit()) this.loseLife();
        p.y = GROUND_Y;
        p.vy = 0;
        p.grounded = true;
        this.particles.burst(PLAYER_X, GROUND_Y, 14, { color: "#8a6aa8", lifeMax: 0.5 });
      }
    }

    update(dt) {
      if (this.state !== STATE.PLAYING) return;

      this.speed = Math.min(MAX_SPEED, this.speed + SPEED_RAMP * dt);
      this.score += this.speed * dt * 0.08;
      scoreEl.textContent = Math.floor(this.score);

      this.bg.update(dt, this.speed);
      this.groundScroll += this.speed * dt;
      this.spawner.update(dt, this.speed, this.score);

      const terrainFn = (x) => this.spawner.groundYAt(x);
      this.player.update(dt, terrainFn);

      this.checkClimbFailure();
      this.checkPitFall();
      this.checkCollisions();

      this.particles.update(dt);

      if (this.shake > 0) this.shake = Math.max(0, this.shake - dt);
    }

    drawGround(ctx) {
      const tex = Assets.images.ground;
      if (tex && tex.naturalWidth) {
        const tileW = 148;
        const drawH = GAME_H - (GROUND_Y - 6); // stretch to fill all the way to the canvas bottom, no seam
        const off = this.groundScroll % tileW;
        for (let x = -off - tileW; x < GAME_W + tileW; x += tileW) {
          ctx.drawImage(tex, x, GROUND_Y - 6, tileW + 1, drawH);
        }
      } else {
        ctx.fillStyle = "#0c0814";
        ctx.fillRect(0, GROUND_Y, GAME_W, GAME_H - GROUND_Y);
      }
    }

    draw() {
      ctx.save();
      if (this.shake > 0) {
        const s = this.shake * 10;
        ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
      }

      this.bg.draw(ctx);
      this.drawGround(ctx);
      this.spawner.draw(ctx);
      this.player.draw(ctx);
      this.particles.draw(ctx);

      // vignette
      const vg = ctx.createRadialGradient(GAME_W / 2, GAME_H / 2, GAME_H * 0.25, GAME_W / 2, GAME_H / 2, GAME_W * 0.65);
      vg.addColorStop(0, "rgba(0,0,0,0)");
      vg.addColorStop(1, "rgba(0,0,0,0.55)");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, GAME_W, GAME_H);

      ctx.restore();
    }

    loop(now) {
      let dt = (now - this.lastTime) / 1000;
      this.lastTime = now;
      dt = Math.min(dt, 1 / 20); // clamp for tab-switch stalls

      this.update(dt);
      this.draw();

      requestAnimationFrame(this.loop.bind(this));
    }
  }

  resizeCanvas();
  const game = new Game();

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && game.state === STATE.PLAYING) game.togglePause();
  });

  // ------------------------------------------------------------------ //
  // Landing page <-> game view toggle
  // ------------------------------------------------------------------ //

  if (goToGameBtn && landingView && gameView) {
    goToGameBtn.addEventListener("click", () => {
      landingView.hidden = true;
      gameView.hidden = false;
      window.scrollTo(0, 0);
      // The canvas was hidden (0x0) when first measured, so its draw scale
      // needs recomputing now that it actually has layout size.
      resizeCanvas();
      canvas.focus();
    });
  }

  if (backToLandingBtn && landingView && gameView) {
    backToLandingBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (game.state === STATE.PLAYING) game.togglePause();
      gameView.hidden = true;
      landingView.hidden = false;
      window.scrollTo(0, 0);
    });
  }
})();
