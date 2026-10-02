import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { openDatabase } from '../storage/database.js';
import { createOwnerRepository } from './repository.js';
import { createOwnerSetupService, OwnerSetupError } from './service.js';
import { formatStartupError } from '../startup-errors.js';

export interface SetupTokenCliOptions {
  readonly args: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export async function runSetupTokenCli({ args, env, stdout, stderr }: SetupTokenCliOptions): Promise<number> {
  if (args.length !== 1 || args[0] !== 'setup-token') {
    stderr('Usage: setup-token');
    return 2;
  }
  const dataDir = env.REMOTE_WEBOS_DATA_DIR;
  if (!dataDir || !isAbsolute(dataDir)) {
    stderr('REMOTE_WEBOS_DATA_DIR must be an absolute path');
    return 2;
  }
  try {
    const database = await openDatabase({ dataDir });
    let token: string;
    try {
      const service = createOwnerSetupService({ repository: createOwnerRepository(database.sqlite) });
      token = await service.issueSetupToken();
    } catch (error) {
      try { database.close(); } catch (closeError) {
        throw new AggregateError([error, closeError], 'Setup token command and cleanup both failed');
      }
      throw error;
    }
    database.close();
    stdout(token);
    return 0;
  } catch (error) {
    stderr(error instanceof OwnerSetupError && error.code === 'SETUP_UNAVAILABLE'
      ? 'Owner is already configured; setup token was not issued'
      : formatStartupError(error, 'Setup token command failed'));
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runSetupTokenCli({
    args: process.argv.slice(2),
    env: process.env,
    stdout: (line) => { process.stdout.write(`${line}\n`); },
    stderr: (line) => { process.stderr.write(`${line}\n`); },
  }).then((exitCode) => { process.exitCode = exitCode; });
}
