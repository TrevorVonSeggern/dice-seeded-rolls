const MODULE_ID = "dice-seeded-rolls";

// ---- Seeded PRNG core (mulberry32) and xmur3 string hash --------------------
// Deterministic and self-contained; no external dependencies.
function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^= h >>> 16) >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- World-synced, GM-only state --------------------------------------------
const SETTINGS = {
  enabled: "enabled",
  daySeed: "daySeed",
  rollIndex: "rollIndex"
};

function settingsGet(key, fallback) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch (e) {
    return fallback;
  }
}

function settingsSet(key, value) {
  return game.settings.set(MODULE_ID, key, value);
}

// Original entropy captured before we override CONFIG.Dice.randomUniform.
let nativeUniform = () => Math.random();

// State for the currently-evaluating die term. randomUniform delegates here.
const stream = { active: false, rng: null };

// ---- Entropy interception ----------------------------------------------------
// Every random draw in the dice system funnels through here. When a die term is
// being evaluated with an active seeded stream, its values come from that stream;
// otherwise (rolls outside a die term, or module disabled) we fall back to native.
function randomUniformOverride() {
  if (stream.active && stream.rng) return stream.rng();
  return nativeUniform();
}

// Reserve a contiguous block of rollIndex slots for a die term, seed a fresh
// PRNG from daySeed:base, run the original roll, and release the stream.
// Internal draws (explosions, rerolls, keep/drop) share one deterministic stream,
// so an identical term at an identical position always reproduces the same faces.
function seedTermRoll(_termRoll, options) {
  return async function (rollOptions) {
    const opts = rollOptions ?? {};
    if (!settingsGet(SETTINGS.enabled, true) || opts.maximize || opts.minimize) {
      return _termRoll.call(this, opts);
    }
    const number = this.number || 1;
    const base = settingsGet(SETTINGS.rollIndex, 0);
    // Reserve slots synchronously so later terms in the same roll get distinct base.
    void settingsSet(SETTINGS.rollIndex, base + number);
    stream.active = true;
    stream.rng = mulberry32(hashSeed(`${settingsGet(SETTINGS.daySeed, 0)}:${base}`));
    try {
      return await _termRoll.call(this, opts);
    } finally {
      stream.active = false;
      stream.rng = null;
    }
  };
}

Hooks.once("init", () => {
  // Capture the native uniform before we replace it.
  nativeUniform = typeof CONFIG.Dice.randomUniform === "function"
    ? CONFIG.Dice.randomUniform.bind(CONFIG.Dice)
    : () => Math.random();

  game.settings.register(MODULE_ID, SETTINGS.enabled, {
    name: "Enabled",
    hint: "Deterministically seed dice rolls from the day seed. When disabled, native randomness is used and the roll counter does not advance.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.daySeed, {
    name: "Day Seed",
    hint: "Seed value used to derive every die result. Choose this to replay a day identically; the roll counter is reset separately with /roll-reset.",
    scope: "world",
    config: true,
    type: Number,
    default: 0
  });

  game.settings.register(MODULE_ID, SETTINGS.rollIndex, {
    name: "Roll Index",
    hint: "Global per-die-roll counter for the current day.",
    scope: "world",
    config: false,
    type: Number,
    default: 0
  });
});

Hooks.once("ready", () => {
  // Register /roll-reset as a native chat command (v14 ChatLog.CHAT_COMMANDS).
  // Typing any unknown "/command" throws before a message is even created, so the
  // command must be registered here (ready, when the foundry namespace exists).
  const ChatLog = foundry.applications.sidebar.tabs.ChatLog;
  if (ChatLog?.CHAT_COMMANDS && !ChatLog.CHAT_COMMANDS["roll-reset"]) {
    ChatLog.CHAT_COMMANDS["roll-reset"] = {
      rgx: /^\/roll-reset(?:\s|$)/,
      fn: async function () {
        if (game.user.isGM) {
          await settingsSet(SETTINGS.rollIndex, 0);
          console.log(`${MODULE_ID} | Roll counter reset to 0. Seed unchanged:`, settingsGet(SETTINGS.daySeed, 0));
        }
        // Return false to consume the command so nothing is posted to chat.
        return false;
      }
    };
  }

  // Replace the global entropy function: covers every RNG consumer in core.
  CONFIG.Dice.randomUniform = randomUniformOverride;

  // Pin the uniform -> face mapping to the module's own formula so that seeds found
  // via diceSeededRolls.findSeed reproduce the exact same faces at the table.
  const Die = foundry.dice.terms.Die;
  if (Die?.prototype) {
    Die.prototype.mapRandomFace = function (u) {
      return faceFromUniform(this.faces, u);
    };
  }

  // Reserve slots at the term boundary so accounting is correct per declared die.
  const DiceTerm = foundry.dice.terms.DiceTerm;
  if (DiceTerm?.prototype?.roll) {
    const _roll = DiceTerm.prototype.roll;
    DiceTerm.prototype.roll = seedTermRoll(_roll);
  }
  const DicePool = foundry.dice.terms.DicePool;
  if (DicePool?.prototype?.roll) {
    const _roll = DicePool.prototype.roll;
    DicePool.prototype.roll = seedTermRoll(_roll);
  }
});

// ---- Uniform -> face mapping --------------------------------------------------
// The module pins its own mapping from a uniform in [0,1) to a die face so that the
// seed-search helper below reproduces exactly what the module produces at runtime.
// A fair, stable mapping: face = floor(u * faces) + 1, clamped to [1, faces].
function faceFromUniform(faces, u) {
  return Math.min(faces, Math.floor(u * faces) + 1);
}

// ---- Seed search ---------------------------------------------------------------
// Facilities for finding a daySeed whose roll sequence starts with desired faces.
// They reuse the hash/PRNG the module uses at runtime plus faceFromUniform, so a
// found seed reproduces exact table rolls.

function seedFaces(seed, faces, indices) {
  return indices.map((i) => faceFromUniform(faces, mulberry32(hashSeed(`${seed}:${i}`))()));
}

function searchSeed(targetFaces, { faces = 20, start = 1, maxAttempts = 2000000 } = {}) {
  const n = targetFaces.length;
  for (let s = start; s < start + maxAttempts; s++) {
    let ok = true;
    for (let i = 0; i < n; i++) {
      if (faceFromUniform(faces, mulberry32(hashSeed(`${s}:${i}`))()) !== targetFaces[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return s;
  }
  return null;
}

// ---- Thin introspection surface ----------------------------------------------
globalThis.diceSeededRolls = {
  getDaySeed: () => settingsGet(SETTINGS.daySeed, 0),
  getRollIndex: () => settingsGet(SETTINGS.rollIndex, 0),
  isEnabled: () => settingsGet(SETTINGS.enabled, true),
  // Find a daySeed so the first targetFaces.length rolls of a faces-sided die are
  // exactly targetFaces (e.g. diceSeededRolls.findSeed([20, 1, 20]) for 1d20s).
  findSeed: (targetFaces, options) => searchSeed(targetFaces, options),
  // What faces a given seed produces for the first `count` rolls.
  previewSeed: (seed, count = 10, faces = 20) =>
    seedFaces(seed, faces, Array.from({ length: count }, (_, i) => i))
};
