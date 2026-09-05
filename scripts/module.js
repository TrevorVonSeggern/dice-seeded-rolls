const MODULE_ID = "dice-seeded-rolls";
const SOCKET_EVENT = `module.${MODULE_ID}`;

// World-synced, GM-only state
const SETTINGS = {
	enabled: "enabled",
	daySeed: "daySeed",
	rollIndex: "rollIndex"
};

let currentSeed = null;
let currentOffset = null;
let gmWasActive = false; // players are local to start pre-gm
let degradedOffset = null; // local chain position when no GM reply is available

function settingsGet(key, fallback) {
	try {
		return game.settings.get(MODULE_ID, key);
	} catch (e) {
		return fallback ?? 0;
	}
}

function settingsSet(key, value) {
	return game.settings.set(MODULE_ID, key, value);
}

Hooks.once("init", () => {
	// register settings into the world
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

// Math function for generating random numbers from seed.
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

function nextRandom(seed, i) {
	if(!settingsGet(SETTINGS.enabled, false))
		return Math.random();
	seed = seed ?? currentSeed ?? settingsGet(SETTINGS.daySeed);
	i = i ?? currentOffset ?? settingsGet(SETTINGS.rollIndex);
	return mulberry32(hashSeed(`${seed}:${i}`))();
}

// Count all dice rolled from foundries dice objects.
function countTermDice(roll) {
	if (!roll || !Array.isArray(roll.terms))
		return 0;
	const DiceTerm = foundry.dice.terms.DiceTerm;
	let total = 0;
	for (const t of roll.terms) {
		if (DiceTerm && t instanceof DiceTerm) total += t.number || 0;
			else if (t?.roll && Array.isArray(t.roll.terms)) total += countTermDice(t.roll);
				else if (Array.isArray(t?.rolls)) total += t.number || 1;
	}
	return total;
}

function generateRequestId() {
	return `reserve-${game.user.id}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

// Need to be GM, and highest id of GM to be authority.
function isCounterAuthority() {
	if (!game.user.isGM)
		return false;
	const actives = game.users.filter((u) => u.isGM && u.active);
	if (actives.length < 2)
		return true;
	return actives.sort((a, b) => (a.id < b.id ? -1 : 1))[0].id === game.user.id;
}

function hasActiveGM() {
	return game.users.some((u) => u.isGM && u.active);
}

function gmAdvance(count) {
	var next = settingsGet(SETTINGS.rollIndex) + count;
	settingsSet(SETTINGS.rollIndex, next);
	return next;
}

function gmBroadcast() {
	const broadcastBody = {
		id: generateRequestId(),
		rollIndex: settingsGet(SETTINGS.rollIndex),
		seed: settingsGet(SETTINGS.daySeed),
		type: "broadcast"
	};
	game.socket.emit(SOCKET_EVENT, broadcastBody);
}

// check for changes to GM role
Hooks.on("updateUser", (_user, data) => {
	if (data.active === undefined)
		return;
	if (!gmWasActive && hasActiveGM())
		gmWasActive = true;
	if (game.user.isGM && isCounterAuthority()) {
		console.log(`${MODULE_ID} | Now the roll counter authority. Counter at`, settingsGet(SETTINGS.rollIndex));
	}
});

Hooks.once("ready", () => {
	if(!game.socket) {
		console.warn(`${MODULE_ID} | Socket namespace unavailable.`);
		return;
	}
	gmWasActive = hasActiveGM();

	// Counter Authority handle count and broadcast result.
	game.socket.on(SOCKET_EVENT, (data, response) => {
		if (!data || data?.type !== "reserve" || !isCounterAuthority())
			return;
		const requestedCount = Math.floor(Number(data.count ?? 0)) || 1;
		var prevCount = settingsGet(SETTINGS.rollIndex);
		var seed = settingsGet(SETTINGS.daySeed);
		const responseBody = {
			id: data.id,
			type: "reserve-respond",
			rolls: Array.from({length: requestedCount}).map((_, i) => nextRandom(seed, prevCount + i))
		};
		if (typeof response === "function")
			response(responseBody);
		gmAdvance(requestedCount);
		gmBroadcast();
	});

	game.socket.on(SOCKET_EVENT, data => {
		if (!data || data?.type !== "broadcast" || isCounterAuthority())
			return;
		currentOffset = data.rollIndex;
		currentSeed = data.seed;
		degradedOffset = null;
	});
});

// Degraded path: no GM online, or the GM's reply was missing or stale. Chain a
// deterministic block locally, advancing from the last synced world counter so the
// day's sequence stays continuous without touching world state.
function chainLocalRolls(count) {
	if (degradedOffset === null)
		degradedOffset = settingsGet(SETTINGS.rollIndex, 0);
	return Array.from({ length: count }, () => nextRandom(undefined, degradedOffset++));
}

function requestRollsFromServerAsync(count) {
	if(isCounterAuthority()) {
		const base = settingsGet(SETTINGS.rollIndex, 0);
		const rolls = Array.from({ length: count }, (_, i) => nextRandom(undefined, base + i));
		gmAdvance(count);
		return Promise.resolve(rolls);
	}
	if(!hasActiveGM())
		return Promise.resolve(chainLocalRolls(count));
	return new Promise(finish => {
		var reserveRequestBody = {
			type: "reserve",
			id: generateRequestId(),
			from: game.user.id,
			count
		};
		game.socket.emit(SOCKET_EVENT, reserveRequestBody, (resp) => {
			if (resp && Array.isArray(resp.rolls)) {
				finish(resp.rolls);
			} else {
				finish(chainLocalRolls(count));
			}
		});
	});
}

// Register /roll-reset
Hooks.once("ready", () => {
	const ChatLog = foundry.applications.sidebar.tabs.ChatLog;
	if (ChatLog?.CHAT_COMMANDS && !ChatLog.CHAT_COMMANDS["roll-reset"]) {
		ChatLog.CHAT_COMMANDS["roll-reset"] = {
			rgx: /^\/roll-reset(?:\s|$)/,
			fn: async function () {
				if (!isCounterAuthority())
					return;
				settingsSet(SETTINGS.rollIndex, 0);
				console.log(`${MODULE_ID} | Roll counter reset to 0. Seed unchanged:`, settingsGet(SETTINGS.daySeed));
				gmBroadcast();
				return false; // Return false to consume the command so nothing is posted to chat.
			}
		};
	}
});



// Roll-scoped cursor: the chunk of uniform values this Roll reserved in one batch.
// Die terms slice their uniforms off this cursor instead of doing their own round trip.
const rollCursor = { active: false, rolls: [], used: 0, total: 0 };

// Stream currently feeding the interleaved RNG consumer during a die term's own
// evaluation. randomUniformOverride pops values off it one die at a time.
const stream = { active: false, rolls: [], idx: 0 };

// Serialize whole Roll evaluations so concurrent async Rolls on one client never
// interleave their cursor reads/writes.
let evaluationMutex = Promise.resolve();
function withEvaluation(fn) {
	const run = evaluationMutex.then(fn);
	evaluationMutex = run.catch(() => {});
	return run;
}

// Every random draw in the dice system funnels through here (via
// CONFIG.Dice.randomUniform); a die term under an active stream consumes its
// pre-computed uniforms, otherwise native randomness is used.
function randomUniformOverride() {
	if (stream.active && stream.idx < stream.rolls.length)
		return stream.rolls[stream.idx++];
	return Math.random();
}

// Reserve one contiguous block for the whole Roll, then evaluate. Replacement for
// the original Roll evaluator (evaluate/_evaluateAST/_evaluateASTAsync).
function seedRollEvaluate(protoRollEvaluate) {
	return async function (options) {
		if (rollCursor.active)
			return protoRollEvaluate.call(this, options);
		const opts = options ?? {};
		if (!settingsGet(SETTINGS.enabled, true) || opts.maximize || opts.minimize)
			return protoRollEvaluate.call(this, opts);
		const total = countTermDice(this);
		if (total <= 0)
			return protoRollEvaluate.call(this, opts);
		return withEvaluation(async () => {
			const rolls = await requestRollsFromServerAsync(total);
			rollCursor.active = true;
			rollCursor.rolls = rolls;
			rollCursor.used = 0;
			rollCursor.total = total;
			try {
				return await protoRollEvaluate.call(this, opts);
			} finally {
				rollCursor.active = false;
				rollCursor.rolls = [];
				rollCursor.used = 0;
				rollCursor.total = 0;
			}
		});
	};
}

// Carve the term's uniforms out of the enclosing Roll's batched reservation (or, for
// a standalone term outside any Roll, fetch its own block), make them the active
// stream, run the original roll, and release the stream. Internal draws (explosions,
// rerolls, keep/drop, pool sub-dice) share one stream — the active-stream guard
// prevents them from re-reserving or clobbering it.
function seedTermRoll(prototype) {
	return async function (rollOptions) {
		const opts = rollOptions ?? {};
		if (!settingsGet(SETTINGS.enabled, true) || opts.maximize || opts.minimize)
			return prototype.call(this, opts);

		// Nested evaluation (explosion, reroll, pool sub-die): reuse the active stream.
		if (stream.active)
			return prototype.call(this, opts);

		const number = this.number || 1;
		let rolls;
		if (rollCursor.active) {
			if (rollCursor.used + number > rollCursor.total) {
				// Estimation mismatch safety valve: never reuse a slot, supplement instead.
				console.warn(`${MODULE_ID} | Roll had more dice than estimated; reserving supplementary slots.`);
				rolls = await requestRollsFromServerAsync(number);
			} else {
				rolls = rollCursor.rolls.slice(rollCursor.used, rollCursor.used + number);
				rollCursor.used += number;
			}
		} else {
			rolls = await requestRollsFromServerAsync(number);
		}
		stream.active = true;
		stream.rolls = rolls;
		stream.idx = 0;
		try {
			return await prototype.call(this, opts);
		} finally {
			stream.active = false;
			stream.rolls = [];
			stream.idx = 0;
		}
	};
}



Hooks.once("ready", () => {
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
  return indices.map((i) => faceFromUniform(faces, nextRandom(seed, i)));
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

// Thin introspection surface
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
