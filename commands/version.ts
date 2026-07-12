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

// The npm-published packages. Private packages (@hmux/protocol, @hmux/server,
// @hmux/mailbox) are bundled or unpublished, so they are not versioned here.
const PUBLISHABLE_FILES = [
  'packages/hmux/package.json',
  'packages/focus/package.json',
  'packages/cc-plugin/package.json',
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
