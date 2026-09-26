#!/usr/bin/env bash
# Run the integration tier (`vitest.integration.config.ts`): real sockets and
# spawned `ethos` processes, kept out of `pnpm test` because they are slow.
# Called by: CI's `integration` job; local devs.
#
# Nothing in this tier needs Docker, credentials, or the internet: every suite
# binds 127.0.0.1 and serves its own mock LLM / channel stand-ins, with HOME and
# ETHOS_STATE_DIR pointed into a temp dir. A suite that ever does need one must
# skip itself explicitly (`it.skipIf(...)`) rather than fail here.
set -euo pipefail
exec pnpm test:integration
