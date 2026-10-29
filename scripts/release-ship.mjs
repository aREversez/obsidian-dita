// Prepare a release in one step: bump the version, verify, refresh the root
// main.js / styles.css / manifest.json, commit and tag. It never pushes, so
// `git push` and `git push origin <version>` stay yours to run.
//
//   npm run release:ship -- 0.3.0 [--dry-run]
//
// What it refuses: a dirty working tree (your work would land in the release
// commit), a detached HEAD, and a version whose tag already exists locally or
// on the remote — each means the number you passed is not the next one. A dry
// run applies the same checks and prints the commands without running them.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEMVER } from './release-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// npm exports its configuration as npm_config_* to every child process, and the
// script-approval entries make a nested `npm` run fail with EALLOWSCRIPTS.
const childEnv = () => {
  const env = { ...process.env };
  delete env.npm_config_allow_scripts;
  delete env.npm_config_dangerously_allow_all_scripts;
  return env;
};

// Node refuses to spawn npm.cmd without a shell (EINVAL), and a shell would
// have to quote the arguments it runs. npm ships a JS entry point next to the
// node binary, so drive that: no shell, nothing to escape.
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const NPM = existsSync(npmCli) ? { cmd: process.execPath, prefix: [npmCli] } : null;

class Plan {
  constructor(dryRun) {
    this.dryRun = dryRun;
  }

  /**
   * Run a command that changes something: printed and skipped under --dry-run.
   * Its output goes to the terminal, so a long verify is visible while it runs.
   * `label` is how the command is shown, when the argv form is noisy.
   */
  run(cmd, args = [], label = [cmd, ...args].join(' ')) {
    if (this.dryRun) {
      console.log(`$ ${label}`);
      return '';
    }
    return this.exec(cmd, args, { stream: true, label });
  }

  /** Run a read-only command, in a dry run too, and return its output. */
  probe(cmd, args = []) {
    return this.exec(cmd, args, { stream: false });
  }

  /** Like probe, for commands that signal through their exit code. */
  probeSoft(cmd, args = []) {
    const result = spawnSync(cmd, args, {
      cwd: root,
      env: childEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return result.status === 0 ? (result.stdout ?? '').trim() : '';
  }

  exec(cmd, args, { stream, label = [cmd, ...args].join(' ') }) {
    const result = spawnSync(cmd, args, {
      cwd: root,
      env: childEnv(),
      encoding: 'utf8',
      stdio: stream ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw new Error(`${label}: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`${label} failed (exit ${result.status})\n${(result.stderr || '').trim()}`);
    }
    return (result.stdout ?? '').trim();
  }

  /** A command whose output the user should see as it happens. */
  npm(...args) {
    if (!NPM) {
      throw new Error(`cannot find npm at ${npmCli}; run the release steps from README.md by hand.`);
    }
    return this.run(NPM.cmd, [...NPM.prefix, ...args], `npm ${args.join(' ')}`);
  }

  git(...args) {
    return this.run('git', args);
  }
}

function ship(plan, version) {
  const dirty = plan.probe('git', ['status', '--porcelain']);
  if (dirty) throw new Error(`the working tree is not clean, commit or stash first:\n${dirty}`);

  const branch = plan.probeSoft('git', ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (!branch) throw new Error('HEAD is detached; check out the branch to release from.');

  if (plan.probe('git', ['tag', '-l', version])) {
    throw new Error(`tag ${version} already exists locally; pick the next version.`);
  }
  if (plan.probe('git', ['ls-remote', '--tags', 'origin', `refs/tags/${version}`])) {
    throw new Error(`tag ${version} is already on origin; delete it there first or pick the next version.`);
  }

  // The plugin's "version" script rewrites the root manifest.json and versions.json.
  plan.npm('version', version, '-w', 'obsidian-dita', '--no-git-tag-version');
  plan.npm('run', 'verify');
  plan.npm('run', 'sync:root');
  plan.npm('run', 'sync:root:check');
  plan.run('node', ['scripts/check-release.mjs', version]);

  plan.git(
    'add',
    'manifest.json',
    'versions.json',
    'package-lock.json',
    'packages/obsidian-plugin/package.json',
    'main.js',
    'styles.css',
  );
  const message = `chore: release ${version}`;
  plan.run('git', ['commit', '-m', message], `git commit -m "${message}"`);
  plan.git('tag', version);

  if (plan.dryRun) {
    console.log(`\nOn ${branch}, this plan would produce one commit and the tag ${version}.`);
    console.log('Drop --dry-run to run it.');
    return;
  }

  console.log(`\n${version} is committed and tagged on ${branch}. Read it, then push:`);
  console.log(`  git push && git push origin ${version}`);
  console.log('Pushing the tag publishes the GitHub release with main.js, manifest.json and styles.css.');
}

function main(argv) {
  const version = argv.find((a) => !a.startsWith('--'));
  const dryRun = argv.includes('--dry-run');
  if (!version) throw new Error('usage: npm run release:ship -- <x.y.z> [--dry-run]');
  if (!SEMVER.test(version)) {
    throw new Error(`"${version}" is not x.y.z: a bare version, no "v", no suffix.`);
  }
  ship(new Plan(dryRun), version);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`release:ship: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
