'use strict';
// ============ mods/copper.js — Copper Ore + Copper Hammer ============
// A content mod, written to prove the mod system can add real gameplay without a single line
// changing in js/*.js. It adds:
//   * a new BLOCK (copper ore) with its own procedural texture, generated into new chunks
//   * a new ITEM (copper hammer) — a pickaxe that breaks a 3-tall, 1-wide slot out of a wall
// Mining the ore drops the hammer, so one block is the whole test loop. Both show up in the
// creative inventory and in /give on their own.
//
// Everything here is registered at RUNTIME through the game's own globals — `defBlock`,
// `defItem`, `Tex.reg`, `oreTex`, `lineArt` — plus two wrapped functions (`Gen.generateChunk`
// for the ore, `World.prototype.breakBlock` for the hammer). onDisable puts all of it back.
//
// Opening a world that contains copper without this mod is handled by the core, twice over:
// the save records which mods it was played with and loadGame refuses to open it without them,
// and fillUnknownBlocks leaves an inert placeholder at any id nothing defines, so nothing can
// throw even if a block slips past. Multiplayer is covered by the host's join-time mod check.

(function () {

// Block ids 0..102 are the game's, and the chunk store is a Uint8Array, so 103..255 are free
// for mods. Counting down from the top leaves the game room to grow upward.
const ORE_ID = 200;
const HAMMER = 'copper_hammer';
const ORE_ITEM = 'copper_ore';

// Wrappers are installed ONCE and never taken off again — they check `on` instead. Restoring
// the saved original on disable looks tidier but silently clobbers any mod that wrapped the
// same function after us, which is a real scenario the moment there are two content mods.
let hooked = false;      // wrappers installed
let on = false;          // ...and currently doing anything
let texDone = false;     // Tex.reg allocates a new atlas slot every call — only ever once
let busy = false;        // re-entrancy guard for our own extra breaks

// ---------- textures ----------
// Pushes a freshly registered tile to the GPU. The atlas was uploaded once at boot, so a tile
// added later is only in the 2D canvas until this runs. Same call the animated water/lava
// tiles use every tick (Tex.tickAnim), so the format is known-good.
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
  // `oreTex` is the game's own ore painter (stone mottle + coloured blobs), so this lands in
  // exactly the same art style as gold/iron/diamond instead of looking bolted on.
  const oreSlot = Tex.reg('copper_ore', (s, r) => oreTex(s, r, 5, [[216, 127, 51], [190, 104, 38], [240, 164, 92]]));
  // The hammer is the game's own pickaxe line art re-run with a yellow palette — same shape
  // as the diamond pickaxe, warm head instead of the cyan one.
  const M = { c: [231, 187, 45], l: [255, 231, 130], d: [168, 132, 20] };
  const HANDLE = [104, 78, 47], HANDLE_L = [158, 132, 79];
  const hammerSlot = Tex.reg('i_copper_hammer', (s) => {
    clearTex(s);
    lineArt(s, 4, 13, 11, 6, HANDLE, 1);
    lineArt(s, 3, 13, 10, 6, HANDLE_L, 1);
    lineArt(s, 2, 5, 5, 2, M.c, 2); lineArt(s, 5, 2, 10, 1, M.c, 2);
    lineArt(s, 10, 1, 13, 3, M.c, 2); lineArt(s, 13, 3, 14, 7, M.c, 2);
    lineArt(s, 5, 2, 10, 2, M.l, 1);
    s(2, 5, M.d); s(14, 7, M.d); s(13, 8, M.d);
    // the extra bulk that says "hammer, not pickaxe"
    lineArt(s, 4, 4, 12, 4, M.c, 1);
  });
  uploadTile(oreSlot);
  uploadTile(hammerSlot);
}

// ---------- inventory icons ----------
// Tex.icons[id] is the 16x16 the hotbar and inventory draw. The game builds these in
// buildIcons() at boot, whose helpers are function-local, so a mod registering later has to
// make its own. Same transforms as the game's isoIcon so the cube sits identically.
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
  defBlock(ORE_ID, {
    name: ORE_ITEM, label: 'Copper Ore', tex: { all: 'copper_ore' },
    hard: 3, tool: 'pickaxe', tier: 0, xp: [0, 1],
    // the point of the whole mod: the ore hands you the hammer
    drops: () => [{ id: HAMMER, n: 1 }],
  });
  defItem(ORE_ITEM, { label: 'Copper Ore', block: ORE_ID, icon: null });
  defItem(HAMMER, {
    label: 'Copper Hammer', icon: 'i_copper_hammer', stack: 1,
    toolType: 'pickaxe', toolTier: 3, dur: 1000, dmg: 5,
  });
  Tex.icons[ORE_ITEM] = isoIcon('copper_ore');
  Tex.icons[HAMMER] = tileCanvas('i_copper_hammer');
  // both are cached the first time they're needed, so drop the caches or the new entries
  // never appear in the creative grid / in /give's tab-complete this session
  UI.creativeItems = null;
  Commands._itemIds = null;
}
function unregister() {
  delete Blocks[ORE_ID];
  // put the core's inert placeholder back rather than leaving a hole — a world still holding
  // copper has to render something instead of throwing on an undefined block def
  if (typeof fillUnknownBlocks === 'function') fillUnknownBlocks();
  delete Items[ORE_ITEM];
  delete Items[HAMMER];
  delete Tex.icons[ORE_ITEM];
  delete Tex.icons[HAMMER];
  UI.creativeItems = null;
  Commands._itemIds = null;
}

