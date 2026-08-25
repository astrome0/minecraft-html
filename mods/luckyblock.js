'use strict';
// ============ mods/luckyblock.js — Lucky Block ============
// Break it and something random happens: treasure, an ambush, an explosion, a cage, a launch.
//
// The interesting part is multiplayer. A random outcome must be rolled ONCE and by ONE machine,
// or three players watching the same block get three different surprises. So the HOST is the
// only one that ever rolls:
//     guest breaks it  ->  sends {x,y,z} to pid 0  ->  host rolls + runs it
//     host breaks it   ->  host rolls + runs it
//     singleplayer     ->  we are the host, same path
// Everything the host then does — spawning mobs, exploding, dropping loot — already reaches
// guests through the game's own host-authority streams, so none of it needs new networking.
// The one exception is an effect on the BREAKER's own body (the launch), which the host sends
// back down the same mod channel for that client to apply to itself.
//
// Recipe: 4 gold ingots around a chest. Also in the creative grid and /give.

(function () {

// Mods take block ids from the top down; copper.js has 200 (see its note).
const LUCKY_ID = 199;
const LUCKY = 'lucky_block';

let hooked = false, on = false, texDone = false;
let myRecipes = [];

// ---------- texture ----------
const Q = [
  '................',
  '................',
  '.....######.....',
  '....##....##....',
  '....##....##....',
  '..........##....',
  '.........##.....',
  '........##......',
  '.......##.......',
  '.......##.......',
  '................',
  '.......##.......',
  '.......##.......',
  '................',
  '................',
  '................',
];

function uploadTile(slot) {
  const gl = Renderer.gl;
  if (!gl || !Renderer.atlasTex || slot == null) return;
  const [x, y] = Tex.slotXY(slot);
  gl.bindTexture(gl.TEXTURE_2D, Renderer.atlasTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, Tex.ctx.getImageData(x, y, 16, 16));
}

function buildTextures() {
  if (texDone) return;
  texDone = true;
  const slot = Tex.reg(LUCKY, (s, r) => {
    // gold-leaf base with a darker bevel, then the question mark punched into it
    const golds = [[247, 214, 78], [235, 197, 55], [255, 232, 130], [214, 173, 40]];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) s(x, y, golds[r.nextInt(golds.length)]);
    for (let i = 0; i < 16; i++) {
      s(i, 0, [255, 243, 170]); s(0, i, [255, 243, 170]);
      s(i, 15, [176, 138, 26]); s(15, i, [176, 138, 26]);
    }
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      if (Q[y][x] === '#') s(x, y, [58, 42, 8]);
    }
  });
  uploadTile(slot);
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
function isoIcon(name) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 16;
  const c = cv.getContext('2d');
  c.imageSmoothingEnabled = false;
  const top = tileCanvas(name), left = tileCanvas(name, 0.8), right = tileCanvas(name, 0.6);
  c.save(); c.setTransform(0.5, 0.25, -0.5, 0.25, 8, 0.5); c.drawImage(top, 0, 0, 16, 16, 0, 0, 16, 16); c.restore();
  c.save(); c.setTransform(0.5, 0.25, 0, 0.6, 0.2, 4.3); c.drawImage(left, 0, 0, 16, 16, 0, 0, 16, 16); c.restore();
  c.save(); c.setTransform(0.5, -0.25, 0, 0.6, 8, 8.3); c.drawImage(right, 0, 0, 16, 16, 0, 0, 16, 16); c.restore();
  return cv;
}

// ---------- registry ----------
function register() {
  defBlock(LUCKY_ID, {
    name: LUCKY, label: 'Lucky Block', tex: { all: LUCKY },
    hard: 0.8, tool: null, tier: -1, sound: 'stone',
    drops: () => [],   // it never drops itself — breaking it IS the reward
  });
  defItem(LUCKY, { label: 'Lucky Block', block: LUCKY_ID, icon: null });
  Tex.icons[LUCKY] = isoIcon(LUCKY);
  recipe(LUCKY, 1, ['GGG', 'GCG', 'GGG'], { G: 'gold_ingot', C: 'chest' });
  myRecipes = [Recipes[Recipes.length - 1]];
  UI.creativeItems = null;
  Commands._itemIds = null;
}
function unregister() {
  delete Blocks[LUCKY_ID];
  if (typeof fillUnknownBlocks === 'function') fillUnknownBlocks();
  delete Items[LUCKY];
  delete Tex.icons[LUCKY];
  for (const r of myRecipes) {
    const i = Recipes.indexOf(r);
    if (i >= 0) Recipes.splice(i, 1);
  }
  myRecipes = [];
  UI.creativeItems = null;
  Commands._itemIds = null;
}

