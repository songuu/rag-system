import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const { CANONICAL_JSON_PROFILE, canonicalJson, canonicalJsonSha256 } = await import(
  './canonical-json.ts'
);

test('the versioned profile sorts object keys, preserves array order and hashes exact UTF-8', () => {
  assert.equal(CANONICAL_JSON_PROFILE, 'kg-canonical-json/v1');
  const encoded = canonicalJson({ z: [3, 1], a: { b: '中文😀', a: true } });
  assert.equal(encoded, '{"a":{"a":true,"b":"中文😀"},"z":[3,1]}');
  assert.equal(
    canonicalJsonSha256({ a: { a: true, b: '中文😀' }, z: [3, 1] }),
    createHash('sha256').update(encoded, 'utf8').digest('hex')
  );
  assert.notEqual(canonicalJsonSha256([1, 3]), canonicalJsonSha256([3, 1]));
});

test('numeric-looking keys use the same lexical ordering as other object keys', () => {
  assert.equal(canonicalJson({ 2: 'two', 10: 'ten', 1: 'one' }),
    '{"1":"one","10":"ten","2":"two"}');
});

test('finite JSON primitives and negative zero have an explicit encoding', () => {
  assert.equal(canonicalJson([null, false, 0.25, -0, '']), '[null,false,0.25,0,""]');
  assert.notEqual(canonicalJsonSha256('é'), canonicalJsonSha256('e\u0301'));
});

test('lossy, unsupported values are rejected rather than silently omitted or coerced', () => {
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('x'), () => 1,
    Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => canonicalJson({ value }), /canonical JSON.*\$/i);
  }
  assert.throws(() => canonicalJson({ value: new Date() }), /plain.*object|prototype/i);
  assert.throws(() => canonicalJson({ value: new Map() }), /plain.*object|prototype/i);
});

test('accessors and hidden or symbol properties cannot create hash ambiguity', () => {
  let invoked = false;
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() { invoked = true; throw new Error('must not invoke getter'); },
  });
  assert.throws(() => canonicalJson(accessor), /accessor|data property/i);
  assert.equal(invoked, false);
  assert.throws(() => canonicalJson(Object.defineProperty({}, 'hidden', { value: 1 })),
    /enumerable|hidden/i);
  assert.throws(() => canonicalJson({ [Symbol('hidden')]: 1 }), /symbol/i);
});

test('array holes, undefined elements and extra properties are not omitted', () => {
  assert.throws(() => canonicalJson(Array(1)), /sparse|hole/i);
  assert.throws(() => canonicalJson([undefined]), /canonical JSON/i);
  assert.throws(() => canonicalJson(Object.assign([1], { extra: 2 })), /array.*propert/i);
});

test('cycles fail closed while repeated noncyclic values encode by value', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /cycl/i);
  const shared = { a: 1 };
  assert.equal(canonicalJson([shared, shared]), '[{"a":1},{"a":1}]');
});

test('unpaired UTF-16 surrogates are rejected in values and keys', () => {
  for (const value of ['\ud800', '\udc00', 'x\ud800y']) {
    assert.throws(() => canonicalJson(value), /surrogate|Unicode/i);
    assert.throws(() => canonicalJson({ [value]: 1 }), /surrogate|Unicode/i);
  }
  assert.equal(canonicalJson('😀'), '"😀"');
});

test('fixed depth and encoded-byte limits bound hostile input without changing the profile', () => {
  let deep = null;
  for (let i = 0; i < 66; i++) deep = [deep];
  assert.throws(() => canonicalJson(deep), /depth/i);
  assert.throws(() => canonicalJson('a'.repeat(256 * 1024)), /bytes|size/i);
});

test('null-prototype records and own prototype-named keys encode without mutation', () => {
  const record = Object.assign(Object.create(null), { a: 1 });
  assert.equal(canonicalJson(record), '{"a":1}');
  const original = JSON.parse('{"__proto__":{"polluted":true},"constructor":1}');
  assert.equal(canonicalJson(original), '{"__proto__":{"polluted":true},"constructor":1}');
  assert.equal({}.polluted, undefined);
});

test('error locations contain structural ordinals, never arbitrary input keys or values', () => {
  const secretLabel = 'production-credential-label';
  const input = { [secretLabel]: undefined };
  assert.throws(() => canonicalJson(input), error => {
    assert.equal(error.message.includes(secretLabel), false);
    assert.match(error.message, /\$.*0/);
    return true;
  });
});

test('proxies fail closed before any trap executes, including arrays and revoked proxies', () => {
  let trapCalls = 0;
  const secretLabel = 'secret-from-proxy-trap';
  const traps = Object.fromEntries(['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor', 'get']
    .map(name => [name, () => { trapCalls += 1; throw new Error(secretLabel); }]));
  const revoked = Proxy.revocable({}, traps);
  revoked.revoke();
  for (const input of [new Proxy({}, traps), new Proxy([], traps), revoked.proxy]) {
    for (const encode of [canonicalJson, canonicalJsonSha256]) {
      assert.throws(() => encode({ input }), error => {
        assert.equal(error.message, 'canonical JSON at $.property[0]: proxy values are unsupported');
        assert.equal(error.message.includes(secretLabel), false);
        return true;
      });
    }
  }
  assert.equal(trapCalls, 0);
});

test('a proxy cannot supply changing descriptors to produce different hashes', () => {
  let descriptorCalls = 0;
  const input = new Proxy({ value: 0 }, {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'value') return { configurable: true, enumerable: true, writable: true,
        value: descriptorCalls++ };
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => canonicalJsonSha256(input), /proxy values are unsupported/);
  }
  assert.equal(descriptorCalls, 0);
});
