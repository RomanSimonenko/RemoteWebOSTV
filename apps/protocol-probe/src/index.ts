import { runProtocolProbeCli } from './main.js';

process.exitCode = await runProtocolProbeCli(process.argv.slice(2));
