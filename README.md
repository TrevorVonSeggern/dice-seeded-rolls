# Dice Seeded Rolls

Foundry VTT module for a D&D one-shot "replay the day" loop. Every die result is
deterministically derived from a **day seed** and a **global per-die-roll counter**.
Resetting the roll counter makes all subsequent rolls reproduce identically, regardless of
which player performs them.

## How it works

- `daySeed` and `rollIndex` are stored as **world-scope settings**, auto-synced to every
  connected client by Foundry.
- `CONFIG.Dice.randomUniform` — Foundry's single entropy function for all dice — is replaced
  so every random draw is deterministic.
- Each **`Roll`** reserves its declared dice in a **single batched slot reservation**: a
  `20d20` is one counter reservation, not twenty. When a `Roll` evaluates at `rollIndex = N`,
  every die in it derives from a PRNG seeded by `hash(daySeed : N + offset)` (offsets fixed by
  term position), then the counter advances by the total number of declared dice. An identical
  roll at an identical position always reproduces the same faces.
- Resetting the roll counter (`rollIndex = 0`) replays the sequence from the start, so the
  first `1d20` of the new "day" always yields the same number.

Control is **GM-only** (world settings are not shown to players). The `rollIndex` counter lives
in a **world-scope setting that only the GM can write** — players reserve their slots through a
module socket instead of writing the setting directly, which keeps every client on the same
counter with no settings-permission errors. A player's `Roll` sends **one** reservation request
per roll; the GM (the counter authority) acks the reserved base slot and the roll evaluates
immediately. `rollIndex` is also visible in the module settings so a GM can inspect or
hand-correct the counter; always `/roll-reset` after a manual edit.

**Reliability:** the socket handler is registered on every client and the counter authority is
elected per-request (lowest-id active GM), so a GM who connects or is promoted later starts
answering immediately. Retries reuse the request id, so the GM re-acks the *same* reserved base —
a slow or repeated answer can never consume counter slots twice. If no GM is connected at all,
player rolls fall back to a local counter instantly (no wait). If a GM is connected but cannot be
reached, rolls fall back after ~2s (2 retries) with a console warning — dice still work, but
cross-client replay is not guaranteed. The local fallback counter is anchored to the last synced
`rollIndex` and to any slot a GM already granted this client, so it never re-treads used bases.
Check the GM/player console at startup for a `dice-seeded-rolls` line confirming the socket
namespace is live; if it reports sockets unavailable, ensure the manifest has `"socket": true` and
reload the world (an stale module build with no socket namespace makes every reservation fall back).

## GM usage

- **Pick the seed**: in Settings → `Dice Seeded Rolls` → set `Day Seed` to any number. Rolls
  are derived from `daySeed` + the roll counter, so picking a seed makes a day reproducible.
- **Find a seed for desired opening rolls**: open the browser console and use the module's
  helper to search for a seed whose first rolls match what you want, e.g.
  so the new day opens with a `1d20` of 20, then 1, then 20:

  ```js
  diceSeededRolls.findSeed([20, 1, 20]);
  // -> 7704  (set this as the Day Seed)
  diceSeededRolls.previewSeed(7704, 6);  // -> [20, 1, 20, 19, 10, 13]
  ```

  `findSeed(targetFaces, {faces, start, maxAttempts})` searches for a seed producing
  `targetFaces` as the first rolls of a `faces`-sided die (default `d20`). Then set the
  returned number as the Day Seed and `/roll-reset` the counter.
- **Start / reset a day**: type `/roll-reset` in chat (GM only). This **only** zeroes the roll
  counter; the day seed is left untouched. The command line is consumed and not posted to chat.
- **Inspect the counter**: type `/roll-index` in chat (GM only) to print the current roll index and
  day seed to the console.
- **Set the counter**: type `/roll-index <n>` in chat (GM only) to jump the roll
  index to an exact value. Handy for hand-correcting drift or resuming a partially consumed day;
  the change is broadcast to all clients. Like `/roll-reset`, the command line is consumed.
- **Toggle detection**: toggle `Enabled`. When disabled, rolls fall back to Foundry's native
  randomness **without advancing the counter**. Re-enabling resumes at the last counter value,
  so always `/roll-reset` to establish a clean baseline before a replay.

## Important caveats

- Foundry evaluates dice on the **rolling player's client**. The GM (counter authority)
  serializes counter reservations, so simultaneous rolls from different players still receive
  distinct slots. Exact replay still assumes the *same rolls happen in the same order* each
  "day" — the normal turn-based case.
- If no GM is connected, player rolls use a local fallback counter and are **not** guaranteed to
  match across clients.
- The seeded stream is established at the **`Roll` boundary** (per die term when a term is rolled
  standalone). Randomness requested outside a roll (e.g. a system calling
  `CONFIG.Dice.randomUniform` directly, not via `Roll`/`Die`/`DiePool`) falls back to native
  randomness and does not advance the counter. Each batch reservation is exactly the declared
  dice count — no block prefetching — so counter slot assignment depends only on roll order,
  never on network timing.

## Compatibility

Verified against Foundry **v14**. Minimum/maximum set to 14.

## Development

Plain JavaScript, no build step. Layout mirrors the reference module:

```
module.json                  # manifest: id, compatibility, esmodules, languages
scripts/module.js            # settings, seeded PRNG, randomUniform override, die-term counter, /roll-reset, /roll-index
lang/en.json                 # localization
.github/workflows/release.yml
```

### Releasing

Tag a release with `v<semver>` (e.g. `git tag v0.2.0 && git push --tags`). The GitHub
Action rewrites `module.json` (`version`, `download`), zips the module, and attaches
`module.zip` to the release. Install in Foundry via
`https://github.com/TrevorVonSeggern/dice-seeded-rolls/releases/latest/download/module.json`.