// ---------- who broke it ----------
// pid -1 means "no room, it was just me". Otherwise the host looks the breaker up: itself if
// the pid is its own, else that guest's streamed avatar position.
function breakerPos(pid) {
  if (pid == null || pid < 0 || (typeof Net !== 'undefined' && pid === Net.pid)) {
    const p = Game.player;
    return p ? { x: p.x, y: p.y, z: p.z } : null;
  }
  const r = Game.remotes.get(pid);
  return (r && r.seen) ? { x: r.dispX, y: r.dispY, z: r.dispZ } : null;
}
function tellBreaker(pid, data) {
  // the breaker is us (singleplayer, or the host broke it) -> apply here
  if (pid == null || pid < 0 || (typeof Net !== 'undefined' && pid === Net.pid)) { applySelfEffect(data); return; }
  Mods.registry.luckyblock && Mods.api(Mods.registry.luckyblock).send(data, pid);
}
// anything that has to happen to a specific player's own body, run on that player's client
function applySelfEffect(d) {
  const p = Game.player;
  if (!p) return;
  if (d.fx === 'launch') {
    p.vy = 15; p.onGround = false; p.fallStart = p.y + 40;   // no fall damage from our own prank
    Sfx.play('pop');
    Particles.burst('crit', p.x, p.y + 0.5, p.z, 16, 0.5);
    UI.msg('Lucky Block: LAUNCH!', '#ffff55');
  } else if (d.fx === 'heal') {
    p.hp = p.maxHp; p.hunger = 20; p.saturation = 5;
    Particles.burst('heart', p.x, p.y + 1, p.z, 10, 0.4);
    UI.msg('Lucky Block: fully healed!', '#55ff55');
  }
}

// ---------- the outcomes ----------
// Weights add up to 100 so the table reads as percentages.
const OUTCOMES = [
  { w: 12, name: 'Boom!', color: '#ff5555', run(w, x, y, z) {
    w.explode(x + 0.5, y + 0.5, z + 0.5, 2.5);
  } },
  { w: 14, name: 'Ambush!', color: '#ff8855', run(w, x, y, z, rng) {
    const kinds = ['zombie', 'skeleton', 'spider', 'creeper'];
    const n = 2 + rng.nextInt(3);
    for (let i = 0; i < n; i++) {
      spawnMob(w, kinds[rng.nextInt(kinds.length)], x + 0.5 + rng.range(-2, 2), y + 1, z + 0.5 + rng.range(-2, 2));
    }
  } },
  { w: 14, name: 'Treasure!', color: '#55ffff', run(w, x, y, z, rng) {
    // every id is filtered against Items first: a stack naming an item this build does not
    // have would sit in the hotbar and throw in drawViewModel on every frame
    const loot = [['diamond', 3], ['gold_ingot', 6], ['iron_ingot', 8], ['lapis', 6], ['coal', 10]]
      .filter((l) => Items[l[0]]);
    if (!loot.length) return;
    const pick = loot[rng.nextInt(loot.length)];
    const n = 1 + rng.nextInt(pick[1]);
    for (let i = 0; i < n; i++) spawnItemEntity(w, x + 0.5, y + 0.7, z + 0.5, mkStack(pick[0], 1), true);
  } },
  { w: 10, name: 'Loot drop!', color: '#ffff55', run(w, x, y, z, rng) {
    const gear = ['diamond_pickaxe', 'diamond_sword', 'diamond_axe', 'bow', 'iron_pickaxe'].filter((g) => Items[g]);
    if (!gear.length) return;
    const id = gear[rng.nextInt(gear.length)];
    spawnItemEntity(w, x + 0.5, y + 0.7, z + 0.5, mkStack(id, 1), true);
    if (id === 'bow' && Items['arrow']) for (let i = 0; i < 16; i++) spawnItemEntity(w, x + 0.5, y + 0.7, z + 0.5, mkStack('arrow', 1), true);
  } },
  { w: 10, name: 'Experience!', color: '#88ff88', run(w, x, y, z, rng) {
    spawnXPOrbs(w, x + 0.5, y + 0.7, z + 0.5, 25 + rng.nextInt(36));
  } },
  { w: 10, name: 'Feast!', color: '#ffaa55', run(w, x, y, z, rng) {
    const food = ['bread', 'steak', 'cooked_porkchop', 'apple', 'cooked_chicken'];
    for (const id of food) {
      if (!Items[id]) continue;
      const n = 1 + rng.nextInt(3);
      for (let i = 0; i < n; i++) spawnItemEntity(w, x + 0.5, y + 0.7, z + 0.5, mkStack(id, 1), true);
    }
  } },
  { w: 8, name: 'Caged!', color: '#aaaaaa', run(w, x, y, z, rng, pid) {
    const p = breakerPos(pid);
    if (!p) return;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    // a 3x4x3 glass shell around them, hollow inside so nobody suffocates
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 2; dy++) for (let dz = -1; dz <= 1; dz++) {
      const shell = dx === -1 || dx === 1 || dz === -1 || dz === 1 || dy === -1 || dy === 2;
      if (!shell) continue;
      if (w.getBlock(bx + dx, by + dy, bz + dz) === B.AIR) w.setBlock(bx + dx, by + dy, bz + dz, B.GLASS);
    }
  } },
  { w: 8, name: 'LAUNCH!', color: '#ff55ff', run(w, x, y, z, rng, pid) {
    tellBreaker(pid, { fx: 'launch' });
  } },
  { w: 6, name: 'Hot!', color: '#ff4400', run(w, x, y, z) {
    if (w.getBlock(x, y, z) === B.AIR) w.setBlock(x, y, z, B.LAVA);
  } },
  { w: 8, name: 'Petting zoo!', color: '#ff99cc', run(w, x, y, z, rng) {
    const kinds = ['pig', 'cow', 'chicken', 'sheep'];
    const n = 3 + rng.nextInt(4);
    for (let i = 0; i < n; i++) {
      spawnMob(w, kinds[rng.nextInt(kinds.length)], x + 0.5 + rng.range(-2, 2), y + 1, z + 0.5 + rng.range(-2, 2));
    }
  } },
];

