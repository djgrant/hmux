import { defineCommand } from '@pokit/core';

export const command = defineCommand({
  label: 'Run tests',
  run: async (r) => {
    // Per-package so each suite runs in its own cwd (module resolution is
    // cwd-sensitive here) and the vendored repos/ trees are never swept.
    await r.exec('pnpm -r --if-present run test');
  },
});
