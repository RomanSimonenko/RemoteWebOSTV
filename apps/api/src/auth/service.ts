import { createSetupToken, hashSetupToken } from './tokens.js';
import { hashPassword } from './passwords.js';
import type { OwnerRepository } from './repository.js';

export type OwnerSetupErrorCode = 'SETUP_UNAVAILABLE' | 'INVALID_SETUP_TOKEN' | 'INVALID_OWNER_INPUT';

export class OwnerSetupError extends Error {
  constructor(readonly code: OwnerSetupErrorCode) {
    super(code);
    this.name = 'OwnerSetupError';
  }
}

export interface OwnerSetupService {
  issueSetupToken(): Promise<string>;
  claimOwner(input: { readonly token: string; readonly username: string; readonly password: string }): Promise<void>;
}

export interface OwnerSetupDependencies {
  readonly repository: OwnerRepository;
  readonly now?: () => number;
  readonly randomBytes?: (length: number) => Uint8Array;
}

function validLength(value: unknown, min: number, max: number): boolean {
  return typeof value === 'string' && [...value].length >= min && [...value].length <= max;
}

export function createOwnerSetupService({ repository, now = Date.now, randomBytes }: OwnerSetupDependencies): OwnerSetupService {
  return {
    async issueSetupToken() {
      const token = createSetupToken(randomBytes);
      const tokenHash = hashSetupToken(token);
      if (!tokenHash) throw new Error('Generated setup token has an invalid format');
      if (!repository.replaceSetupToken(tokenHash, now() + 15 * 60 * 1000)) throw new OwnerSetupError('SETUP_UNAVAILABLE');
      return token;
    },
    async claimOwner({ token, username, password }) {
      if (!validLength(username, 1, 64) || !validLength(password, 12, 128)) throw new OwnerSetupError('INVALID_OWNER_INPUT');
      const tokenHash = hashSetupToken(token);
      if (!tokenHash) throw new OwnerSetupError('INVALID_SETUP_TOKEN');
      const passwordHash = await hashPassword(password);
      if (!repository.claimOwner({ tokenHash, username, passwordHash, now: now() })) throw new OwnerSetupError('INVALID_SETUP_TOKEN');
    },
  };
}
