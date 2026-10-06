import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, cp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const id = `remote-webos-smoke-${randomUUID()}`;
const image = `${id}:test`;
const volume = `${id}-data`;
const containers = new Set();
const images = new Set();
let context;
function docker(args, input) {
  // Never echo captured output: CLI tokens and HTTP bodies are private even in tests.
  try { return execFileSync('docker', args, { cwd: root, input, encoding: 'utf8', timeout: 600000, maxBuffer: 8 * 1024 * 1024 }).trim(); }
  catch (cause) { throw new Error(`Docker operation failed: ${args[0]} ${args[1] ?? ''} (exit ${cause.status ?? 'unknown'})`); }
}
async function waitHealthy(name) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = JSON.parse(docker(['inspect', name]))[0].State;
    assert.equal(state.Running, true, 'Container exited before becoming healthy');
    if (state.Health?.Status === 'healthy') return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Container did not become healthy within 30 seconds');
}
function start(name) {
  containers.add(name);
  docker(['run', '-d', '--name', name, '-p', '127.0.0.1::8080', '-v', `${volume}:/data`,
    '-e', 'REMOTE_WEBOS_DATA_DIR=/data', '-e', 'REMOTE_WEBOS_HOST=0.0.0.0',
    '-e', 'REMOTE_WEBOS_PORT=8080', '-e', 'REMOTE_WEBOS_PUBLIC_ORIGIN=http://127.0.0.1:8080', image]);
}
try {
  docker(['info']);
  context = await mkdtemp(join(tmpdir(), 'remote-webos-build-'));
  // Use an allowlisted synthetic build context; never copy the user's data or Git.
  for (const file of ['Dockerfile', '.dockerignore', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'apps', 'packages']) {
    await cp(join(root, file), join(context, file), { recursive: true, filter: path => !/(^|\/)(node_modules|dist|\.local)(\/|$)/.test(path) });
  }
  const canary = `CANARY-${randomUUID()}`;
  const forbidden = ['.local', '.git', 'graft', 'node_modules'];
  for (const dir of forbidden) {
    await mkdir(join(context, dir), { recursive: true });
    await writeFile(join(context, dir, 'canary'), canary);
  }
  const audit = `${id}:context`;
  images.add(audit);
  docker(['build', '-t', audit, '-f', '-', context], 'FROM scratch\nCOPY . /context\n');
  const auditContainer = `${id}-context`;
  containers.add(auditContainer);
  docker(['create', '--name', auditContainer, audit, '/unused']);
  const exported = join(context, 'audit');
  docker(['cp', `${auditContainer}:/context`, exported]);
  for (const dir of forbidden) {
    await assert.rejects(readFile(join(exported, dir, 'canary')), { code: 'ENOENT' });
  }
  console.log('PASS: forbidden build-context canaries excluded');
  images.add(image);
  docker(['build', '-t', image, context]);
  docker(['volume', 'create', volume]);
  const name = `${id}-app`;
  start(name);
  await waitHealthy(name);
  assert.notEqual(docker(['exec', name, 'id', '-u']), '0');
  const published = JSON.parse(docker(['inspect', name]))[0].NetworkSettings.Ports['8080/tcp'][0];
  assert.equal(published.HostIp, '127.0.0.1');
  const origin = `http://127.0.0.1:${published.HostPort}`;
  assert.deepEqual(await (await fetch(`${origin}/api/health`)).json(), { status: 'ok' });
  const html = await (await fetch(origin)).text();
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /\/assets\/[^" ]+\.js/);
  assert.deepEqual(await (await fetch(`${origin}/api/setup/status`)).json(), { state: 'unclaimed' });
  docker(['exec', name, 'node', '-e', "const f=require('fs');for(const p of ['/app/.git','/app/.local','/app/graft','/app/node_modules/canary'])if(f.existsSync(p))process.exit(1)"]);
  console.log('PASS: non-root runtime, SQLite, HTTP health and built web');
} finally {
  const failures = [];
  for (const name of containers) try { docker(['rm', '-f', name]); } catch (error) { failures.push(error); }
  // Only the unique synthetic volume created by this invocation may be removed.
  try { if (docker(['volume', 'ls', '-q']).split('\n').includes(volume)) docker(['volume', 'rm', volume]); } catch (error) { failures.push(error); }
  for (const tag of images) try { if (docker(['image', 'ls', '-q', tag])) docker(['image', 'rm', tag]); } catch (error) { failures.push(error); }
  if (context) await rm(context, { recursive: true, force: true });
  if (failures.length) throw new AggregateError(failures, 'Synthetic Docker resources could not all be cleaned up');
}
