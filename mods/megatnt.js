'use strict';
// ============ mods/megatnt.js — TNT x2 / x5 / x10 / x25 / x50 ============
// Five stronger TNT blocks, each its own colour, lit with flint and steel like the real thing.
//
// WHY THEY ARE NOT JUST "power * 50"
// `World.explode` fires a FIXED shell of 1352 rays and marches each one until its intensity
// runs out, so the crater radius is about power/2 and the cost climbs with the volume. Measured
// on this machine, in solid stone:
//     power  4 ->  2 ms,    37 blocks, r 2.4      power 24 -> 18 ms,  3 972 blocks, r 12.4
//     power  8 ->  6 ms,   273 blocks, r 4.4      power 32 -> 37 ms,  7 930 blocks, r 16.3
//     power 16 ->  9 ms, 1 555 blocks, r 8.5      power 48 -> 55 ms, 17 200 blocks, r 24.4
// A literal x50 (power 200) would be a ~100 block radius, over a million blocks and a multi-
// second freeze — and because the ray count is fixed, the far edge would come out as swiss
// cheese rather than a crater. So a tier is instead a CLUSTER of ordinary blasts, fired a
// couple of frames apart: each one stays cheap and solid-looking, the crater is genuinely huge
// and irregular, and the blast visibly rolls outward instead of appearing all at once.
// Measured for x50 (14 blasts of power 19): 10-22 ms each, 52 563 blocks gone, crater radius 32.
//
// Multiplayer: the host owns every blast (same rule as Lucky Block). A guest lighting a fuse
// sends the position and tier to the host, which spawns the entity and runs the explosions;
// the blocks then reach everyone through the game's own host-authority block stream.

(function () {

// Mods take block ids from the top down — copper has 200, lucky block 199.
const TIERS = [
  { mult: 2,  id: 198, blasts: 1,  power: 8,  spread: 0,  body: [214, 106, 40],  cap: [140, 62, 20] },
  { mult: 5,  id: 197, blasts: 3,  power: 10, spread: 3,  body: [226, 194, 48],  cap: [150, 126, 24] },
  { mult: 10, id: 196, blasts: 5,  power: 13, spread: 6,  body: [86, 190, 78],   cap: [44, 122, 42] },
  { mult: 25, id: 195, blasts: 9,  power: 16, spread: 10, body: [70, 132, 224],  cap: [32, 76, 150] },
  { mult: 50, id: 194, blasts: 14, power: 19, spread: 15, body: [170, 78, 214],  cap: [104, 38, 140] },
];
const BY_BLOCK = {};   // block id -> tier
for (const t of TIERS) { t.name = 'tnt_x' + t.mult; t.label = 'TNT x' + t.mult; BY_BLOCK[t.id] = t; }

let hooked = false, on = false, texDone = false;
let queue = [];        // pending blasts, drained a couple of frames apart
let acc = 0;

// ---------- textures ----------
function uploadTile(slot) {
  const gl = Renderer.gl;
  if (!gl || !Renderer.atlasTex || slot == null) return;
  const [x, y] = Tex.slotXY(slot);
  gl.bindTexture(gl.TEXTURE_2D, Renderer.atlasTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, Tex.ctx.getImageData(x, y, 16, 16));
}
function shade(c, f) { return [Math.min(255, c[0] * f) | 0, Math.min(255, c[1] * f) | 0, Math.min(255, c[2] * f) | 0]; }

// the exact "TNT" pixel letters the game's own tnt_side uses, so these read as real TNT
const TNT_LETTERS = [
  [2, 0], [3, 0], [4, 0], [3, 1], [3, 2],                       // T
  [6, 0], [6, 1], [6, 2], [7, 1], [8, 0], [8, 1], [8, 2],       // N
  [10, 0], [11, 0], [12, 0], [11, 1], [11, 2],                  // T
];

function buildTextures() {
  if (texDone) return;
  texDone = true;
  const slots = [];
  for (const t of TIERS) {
    // Built the same way as the game's own tnt_side — mottled body, pale band across the
    // middle, TNT lettering on it. Only the body colour changes per tier, so a stack of these
    // still reads as TNT at a glance and the colour tells you how hard it hits.
    slots.push(Tex.reg(t.name + '_side', (s, r) => {
      mottle(s, r, [t.body, shade(t.body, 0.88), shade(t.body, 1.12)], 3, 0.4);
      for (let y = 6; y < 10; y++) for (let x = 0; x < 16; x++) {
        s(x, y, (y === 6 || y === 9) ? [200, 200, 200] : [227, 218, 209]);
      }
      for (const [x, y] of TNT_LETTERS) s(x + 1, y + 7, [50, 50, 50]);
    }));
    slots.push(Tex.reg(t.name + '_top', (s, r) => {
      mottle(s, r, [t.body, shade(t.body, 0.88), shade(t.body, 1.12)], 3, 0.4);
      for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) s(x, y, [227, 218, 209]);
      for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) s(x, y, [200, 190, 180]);
      s(7, 7, [60, 60, 60]); s(8, 7, [60, 60, 60]); s(7, 8, [60, 60, 60]); s(8, 8, [60, 60, 60]);
    }));
  }
  for (const s of slots) uploadTile(s);
}

