/**
 * DOMParser resolution shim.
 *
 * Browser/Tauri webview: native `globalThis.DOMParser` is available — used as-is.
 * Node (tests, server bootstrap): no native DOMParser. The test setup file
 *   (vitest.setup.ts) imports `DOMParser` from `linkedom` and assigns it to
 *   `globalThis.DOMParser` before tests run. Production Node callers do the
 *   same once at process start.
 *
 * This file deliberately does NOT statically import `linkedom` so that the
 * browser bundle never pulls linkedom in.
 */

export function getDOMParser(): typeof DOMParser {
  const ctor = (globalThis as unknown as { DOMParser?: typeof DOMParser })
    .DOMParser;
  if (!ctor) {
    throw new Error(
      "No DOMParser found in globalThis. In Node, import { DOMParser } from " +
        "'linkedom' and assign it to globalThis.DOMParser before calling extract().",
    );
  }
  return ctor;
}
