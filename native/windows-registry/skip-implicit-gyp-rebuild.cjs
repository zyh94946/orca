'use strict'

// Why: a root binding.gyp makes pnpm infer `node-gyp rebuild` as the install
// script. That still runs on macOS/Linux for this workspace package, and it
// invokes whatever `node-gyp` is on PATH (often a broken global pnpm shim).
// The win32 addon is built later by rebuild-native-deps / ensure-native-runtime.
process.exit(0)
