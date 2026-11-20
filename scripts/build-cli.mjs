// Bundle the CLI into one dependency-free file and an installable npm tarball.
//   node scripts/build-cli.mjs          → dist/cli/plainwire.mjs, dist/plainwire-cli-<version>.tgz
import { build } from 'esbuild';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const dir = 'dist/cli';
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
await build({
  entryPoints: ['src/cli/bin.ts'],
  outfile: `${dir}/plainwire.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  minify: true,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
  define: { PLAINWIRE_VERSION: JSON.stringify(pkg.version) },
  logLevel: 'error',
});
chmodSync(`${dir}/plainwire.mjs`, 0o755);
writeFileSync(
  `${dir}/package.json`,
  JSON.stringify(
    {
      name: 'plainwire',
      version: pkg.version,
      description: 'Run and test .http files (REST Client / JetBrains HTTP format) from the command line and in CI. No login, no account, no telemetry.',
      bin: { plainwire: 'plainwire.mjs' },
      files: ['plainwire.mjs', 'README.md', 'LICENSE'],
      engines: { node: '>=18' },
      license: pkg.license,
      homepage: 'https://janwan2003.github.io/vscode-api-client/run-http-files-in-ci.html',
      repository: pkg.repository,
      keywords: ['http', 'rest-client', 'http-file', 'api-testing', 'ci', 'junit', 'thunder-client', 'postman'],
    },
    null,
    2,
  ) + '\n',
);
copyFileSync('LICENSE', `${dir}/LICENSE`);
copyFileSync('cli/README.md', `${dir}/README.md`);
const r = spawnSync('npm', ['pack', '--pack-destination', '..'], { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' });
if (r.status !== 0) {
  process.stderr.write(r.stderr);
  process.exit(1);
}
const tgz = r.stdout.trim().split('\n').pop();
renameSync(`dist/${tgz}`, `dist/plainwire-cli-${pkg.version}.tgz`);
console.log(`dist/cli/plainwire.mjs (${readFileSync(`${dir}/plainwire.mjs`).length} bytes), dist/plainwire-cli-${pkg.version}.tgz`);
