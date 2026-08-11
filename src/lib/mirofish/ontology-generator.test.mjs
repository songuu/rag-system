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
  OntologyGenerator,
  normalizeEntityTypeName,
  normalizeEdgeTypeName,
  sampleOntologyText,
} = await import('./ontology-generator.ts');
const { ONTOLOGY_CONSTANTS } = await import('./types.ts');
const { MiroFishJsonObjectResponseError } = await import('./json-object-response.ts');

test('normalizes MiroFish entity type names to PascalCase', () => {
  assert.equal(normalizeEntityTypeName('media outlet'), 'MediaOutlet');
  assert.equal(normalizeEntityTypeName('government_agency'), 'GovernmentAgency');
  assert.equal(normalizeEntityTypeName('studentRepresentative'), 'StudentRepresentative');
  assert.equal(normalizeEntityTypeName('NGO'), 'NGO');
});

test('normalizes MiroFish edge type names to screaming snake case', () => {
  assert.equal(normalizeEdgeTypeName('reports on'), 'REPORTS_ON');
  assert.equal(normalizeEdgeTypeName('affiliatedWith'), 'AFFILIATED_WITH');
  assert.equal(normalizeEdgeTypeName('supports'), 'SUPPORTS');
});

test('configures Ollama ontology generation for JSON output with enough context', () => {
  const generator = new OntologyGenerator({
    provider: 'ollama',
    modelName: 'llama3.1',
  });

  assert.equal(generator.llm.format, 'json');
  assert.equal(generator.llm.numCtx, 32768);
});

test('keeps the short-document ontology prompt unchanged', () => {
  const generator = createGenerator();
  const shortText = '第一段\n\n---\n\n第二段';

  assert.equal(sampleOntologyText(shortText), shortText);
  assert.equal(
    generator.buildUserMessage(
      ['第一段', '第二段'],
      '关注讨论',
      '仅分析公开信息',
    ),
    `## 模拟需求

关注讨论

## 文档内容

第一段

---

第二段

## 额外说明

仅分析公开信息
请根据以上内容，设计适合社会舆论模拟的实体类型和关系类型。

**必须遵守的规则**：
1. 必须正好输出10个实体类型
2. 最后2个必须是兜底类型：Person（个人兜底）和 Organization（组织兜底）
3. 前8个是根据文本内容设计的具体类型
4. 所有实体类型必须是现实中可以发声的主体，不能是抽象概念
5. 属性名不能使用 name、uuid、group_id 等保留字，用 full_name、org_name 等替代
`,
  );
});

test('deterministically samples oversized ontology text from head, middle, and tail within the full budget', () => {
  const source = [
    'HEAD_MARKER',
    'a'.repeat(ONTOLOGY_CONSTANTS.MAX_TEXT_LENGTH),
    'MIDDLE_MARKER',
    'b'.repeat(ONTOLOGY_CONSTANTS.MAX_TEXT_LENGTH),
    'TAIL_MARKER',
  ].join('');

  const sampled = sampleOntologyText(source);

  assert.equal(sampleOntologyText(source), sampled);
  assert.ok(sampled.length <= ONTOLOGY_CONSTANTS.MAX_TEXT_LENGTH);
  assert.match(sampled, /原文共\d+字，已按首\/中\/尾等距采样/u);
  assert.ok(sampled.includes('HEAD_MARKER'));
  assert.ok(sampled.includes('MIDDLE_MARKER'));
  assert.ok(sampled.includes('TAIL_MARKER'));
});

test('samples ontology text without splitting UTF-16 surrogate pairs at any segment boundary', () => {
  const sourceLength = ONTOLOGY_CONSTANTS.MAX_TEXT_LENGTH * 2 + 1;
  const separator = `\n\n...(原文共${sourceLength}字，已按首/中/尾等距采样；中间内容省略)...\n\n`;
  const contentBudget = ONTOLOGY_CONSTANTS.MAX_TEXT_LENGTH - separator.length * 2;
  const baseSampleLength = Math.floor(contentBudget / 3);
  const remainder = contentBudget % 3;
  const headLength = baseSampleLength + (remainder > 0 ? 1 : 0);
  const middleLength = baseSampleLength + (remainder > 1 ? 1 : 0);
  const tailLength = baseSampleLength;
  const middleStart = Math.floor((sourceLength - middleLength) / 2);
  const tailStart = sourceLength - tailLength;
  const boundaries = [
    headLength,
    middleStart,
    middleStart + middleLength,
    tailStart,
  ];
  let source = 'a'.repeat(sourceLength);

  for (const boundary of boundaries) {
    source = `${source.slice(0, boundary - 1)}😀${source.slice(boundary + 1)}`;
  }

  const sampled = sampleOntologyText(source);

  assert.ok(sampled.length <= ONTOLOGY_CONSTANTS.MAX_TEXT_LENGTH);
  assertNoLoneSurrogates(sampled);
});

test('uses the strict object parser and one fixed safe error for invalid ontology responses', () => {
  const generator = createGenerator();
  const secret = 'ONTOLOGY-SECRET-811';

  for (const response of [
    `{"first":1}{"secret":"${secret}"}`,
    '[{"entity_types":[],"edge_types":[]}]',
    `{"secret":"${secret}"`,
  ]) {
    const error = captureParseError(generator, response);

    assert.ok(error instanceof MiroFishJsonObjectResponseError);
    assert.equal(error.code, 'MIROFISH_JSON_OBJECT_RESPONSE_INVALID');
    assert.equal(error.message, 'Invalid MiroFish JSON object response.');
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(String(error), new RegExp(secret));
  }
});

test('fills missing attribute metadata from LLM-generated ontology output', () => {
  const generator = new OntologyGenerator({
    provider: 'ollama',
    modelName: 'llama3.1',
  });

  const ontology = generator.validateAndProcess({
    entity_types: [
      {
        name: 'Student',
        description: 'Current student',
        attributes: [{ name: 'full_name' }],
        examples: [],
      },
    ],
    edge_types: [],
  });

  assert.deepEqual(ontology.entity_types[0].attributes, [
    { name: 'full_name', type: 'text', description: '' },
  ]);
});

test('normalizes string attributes only at the LLM ontology processing boundary', () => {
  const generator = createGenerator();

  const ontology = generator.validateAndProcess({
    entity_types: [
      {
        name: 'Student',
        description: 'Current student',
        attributes: ['full_name'],
        examples: [],
      },
    ],
    edge_types: [
      {
        name: 'supports',
        description: 'Supports another subject',
        source_targets: [{ source: 'Student', target: 'Student' }],
        attributes: ['strength'],
      },
    ],
  });

  assert.deepEqual(ontology.entity_types[0].attributes, [
    { name: 'full_name', type: 'text', description: '' },
  ]);
  assert.deepEqual(ontology.edge_types[0].attributes, [
    { name: 'strength', type: 'text', description: '' },
  ]);
});

function createGenerator() {
  return new OntologyGenerator({
    provider: 'ollama',
    modelName: 'llama3.1',
  });
}

function captureParseError(generator, response) {
  try {
    generator.parseJsonResponse(response);
  } catch (error) {
    return error;
  }

  assert.fail('Expected ontology response parsing to fail.');
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
