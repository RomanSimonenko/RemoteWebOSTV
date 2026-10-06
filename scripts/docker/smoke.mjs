import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, cp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Every probe owns a fresh transport: containers are deliberately recreated
// synchronously, so a pooled keep-alive socket would refer to the old process.
const fetch = (url, options = {}) => globalThis.fetch(url, {
  ...options, headers: { ...options.headers, connection: 'close' }, signal: AbortSignal.timeout(10000),
});
const id = `remote-webos-smoke-${randomUUID()}`;
const image = `${id}:test`;
const volume = `${id}-data`;
const containers = new Set();
const images = new Set();
const volumes = new Set();
const network = `${id}-network`;
let networkCreated = false;
let context;
let composeArgs;
let cancelled = false;
let cleaning = false;
let originalFailure;
const cancel = () => { cancelled = true; };
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
function docker(args, input) {
  if (cancelled && !cleaning) throw new Error('Synthetic Docker check cancelled');
  // Never echo captured output: CLI tokens and HTTP bodies are private even in tests.
  const result = spawnSync('docker', args, { cwd: root, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = args[0] === 'build' ? String(result.stderr).slice(-4000) : '';
    throw new Error(`Docker operation failed: ${args[0]} ${args[1] ?? ''} (exit ${result.status ?? 'unknown'}) ${detail}`, { cause: result.error });
  }
  return (args[0] === 'logs' ? result.stdout + result.stderr : result.stdout).trim();
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
function start(name, dataVolume = volume, readOnly = false) {
  containers.add(name);
  docker(['run', '-d', '--name', name, '--network', network, '-p', '127.0.0.1::8080', '-v', `${dataVolume}:/data${readOnly ? ':ro' : ''}`,
    '-e', 'REMOTE_WEBOS_DATA_DIR=/data', '-e', 'REMOTE_WEBOS_HOST=0.0.0.0',
    '-e', 'REMOTE_WEBOS_PORT=8080', '-e', 'REMOTE_WEBOS_PUBLIC_ORIGIN=http://127.0.0.1:8080', image]);
}
async function expectFailedStartup(name) {
  const deadline = Date.now() + 15000;
  while (JSON.parse(docker(['inspect', name]))[0].State.Running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  const state = JSON.parse(docker(['inspect', name]))[0].State;
  assert.equal(state.Running, false, 'Invalid storage must prevent startup');
  assert.notEqual(state.ExitCode, 0);
}
function address(name) {
  const port = JSON.parse(docker(['inspect', name]))[0].NetworkSettings.Ports['8080/tcp'][0];
  assert.equal(port.HostIp, '127.0.0.1');
  return `http://127.0.0.1:${port.HostPort}`;
}
async function post(origin, path, body, headers = {}) {
  return fetch(`${origin}${path}`, { method: 'POST', headers: { origin: 'http://127.0.0.1:8080', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
function keys(name) {
  return docker(['exec', name, 'node', '-e', "const f=require('fs'),c=require('crypto');console.log(JSON.stringify(['auth-master.key','tv-master.key'].map(n=>c.createHash('sha256').update(f.readFileSync('/data/'+n)).digest('hex'))))"]);
}
function stop(name) {
  docker(['stop', '-t', '30', name]);
  const state = JSON.parse(docker(['inspect', name]))[0].State;
  assert.equal(state.ExitCode, 0, 'SIGTERM should close cleanly');
  docker(['rm', name]);
  containers.delete(name);
}
try {
  docker(['info']);
  context = await mkdtemp(join(tmpdir(), 'remote-webos-build-'));
  // Use an allowlisted synthetic build context; never copy the user's data or Git.
  for (const file of ['Dockerfile', '.dockerignore', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'apps', 'packages']) {
    await cp(join(root, file), join(context, file), { recursive: true, filter: path => !/(^|\/)(node_modules|dist|\.local)(\/|$)/.test(path) });
  }
  const canary = `CANARY-${randomUUID()}`;
  const forbidden = ['.local', '.git', 'graft', 'node_modules', 'apps/api/src/.local', 'apps/api/src/node_modules'];
  for (const dir of forbidden) {
    await mkdir(join(context, dir), { recursive: true });
    await writeFile(join(context, dir, 'canary'), canary);
  }
  const secretPaths = ['apps/api/src/.env', 'apps/api/src/canary.key', 'apps/api/src/canary.sqlite'];
  for (const file of secretPaths) await writeFile(join(context, file), canary);
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
  for (const file of secretPaths) await assert.rejects(readFile(join(exported, file)), { code: 'ENOENT' });
  console.log('PASS: forbidden build-context canaries excluded');
  images.add(image);
  docker(['build', '-t', image, context]);
  docker(['network', 'create', network]);
  networkCreated = true;
  const mockContext = join(context, 'mock-context');
  await mkdir(mockContext);
  for (const file of ['mock-webos-tv.js', 'fixtures.js']) await cp(join(root, 'packages/webos/dist/test/support', file), join(mockContext, file));
  await cp(join(root, 'scripts/docker/mock-tv.mjs'), join(mockContext, 'mock-tv.mjs'));
  const mockImage = `${id}:mock`;
  images.add(mockImage);
  docker(['build', '-t', mockImage, '-f', '-', mockContext], `FROM ${image}\nUSER root\nRUN node -e "const m=require('module'),f=require('fs'),p=require('path');const r=m.createRequire(f.realpathSync('/app/packages/webos/node_modules/lgtv2/package.json'));f.symlinkSync(p.dirname(r.resolve('ws/package.json')),'/app/packages/webos/node_modules/ws')"\nCOPY . /app/packages/webos/node_modules/docker-mock/\nUSER node\nCMD ["node","/app/packages/webos/node_modules/docker-mock/mock-tv.mjs"]\n`);
  const mockName = `${id}-tv`;
  containers.add(mockName);
  docker(['run', '-d', '--name', mockName, '--network', network, mockImage]);
  const tvHost = JSON.parse(docker(['inspect', mockName]))[0].NetworkSettings.Networks[network].IPAddress;
  volumes.add(volume);
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
  if (process.argv.includes('--test-cancel')) {
    console.log(`Synthetic cancellation resources: ${id}`);
    process.kill(process.pid, 'SIGINT');
    await new Promise(resolve => setImmediate(resolve));
  }
  const token = docker(['exec', name, 'node', 'apps/api/dist/src/auth/cli.js', 'setup-token']);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const account = { username: 'synthetic-owner', password: 'synthetic-docker-password-1234' };
  assert.equal((await post(origin, '/api/setup', { token, ...account })).status, 201);
  const login = await post(origin, '/api/auth/login', account);
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const session = await (await fetch(`${origin}/api/auth/session`, { headers: { cookie } })).json();
  const headers = { cookie, 'x-csrf-token': session.csrfToken };
  const pair = await post(origin, '/api/tv/operations', { action: 'pair', host: tvHost }, headers);
  assert.equal(pair.status, 202);
  async function status(base) { return (await fetch(`${base}/api/tv`, { headers: { cookie } })).json(); }
  const pairDeadline = Date.now() + 15000;
  let paired;
  do { paired = await status(origin); if (paired.operation?.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < pairDeadline);
  assert.equal(paired.operation?.status, 'succeeded', 'Synthetic TV must pair through the real protected API');
  assert.equal(paired.tv.host, tvHost);
  assert.equal((await post(origin, '/api/auth/login', account, { origin: 'http://foreign.invalid' })).status, 403);
  const beforeKeys = keys(name);
  stop(name);
  start(name);
  await waitHealthy(name);
  const afterOrigin = address(name);
  assert.equal(keys(name), beforeKeys, 'Recreation must preserve both master keys');
  assert.deepEqual(await (await fetch(`${afterOrigin}/api/setup/status`)).json(), { state: 'claimed' });
  assert.equal((await fetch(`${afterOrigin}/api/auth/session`, { headers: { cookie } })).status, 200);
  assert.equal((await post(afterOrigin, '/api/auth/login', account)).status, 200);
  let restored;
  const restoreDeadline = Date.now() + 15000;
  do { restored = await status(afterOrigin); if (restored.connection === 'available') break; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < restoreDeadline);
  assert.deepEqual(restored.tv, paired.tv);
  // Public connection serialization is checked independently below, not inferred from delivery.
  assert.equal(restored.connection, 'available');
  console.log('PASS: real protocol pairing and saved TV survive recreation');
  docker(['stop', '-t', '10', mockName]);
  assert.deepEqual(await (await fetch(`${afterOrigin}/api/health`)).json(), { status: 'ok' });
  console.log('PASS: owner, session and master keys survive SIGTERM and recreation; foreign Origin rejected');
  const freshVolume = `${id}-fresh`;
  volumes.add(freshVolume);
  docker(['volume', 'create', freshVolume]);
  const fresh = `${id}-fresh-app`;
  start(fresh, freshVolume);
  await waitHealthy(fresh);
  const freshOrigin = address(fresh);
  assert.deepEqual(await (await fetch(`${freshOrigin}/api/setup/status`)).json(), { state: 'unclaimed' });
  assert.notEqual(keys(fresh), beforeKeys, 'New installation must have independent keys');
  const override = join(context, 'compose-smoke.yaml');
  const envFile = join(context, 'compose-smoke.env');
  await writeFile(override, `services:\n  app:\n    image: ${image}\nvolumes:\n  app-data:\n    name: ${freshVolume}\n    external: true\n`);
  await writeFile(envFile, `REMOTE_WEBOS_HTTP_PORT=${new URL(freshOrigin).port}\n`);
  composeArgs = ['compose', '--project-name', id, '--env-file', envFile, '-f', join(root, 'compose.yaml'), '-f', override];
  const config = JSON.parse(docker([...composeArgs, 'config', '--format', 'json']));
  assert.equal(config.services.app.ports[0].host_ip, '127.0.0.1');
  assert.equal(config.services.app.environment.REMOTE_WEBOS_PUBLIC_ORIGIN, freshOrigin);
  stop(fresh);
  // A native Mac listener models the current non-container application.
  const occupied = createServer();
  await new Promise((resolve, reject) => { occupied.once('error', reject); occupied.listen(Number(new URL(freshOrigin).port), '127.0.0.1', resolve); });
  try { assert.throws(() => docker([...composeArgs, 'up', '-d', '--no-build']), /Docker operation failed/); }
  finally { await new Promise((resolve, reject) => occupied.close(error => error ? reject(error) : resolve())); }
  docker([...composeArgs, 'down']);
  docker([...composeArgs, 'up', '-d', '--no-build', '--wait', '--wait-timeout', '30']);
  assert.deepEqual(await (await fetch(`${freshOrigin}/api/health`)).json(), { status: 'ok' });
  const composeToken = docker([...composeArgs, 'exec', '-T', 'app', 'node', 'apps/api/dist/src/auth/cli.js', 'setup-token']);
  assert.equal((await post(freshOrigin, '/api/setup', { token: composeToken, ...account }, { origin: freshOrigin })).status, 201);
  assert.equal((await post(freshOrigin, '/api/auth/login', account, { origin: freshOrigin })).status, 200);
  assert.equal((await post(freshOrigin, '/api/auth/login', account, { origin: 'http://foreign.invalid' })).status, 403);
  docker([...composeArgs, 'up', '-d', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '30']);
  assert.deepEqual(await (await fetch(`${freshOrigin}/api/setup/status`)).json(), { state: 'claimed' });
  docker([...composeArgs, 'down']);
  console.log('PASS: actual Compose startup/recreation, alternate port/Origin and occupied-port rejection');
  const readOnlyName = `${id}-readonly`;
  start(readOnlyName, freshVolume, true);
  await expectFailedStartup(readOnlyName);
  assert.match(docker(['logs', readOnlyName]), /STORAGE_OPEN_FAILED/);
  console.log('PASS: read-only data volume fails explicitly');
  // Remove a key only inside the synthetic volume which has an active stored session.
  docker(['exec', name, 'node', '-e', "require('fs').unlinkSync('/data/auth-master.key')"]);
  stop(name);
  start(name);
  await expectFailedStartup(name);
  assert.match(docker(['logs', name]), /Auth storage unavailable/);
  console.log('PASS: independent fresh installation; missing master key fails closed');
} catch (error) {
  originalFailure = error;
  throw error;
} finally {
  cleaning = true;
  const failures = [];
  if (composeArgs) try { docker([...composeArgs, 'down']); } catch (error) { failures.push(error); }
  for (const name of containers) try { docker(['rm', '-f', name]); } catch (error) { failures.push(error); }
  if (networkCreated) try { docker(['network', 'rm', network]); } catch (error) { failures.push(error); }
  // Only the unique synthetic volume created by this invocation may be removed.
  for (const dataVolume of volumes) try { docker(['volume', 'rm', dataVolume]); } catch (error) { failures.push(error); }
  for (const tag of images) try { if (docker(['image', 'ls', '-q', tag])) docker(['image', 'rm', tag]); } catch (error) { failures.push(error); }
  if (context) await rm(context, { recursive: true, force: true });
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
  if (failures.length) throw new AggregateError([...(originalFailure ? [originalFailure] : []), ...failures], 'Synthetic Docker resources could not all be cleaned up');
}
