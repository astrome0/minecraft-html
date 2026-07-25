# Minecraft PE — a browser-based Minecraft tribute

A project made as recreation of Minecraft (roughly the 1.8-era look and feel), built entirely in vanilla JavaScript + WebGL. No engine, no external assets — every texture, sound, and music track is generated procedurally at runtime. Runs directly in the browser, on desktop and mobile alike, with no install.

**Play it here:** https://astrome0.github.io/minecraft-html/

This is an project for fun, because im bored :D, not affiliated with or endorsed by Mojang/Microsoft.

## What's in the game

- **Survival and Creative modes**, with a full crafting system, smelting, tools, armor, food/hunger, XP, and health regeneration
- **Procedurally generated worlds** from a seed: biomes, caves, ores, trees, lakes, villages, dungeons with spawners, and a stronghold to find
- **The full dimension loop**: Overworld → mine your way to a Nether portal → find blaze rods and ender pearls → craft eyes of ender → locate the stronghold → enter the End → defeat the Ender Dragon → credits
- **Mobs**: passive animals (pig, cow, sheep, chicken) and hostiles (zombie, skeleton, creeper, spider, enderman, blaze, ghast, zombie pigman, plus villagers), all with real AI, pathing, and combat
- **Day/night cycle and weather** — rain, snow (biome-dependent), and thunderstorms with lightning, all affecting lighting and ambience
- **Redstone**: wires, repeaters, and the usual contraption-building basics
- **A synthesized soundtrack and sound effects** — no audio files, everything is generated with the Web Audio API
- **Achievements**, a debug overlay (F3), and chat with slash commands (`/give`, `/tp`, `/fill`, `/time`, `/weather`, `/spawn`, `/kill`, `/heal`, `/clear`, `/seed`, `/fly`, `/gamemode`, `/help`) with tab-complete suggestions, vanilla-style

## Controls

**Desktop:** WASD to move, mouse to look, left/right click to mine/place, E for inventory, Space to jump (double-tap to fly in Creative), Shift to sneak, T or `/` to chat, F3 for debug info, F11 for fullscreen.

**Mobile / touch (this fork, "Pocket Edition"):** a full on-screen control scheme — movement joystick, look-by-dragging, and buttons for jump, sneak, sprint, break, use, inventory, drop, fly, and pause. Every control is **fully customizable** (Bedrock-style): drag any button anywhere on screen, resize it, adjust opacity, or hide the crosshair, via Options → "Edit Touch Layout...". Long-press an inventory slot to split a stack instead of taking it all. Touch is auto-detected, with `?touch=1`/`?touch=0` to force it either way.

## Multiplayer

Up to **10 players** can play together in one world in real time — one player hosts (Pause menu → "Host World", pick how many total players the room should allow), everyone else joins with a 6-digit code from the title screen's Multiplayer menu. Synced live: player movement and animations, block placing/breaking, dropped items, mobs and projectiles (including PvP), day/night and weather, sleeping (everyone needs to be in bed to skip the night), custom uploaded skins, and chat (each player's name shown per message).

This works over the open internet (not just the same Wi-Fi) thanks to a small relay server — see below for how that part works.

## How it's built

Pure vanilla JS split into focused modules (world generation, chunk meshing, WebGL rendering, entities/mobs, player, procedurally-generated textures and sound, UI, chat, touch controls, networking) loaded as plain `<script>` tags — no build step, no framework required to run it locally.

World generation, chunk data, and physics run entirely client-side; nothing about single-player requires a server at all. Only multiplayer needs the relay described below.

---

## Multiplayer Relay

A small WebSocket server that pairs players together for multiplayer.

### What this is for

The server itself knows nothing about the game — it's a "dumb pipe" that:
- generates a 6-digit room code when someone clicks **Host World**
- lets other players join that room by typing the code (**Join**)
- forwards messages between everyone in the room (player positions, block edits, entities, chat, skins, weather, sleeping, etc.)

The actual game — world generation, physics, block logic — runs entirely in each player's own browser. The server never simulates anything; it just relays JSON messages back and forth.

Without this server running publicly on the internet (not just on a local network), multiplayer would only work between devices on the same Wi-Fi.

### How it works

- The host connects first and gets **peer id (pid) 0**, plus a 6-digit room code
- Guests join with that code and get the smallest free pid (1, 2, 3, ...)
- The host picks the room size when hosting (2–10 players total, including themselves)
- Every message can be either **broadcast** to everyone else in the room, or **targeted** at one specific player
- The server stamps every forwarded message with the sender's id, so nobody can spoof who a message came from
- If a player leaves, their slot is freed and can be reused by the next person who joins
- Idle/abandoned rooms are automatically cleaned up after a period of inactivity

### Built-in abuse protection

The relay limits how many rooms can be open at once, how many rooms a single connection can host, and how fast any one connection can send messages — so one misbehaving client can't take the whole thing down for everyone else.

### Files

- `relay.js` — the server itself (Node.js, using the `ws` WebSocket library)
- `package.json` — dependencies; `npm start` runs `node relay.js`
- `render.yaml` — deployment config for the hosting platform this runs on

### Deployment

This server runs as a small hosted web service connected to this GitHub repo — every push to `main` automatically deploys the new version.

**Free-tier note:** the hosting plan this runs on puts the service to sleep after a period of no traffic. The *first* connection after a gap can take up to a minute while it wakes back up — that's expected, not a bug.

### Why one repo does both jobs

This relay and the game's static site live in the same repo for convenience, but they're independent — updating one doesn't require touching the other.
