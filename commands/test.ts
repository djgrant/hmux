import { defineCommand } from '@pokit/core';

export const command = defineCommand({
  label: 'Run tests',
  run: async (r, ctx) => {
    // Forward any extra args to the test runner (e.g. --watch, specific files)
    const extraArgs = ctx.extraArgs.length > 0 ? ` ${ctx.extraArgs.join(' ')}` : '';
    await r.exec(`bun test${extraArgs}`);
  },
});
