/**
 * Minimal RFC 8785 (JCS) canonicalizer. No dependencies.
 * Returns the UTF-8 string of the canonical bytes.
 * Rules: UTF-16-code-unit key sort, no whitespace, shortest-form numbers
 * (-0 -> "-0"), minimal string escapes, recursive nesting. Throws on values
 * with no JSON representation (undefined, functions, symbols, bigint,
 * NaN/Infinity, non-plain objects).
 */
export function canonicalizeJson(value: unknown): string {
  return canonicalize(value);
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return canonicalizeString(value);
  if (typeof value === "number") return canonicalizeNumber(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("canonicalizeJson: non-plain object");
    }
    const keys = Object.keys(value).sort();
    const body = keys
      .map((k) => `${canonicalizeString(k)}:${canonicalize((value as Record<string, unknown>)[k])}`)
      .join(",");
    return `{${body}}`;
  }
  throw new TypeError(`canonicalizeJson: unsupported type ${typeof value}`);
}

function canonicalizeNumber(n: number): string {
  if (!Number.isFinite(n)) throw new TypeError("canonicalizeJson: non-finite number");
  if (Object.is(n, -0)) return "-0";
  return String(n);
}

function canonicalizeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (s[i] === '"') out += '\\"';
    else if (s[i] === "\\") out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20) out += `\\u00${c.toString(16).padStart(2, "0")}`;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const lo = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        out += s[i]! + s[i + 1]!;
        i++;
      } else {
        out += `\\u${c.toString(16).padStart(4, "0")}`;
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out += `\\u${c.toString(16).padStart(4, "0")}`;
    } else {
      out += s[i]!;
    }
  }
  return out + '"';
}
