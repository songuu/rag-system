import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const {
  MiroFishJsonObjectResponseError,
} = await import('./json-object-response.ts');
const { ProfileGenerator } = await import('./profile-generator.ts');

const generator = Object.create(ProfileGenerator.prototype);
const entity = {
  name: 'Fallback Name',
  type: 'person',
  description: 'Fallback background',
};
const enabledOptions = {
  includePersonality: true,
  includeViewpoints: true,
  includePosts: true,
};

test('uses the strict MiroFish JSON object parser without greedy extraction or repair', () => {
  assert.deepEqual(generator.parseProfileResponse('{"full_name":"Ada"}'), {
    full_name: 'Ada',
  });

  for (const response of [
    'prefix {"full_name":"Ada"}',
    '{"full_name":"Ada"} suffix',
    '{"full_name":"Ada",}',
    '{"full_name"："Ada"}',
    '{"first":1}{"second":2}',
  ]) {
    assert.throws(
      () => generator.parseProfileResponse(response),
      error => error instanceof MiroFishJsonObjectResponseError,
    );
  }
});

test('preserves special viewpoint keys through generate, strict parse, and build', async () => {
  const fullPathGenerator = Object.create(ProfileGenerator.prototype);
  fullPathGenerator.llm = {
    async invoke() {
      return {
        content: '{"full_name":"Ada","viewpoints":{"__proto__":"proto viewpoint","constructor":"constructor viewpoint","prototype":"prototype viewpoint","safe":"safe viewpoint"}}',
      };
    },
  };

  const profile = await fullPathGenerator.generateProfile({
    entity,
    simulationContext: 'Test special viewpoint keys.',
    options: enabledOptions,
  });

  assert.equal(Object.getPrototypeOf(profile.viewpoints), Object.prototype);
  assert.deepEqual(Object.keys(profile.viewpoints), [
    '__proto__',
    'constructor',
    'prototype',
    'safe',
  ]);
  for (const [key, value] of [
    ['__proto__', 'proto viewpoint'],
    ['constructor', 'constructor viewpoint'],
    ['prototype', 'prototype viewpoint'],
    ['safe', 'safe viewpoint'],
  ]) {
    assert.equal(Object.hasOwn(profile.viewpoints, key), true);
    assert.equal(profile.viewpoints[key], value);
  }
  assert.equal(
    JSON.stringify(profile.viewpoints),
    '{"__proto__":"proto viewpoint","constructor":"constructor viewpoint","prototype":"prototype viewpoint","safe":"safe viewpoint"}',
  );
});

test('coerces structured profile fields by semantic priority before safe JSON serialization', () => {
  const profile = buildProfile({
    full_name: {
      name: 'name',
      summary: 'summary',
      content: 'content',
      description: 'description',
      value: 'value',
      text: 'text',
    },
    gender: { value: 'nonbinary' },
    occupation: { description: 'researcher' },
    position: { content: 'principal investigator' },
    speaking_style: { summary: 'precise and concise' },
    social_media_style: { name: 'educational' },
    background: { years: 12, domain: 'safety' },
    personality_traits: [
      { text: 'curious' },
      { value: 'methodical' },
      { description: 'empathetic' },
      { content: 'direct' },
      { summary: 'patient' },
      { name: 'builder' },
      { nested: true },
    ],
    typical_posts: [
      { content: 'Read the primary source.' },
      { tags: ['research', 'safety'] },
    ],
    viewpoints: {
      privacy: { summary: 'Privacy is a design requirement.' },
      tooling: { nested: { evidence: true } },
    },
  });

  assert.equal(profile.full_name, 'text');
  assert.equal(profile.gender, 'nonbinary');
  assert.equal(profile.occupation, 'researcher');
  assert.equal(profile.position, 'principal investigator');
  assert.equal(profile.speaking_style, 'precise and concise');
  assert.equal(profile.social_media_style, 'educational');
  assert.equal(profile.background, '{"years":12,"domain":"safety"}');
  assert.deepEqual(profile.personality_traits, [
    'curious',
    'methodical',
    'empathetic',
    'direct',
    'patient',
    'builder',
    '{"nested":true}',
  ]);
  assert.deepEqual(profile.typical_posts, [
    'Read the primary source.',
    '{"tags":["research","safety"]}',
  ]);
  assert.deepEqual(profile.viewpoints, {
    privacy: 'Privacy is a design requirement.',
    tooling: '{"nested":{"evidence":true}}',
  });
  assert.doesNotMatch(JSON.stringify(profile), /\[object Object\]/u);
});

