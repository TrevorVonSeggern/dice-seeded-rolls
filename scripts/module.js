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

// ---- Roll counter (GM-authoritative) ------------------------------------------
// rollIndex is a world-scope setting, which only GMs may write. Since dice are
// evaluated on the rolling player's client, non-GM rolls must ask the GM to
// reserve their counter slots over the socket instead of writing the setting.
const SOCKET_EVENT = `module.${MODULE_ID}`;

// Serializes reservations so concurrent terms/rolls on one client get distinct bases.
let reservationTail = Promise.resolve();
// Optimistic fallback counter used only when no GM can answer a reservation.
let noGMCounter = null;
// Last GM-authoritative grant this client received (its frontier). Kept so the
// degraded local counter never re-treads slots a GM already assigned.
let lastGrant = null;
// Shadow of rollIndex kept on the counter authority so increments (including
// those for remote players) are serialized locally instead of racing on the
// synced setting value.
let gmShadow = null;
// Whether an active GM was observed. Players drop their degraded local counter
// the moment a GM appears so a later fallback re-reads the authoritative value.
let gmWasActive = false;

function gmAdvance(count) {
  if (gmShadow === null) gmShadow = settingsGet(SETTINGS.rollIndex, 0);
  const base = gmShadow;
  gmShadow += count;
  void settingsSet(SETTINGS.rollIndex, gmShadow);
  return base;
}

// Only one connected GM should act as the counter authority to avoid double-increments.
function isCounterAuthority() {
  if (!game.user.isGM) return false;
  const actives = game.users.filter((u) => u.isGM && u.active);
  if (actives.length < 2) return true;
  return actives.sort((a, b) => (a.id < b.id ? -1 : 1))[0].id === game.user.id;
}

function hasActiveGM() {
  return game.users.some((u) => u.isGM && u.active);
}

// Grants are idempotent per request id. A retried emit (slow ack, socket repeat)
// re-delivers the SAME id, so the GM re-acks the same base instead of consuming
// fresh slots twice — otherwise one logical player reservation silently inflates
// the counter and shifts every later roll (the "second roll breaks" symptom).
const granted = new Map(); // requestId -> { base, ts }
const GRANT_TTL = 15000;

function grantOnce(requestId, count) {
  const prior = granted.get(requestId);
  if (prior) return prior.base;
  const base = gmAdvance(count);
  granted.set(requestId, { base, ts: Date.now() });
  if (granted.size > 128) {
    const now = Date.now();
    for (const [id, g] of granted) {
      if (now - g.ts > GRANT_TTL) granted.delete(id);
    }
  }
  return base;
}

async function reserveSlots(count) {
  const run = reservationTail.then(async () => {
    if (isCounterAuthority()) return gmAdvance(count);
    return requestReservation(count);
  });
  reservationTail = run.catch(() => {});
  return run;
}

// Track a GM-authoritative grant so the local/degraded counter and the live
// setting stay aligned with the frontier the GM actually handed out.
function trackGrant(base, count) {
  lastGrant = { base, count };
  noGMCounter = Math.max(noGMCounter ?? base, base + count);
}

// Degraded counter used only when no GM can be reached. It starts at (and never
// goes below) the latest synced rollIndex plus anything a GM already granted this
// client, so it cannot re-tread assigned slots.
function localFallbackBase(count) {
  const synced = settingsGet(SETTINGS.rollIndex, 0);
  const frontier = Math.max(
    noGMCounter ?? 0,
    lastGrant ? lastGrant.base + lastGrant.count : 0,
    synced
  );
  noGMCounter = frontier + count;
  return frontier;
}

// The ack can arrive wrapped by transport semantics (e.g. keyed by the answering
// user's id). Dig the grant object for our exact request id out of any envelope.
function findGrant(resp, id, depth = 0) {
  if (resp == null || depth > 4 || typeof resp !== "object") return null;
  if (resp.type === "reserve" && resp.id === id && typeof resp.base === "number") return resp;
  for (const value of Object.values(resp)) {
    const grant = findGrant(value, id, depth + 1);
    if (grant) return grant;
  }
  return null;
}

// A single handshake for a whole Roll: reserve the exact total of declared dice
// in one request, then each die term derives its base from a shared cursor below.
// Bounded retry — but never a double-spend: retries reuse the request id, so the
// GM re-acks the same base. If no GM is connected at all, degrade immediately
// instead of waiting out the retry window.
const RESERVE_DELAY = 1000;
const RESERVE_RETRIES = 2;

