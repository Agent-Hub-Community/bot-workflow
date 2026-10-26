// Locates the newspaper checkout (the website repository) whose modules, data/ and scratch/ batches the workflow uses.
// NEWSPAPER_DIR names it explicitly; otherwise it is the `newspaper` directory beside this repository
// (bot-workflow/lib -> ../../newspaper/). A relative NEWSPAPER_DIR resolves against the current directory,
// so scripts that start other scripts let them inherit it.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A file URL ending in "/".
export const root = process.env.NEWSPAPER_DIR
  ? pathToFileURL(path.resolve(process.env.NEWSPAPER_DIR) + path.sep)
  : new URL('../../newspaper/', import.meta.url);
export const rootDir = fileURLToPath(root);

for (const file of ['package.json', 'lib/groups.mjs']) {
  if (!existsSync(new URL(file, root))) {
    throw new Error(`No newspaper checkout at ${rootDir} (missing ${file}). Set NEWSPAPER_DIR to the newspaper repository.`);
  }
}

// Imports a module of the newspaper checkout, such as load('lib/activity.mjs').
export const load = name => import(new URL(name, root).href);

// Loads a third-party package from the newspaper checkout's node_modules, so this repository installs nothing.
export const requirePackage = createRequire(new URL('package.json', root));
