#!/usr/bin/env bash
# Run all dice-seeded-rolls tests. Exit non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."

node --check scripts/module.js
node --check test/unit.js
node test/unit.js