function requestReservation(count) {
  return new Promise((resolve) => {
    const id = `reserve-${game.user.id}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    let attempt = 0;
    let timer = null;
    let finished = false;
    const finish = (base) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      timer = null;
      resolve(base);
    };
    const fallback = () => {
      if (finished) return;
      finish(localFallbackBase(count));
      console.warn(
        `${MODULE_ID} | No GM available to reserve the roll counter; using a local counter. Cross-client replay will not reproduce.`
      );
    };
    const tryEmit = () => {
      attempt++;
      timer = setTimeout(() => {
        if (attempt < RESERVE_RETRIES) {
          tryEmit();
          return;
        }
        fallback();
      }, RESERVE_DELAY);
      try {
        game.socket.emit(SOCKET_EVENT, { type: "reserve", id, count, from: game.user.id }, (resp) => {
          const grant = findGrant(resp, id);
          if (grant) {
            trackGrant(grant.base, count);
            finish(grant.base);
          }
        });
      } catch (err) {
        // Socket unavailable entirely: fall back to the degraded counter.
        fallback();
      }
    };
    if (!hasActiveGM()) {
      fallback();
      return;
    }
    tryEmit();
  });
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

// Roll-scoped slot cursor. A whole Roll reserves its declared dice in ONE
// reservation; die terms then carve offsets off this cursor instead of doing
// their own socket handshake (a 20d20 is a single reservation, not 20).
const rollCursor = { active: false, base: 0, used: 0, total: 0 };

// Serializes whole Roll evaluations so concurrent async Rolls on one client can
// never interleave their cursor reads/writes. Distinct from reservationTail, so a
// Roll may await a reservation while another evaluation waits on this mutex.
let evaluationMutex = Promise.resolve();
function withEvaluation(fn) {
  const run = evaluationMutex.then(fn);
  evaluationMutex = run.catch(() => {});
  return run;
}

// Sum of declared dice across a Roll's term tree (parentheticals and dice pools
// included). Used only to size the single batched reservation.
function countTermDice(roll) {
  if (!roll || !Array.isArray(roll.terms)) return 0;
  const DiceTerm = foundry.dice.terms.DiceTerm;
  let total = 0;
  for (const t of roll.terms) {
    if (DiceTerm && t instanceof DiceTerm) total += t.number || 0;
    else if (t?.roll && Array.isArray(t.roll.terms)) total += countTermDice(t.roll);
    else if (Array.isArray(t?.rolls)) total += t.number || 1;
  }
  return total;
}

// Reserve one contiguous block for the whole Roll, then evaluate. Replacement for
// the original Roll evaluator (evaluate/_evaluateAST/_evaluateASTAsync).
function seedRollEvaluate(_rollEval) {
  return async function (options) {
    if (rollCursor.active) return _rollEval.call(this, options);
    const opts = options ?? {};
    if (!settingsGet(SETTINGS.enabled, true) || opts.maximize || opts.minimize) {
      return _rollEval.call(this, opts);
    }
    const total = countTermDice(this);
    if (total <= 0) return _rollEval.call(this, opts);
    return withEvaluation(async () => {
      const base = await reserveSlots(total);
      rollCursor.active = true;
      rollCursor.base = base;
      rollCursor.used = 0;
      rollCursor.total = total;
      try {
        return await _rollEval.call(this, opts);
      } finally {
        rollCursor.active = false;
        rollCursor.base = 0;
        rollCursor.used = 0;
        rollCursor.total = 0;
      }
    });
  };
}

// ---- Entropy interception ----------------------------------------------------
// Every random draw in the dice system funnels through here. When a die term is
// being evaluated with an active seeded stream, its values come from that stream;
// otherwise (rolls outside a die term, or module disabled) we fall back to native.
function randomUniformOverride() {
  if (stream.active && stream.rng) return stream.rng();
  return nativeUniform();
}

// Carve the term's slots out of the enclosing Roll's batched reservation (or, for
// a standalone term outside any Roll, reserve its own block), seed a fresh PRNG
// from daySeed:base, run the original roll, and release the stream. Internal draws
// (explosions, rerolls, keep/drop, pool sub-dice) share one deterministic stream —
// the active-stream guard prevents them from re-reserving or clobbering it.
function seedTermRoll(_termRoll) {
  return async function (rollOptions) {
    const opts = rollOptions ?? {};
    if (!settingsGet(SETTINGS.enabled, true) || opts.maximize || opts.minimize) {
      return _termRoll.call(this, opts);
    }
    // Nested evaluation (explosion, reroll, pool sub-die): reuse the active stream.
    if (stream.active) return _termRoll.call(this, opts);
    const number = this.number || 1;
    let base;
    if (rollCursor.active) {
      if (rollCursor.used + number > rollCursor.total) {
        // Estimation mismatch safety valve: never reuse a slot, supplement instead.
        console.warn(`${MODULE_ID} | Roll had more dice than estimated; reserving supplementary slots.`);
        base = await reserveSlots(number);
      } else {
        base = rollCursor.base + rollCursor.used;
        rollCursor.used += number;
      }
    } else {
      base = await reserveSlots(number);
    }
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
    hint: "Global per-die-roll counter for the current day. Visible to GMs for inspection; edit only to hand-correct drift, then /roll-reset before replaying.",
    scope: "world",
    config: true,
    type: Number,
    default: 0
  });
});

Hooks.once("ready", () => {
  // Always register the reservation handler, no matter what the authority was at
  // ready time. The authority is checked per-message, so a GM that connects or is
  // promoted later starts answering automatically (isCounterAuthority() re-evaluates
  // live against active GMs). The acknowledgment returns only to the requester.
  if (game.socket) {
    gmWasActive = hasActiveGM();
    game.socket.on(SOCKET_EVENT, (data, ack) => {
      if (data?.type !== "reserve") return;
      const respond = (payload) => {
        if (typeof ack === "function") ack(payload);
      };
      try {
        if (isCounterAuthority()) {
          const count = Math.max(1, Math.floor(Number(data.count) || 1));
          respond({ type: "reserve", id: data.id, base: grantOnce(String(data.id), count) });
        }
      } catch (err) {
        console.error(`${MODULE_ID} | Error handling a roll counter reservation.`, err);
        respond({ type: "reserve", id: data.id, error: true });
      }
    });
  } else {
    console.warn(
      `${MODULE_ID} | Socket namespace unavailable. Ensure the module manifest declares "socket": true and the world was reloaded; otherwise player rolls fall back to the degraded local counter.`
    );
  }

  // When this client becomes/assumes the counter authority (a GM logs in or out),
  // re-sync the shadow from the persisted setting before fielding reservations.
  Hooks.on("updateUser", (user, data) => {
    if (typeof data.active === "undefined") return;
    // A GM appearing lets every client give up its degraded local counter so a
    // later fallback re-reads the authoritative setting instead of local drift.
    if (hasActiveGM() && !gmWasActive) noGMCounter = null;
    gmWasActive = hasActiveGM();
    if (game.user.isGM && isCounterAuthority()) {
      gmShadow = settingsGet(SETTINGS.rollIndex, 0);
      console.log(`${MODULE_ID} | Now the roll counter authority. Counter at`, gmShadow);
    }
  });

  console.log(
    `${MODULE_ID} | socket=${!!game.socket} event=${SOCKET_EVENT} counterAuthority=${isCounterAuthority()}`
  );

  // Batch a Roll's declared dice into a single reservation. Roll#evaluate funnels
  // into the AST evaluators, so wrapping those covers every dice path; the
  // rollCursor.active guard makes nested calls (evaluate -> _evaluateAST, pool
  // inner rolls) pass through without double-reserving.
  const Roll = foundry.dice.Roll;
  if (Roll?.prototype?.evaluate) {
    Roll.prototype.evaluate = seedRollEvaluate(Roll.prototype.evaluate);
  }
  for (const name of ["_evaluateAST", "_evaluateASTAsync"]) {
    const proto = Roll?.prototype ?? {};
    if (typeof proto[name] === "function" && proto[name] !== proto.evaluate) {
      proto[name] = seedRollEvaluate(proto[name]);
    }
  }

  // Register /roll-reset as a native chat command (v14 ChatLog.CHAT_COMMANDS).
  // Typing any unknown "/command" throws before a message is even created, so the
  // command must be registered here (ready, when the foundry namespace exists).
  const ChatLog = foundry.applications.sidebar.tabs.ChatLog;
  if (ChatLog?.CHAT_COMMANDS && !ChatLog.CHAT_COMMANDS["roll-reset"]) {
    ChatLog.CHAT_COMMANDS["roll-reset"] = {
      rgx: /^\/roll-reset(?:\s|$)/,
      fn: async function () {
        if (isCounterAuthority()) {
          gmShadow = 0;
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
