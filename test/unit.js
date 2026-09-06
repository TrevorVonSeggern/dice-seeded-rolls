// Unit tests for dice-seeded-rolls scripts/module.js.
// Run with: node test/unit.js
//
// Exercises the module's counter/settings/seed machinery against a headless Foundry
// sandbox: settingsGet, settingsSet, gmAdvance, nextRandom, countTermDice, plus the
// socket reservation flow and end-to-end die evaluation determinism.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "module.js"),
  "utf8"
);

// const-level names in the module never leak to the VM global, so hardcode the keys.
const KEYS = { enabled: "enabled", daySeed: "daySeed", rollIndex: "rollIndex" };

// ---- sandbox ---------------------------------------------------------------

function newWorld() {
  return {
    defaults: { enabled: true, daySeed: 7704, rollIndex: 0 },
    stored: {},
    gmActive: true,
    clients: [],
    emits: [],
  };
}

function makeSandbox({ world, isGM }) {
  const gmActive = world.gmActive ?? true;

  class FakeDiceTerm {
    constructor(number, faces) {
      this.number = number;
      this.faces = faces;
      this.results = [];
    }
    // Foundry v12+ semantics: _evaluate loops once per die and roll() returns a
    // single DiceTermResult, pulling one uniform from CONFIG.Dice.randomUniform
    // (replaced by the module's seeded override in ready) per draw.
    async _evaluate(options) {
      this.results = [];
      for (let done = 0; done < this.number; done++) {
        await this.roll(options);
      }
      return this;
    }
    async roll() {
      const u = sandbox.CONFIG.Dice.randomUniform();
      const roll = { result: Math.min(this.faces, Math.floor(u * this.faces) + 1), active: true };
      this.results.push(roll);
      return roll;
    }
    get total() {
      return this.results.reduce((s, r) => s + r.result, 0);
    }
  }
  class FakeDie extends FakeDiceTerm {}
  class FakeDicePool extends FakeDiceTerm {}

  const handlers = [];
  const userId = isGM ? "gm-a" : "player-1";
  world.clients.push({ id: userId, handlers });

  const sandbox = {
    game: {
      user: { id: userId, isGM },
      users: {
        filter: (fn) =>
          (gmActive ? [{ id: "gm-a", isGM: true, active: true }] : []).filter(fn),
        some: (fn) =>
          gmActive ? [{ id: "gm-a", isGM: true, active: true }].some(fn) : false,
      },
      settings: {
        register: (_m, key) => {
          world.registered ??= new Set();
          world.registered.add(key);
        },
        registerMenu: () => {},
        get: (_m, key) => {
          // Foundry throws for unregistered keys; module settingsGet catches -> fallback.
          if (!world.registered?.has(key)) throw new Error(`not registered: ${key}`);
          return key in world.stored ? world.stored[key] : world.defaults[key];
        },
        set: (_m, key, value) => {
          world.stored[key] = value;
          return Promise.resolve();
        },
      },
      socket: {
        on: (_ev, fn) => {
          handlers.push(fn);
        },
        emit: (_ev, data, cb) => {
          world.emits.push(data);
          // The server relays the data to every other client; the emit callback is a
          // server receipt echo and does not carry replies from other clients.
          if (typeof cb === "function") cb?.(data);
          if (world.relayEnabled === false) return;
          for (const client of world.clients) {
            if (client.id === userId) continue;
            let payload = data;
            if (data?.type === "reserve" && world.reserveOverride) {
              const override = world.reserveOverride(data);
              if (override === undefined) continue; // reply dropped
              payload = override;
            }
            for (const h of client.handlers) h(payload);
          }
        },
      },
    },
    foundry: {
      dice: {
        terms: { DiceTerm: FakeDiceTerm, DicePool: FakeDicePool, Die: FakeDie },
        Roll: null,
      },
      applications: { sidebar: { tabs: { ChatLog: { CHAT_COMMANDS: {} } } } },
    },
    CONFIG: { Dice: {} },
    Math,
    Date,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: (fn, ms) => (world.fakeClock ? world.fakeClock.set(fn) : globalThis.setTimeout(fn, ms)),
    clearTimeout: (id) => (world.fakeClock ? world.fakeClock.clear(id) : globalThis.clearTimeout(id)),
  };
  sandbox.CONFIG.Dice.randomUniform = () => Math.min(0.999999, Math.random());
  // Foundry's Roll.prototype.evaluate chains term evaluations; attach a fake here so
  // the module's ready hook wraps it into the seeded evaluator.
  const RollEvaluate = async function (options) {
    for (const t of this.terms) {
      if (t instanceof FakeDiceTerm) await t._evaluate(options);
      else if (t?.roll && Array.isArray(t.roll.terms)) await t.roll.evaluate?.(options);
    }
    return this;
  };
  sandbox.foundry.dice.Roll = {
    prototype: {
      evaluate: RollEvaluate,
      _evaluateAST: RollEvaluate,
      _evaluateASTAsync: RollEvaluate,
      _evaluate: RollEvaluate,
    },
  };
  sandbox.CONFIG.Dice.randomUniform = () => Math.min(0.999999, Math.random());

  const ready = [];
  const init = [];
  sandbox.Hooks = {
    on: () => {},
    once: (name, cb) => (name === "init" ? init : ready).push(cb),
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SRC, ctx, { filename: "module.js" });
  for (const cb of init) cb();
  for (const cb of ready) cb({});
  return ctx;
}

