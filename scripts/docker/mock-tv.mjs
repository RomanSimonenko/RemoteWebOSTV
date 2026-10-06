// Test-only entry point: reuse the existing protocol fixture, not a product adapter.
import { networkInterfaces } from 'node:os';
import { MockWebOsTv } from './mock-webos-tv.js';
const host = Object.values(networkInterfaces()).flat().find(address => address && address.family === 'IPv4' && !address.internal)?.address;
if (!host) throw new Error('Synthetic TV requires an isolated IPv4 Docker network');
const tv = new MockWebOsTv({ scenario: { kind: 'success' }, listen: { host: '0.0.0.0', port: 3000, advertisedHost: host } });
await tv.start();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void tv.stop(); });