// ---------- icon ----------
function tileCanvas(name, bright) {
  const slot = Tex.map[name] !== undefined ? Tex.map[name] : Tex.map['missing'];
  const [x, y] = Tex.slotXY(slot);
  const cv = document.createElement('canvas'); cv.width = cv.height = 16;
  const c = cv.getContext('2d');
  c.drawImage(Tex.canvas, x, y, 16, 16, 0, 0, 16, 16);
  if (bright !== undefined && bright < 1) {
    c.globalCompositeOperation = 'multiply';
    const v = (bright * 255) | 0;
    c.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
    c.fillRect(0, 0, 16, 16);
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(Tex.canvas, x, y, 16, 16, 0, 0, 16, 16);
  }
  return cv;
}
function isoIcon(topName, sideName) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 16;
  const c = cv.getContext('2d');
  c.imageSmoothingEnabled = false;
  const top = tileCanvas(topName), left = tileCanvas(sideName, 0.8), right = tileCanvas(sideName, 0.6);
  c.save(); c.setTransform(0.5, 0.25, -0.5, 0.25, 8, 0.5); c.drawImage(top, 0, 0, 16, 16, 0, 0, 16, 16); c.restore();
  c.save(); c.setTransform(0.5, 0.25, 0, 0.6, 0.2, 4.3); c.drawImage(left, 0, 0, 16, 16, 0, 0, 16, 16); c.restore();
  c.save(); c.setTransform(0.5, -0.25, 0, 0.6, 8, 8.3); c.drawImage(right, 0, 0, 16, 16, 0, 0, 16, 16); c.restore();
  return cv;
}

// ---------- registry ----------
let myRecipes = [];
function register() {
  for (const t of TIERS) {
    defBlock(t.id, {
      name: t.name, label: t.label,
      tex: { top: t.name + '_top', bottom: t.name + '_top', side: t.name + '_side' },
      hard: 0, sound: 'grass', flammable: true,
    });
    defItem(t.name, { label: t.label, block: t.id, icon: null });
    Tex.icons[t.name] = isoIcon(t.name + '_top', t.name + '_side');
  }
  // x2 from plain TNT + gunpowder, then each tier from four of the one below —
  // so the ladder costs 4^n and x50 is a genuine project
  recipe(TIERS[0].name, 1, ['GTG', 'TTT', 'GTG'], { T: 'tnt', G: 'gunpowder' });
  myRecipes.push(Recipes[Recipes.length - 1]);
  for (let i = 1; i < TIERS.length; i++) {
    recipe(TIERS[i].name, 1, ['PP', 'PP'], { P: TIERS[i - 1].name });
    myRecipes.push(Recipes[Recipes.length - 1]);
  }
  UI.creativeItems = null;
  Commands._itemIds = null;
}
function unregister() {
  for (const t of TIERS) {
    delete Blocks[t.id];
    delete Items[t.name];
    delete Tex.icons[t.name];
  }
  if (typeof fillUnknownBlocks === 'function') fillUnknownBlocks();
  for (const r of myRecipes) { const i = Recipes.indexOf(r); if (i >= 0) Recipes.splice(i, 1); }
  myRecipes = [];
  queue = [];
  UI.creativeItems = null;
  Commands._itemIds = null;
}

// ---------- the primed entity ----------
// Extends the game's own PrimedTNT so the physics, the nudge-from-a-nearby-blast and the
// entity streaming all come for free. `type` stays 'tnt', which means it renders as an ordinary
// primed TNT block while it flies — the colour is on the placed block, not the lit one.
let MegaTNT = null;
function defineEntity() {
  if (MegaTNT) return;
  MegaTNT = class extends PrimedTNT {
    constructor(world, x, y, z, fuse, tier) {
      super(world, x, y, z, fuse);
      this.tier = tier;
    }
    update(dt, game) {
      this.physics(dt);
      this.fuse -= dt;
      if (Math.random() < dt * 20) Particles.burst('smoke', this.x, this.y + 1.05, this.z, 1, 0.05);
      if (this.fuse <= 0) {
        this.remove();
        queueBlast(this.world, this.x, this.y + 0.5, this.z, this.tier);
      }
    }
  };
}

