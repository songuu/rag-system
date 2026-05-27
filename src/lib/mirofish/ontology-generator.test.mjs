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
} = await import('./ontology-generator.ts');

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

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