// Cross-realm arrays (created inside the VM) vs host-realm values: compare
// element-wise on primitives so prototype identity never matters.
function assertNumbersEqual(actual, expected, msg) {
  assert.strictEqual(actual.length, expected.length, `${msg}: length`);
  for (let i = 0; i < actual.length; i++) {
    assert.strictEqual(actual[i], expected[i], `${msg} [${i}]`);
  }
}

// ---- tests ----------------------------------------------------------------

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("settingsGet/settingsSet round-trip with defaults", () => {
  const world = newWorld();
  const ctx = makeSandbox({ world, isGM: true });

  assert.strictEqual(ctx.settingsGet(KEYS.enabled, true), true);
  assert.strictEqual(ctx.settingsGet(KEYS.daySeed, 0), 7704);
  assert.strictEqual(ctx.settingsGet(KEYS.rollIndex, 0), 0);
  assert.strictEqual(ctx.settingsGet("unregistered", 42), 42);

  ctx.settingsSet(KEYS.daySeed, 12345);
  ctx.settingsSet(KEYS.rollIndex, 7);
  assert.strictEqual(world.stored[KEYS.daySeed], 12345);
  assert.strictEqual(world.stored[KEYS.rollIndex], 7);
  assert.strictEqual(ctx.settingsGet(KEYS.daySeed, 0), 12345);
  assert.strictEqual(ctx.settingsGet(KEYS.rollIndex, 0), 7);
});

test("gmAdvance advances the persisted counter and returns the new value", () => {
  const world = newWorld();
  const ctx = makeSandbox({ world, isGM: true });

  assert.strictEqual(ctx.gmAdvance(3), 3);
  assert.strictEqual(world.stored[KEYS.rollIndex], 3);
  assert.strictEqual(ctx.gmAdvance(2), 5);
  assert.strictEqual(ctx.settingsGet(KEYS.rollIndex, 0), 5);
});

test("nextRandom is deterministic per (seed, offset) pair", () => {
  const world = newWorld();
  const ctx = makeSandbox({ world, isGM: true });

  const a = ctx.nextRandom(7704, 12);
  assert.strictEqual(a, ctx.nextRandom(7704, 12));
  assert.notStrictEqual(a, ctx.nextRandom(7704, 13));
  assert.notStrictEqual(a, ctx.nextRandom(7705, 12));
  assert.ok(a >= 0 && a < 1, "uniform in [0,1)");
});