function pickOutcome(rng) {
  let total = 0;
  for (const o of OUTCOMES) total += o.w;
  let r = rng.nextInt(total);
  for (const o of OUTCOMES) { r -= o.w; if (r < 0) return o; }
  return OUTCOMES[0];
}

// HOST ONLY (or singleplayer). Rolls once and runs it.
function resolve(x, y, z, pid) {
  const w = Game.world;
  if (!w) return;
  // a guest can break a block in a chunk the host has not generated yet
  if (Game.mpEnsureAt) { try { Game.mpEnsureAt(x + 0.5, z + 0.5); } catch (e) {} }
  const rng = RNG(((Math.random() * 1e9) | 0) ^ (x * 31 + y * 17 + z));
  const out = pickOutcome(rng);
  Particles.burst('happy', x + 0.5, y + 0.5, z + 0.5, 12, 0.4);
  Sfx.play('pop', { pos: [x + 0.5, y + 0.5, z + 0.5] });
  try { out.run(w, x, y, z, rng, pid); } catch (e) { console.error('[luckyblock] ' + out.name, e); }
  announce(pid, out.name, out.color);
}

// Everyone gets the SAME coloured banner. This used to go out as a chat line, which meant the
// host saw a nice coloured message and everybody else got a wall of grey "<Player> Guest hit a
// Lucky Block: ..." spam. Sending it down the mod channel instead lets each client render it
// properly, and resolve "You" from its own point of view.
function announce(pid, name, color) {
  showAnnounce(pid, name, color);
  if (typeof Net !== 'undefined' && Net.connected) {
    const m = Mods.registry.luckyblock;
    if (m) Mods.api(m).send({ ann: name, c: color, p: pid });   // broadcast, no `to`
  }
}
function showAnnounce(pid, name, color) {
  let who = 'You';
  if (pid != null && pid >= 0 && typeof Net !== 'undefined' && Net.pid != null && pid !== Net.pid) {
    const r = Game.remotes.get(pid);
    who = (r && r.name) || 'Player';
  }
  UI.msg(who + ' hit a Lucky Block: ' + name, color || '#ffff55');
}

// ---------- hook ----------
function installHooks() {
  if (hooked) return;
  hooked = true;
  const breakOrig = World.prototype.breakBlock;
  World.prototype.breakBlock = function (x, y, z, tool, dropAlways) {
    const wasLucky = on && this === Game.world && Game.state === 'play' && this.getBlock(x, y, z) === LUCKY_ID;
    const r = breakOrig.call(this, x, y, z, tool, dropAlways);
    if (!wasLucky) return r;
    // Creative breaks things by the dozen while flying; still fine, it just means chaos.
    if (typeof Net !== 'undefined' && Net.connected && Game.isGuest) {
      // not ours to decide — the host rolls, so everyone sees the same surprise
      Mods.api(Mods.registry.luckyblock).send({ lx: x, ly: y, lz: z }, 0);
    } else {
      resolve(x, y, z, (typeof Net !== 'undefined' && Net.connected) ? Net.pid : -1);
    }
    return r;
  };
}

Mods.register({
  id: 'luckyblock',
  name: 'Lucky Block',
  description: 'Break it - something random happens.',

  onEnable() {
    buildTextures();
    register();
    installHooks();
    on = true;
  },
  onDisable() {
    on = false;
    unregister();
  },
  onNet(api, d, from) {
    // the host announcing what it rolled, to everyone
    if (d.ann) { showAnnounce(d.p, d.ann, d.c); return; }
    // the host telling us to launch ourselves
    if (d.fx) { applySelfEffect(d); return; }
    // a guest asking us to roll for them
    if (d.lx === undefined) return;
    if (Game.mpRole !== 'host') return;   // only the host rolls
    resolve(d.lx | 0, d.ly | 0, d.lz | 0, from);
  },
});

})();
