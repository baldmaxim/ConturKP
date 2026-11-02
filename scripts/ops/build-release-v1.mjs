// Local candidate only: no database, services, model calls or deployment.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const git = (...args) => execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, ...args], { cwd: root, encoding: 'utf8' }).trim();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const nodeVersion = process.versions.node.split('.').map(Number);
if (nodeVersion[0] !== 24 || nodeVersion[1] < 11) throw new Error('Release requires Node >=24.11 <25');
if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Commit the candidate before building; worktree must be clean');

const workspaces = {
  adapters: 'packages/adapters', config: 'packages/config', contracts: 'packages/contracts',
  core: 'packages/core', db: 'packages/db', storage: 'packages/storage',
  server: 'apps/server', web: 'apps/web', worker: 'apps/worker',
};
for (const [name, path] of Object.entries(workspaces)) {
  if (await realpath(join(root, 'node_modules/@kontur', name)) !== await realpath(join(root, path))) {
    throw new Error(`Workspace ${name} resolves outside this candidate`);
  }
}

const commit = git('rev-parse', 'HEAD');
const tree = git('rev-parse', 'HEAD^{tree}');
const version = `v1-rc1-${commit.slice(0, 12)}`;
const identity = { version, commit, tree };
const tsc = join(root, 'node_modules/typescript/bin/tsc');
for (const project of ['tsconfig.json', 'apps/web/tsconfig.json']) {
  execFileSync(process.execPath, [tsc, '-p', join(root, project), '--noEmit'], { cwd: root, stdio: 'inherit', windowsHide: true });
}
await build({
  root: join(root, 'apps/web'),
  configFile: join(root, 'apps/web/vite.config.ts'),
  plugins: [{
    name: 'kontur-v1-release-identity',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'app-build', content: version }, injectTo: 'head' }],
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(identity, null, 2) + '\n' });
    },
  }],
});

const dist = join(root, 'apps/web/dist');
const files = [];
const walk = async dir => {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      files.push({ path: relative(dist, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha256(bytes) });
    } else throw new Error('Unexpected link in web/dist');
  }
};
await walk(dist);
if (!((await readFile(join(dist, 'index.html'), 'utf8')).includes(`content="${version}"`))) throw new Error('Missing HTML build identity');
const manifest = JSON.parse(await readFile(join(dist, 'version.json'), 'utf8'));
if (manifest.commit !== commit || manifest.version !== version) throw new Error('Inconsistent web version');
const receipt = {
  schema: 'kontur.release-v1-build.v1', ...identity, createdAt: new Date().toISOString(),
  node: process.versions.node, packageLockSha256: sha256(await readFile(join(root, 'package-lock.json'))),
  typecheck: 'PASS', webBuild: 'PASS', workspaceResolution: 'PASS',
  fullSuiteRun: false, installed: false, accepted: false, files,
};
await mkdir(join(root, 'runtime/release-v1'), { recursive: true });
await writeFile(join(root, 'runtime/release-v1/build.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(`Candidate built: ${version}; ${files.length} web files. Not installed or accepted.`);