test("nextRandom falls back to daySeed + rollIndex when args omitted", () => {
  const world = newWorld();
  const ctx = makeSandbox({ world, isGM: true });
  ctx.settingsSet(KEYS.rollIndex, 4);
  ctx.settingsSet(KEYS.daySeed, 999);

  assert.strictEqual(ctx.nextRandom(), ctx.nextRandom(999, 4));
});

test("nextRandom bypasses the PRNG when the module is disabled", () => {
  const world = newWorld();
  const ctx = makeSandbox({ world, isGM: true });

  const seeded = ctx.nextRandom(7704, 0);
  ctx.settingsSet(KEYS.enabled, false);
  const disabled1 = ctx.nextRandom(7704, 0);
  const disabled2 = ctx.nextRandom(7704, 0);
  assert.notStrictEqual(disabled1, seeded, "disabled must not produce the seeded value");
  assert.notStrictEqual(disabled2, seeded, "disabled must not produce the seeded value");
  assert.notStrictEqual(disabled1, disabled2, "disabled draws are independent");
});

test("countTermDice aggregates Die terms, pools, rolled terms, and .rolls", () => {
  const world = newWorld();
  const ctx = makeSandbox({ world, isGM: true });

  const { DiceTerm, DicePool } = ctx.foundry.dice.terms;
  const die = new DiceTerm(2, 20);
  const die1 = new DiceTerm(1, 6);
  const pool = new DicePool(3, 20);

  assert.strictEqual(ctx.countTermDice({ terms: [die, die1] }), 3);
  assert.strictEqual(ctx.countTermDice({ terms: [pool] }), 3);
  assert.strictEqual(ctx.countTermDice({ terms: [{ number: 2, rolls: [{}] }] }), 2);

  assert.strictEqual(ctx.countTermDice(null), 0);
  assert.strictEqual(ctx.countTermDice({}), 0);
  assert.strictEqual(ctx.countTermDice({ terms: [] }), 0);
});

test("GM authority: reservation returns nextRandom uniforms and advances the counter", async () => {
  const world = newWorld();
  const ctx = makeSandbox({ world, isGM: true });
  world.stored[KEYS.rollIndex] = 0;

  const rolls = await ctx.requestRollsFromServerAsync(3);
  const expected = [0, 1, 2].map((i) => ctx.nextRandom(world.defaults.daySeed, i));
  assertNumbersEqual(rolls, expected, "GM rolls");
  assert.strictEqual(world.stored[KEYS.rollIndex], 3);
});

test("player reservation through the GM returns the GM-computed uniforms", async () => {
  const world = newWorld();
  makeSandbox({ world, isGM: true }); // registers the reserve handler
  assert.ok(
    world.clients.some((c) => c.id === "gm-a" && c.handlers.length > 0),
    "GM registered a reserve handler"
  );

  const ctx = makeSandbox({ world, isGM: false });
  const rolls = await ctx.requestRollsFromServerAsync(2);
  const expected = [0, 1].map((i) => ctx.nextRandom(world.defaults.daySeed, i));
  assertNumbersEqual(rolls, expected, "player->GM rolls");
  assert.strictEqual(world.stored[KEYS.rollIndex], 2);
});

test("no-GM degraded path chains a local offset from the world counter", async () => {
  const world = newWorld();
  world.gmActive = false;
  world.stored[KEYS.rollIndex] = 4;
  const ctx = makeSandbox({ world, isGM: false });

  const first = await ctx.requestRollsFromServerAsync(1);
  const second = await ctx.requestRollsFromServerAsync(1);
  assert.strictEqual(first[0], ctx.nextRandom(world.defaults.daySeed, 4));
  assert.strictEqual(second[0], ctx.nextRandom(world.defaults.daySeed, 5));
  assert.strictEqual(world.stored[KEYS.rollIndex], 4, "world counter untouched when no GM");
});

