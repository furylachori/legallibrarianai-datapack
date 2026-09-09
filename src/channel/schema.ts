import { z } from "zod";

/** One release asset: lowercase hex sha256 of the EXACT bytes + byte length. */
export const ChannelFileSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
});

export type ChannelFile = z.infer<typeof ChannelFileSchema>;

/**
 * Frozen `channel.json` schema (docs/channel-contract.md §1).
 * Unknown top-level fields are tolerated via catchall (forward-compat).
 */
export const ChannelJsonSchema = z
  .object({
    corpusVersion: z.number().int().nonnegative(),
    releaseTag: z.string().min(1),
    files: z.record(z.string(), ChannelFileSchema),
    keyId: z.string().min(1).optional(),
  })
  .catchall(z.unknown());

export type ChannelJson = z.infer<typeof ChannelJsonSchema>;