// ---------- ignition ----------
function igniteMega(world, x, y, z, tier) {
  // a guest never owns a blast — hand it to the host, exactly like vanilla TNT does
  if (typeof Game !== 'undefined' && Game.isGuest && typeof Net !== 'undefined' && Net.connected) {
    const m = Mods.registry.megatnt;
    if (m) Mods.api(m).send({ ix: x, iy: y, iz: z, mult: tier.mult }, 0);
    return;
  }
  defineEntity();
  world.setBlock(x, y, z, B.AIR);
  const e = new MegaTNT(world, x + 0.5, y, z + 0.5, 80, tier);
  world.entities.push(e);
  Sfx.play('fuse', { pos: [x, y, z] });
}

// ---------- staged blast ----------
function queueBlast(world, x, y, z, tier) {
  // the first one goes off where the fuse was, immediately; the rest scatter around it
  queue.push({ w: world, x, y, z, power: tier.power, now: true });
  for (let i = 1; i < tier.blasts; i++) {
    const a = Math.random() * Math.PI * 2, rr = Math.random() * tier.spread;
    queue.push({
      w: world,
      x: x + Math.cos(a) * rr,
      y: y + (Math.random() - 0.5) * tier.spread * 0.7,
      z: z + Math.sin(a) * rr,
      power: tier.power,
    });
  }
  acc = 99;   // fire the first one on this very frame
}

// Any mega TNT sitting in the blast is lit rather than deleted, so stacks chain like real TNT.
// Deliberately a small box (radius 6, ~2k lookups) — scanning the full blast radius would cost
// more than the explosion itself.
function chainNearby(world, x, y, z) {
  const R = 6;
  const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
  for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) for (let dz = -R; dz <= R; dz++) {
    const t = BY_BLOCK[world.getBlock(bx + dx, by + dy, bz + dz)];
    if (t) igniteMega(world, bx + dx, by + dy, bz + dz, t);
  }
}

function tick(dt) {
  if (!queue.length) return;
  acc += dt;
  if (acc < 0.08) return;   // ~1 blast every 5 frames: smooth, and it reads as a rolling blast
  acc = 0;
  const b = queue.shift();
  if (!b || b.w !== Game.world) return;
  chainNearby(b.w, b.x, b.y, b.z);
  b.w.explode(b.x, b.y, b.z, b.power);
}

// ---------- hooks ----------
function installHooks() {
  if (hooked) return;
  hooked = true;
  const useOrig = Player.prototype.useItemOnBlock;
  Player.prototype.useItemOnBlock = function (held, it, hit) {
    if (on && held && held.id === 'flint_and_steel' && hit) {
      const t = BY_BLOCK[this.world.getBlock(hit.x, hit.y, hit.z)];
      if (t) {
        Sfx.play('ignite');
        igniteMega(this.world, hit.x, hit.y, hit.z, t);
        if (this.game.mode !== 'creative' && held.dur !== undefined) {
          held.dur--;
          if (held.dur <= 0) { this.inventory.slots[this.selected] = null; Sfx.play('break'); }
        }
        return true;
      }
    }
    return useOrig.apply(this, arguments);
  };
}

Mods.register({
  id: 'megatnt',
  name: 'Mega TNT',
  description: 'Stronger TNT: x2, x5, x10, x25, x50.',

  onEnable() {
    buildTextures();
    defineEntity();
    register();
    installHooks();
    on = true;
  },
  onDisable() {
    on = false;
    unregister();
  },
  onTick(api, dt) { if (on) tick(dt); },
  onNet(api, d, from) {
    // a guest lit one: the host owns the blast
    if (d.ix === undefined) return;
    if (Game.mpRole !== 'host') return;
    const t = TIERS.find((x) => x.mult === d.mult);
    if (!t) return;
    if (Game.mpEnsureAt) { try { Game.mpEnsureAt(d.ix + 0.5, d.iz + 0.5); } catch (e) {} }
    if (BY_BLOCK[Game.world.getBlock(d.ix | 0, d.iy | 0, d.iz | 0)]) igniteMega(Game.world, d.ix | 0, d.iy | 0, d.iz | 0, t);
  },
});

})();