test("absent reservation reply degrades to the local chain after the timeout", async () => {
  const world = newWorld();
  makeSandbox({ world, isGM: true }); // GM online but its replies never arrive
  world.stored[KEYS.rollIndex] = 4;
  world.relayEnabled = false;
  world.fakeClock = { set: (fn) => (world.deferred = fn), clear: () => {} };
  const ctx = makeSandbox({ world, isGM: false });

  const pendingRolls = ctx.requestRollsFromServerAsync(2);
  world.deferred(); // reservation times out, no GM reply received
  const rolls = await pendingRolls;
  const expected = [0, 1].map((i) => ctx.nextRandom(world.defaults.daySeed, 4 + i));
  assertNumbersEqual(rolls, expected, "degraded chain starts at synced rollIndex");
  assert.strictEqual(world.stored[KEYS.rollIndex], 4, "GM world counter untouched");
});

test("roll-index command reads the current index and seed", async () => {
  const world = newWorld();
  const ctx = makeSandbox({ world, isGM: true });
  world.stored[KEYS.rollIndex] = 7;
  world.stored[KEYS.daySeed] = 7704;
  const cmd = ctx.foundry.applications.sidebar.tabs.ChatLog.CHAT_COMMANDS["roll-index"];

  const match = "/roll-index".match(cmd.rgx);
  const result = await cmd.fn(null, "/roll-index", match);
  assert.strictEqual(result, false, "command consumes the message");
  assert.strictEqual(world.stored[KEYS.rollIndex], 7, "read does not change the index");
});

test("roll-index command sets the index as the authority and broadcasts", async () => {
  const world = newWorld();
  const ctx = makeSandbox({ world, isGM: true });
  world.stored[KEYS.rollIndex] = 3;
  const cmd = ctx.foundry.applications.sidebar.tabs.ChatLog.CHAT_COMMANDS["roll-index"];

  const match = "/roll-index 9".match(cmd.rgx);
  await cmd.fn(null, "/roll-index 9", match);
  assert.strictEqual(world.stored[KEYS.rollIndex], 9, "world counter set to 9");
  assert.ok(
    world.emits.some((e) => e?.type === "broadcast" && e.rollIndex === 9),
    "counter change broadcast to clients"
  );
});

test("roll-index command refuses both read and set as a non-authority", async () => {
  const world = newWorld();
  makeSandbox({ world, isGM: true }); // real GM owns the counter
  const ctx = makeSandbox({ world, isGM: false });
  world.stored[KEYS.rollIndex] = 3;
  const cmd = ctx.foundry.applications.sidebar.tabs.ChatLog.CHAT_COMMANDS["roll-index"];

  const reads = "/roll-index".match(cmd.rgx);
  const readResult = await cmd.fn(null, "/roll-index", reads);
  assert.strictEqual(readResult, false, "read is consumed for non-authority");
  assert.strictEqual(world.stored[KEYS.rollIndex], 3, "player cannot change the world counter");

  const sets = "/roll-index 9".match(cmd.rgx);
  await cmd.fn(null, "/roll-index 9", sets);
  assert.strictEqual(world.stored[KEYS.rollIndex], 3, "player cannot set the world counter");
  assert.ok(
    !world.emits.some((e) => e?.type === "broadcast"),
    "player actions never broadcast a counter change"
  );
});

test("roll-reset command requires the counter authority", async () => {
  const world = newWorld();
  makeSandbox({ world, isGM: true }); // real GM owns the counter
  const ctx = makeSandbox({ world, isGM: false });
  world.stored[KEYS.rollIndex] = 5;
  const cmd = ctx.foundry.applications.sidebar.tabs.ChatLog.CHAT_COMMANDS["roll-reset"];

  const result = await cmd.fn(null, "/roll-reset", "/roll-reset".match(cmd.rgx));
  assert.strictEqual(result, false, "reset is consumed even when refused");
  assert.strictEqual(world.stored[KEYS.rollIndex], 5, "player cannot reset the world counter");
});

