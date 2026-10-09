import { z } from 'zod';

export const tvMacAddressSchema = z.string()
  .regex(/^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i)
  .transform((mac) => mac.replaceAll('-', ':').toUpperCase())
  .refine((mac) => (Number.parseInt(mac.slice(0, 2), 16) & 1) === 0 && mac !== '00:00:00:00:00:00', {
    message: 'Expected a nonzero unicast MAC address',
  });
