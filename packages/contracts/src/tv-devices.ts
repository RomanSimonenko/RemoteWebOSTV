import { z } from 'zod';
import { localTvHostSchema, tvOperationSchema, tvStatusResponseSchema } from './tv-setup.js';
import { tvPlatformSchema } from './tv.js';

export const tvIdSchema = z.uuid();
export type TvId = z.infer<typeof tvIdSchema>;
export const tvDeviceSchema = z.strictObject({
  tvId: tvIdSchema,
  platform: tvPlatformSchema,
  status: tvStatusResponseSchema,
});
export type TvDevice = Readonly<z.infer<typeof tvDeviceSchema>>;
export const tvDevicesResponseSchema = z.strictObject({ devices: z.array(tvDeviceSchema) });
export const deleteTvRequestSchema = z.strictObject({ confirm: z.literal(true) });
export const addTvRequestSchema = z.strictObject({
  id: z.uuid(), platform: tvPlatformSchema, host: localTvHostSchema,
});
export type AddTvRequest = Readonly<z.infer<typeof addTvRequestSchema>>;
export const addTvResponseSchema = z.strictObject({ tvId: tvIdSchema, operation: tvOperationSchema });
export type AddTvResponse = Readonly<z.infer<typeof addTvResponseSchema>>;
