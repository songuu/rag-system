import { createHash } from 'node:crypto';
import { types } from 'node:util';

export const CANONICAL_JSON_PROFILE = 'kg-canonical-json/v1' as const;
const MAX_ENCODED_BYTES = 256 * 1024;
const MAX_DEPTH = 64;

/**
 * Production contracts must not hash silently dropped/coerced input. Keep this
 * stricter profile separate from the already-frozen RagEval dataset hashes.
 * Limits and numeric/string rules belong to the versioned profile, not callers.
 */
export function canonicalJson(value: unknown): string {
  const chunks: string[] = [];
  const ancestors = new WeakSet<object>();
  let encodedBytes = 0;

  const append = (text: string, location: string): void => {
    encodedBytes += Buffer.byteLength(text, 'utf8');
    if (encodedBytes > MAX_ENCODED_BYTES) fail(location, 'encoded size exceeds 256 KiB');
    chunks.push(text);
  };

  const encodeString = (text: string, location: string): string => {
    if (text.length > MAX_ENCODED_BYTES) fail(location, 'encoded size exceeds 256 KiB');
    for (let index = 0; index < text.length; index += 1) {
      const unit = text.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail(location, 'unpaired Unicode surrogate');
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        fail(location, 'unpaired Unicode surrogate');
      }
    }
    return JSON.stringify(text);
  };

  const visit = (input: unknown, location: string, depth: number): void => {
    if (depth > MAX_DEPTH) fail(location, 'nesting depth exceeds 64');
    if (input === null) { append('null', location); return; }
    if (typeof input === 'string') { append(encodeString(input, location), location); return; }
    if (typeof input === 'boolean') { append(input ? 'true' : 'false', location); return; }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)
        || (Number.isInteger(input) && !Number.isSafeInteger(input))) {
        fail(location, 'number must be finite and integers must be safe');
      }
      append(JSON.stringify(input), location);
      return;
    }
    if (typeof input !== 'object') fail(location, 'unsupported JSON value type');
    // Reflection on a Proxy executes caller code before descriptor validation.
    if (types.isProxy(input)) fail(location, 'proxy values are unsupported');
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      fail(location, 'must be a plain object or ordinary array without a custom prototype');
    }
    if (ancestors.has(input)) fail(location, 'cyclic value');
    ancestors.add(input);
    try {
      const keys = Reflect.ownKeys(input);
      if (keys.some(key => typeof key === 'symbol')) fail(location, 'symbol properties are unsupported');
      if (array) {
        for (const key of keys) {
          if (key === 'length') continue;
          if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length) {
            fail(location, 'array extra properties are unsupported');
          }
        }
        append('[', location);
        for (let index = 0; index < input.length; index += 1) {
          if (index > 0) append(',', location);
          const child = `${location}[${index}]`;
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor) fail(child, 'sparse array hole');
          assertDataProperty(descriptor, child);
          visit(descriptor.value, child, depth + 1);
        }
        append(']', location);
      } else {
        append('{', location);
        const names = (keys as string[]).sort();
        names.forEach((key, index) => {
          if (index > 0) append(',', location);
          const child = `${location}.property[${index}]`;
          const descriptor = Object.getOwnPropertyDescriptor(input, key);
          if (!descriptor) fail(child, 'data property disappeared during encoding');
          assertDataProperty(descriptor, child);
          append(encodeString(key, child), child);
          append(':', location);
          visit(descriptor.value, child, depth + 1);
        });
        append('}', location);
      }
    } finally {
      ancestors.delete(input);
    }
  };

  visit(value, '$', 0);
  return chunks.join('');
}

export function canonicalJsonSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function assertDataProperty(descriptor: PropertyDescriptor, location: string): void {
  if (!Object.hasOwn(descriptor, 'value')) fail(location, 'accessor is not a data property');
  if (!descriptor.enumerable) fail(location, 'property must be enumerable; hidden properties are unsupported');
}

function fail(location: string, reason: string): never {
  // Report the contract location, not the potentially secret rejected value.
  throw new Error(`canonical JSON at ${location}: ${reason}`);
}
