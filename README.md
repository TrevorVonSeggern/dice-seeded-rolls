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
- Each die term reserves a contiguous block of counter slots: when a `1d20` evaluates at
  `rollIndex = N`, all its values come from a PRNG seeded by `hash(daySeed : N)`, then the
  counter advances by the number of declared dice. An identical die at an identical position
  always reproduces the same faces.
- Resetting the roll counter (`rollIndex = 0`) replays the sequence from the start, so the
  first `1d20` of the new "day" always yields the same number.

Control is **GM-only** (world settings are not shown to players).

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
- **Toggle detection**: toggle `Enabled`. When disabled, rolls fall back to Foundry's native
  randomness **without advancing the counter**. Re-enabling resumes at the last counter value,
  so always `/roll-reset` to establish a clean baseline before a replay.

## Important caveats

- Foundry evaluates dice on the **rolling player's client**. Because the counter is
  world-synced, determinism holds under **sequential, turn-based play** — the normal D&D case.
  If two players roll in the *literal same instant*, both may read the same `rollIndex` slot
  (a race). Keep rolls effectively sequential for exact replays.
- The seeded stream is established at the **die term** boundary. Randomness requested outside a
  die term (e.g. a system calling `CONFIG.Dice.randomUniform` directly, not via `Die`/`DiePool`)
  falls back to native randomness and does not advance the counter.

## Compatibility

Verified against Foundry **v14**. Minimum/maximum set to 14.

## Development

Plain JavaScript, no build step. Layout mirrors the reference module:

```
module.json                  # manifest: id, compatibility, esmodules, languages
scripts/module.js            # settings, seeded PRNG, randomUniform override, die-term counter, /roll-reset
lang/en.json                 # localization
.github/workflows/release.yml
```

### Releasing

Tag a release with `v<semver>` (e.g. `git tag v0.2.0 && git push --tags`). The GitHub
Action rewrites `module.json` (`version`, `download`), zips the module, and attaches
`module.zip` to the release. Install in Foundry via
`https://github.com/TrevorVonSeggern/dice-seeded-rolls/releases/latest/download/module.json`.