test('accepts string and structured singleton values for profile list fields', () => {
  const profile = buildProfile({
    personality_traits: 'curious',
    typical_posts: { content: 'Read the primary source.' },
  });

  assert.deepEqual(profile.personality_traits, ['curious']);
  assert.deepEqual(profile.typical_posts, ['Read the primary source.']);
});

test('coerces and bounds expertise while preserving missing expertise', () => {
  const longExpertise = { text: `领域${'x'.repeat(2_000)}` };
  const expertise = Array.from({ length: 40 }, (_, index) => (
    index === 0 ? { text: 'AI safety' } : longExpertise
  ));

  const profile = buildProfile({ expertise });
  const missing = buildProfile({});

  assert.equal(profile.expertise.length, 32);
  assert.equal(profile.expertise[0], 'AI safety');
  assert.ok(profile.expertise.slice(1).every(value => value.length === 1_024));
  assert.doesNotMatch(JSON.stringify(profile.expertise), /\[object Object\]/u);
  assert.equal(missing.expertise, undefined);
});

test('falls back safely for circular and otherwise unserializable structured values', () => {
  const circular = {};
  circular.self = circular;

  const containsBigInt = { value: { count: 1n } };
  const throwingGetter = {};
  Object.defineProperty(throwingGetter, 'text', {
    enumerable: true,
    get() {
      throw new Error('unreadable');
    },
  });

  const profile = buildProfile({
    full_name: circular,
    gender: containsBigInt,
    occupation: throwingGetter,
    position: circular,
    speaking_style: circular,
    social_media_style: containsBigInt,
    background: throwingGetter,
    personality_traits: [circular, containsBigInt, throwingGetter, { text: 'safe' }],
    typical_posts: [circular, { content: 'safe post' }],
    viewpoints: {
      circular,
      bigint: containsBigInt,
      getter: throwingGetter,
      safe: { description: 'safe viewpoint' },
    },
  });

  assert.equal(profile.full_name, entity.name);
  assert.equal(profile.gender, '');
  assert.equal(profile.occupation, '');
  assert.equal(profile.position, undefined);
  assert.equal(profile.speaking_style, '');
  assert.equal(profile.social_media_style, '');
  assert.equal(profile.background, entity.description);
  assert.deepEqual(profile.personality_traits, ['', '', '', 'safe']);
  assert.deepEqual(profile.typical_posts, ['', 'safe post']);
  assert.deepEqual(profile.viewpoints, {
    circular: '',
    bigint: '',
    getter: '',
    safe: 'safe viewpoint',
  });
  assert.doesNotMatch(JSON.stringify(profile), /\[object Object\]/u);
});

test('bounds scalar, collection, and collection-item profile text', () => {
  const longScalar = 's'.repeat(5_000);
  const longItem = 'i'.repeat(2_000);
  const list = Array.from({ length: 40 }, () => longItem);
  const viewpoints = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [`topic-${index}`, longItem]),
  );

  const profile = buildProfile({
    full_name: longScalar,
    gender: longScalar,
    occupation: longScalar,
    position: longScalar,
    speaking_style: longScalar,
    social_media_style: longScalar,
    background: longScalar,
    personality_traits: list,
    typical_posts: list,
    viewpoints,
  });

  for (const value of [
    profile.full_name,
    profile.gender,
    profile.occupation,
    profile.position,
    profile.speaking_style,
    profile.social_media_style,
    profile.background,
  ]) {
    assert.equal(value.length, 4_096);
  }

  for (const values of [profile.personality_traits, profile.typical_posts]) {
    assert.equal(values.length, 32);
    assert.ok(values.every(value => value.length === 1_024));
  }

  assert.equal(Object.keys(profile.viewpoints).length, 32);
  assert.ok(Object.values(profile.viewpoints).every(value => value.length === 1_024));
});

