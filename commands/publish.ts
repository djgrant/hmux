/**
 * Publish command
 *
 * Publishes the workspace packages to npm directly from the machine. The normal
 * flow is `pok version` (which pushes a tag the Release workflow publishes from)
 * — this command is the manual fallback and for --dry-run inspection.
 *
 * Usage: pok publish [--dry-run]
 */

import { z } from 'zod';
import { defineCommand } from '@pokit/core';
import { $ } from 'bun';

export const command = defineCommand({
  label: 'Publish packages to npm',
  context: {
    dryRun: {
      from: 'flag',
      schema: z.boolean().default(false),
      description: 'Perform a dry run without actually publishing',
    },
  },
  run: async (r, ctx) => {
    const registry = 'https://registry.npmjs.org/';
    const dryRunFlag = ctx.context.dryRun ? ' --dry-run --no-git-checks' : '';

    if (!ctx.context.dryRun) {
      const whoami = await $`npm whoami --registry ${registry}`.quiet().nothrow();
      if (whoami.exitCode !== 0) {
        throw new Error(`Not logged in to ${registry}. Run: npm login --registry ${registry}`);
      }
    }

    await r.group(`Publish to ${registry}`, { layout: 'sequence' }, async (g) => {
      await g.activity('Install workspace dependencies', async () => {
        await r.exec('pnpm install --frozen-lockfile');
      });

      await g.activity('Build packages', async () => {
        await r.exec('pnpm -r --if-present run build');
      });

      await g.activity('Publish packages', async () => {
        // Interactive so npm can prompt for OTP / browser auth.
        await r.exec(`pnpm -r publish --access public${dryRunFlag}`, {
          interactive: !ctx.context.dryRun,
        });
      });
    });

    if (ctx.context.dryRun) {
      r.reporter.info('Dry run complete. No packages were published.');
    } else {
      r.reporter.success('Published packages to npm.');
    }
  },
});
