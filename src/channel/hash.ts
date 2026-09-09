import { createHash } from "node:crypto";

/** Lowercase hex sha256 of the EXACT bytes (no string conversion). */
export function sha256HexOfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
