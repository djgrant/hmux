import { defineConfig } from '@pokit/core';
import { releaseRecipe } from 'pok-plugins';

// Dogfood pok as the repo's dev-tooling launcher. @pokit/core and
// @pokit/terminal are installed from the registry as devDependencies, so this
// uses the zero-config surface: reporter / prompter / navigator are omitted and
// the `pok` launcher wires in @pokit/terminal's createTerminalUI() defaults.
//
// Run tooling with `pok <command>` (e.g. `pok version`, `pok publish`). The
// version/publish flow comes from the shared pok-plugins releaseRecipe.
export default defineConfig({
  commandsDir: './commands',
  appName: 'pok',
  theme: { preset: 'minimal' },
  plugins: [
    releaseRecipe({
      packages: {
        files: ['packages/hmux/package.json', 'packages/focus/package.json'],
      },
    }),
  ],
});