test("stale old-shape reply degrades to the local chain", async () => {
  const world = newWorld();
  makeSandbox({ world, isGM: true });
  world.stored[KEYS.rollIndex] = 9;
  // Old 0.0.8-style grant reply: base/count, no rolls array.
  world.reserveOverride = (req) => ({ id: req.id, type: "reserve-respond", base: 9, count: 2 });
  const ctx = makeSandbox({ world, isGM: false });

  const rolls = await ctx.requestRollsFromServerAsync(2);
  const expected = [0, 1].map((i) => ctx.nextRandom(world.defaults.daySeed, 9 + i));
  assertNumbersEqual(rolls, expected, "rejects wrong shape, uses degraded chain");
  assert.strictEqual(world.stored[KEYS.rollIndex], 9, "GM counter untouched by override");
});

test("end-to-end: 2d20 evaluation reproduces the exact seeded faces", async () => {
  const world = newWorld();
  makeSandbox({ world, isGM: true });
  const ctx = makeSandbox({ world, isGM: false });
  world.stored[KEYS.rollIndex] = 0;

  const { Die } = ctx.foundry.dice.terms;
  const roll = {
    terms: [new Die(2, 20)],
    async evaluate(o) {
      await ctx.foundry.dice.Roll.prototype.evaluate.call(this, o);
      return this;
    },
  };
  await roll.evaluate();

  // Seed 7704: uniforms at offsets 0 and 1 map to faces 20 and 1. The second die
  // must NOT reuse the first die's uniform (the reason a 2d20 rolled 20,20).
  assert.deepStrictEqual(
    roll.terms[0].results.map((r) => r.result),
    [20, 1],
    "each die consumes its own offset"
  );
  assert.strictEqual(world.stored[KEYS.rollIndex], 2, "counter advanced by declared dice");

  // Second roll occupies fresh slots -> reproduces its own deterministic faces.
  world.stored[KEYS.rollIndex] = 2;
  const roll2 = {
    terms: [new Die(2, 20)],
    async evaluate(o) {
      await ctx.foundry.dice.Roll.prototype.evaluate.call(this, o);
      return this;
    },
  };
  await roll2.evaluate();
  assert.deepStrictEqual(
    roll2.terms[0].results.map((r) => r.result),
    [20, 19],
    "subsequent roll uses advanced slots"
  );
});

test("v12 per-die roll calls pop one uniform each from the reservation", async () => {
  const world = newWorld();
  makeSandbox({ world, isGM: true }); // authority reserves [u0, u1]
  const ctx = makeSandbox({ world, isGM: false });
  world.stored[KEYS.rollIndex] = 0;

  const { Die } = ctx.foundry.dice.terms;
  const die = new Die(2, 20);
  await die._evaluate();

  const uniforms = ctx.nextRandom;
  assert.deepStrictEqual(
    die.results.map((r) => r.result),
    [20, 1],
    "two roll() calls produce two distinct seeded faces"
  );
  assert.strictEqual(die.results[1].result, ctx.faceFromUniform(20, uniforms(world.defaults.daySeed, 1)));
  assert.strictEqual(world.stored[KEYS.rollIndex], 2, "standalone term advances the counter");
});

test("standalone Die evaluation outside any Roll gets its own seeded block", async () => {
  const world = newWorld();
  makeSandbox({ world, isGM: true }); // authority, no socket round trip needed
  const ctx = makeSandbox({ world, isGM: true });
  world.stored[KEYS.rollIndex] = 0;

  const { Die } = ctx.foundry.dice.terms;
  const die = new Die(2, 20);
  await die._evaluate();
  assert.deepStrictEqual(
    die.results.map((r) => r.result),
    [20, 1],
    "standalone term is seeded like any other"
  );
  assert.strictEqual(world.stored[KEYS.rollIndex], 2);
});

// ---- runner ---------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (e) {
      failed += 1;
      console.error(`FAIL ${name}: ${e.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
