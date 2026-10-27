import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context); throw error; } } });
let subject;
try { subject = await import('./build-publication-manifest.ts'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; subject = {}; }
const fixture = () => ({ tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-a', artifactDigest: `sha256:${'a'.repeat(64)}`,
  documents: [{ documentId: 'doc-a', documentVersion: 'v1', trustLevel: 'reviewed' }, { documentId: 'doc-b', documentVersion: 'v2', trustLevel: 'trusted' }] });

test('persisted build publication manifest has creation and validation entry points', () => {
  assert.equal(typeof subject.createBuildPublicationManifest, 'function'); assert.equal(typeof subject.validateBuildPublicationManifest, 'function');
});
test('manifest binds scope, version, artifact and full sorted documents without authenticating the producer', () => {
  const input = fixture(); input.documents.reverse(); const value = subject.createBuildPublicationManifest(input);
  assert.equal(value.schemaVersion, 'kg-build-publication-manifest/v1'); assert.deepEqual(value.documents, fixture().documents);
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.documents[0])); input.documents[0].documentVersion = 'modified';
  assert.equal(value.documents[1].documentVersion, 'v2'); assert.deepEqual(subject.validateBuildPublicationManifest(value), value);
});
test('validator rejects missing, duplicate, unsorted or substituted manifest fields', () => {
  for (const change of [v => { v.schemaVersion = 'other'; }, v => { v.documents = []; }, v => { v.documents.reverse(); },
    v => { v.documents.push({ ...v.documents[0] }); }, v => { v.documents[0].trustLevel = 'unknown'; }, v => { v.extra = true; },
    v => { v.documents[0].count = 1; }, v => { v.artifactDigest = 'a'.repeat(64); }, v => { v.tenantId = '../other'; }, v => { v.documents[0].documentId = ''; }]) {
    const value = structuredClone(subject.createBuildPublicationManifest(fixture())); change(value);
    assert.throws(() => subject.validateBuildPublicationManifest(value), /publication manifest is invalid/);
  }
});
test('document/version duplicates are forbidden even when trust differs; manifest capacity is bounded', () => {
  const input = fixture(); input.documents.push({ ...input.documents[0], trustLevel: 'external' });
  assert.throws(() => subject.createBuildPublicationManifest(input), /publication manifest is invalid/);
  const many = fixture(); many.documents = Array.from({ length: 513 }, (_, i) => ({ documentId: `doc-${i}`, documentVersion: 'v1', trustLevel: 'reviewed' }));
  assert.throws(() => subject.createBuildPublicationManifest(many), /publication manifest is invalid/);
});

test('existing opaque Chinese and path-like document identities retain their exact values', () => {
  for (const [documentId, documentVersion] of [['课程甲', 'v1'], ['doc/a', 'v1'], ['doc-a', '版本/一']]) {
    const input = fixture(); input.documents = [{ documentId, documentVersion, trustLevel: 'reviewed' }];
    const manifest = subject.createBuildPublicationManifest(input);
    assert.deepEqual(manifest.documents, input.documents);
    assert.deepEqual(subject.validateBuildPublicationManifest(manifest), manifest);
  }
  for (const value of ['', ' ', 'doc\u0000a', 'doc\na', 'x'.repeat(513)]) {
    const input = fixture(); input.documents[0].documentId = value;
    assert.throws(() => subject.createBuildPublicationManifest(input), /publication manifest is invalid/);
  }
});
test('hostile getters and Proxy manifest inputs do not execute hooks or leak their text', () => {
  let hooks = 0; const value = fixture(); Object.defineProperty(value, 'documents', { enumerable: true, get() { hooks++; throw new Error('secret-token'); } });
  assert.throws(() => subject.createBuildPublicationManifest(value), /publication manifest is invalid/);
  assert.throws(() => subject.validateBuildPublicationManifest(new Proxy({}, { ownKeys() { hooks++; throw new Error('secret-token'); } })), /publication manifest is invalid/);
  assert.equal(hooks, 0);
});
