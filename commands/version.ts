/**
 * Version command
 *
 * Bumps the publishable packages with bumpp: interactive prompt, git commit,
 * and a `v%s` tag. Pushing the tag triggers the Release workflow, which
 * publishes to npm.
 *
 * Usage: pok version [release-type]   (e.g. pok version patch)
 */

import { z } from 'zod';
import { defineCommand } from '@pokit/core';
import { versionBump } from 'bumpp';

// The npm-published packages. The rest are private: @hmux/protocol, @hmux/server
// and @hmux/mailbox are bundled or unpublished, and hmux-cc-plugin ships via the
// GitHub plugin marketplace rather than npm.
const PUBLISHABLE_FILES = [
  'packages/hmux/package.json',
  'packages/focus/package.json',
];

export const command = defineCommand({
  label: 'Bump package versions',
  context: {
    skipPush: {
      from: 'flag',
      schema: z.boolean().optional(),
      description: 'Skip pushing the commit and tag to remote',
    },
  },
  run: async (_r, ctx) => {
    const release = ctx.extraArgs[0] || 'prompt';
    const skipConfirm = release !== 'prompt';

    await versionBump({
      release,
      files: [...PUBLISHABLE_FILES],
      push: !ctx.context.skipPush,
      tag: 'v%s',
      commit: 'release: v%s',
      confirm: !skipConfirm,
    });
  },
});