test('bounds profile text without splitting UTF-16 surrogate pairs', () => {
  const scalar = `${'s'.repeat(4_095)}😀`;
  const listItem = `${'i'.repeat(1_023)}😀`;

  const profile = buildProfile({
    full_name: scalar,
    personality_traits: [listItem],
    typical_posts: [listItem],
    expertise: [listItem],
    viewpoints: { unicode: listItem },
  });

  for (const value of [
    profile.full_name,
    profile.personality_traits[0],
    profile.typical_posts[0],
    profile.expertise[0],
    profile.viewpoints.unicode,
  ]) {
    assertNoLoneSurrogates(value);
  }
});

test('bounds viewpoint topic keys without splitting UTF-16 surrogate pairs', () => {
  const longEmojiKey = `x${'😀'.repeat(512)}`;
  const profile = buildProfile({
    viewpoints: { [longEmojiKey]: 'emoji viewpoint' },
  });

  const [topic] = Object.keys(profile.viewpoints);
  assert.equal(topic, `x${'😀'.repeat(511)}`);
  assert.ok(topic.length <= 1_024);
  assertNoLoneSurrogates(topic);
  assert.equal(profile.viewpoints[topic], 'emoji viewpoint');
});

test('deduplicates viewpoint topic keys after truncation without losing entries', () => {
  const sharedPrefix = `${'t'.repeat(1_022)}😀`;
  const profile = buildProfile({
    viewpoints: {
      [`${sharedPrefix}-first`]: 'first viewpoint',
      [`${sharedPrefix}-second`]: 'second viewpoint',
    },
  });

  assert.deepEqual(Object.entries(profile.viewpoints), [
    [sharedPrefix, 'first viewpoint'],
    [`${'t'.repeat(1_022)}#2`, 'second viewpoint'],
  ]);
  assert.equal(Object.keys(profile.viewpoints).length, 2);
  for (const topic of Object.keys(profile.viewpoints)) {
    assert.ok(topic.length <= 1_024);
    assertNoLoneSurrogates(topic);
  }
});

test('preserves short viewpoint topic keys', () => {
  const profile = buildProfile({
    viewpoints: { privacy: 'Privacy is a design requirement.' },
  });

  assert.deepEqual(profile.viewpoints, {
    privacy: 'Privacy is a design requirement.',
  });
});

test('falls back safely when semantic profile fields exceed the recursion budget', () => {
  let deeplyNested = 'leaf';
  for (let index = 0; index < 20_000; index += 1) {
    deeplyNested = { text: deeplyNested };
  }

  const profile = buildProfile({
    full_name: deeplyNested,
    personality_traits: [deeplyNested],
  });

  assert.equal(profile.full_name, entity.name);
  assert.deepEqual(profile.personality_traits, ['']);
});

test('preserves behavioral anchor validation and numeric clamps', () => {
  const profile = buildProfile({
    behavioral_anchors: {
      posting_style: 'unsupported',
      active_hours: Array.from({ length: 24 }, (_, hour) => hour),
      stance: 'amplifier',
      opinion_drift_rate: 9,
      influence_weight: -9,
    },
  });

  assert.deepEqual(profile.behavioral_anchors, {
    posting_style: 'data-driven',
    active_hours: Array.from({ length: 12 }, (_, hour) => hour),
    stance: 'amplifier',
    opinion_drift_rate: 1,
    influence_weight: 0.5,
  });
});

function buildProfile(data) {
  return generator.buildEntityProfile(entity, data, enabledOptions);
}

function assertNoLoneSurrogates(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, `lone high surrogate at ${index}`);
      index += 1;
      continue;
    }
    assert.ok(
      codeUnit < 0xdc00 || codeUnit > 0xdfff,
      `lone low surrogate at ${index}`,
    );
  }
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