// ---------- ore generation ----------
// Runs after the game has generated a chunk, using the same walk-and-replace the game's own
// veins use (worldgen.js) and the same seeded RNG, just salted differently so copper doesn't
// land in lockstep with the vanilla ores. Deterministic from the world seed, so a guest
// generating the same chunk gets identical ore without anything crossing the network.
function injectOre(world, chunk) {
  if (world.dim !== 'overworld') return;
  const blocks = chunk.blocks;
  const rng = RNG(hash2(Gen.seed ^ 0x0C0FFEE, chunk.cx, chunk.cz));
  for (let i = 0; i < 10; i++) {           // veins per chunk
    let x = rng.nextInt(16), z = rng.nextInt(16);
    let y = 8 + rng.nextInt(64);           // deep enough to need a mine, shallow enough to find
    for (let k = 0; k < 7; k++) {          // blocks per vein
      if (x >= 0 && x < 16 && z >= 0 && z < 16 && y > 0 && y < 127) {
        const idx = (x * 16 + z) * 128 + y;
        if (blocks[idx] === B.STONE) blocks[idx] = ORE_ID;
      }
      x += rng.nextInt(3) - 1; y += rng.nextInt(3) - 1; z += rng.nextInt(3) - 1;
    }
  }
}

// ---------- the hammer's 3x1 ----------
// Which extra blocks go with the one being broken. Faces 4 and 5 are the Y faces (see
// World.raycast), i.e. floor and ceiling — there the hammer behaves like an ordinary pickaxe,
// because widening a hole you are standing on or under is never what anyone wanted. On a WALL
// it takes the block above and below too: a 3-tall, 1-wide slot you can walk straight through.
function extraFor(hit) {
  if (hit.face === 4 || hit.face === 5) return null;
  return [[hit.x, hit.y + 1, hit.z], [hit.x, hit.y - 1, hit.z]];
}
function aimHit(world) {
  const p = Game.player;
  const eye = p.eyePos(), dir = p.lookDir();
  return world.raycast(eye[0], eye[1], eye[2], dir[0], dir[1], dir[2], 5);
}
// One durability point per extra block, and the tool really can break mid-swing — same rule
// the game applies to the block you aimed at (Player.finishBreak).
function wearTool(held) {
  const p = Game.player;
  if (Game.mode === 'creative' || !held || held.dur === undefined) return;
  if (!Items[held.id] || !Items[held.id].toolType) return;
  held.dur--;
  if (held.dur <= 0) {
    p.inventory.slots[p.selected] = null;
    Sfx.play('break');
    Particles.burst('smoke', p.x, p.y + 1.2, p.z, 5, 0.2);
  }
}

function installHooks() {
  if (hooked) return;
  hooked = true;
  const genOrig = Gen.generateChunk;
  const breakOrig = World.prototype.breakBlock;

  Gen.generateChunk = function (world, chunk) {
    const r = genOrig.call(this, world, chunk);
    if (on) { try { injectOre(world, chunk); } catch (e) { console.error('[copper] injectOre', e); } }
    return r;
  };

  World.prototype.breakBlock = function (x, y, z, tool, dropAlways) {
    // Work out the extras BEFORE the block goes, or the raycast shoots through the fresh hole
    // and reports whatever is behind it. Guarded on the player actually aiming at this block,
    // which is what keeps explosions, fluids and falling sand out of here.
    let extra = null, held = null;
    if (on && !busy && typeof Game !== 'undefined' && Game.player && this === Game.world && Game.state === 'play') {
      held = Game.player.heldItem();
      if (held && held.id === HAMMER) {
        const hit = aimHit(this);
        if (hit && hit.x === x && hit.y === y && hit.z === z) extra = extraFor(hit);
      }
    }
    const r = breakOrig.call(this, x, y, z, tool, dropAlways);
    if (!extra) return r;
    busy = true;
    try {
      for (const c of extra) {
        const id = this.getBlock(c[0], c[1], c[2]);
        if (id === B.AIR) continue;
        const def = Blocks[id];
        if (!def || def.hard < 0) continue;   // bedrock, water, lava — leave them alone
        // the aimed block's own particles/sound come from Player.finishBreak; the extras are
        // ours to announce, or they vanish in silence
        Particles.blockBreak(this, c[0], c[1], c[2], id);
        Sfx.play('break_' + def.sound, { pos: [c[0], c[1], c[2]] });
        breakOrig.call(this, c[0], c[1], c[2], tool, dropAlways);
        wearTool(held);
      }
    } finally { busy = false; }
    return r;
  };
}

Mods.register({
  id: 'copper',
  name: 'Copper & Hammer',
  description: 'New copper ore in the world. Mining it drops a hammer that cuts 3x1 through walls.',

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
});

})();
