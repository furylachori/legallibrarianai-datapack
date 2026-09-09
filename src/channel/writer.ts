import { createPrivateKey, sign } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalizeJson } from "./canonical.js";
import { sha256HexOfBytes } from "./hash.js";
import { ChannelJsonSchema } from "./schema.js";
import { isValidCorpusVersion } from "./versions.js";

/** Inputs for {@link writeChannelManifest}. */
export interface WriteChannelManifestOptions {
  /** Server-assigned monotonic counter (data CI policy; taken as input here). */
  readonly corpusVersion: number;
  /** GitHub release tag, e.g. `corpus-v12`. Informational but checked. */
  readonly releaseTag: string;
  /** Key id whose signature is primary; also names the sidecar file. */
  readonly keyId: string;
  /** 32-byte Ed25519 seed as 64 hex chars (build-lane secret, never committed). */
  readonly secretSeedHex: string;
}

/** Absolute paths emitted by {@link writeChannelManifest}. */
export interface WriteChannelManifestResult {
  readonly channelPath: string;
  readonly sigPath: string;
}

const SEED_HEX_RE = /^[0-9a-fA-F]{64}$/;

// PKCS#8 DER prefix for an Ed25519 private key:
// SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 },
// OCTET STRING { OCTET STRING(seed) } }. Lets node:crypto derive the
// keypair from the bare 32-byte seed (same stdlib Ed25519 the A0 vector
// test uses; @noble/ed25519 remains the data-lane pin per contract §8).
const ED25519_PKCS8_PREFIX_HEX = "302e020100300506032b657004220420";

/**
 * Emit `channel.json` + `channel.json.sig.<keyId>` for a built `outDir`,
 * per docs/channel-contract.md §§1–2.
 *
 * Enumerates the TOP-LEVEL files of `outDir` (never `channel.json` nor
 * `channel.json.sig.*` themselves), hashes each file's EXACT bytes,
 * fail-closed validates the tuple with `ChannelJsonSchema`, writes the
 * EXACT canonical bytes as `channel.json`, and signs those bytes with
 * Ed25519 under the seed. Returns both absolute paths.
 *
 * Misuse (bad version, empty tag/id, malformed seed, unreadable dir)
 * throws — data-states-never-throw applies to runtime data states, not
 * this build-lane API.
 */
export function writeChannelManifest(
  outDir: string,
  opts: WriteChannelManifestOptions,
): WriteChannelManifestResult {
  if (typeof outDir !== "string" || outDir.length === 0) {
    throw new TypeError("writeChannelManifest: outDir must be a non-empty string");
  }
  if (opts === null || opts === undefined) {
    throw new TypeError("writeChannelManifest: opts is required");
  }
  if (!isValidCorpusVersion(opts.corpusVersion)) {
    throw new TypeError("writeChannelManifest: invalid corpusVersion");
  }
  if (typeof opts.releaseTag !== "string" || opts.releaseTag.length === 0) {
    throw new TypeError("writeChannelManifest: releaseTag must be a non-empty string");
  }
  if (typeof opts.keyId !== "string" || opts.keyId.length === 0) {
    throw new TypeError("writeChannelManifest: keyId must be a non-empty string");
  }
  if (typeof opts.secretSeedHex !== "string" || !SEED_HEX_RE.test(opts.secretSeedHex)) {
    throw new TypeError("writeChannelManifest: secretSeedHex must be 64 hex chars");
  }

  const dir = resolve(outDir);
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    throw new Error(`writeChannelManifest: cannot read outDir ${dir}`, { cause: err });
  }

  const files: Record<string, { sha256: string; bytes: number }> = {};
  for (const name of names) {
    if (name === "channel.json" || name.startsWith("channel.json.sig.")) continue;
    const bytes = readFileSync(join(dir, name));
    files[name] = { sha256: sha256HexOfBytes(bytes), bytes: bytes.length };
  }

  const tuple = {
    corpusVersion: opts.corpusVersion,
    releaseTag: opts.releaseTag,
    keyId: opts.keyId,
    files,
  };
  const parsed = ChannelJsonSchema.parse(tuple);
  const canonical = canonicalizeJson(parsed);
  const canonicalBytes = Buffer.from(canonical, "utf8");

  const channelPath = join(dir, "channel.json");
  writeFileSync(channelPath, canonical, "utf8");

  const seed = Buffer.from(opts.secretSeedHex, "hex");
  const prefix = Buffer.from(ED25519_PKCS8_PREFIX_HEX, "hex");
  const privateKey = createPrivateKey({
    key: Buffer.concat([prefix, seed]),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, canonicalBytes, privateKey);

  const sigPath = join(dir, `channel.json.sig.${opts.keyId}`);
  writeFileSync(sigPath, signature);

  return { channelPath: resolve(channelPath), sigPath: resolve(sigPath) };
}
