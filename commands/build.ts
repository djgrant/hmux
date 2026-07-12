import { defineCommand } from '@pokit/core';

export const command = defineCommand({
  label: 'Build packages',
  run: async (r) => {
    await r.exec('pnpm -r --if-present run build');
  },
});
