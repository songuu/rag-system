import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
  LocalBackfillError,
  applyLocalBackfill,
  buildLocalBackfillPlan,
  inspectLocalBackfill,
  resetLocalBackfillReceipt,
} = await import('./backfill-local-postgres.mjs');

const SCOPE = { tenantId: 'tenant-a', corpusId: 'corpus-a' };

test('MAIC manifests that reuse the parsed filename produce one parsed blob', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceRoot = path.join(directory, 'uploads');
    const content = 'slide one\nslide two\n';
    const item = manifestItem({ content });
    await writeSource(sourceRoot, { [item.id]: item }, {
      [item.storedFilename]: content,
    });

    const plan = await buildLocalBackfillPlan([sourceRoot]);

    assert.equal(plan.documents.length, 1);
    assert.equal(plan.blobs.length, 1);
    assert.equal(plan.blobs[0].filename, item.storedFilename);
    assert.equal(plan.blobs[0].kind, 'parsed');
    assert.equal(plan.blobs[0].contentType, 'text/plain');
    assert.equal(plan.blobs[0].data.toString('utf8'), content);
    assert.match(plan.blobs[0].sha256, /^[0-9a-f]{64}$/);
  });
});

test('identical documents and blobs copied across source roots are deduplicated deterministically', async () => {
  await withTemporaryDirectory(async (directory) => {
    const firstRoot = path.join(directory, 'release-a', 'uploads');
    const secondRoot = path.join(directory, 'release-b', 'uploads');
    const content = 'same parsed content';
    const item = manifestItem({ content });
    const manifest = { [item.id]: item };
    const blobs = { [item.storedFilename]: content };
    await Promise.all([
      writeSource(firstRoot, manifest, blobs),
      writeSource(secondRoot, manifest, blobs),
    ]);

    const forward = await buildLocalBackfillPlan([firstRoot, secondRoot, firstRoot]);
    const reverse = await buildLocalBackfillPlan([secondRoot, firstRoot]);

    assert.equal(forward.sources.length, 2);
    assert.equal(forward.documents.length, 1);
    assert.equal(forward.blobs.length, 1);
    assert.equal(forward.hash, reverse.hash);
    assert.deepEqual(forward.documents, reverse.documents);
    assert.deepEqual(forward.blobs, reverse.blobs);
  });
});

test('conflicting document ids across source roots are rejected', async () => {
  await withTemporaryDirectory(async (directory) => {
    const firstRoot = path.join(directory, 'release-a', 'uploads');
    const secondRoot = path.join(directory, 'release-b', 'uploads');
    const first = manifestItem({ content: 'alpha', originalName: 'alpha.pptx' });
    const second = manifestItem({
      content: 'bravo',
      originalName: 'bravo.pptx',
      storedFilename: 'bravo.txt',
    });
    await Promise.all([
      writeSource(firstRoot, { [first.id]: first }, { [first.storedFilename]: 'alpha' }),
      writeSource(secondRoot, { [second.id]: second }, { [second.storedFilename]: 'bravo' }),
    ]);

    await assert.rejects(
      () => buildLocalBackfillPlan([firstRoot, secondRoot]),
      (error) => error instanceof LocalBackfillError
        && /conflicting document ids/i.test(error.message)
    );
  });
});

test('conflicting blob filenames across source roots are rejected', async () => {
  await withTemporaryDirectory(async (directory) => {
    const firstRoot = path.join(directory, 'release-a', 'uploads');
    const secondRoot = path.join(directory, 'release-b', 'uploads');
    const first = manifestItem({ id: 'maic-a', content: 'alpha' });
    const second = manifestItem({ id: 'maic-b', content: 'bravo' });
    await Promise.all([
      writeSource(firstRoot, { [first.id]: first }, { [first.storedFilename]: 'alpha' }),
      writeSource(secondRoot, { [second.id]: second }, { [second.storedFilename]: 'bravo' }),
    ]);

    await assert.rejects(
      () => buildLocalBackfillPlan([firstRoot, secondRoot]),
      (error) => error instanceof LocalBackfillError
        && /conflicting blob filenames/i.test(error.message)
    );
  });
});

test('unsafe, missing, and size-mismatched manifest blobs are rejected', async () => {
  await withTemporaryDirectory(async (directory) => {
    const traversalRoot = path.join(directory, 'traversal', 'uploads');
    const traversal = manifestItem({ content: 'alpha', storedFilename: '../outside.txt' });
    await writeSource(traversalRoot, { [traversal.id]: traversal }, {});
    await assert.rejects(
      () => buildLocalBackfillPlan([traversalRoot]),
      (error) => error instanceof LocalBackfillError && /filename is unsafe/i.test(error.message)
    );

    const missingRoot = path.join(directory, 'missing-blob', 'uploads');
    const missing = manifestItem({ content: 'alpha' });
    await writeSource(missingRoot, { [missing.id]: missing }, {});
    await assert.rejects(
      () => buildLocalBackfillPlan([missingRoot]),
      (error) => error instanceof LocalBackfillError && /missing blob/i.test(error.message)
    );

    const mismatchRoot = path.join(directory, 'size-mismatch', 'uploads');
    const mismatch = manifestItem({ content: 'alpha', size: 6 });
    await writeSource(mismatchRoot, { [mismatch.id]: mismatch }, {
      [mismatch.storedFilename]: 'alpha',
    });
    await assert.rejects(
      () => buildLocalBackfillPlan([mismatchRoot]),
      (error) => error instanceof LocalBackfillError && /size does not match/i.test(error.message)
    );
  });
});

test('symbolic-link source roots are rejected', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceRoot = path.join(directory, 'real-uploads');
    const linkedRoot = path.join(directory, 'linked-uploads');
    const content = 'linked content';
    const item = manifestItem({ content });
    await writeSource(sourceRoot, { [item.id]: item }, {
      [item.storedFilename]: content,
    });
    await symlink(sourceRoot, linkedRoot, 'junction');

    await assert.rejects(
      () => buildLocalBackfillPlan([linkedRoot]),
      (error) => error instanceof LocalBackfillError && /non-symlink directory/i.test(error.message)
    );
  });
});

test('empty, missing, and manifest-free source roots produce an empty plan', async () => {
  await withTemporaryDirectory(async (directory) => {
    const emptyRoot = path.join(directory, 'empty-uploads');
    const missingRoot = path.join(directory, 'missing-uploads');
    await mkdir(emptyRoot, { recursive: true });

    for (const roots of [[], [missingRoot], [emptyRoot], [missingRoot, emptyRoot]]) {
      const plan = await buildLocalBackfillPlan(roots);
      assert.deepEqual(plan.sources, []);
      assert.deepEqual(plan.documents, []);
      assert.deepEqual(plan.blobs, []);
      assert.match(plan.hash, /^[0-9a-f]{64}$/);
    }

    await assert.rejects(
      () => buildLocalBackfillPlan(['relative/uploads']),
      (error) => error instanceof LocalBackfillError && /must be absolute paths/i.test(error.message)
    );
  });
});

test('an exact corpus receipt completes inspection only after scanning blob and document rows', async () => {
  const plan = receiptPlan();
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (/metadata->'local_postgres_backfill' as receipt/i.test(text)) {
        return { rows: [{ receipt: receiptFor(plan) }], rowCount: 1 };
      }
      if (/select 1\s+from public\.tenants/i.test(text)) {
        return { rows: [{}], rowCount: 1 };
      }
      if (/from public\.object_blobs/i.test(text)) {
        return { rows: [blobRowFor(plan.blobs[0])], rowCount: 1 };
      }
      if (/from public\.document_assets/i.test(text)) {
        return { rows: [documentRowFor(plan.documents[0])], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const status = await inspectLocalBackfill(client, plan, SCOPE);

  assert.deepEqual(status, { complete: true, missing: 0, receipt: true });
  assert.equal(calls.length, 4);
  assert.match(calls[0].text, /metadata->'local_postgres_backfill' as receipt/i);
  assert.deepEqual(calls[0].values, ['tenant-a', 'corpus-a']);
  assert.ok(calls.some(({ text }) => /from public\.object_blobs/i.test(text)));
  assert.ok(calls.some(({ text }) => /from public\.document_assets/i.test(text)));
});

test('a matching receipt with a missing blob remains incomplete after row readback', async () => {
  const plan = receiptPlan();
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (/metadata->'local_postgres_backfill' as receipt/i.test(text)) {
        return { rows: [{ receipt: receiptFor(plan) }], rowCount: 1 };
      }
      if (/select 1\s+from public\.tenants/i.test(text)) {
        return { rows: [{}], rowCount: 1 };
      }
      if (/from public\.object_blobs/i.test(text)) return { rows: [], rowCount: 0 };
      if (/from public\.document_assets/i.test(text)) {
        return { rows: [documentRowFor(plan.documents[0])], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const status = await inspectLocalBackfill(client, plan, SCOPE);

  assert.deepEqual(status, { complete: false, missing: 1, receipt: true });
  assert.ok(calls.some(({ text }) => /from public\.object_blobs/i.test(text)));
  assert.ok(calls.some(({ text }) => /from public\.document_assets/i.test(text)));
});

test('a matching receipt with a corrupted blob fails closed after digest readback', async () => {
  const plan = receiptPlan();
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (/metadata->'local_postgres_backfill' as receipt/i.test(text)) {
        return { rows: [{ receipt: receiptFor(plan) }], rowCount: 1 };
      }
      if (/select 1\s+from public\.tenants/i.test(text)) {
        return { rows: [{}], rowCount: 1 };
      }
      if (/from public\.object_blobs/i.test(text)) {
        return {
          rows: [{ ...blobRowFor(plan.blobs[0]), data: Buffer.from('corrupted') }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  await assert.rejects(
    () => inspectLocalBackfill(client, plan, SCOPE),
    (error) => error instanceof LocalBackfillError && /conflicting.*blob/i.test(error.message)
  );
  assert.ok(calls.some(({ text }) => /from public\.object_blobs/i.test(text)));
});

test('a conflicting corpus receipt fails closed without scanning blob or document rows', async () => {
  const plan = receiptPlan();
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      return {
        rows: [{ receipt: { ...receiptFor(plan), plan_sha256: '0'.repeat(64) } }],
        rowCount: 1,
      };
    },
  };

  await assert.rejects(
    () => inspectLocalBackfill(client, plan, SCOPE),
    (error) => error instanceof LocalBackfillError && /conflicting.*receipt/i.test(error.message)
  );
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].text, /object_blobs|document_assets/i);
});

test('apply imports missing rows, records the receipt, commits, and verifies by receipt', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceRoot = path.join(directory, 'uploads');
    const content = 'content to import';
    const item = manifestItem({ content });
    await writeSource(sourceRoot, { [item.id]: item }, {
      [item.storedFilename]: content,
    });
    const plan = await buildLocalBackfillPlan([sourceRoot]);
    const calls = [];
    let blobRow;
    let documentRow;
    let receipt;
    const client = {
      async query(text, values) {
        calls.push({ text, values });
        if (/metadata->'local_postgres_backfill' as receipt/i.test(text)) {
          return { rows: [{ receipt }], rowCount: 1 };
        }
        if (/select kind, data, content_type\s+from public\.object_blobs/i.test(text)) {
          return { rows: blobRow ? [blobRow] : [], rowCount: blobRow ? 1 : 0 };
        }
        if (/insert into public\.object_blobs/i.test(text)) {
          blobRow = { kind: values[2], data: values[4], content_type: values[5] };
          return { rows: [], rowCount: 1 };
        }
        if (/select original_name, content_type, byte_size, source_hash,[\s\S]+from public\.document_assets/i.test(text)) {
          return { rows: documentRow ? [documentRow] : [], rowCount: documentRow ? 1 : 0 };
        }
        if (/insert into public\.document_assets/i.test(text)) {
          documentRow = {
            original_name: values[3],
            content_type: values[4],
            byte_size: values[5],
            source_hash: values[6],
            raw_blob_filename: values[7],
            parsed_blob_filename: values[8],
            parse_method: values[9],
            metadata: JSON.parse(values[10]),
          };
          return { rows: [], rowCount: 1 };
        }
        if (/select 1\s+from public\.tenants/i.test(text)) {
          return { rows: [{}], rowCount: 1 };
        }
        if (/update public\.corpora/i.test(text)) {
          receipt = JSON.parse(values[2]);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    const summary = await applyLocalBackfill(client, [sourceRoot], SCOPE);

    assert.deepEqual(summary, {
      planHash: plan.hash,
      documents: 1,
      blobs: 1,
      bytes: Buffer.byteLength(content),
    });
    assert.deepEqual(receipt, receiptFor(plan));
    assert.ok(calls.some(({ text }) => /^begin$/i.test(text)));
    assert.ok(calls.some(({ text }) => /pg_advisory_xact_lock/i.test(text)));
    assert.ok(calls.some(({ text }) => /insert into public\.object_blobs/i.test(text)));
    assert.ok(calls.some(({ text }) => /insert into public\.document_assets/i.test(text)));
    assert.ok(calls.some(({ text }) => /update public\.corpora/i.test(text)));
    assert.ok(calls.some(({ text }) => /^commit$/i.test(text)));
    assert.equal(calls.some(({ text }) => /^rollback$/i.test(text)), false);
  });
});

test('apply with a matching receipt verifies scoped rows both inside and after the transaction', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceRoot = path.join(directory, 'uploads');
    const content = 'already imported content';
    const item = manifestItem({ content });
    await writeSource(sourceRoot, { [item.id]: item }, {
      [item.storedFilename]: content,
    });
    const plan = await buildLocalBackfillPlan([sourceRoot]);
    const calls = [];
    const client = {
      async query(text, values) {
        calls.push({ text, values });
        if (/metadata->'local_postgres_backfill' as receipt/i.test(text)) {
          return { rows: [{ receipt: receiptFor(plan) }], rowCount: 1 };
        }
        if (/select 1\s+from public\.tenants/i.test(text)) {
          return { rows: [{}], rowCount: 1 };
        }
        if (/from public\.object_blobs/i.test(text)) {
          return { rows: [blobRowFor(plan.blobs[0])], rowCount: 1 };
        }
        if (/from public\.document_assets/i.test(text)) {
          return { rows: [documentRowFor(plan.documents[0])], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    const summary = await applyLocalBackfill(client, [sourceRoot], SCOPE);

    assert.deepEqual(summary, {
      planHash: plan.hash,
      documents: 1,
      blobs: 1,
      bytes: Buffer.byteLength(content),
    });
    assert.equal(calls.filter(({ text }) => /from public\.object_blobs/i.test(text)).length, 2);
    assert.equal(calls.filter(({ text }) => /from public\.document_assets/i.test(text)).length, 2);
    assert.equal(calls.filter(({ text }) => /select 1\s+from public\.tenants/i.test(text)).length, 2);
    assert.equal(calls.some(({ text }) => /insert into public\./i.test(text)), false);
    assert.equal(calls.some(({ text }) => /update public\.corpora/i.test(text)), false);
    assert.ok(calls.some(({ text }) => /^commit$/i.test(text)));
  });
});

test('apply with a matching receipt rolls back when a scoped blob is missing', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceRoot = path.join(directory, 'uploads');
    const content = 'receipt cannot replace this blob';
    const item = manifestItem({ content });
    await writeSource(sourceRoot, { [item.id]: item }, {
      [item.storedFilename]: content,
    });
    const plan = await buildLocalBackfillPlan([sourceRoot]);
    const calls = [];
    const client = {
      async query(text, values) {
        calls.push({ text, values });
        if (/metadata->'local_postgres_backfill' as receipt/i.test(text)) {
          return { rows: [{ receipt: receiptFor(plan) }], rowCount: 1 };
        }
        if (/select 1\s+from public\.tenants/i.test(text)) {
          return { rows: [{}], rowCount: 1 };
        }
        if (/from public\.object_blobs/i.test(text)) return { rows: [], rowCount: 0 };
        if (/from public\.document_assets/i.test(text)) {
          return { rows: [documentRowFor(plan.documents[0])], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    await assert.rejects(
      () => applyLocalBackfill(client, [sourceRoot], SCOPE),
      (error) => error instanceof LocalBackfillError && /verification was incomplete/i.test(error.message)
    );
    assert.ok(calls.some(({ text }) => /from public\.object_blobs/i.test(text)));
    assert.ok(calls.some(({ text }) => /from public\.document_assets/i.test(text)));
    assert.ok(calls.some(({ text }) => /^rollback$/i.test(text)));
    assert.equal(calls.some(({ text }) => /^commit$/i.test(text)), false);
    assert.equal(calls.some(({ text }) => /insert into public\./i.test(text)), false);
  });
});

test('apply rolls back when a locked receipt conflicts with the source plan', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceRoot = path.join(directory, 'uploads');
    const content = 'content to import';
    const item = manifestItem({ content });
    await writeSource(sourceRoot, { [item.id]: item }, {
      [item.storedFilename]: content,
    });
    const calls = [];
    const client = {
      async query(text) {
        calls.push(text);
        if (/metadata->'local_postgres_backfill' as receipt/i.test(text)) {
          return {
            rows: [{
              receipt: {
                version: 1,
                plan_sha256: '0'.repeat(64),
                documents: 1,
                blobs: 1,
                bytes: Buffer.byteLength(content),
              },
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    await assert.rejects(
      () => applyLocalBackfill(client, [sourceRoot], SCOPE),
      (error) => error instanceof LocalBackfillError && /conflicting.*receipt/i.test(error.message)
    );
    assert.match(calls[0], /^begin$/i);
    assert.match(calls[1], /pg_advisory_xact_lock/i);
    assert.match(calls[2], /for update of corpus/i);
    assert.match(calls.at(-1), /^rollback$/i);
    assert.equal(calls.some((text) => /^commit$/i.test(text)), false);
    assert.equal(calls.some((text) => /insert into public\./i.test(text)), false);
  });
});

test('receipt reset locks the scope, deletes only the backfill metadata key, and commits', async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (/for update of corpus/i.test(text)) {
        return { rows: [{ receipt: receiptFor(receiptPlan()) }], rowCount: 1 };
      }
      if (/update public\.corpora/i.test(text)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };

  await resetLocalBackfillReceipt(client, SCOPE);

  assert.match(calls[0].text, /^begin$/i);
  assert.match(calls[1].text, /pg_advisory_xact_lock/i);
  assert.match(calls[2].text, /from public\.tenants[\s\S]+join public\.corpora/i);
  assert.match(calls[2].text, /for update of corpus/i);
  assert.deepEqual(calls[2].values, ['tenant-a', 'corpus-a']);
  assert.match(calls[3].text, /update public\.corpora/i);
  assert.match(calls[3].text, /metadata\s*=\s*metadata\s*-\s*'local_postgres_backfill'/i);
  assert.doesNotMatch(calls[3].text, /metadata\s*=\s*'\{\}'|metadata\s*=\s*null/i);
  assert.deepEqual(calls[3].values, ['tenant-a', 'corpus-a']);
  assert.match(calls[4].text, /^commit$/i);
  assert.equal(calls.some(({ text }) => /^rollback$/i.test(text)), false);
});

test('receipt reset rolls back when the metadata-key deletion fails', async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (/for update of corpus/i.test(text)) {
        return { rows: [{ receipt: receiptFor(receiptPlan()) }], rowCount: 1 };
      }
      if (/update public\.corpora/i.test(text)) throw new Error('expected delete failure');
      return { rows: [], rowCount: 0 };
    },
  };

  await assert.rejects(
    () => resetLocalBackfillReceipt(client, SCOPE),
    (error) => error instanceof LocalBackfillError
  );
  assert.match(calls[0].text, /^begin$/i);
  assert.match(calls[1].text, /pg_advisory_xact_lock/i);
  assert.match(calls[2].text, /for update of corpus/i);
  assert.match(calls[3].text, /metadata\s*=\s*metadata\s*-\s*'local_postgres_backfill'/i);
  assert.match(calls.at(-1).text, /^rollback$/i);
  assert.equal(calls.some(({ text }) => /^commit$/i.test(text)), false);
});

function manifestItem(overrides = {}) {
  const content = overrides.content ?? 'parsed content';
  const storedFilename = overrides.storedFilename ?? 'maic-document.txt';
  return {
    id: overrides.id ?? 'maic-document',
    originalName: overrides.originalName ?? 'course.pptx',
    originalExtension: '.pptx',
    storedFilename,
    parsedFilename: overrides.parsedFilename ?? storedFilename,
    size: overrides.size ?? Buffer.byteLength(content),
    contentLength: content.length,
    uploadedAt: '2026-08-14T00:00:00.000Z',
    parseMethod: 'maic-slide-parser',
    pages: 2,
    source: 'maic',
    sourceHash: 'a'.repeat(64),
  };
}

async function writeSource(root, manifest, blobs) {
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(path.join(root, 'file-manifest.json'), JSON.stringify(manifest)),
    ...Object.entries(blobs).map(([filename, content]) => writeFile(
      path.join(root, filename),
      content
    )),
  ]);
}

function receiptPlan() {
  const data = Buffer.from('receipt row data');
  return {
    hash: 'f'.repeat(64),
    sources: [],
    documents: [{
      id: 'document-a',
      originalName: 'course.pptx',
      contentType: '.pptx',
      size: data.byteLength,
      sourceHash: 'a'.repeat(64),
      storedFilename: 'document-a.txt',
      parsedFilename: 'document-a.txt',
      parseMethod: 'maic-slide-parser',
      metadata: {
        manifest_id: 'document-a',
        original_extension: '.pptx',
        content_length: data.toString('utf8').length,
        uploaded_at: '2026-08-14T00:00:00.000Z',
        pages: 1,
        source: 'maic',
        source_hash: 'a'.repeat(64),
      },
    }],
    blobs: [{
      filename: 'document-a.txt',
      kind: 'parsed',
      contentType: 'text/plain',
      data,
      byteLength: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
      manifestDigest: 'b'.repeat(64),
    }],
  };
}

function blobRowFor(blob) {
  return {
    kind: blob.kind,
    data: blob.data,
    content_type: blob.contentType,
  };
}

function documentRowFor(document) {
  return {
    original_name: document.originalName,
    content_type: document.contentType,
    byte_size: document.size,
    source_hash: document.sourceHash,
    raw_blob_filename: document.storedFilename,
    parsed_blob_filename: document.parsedFilename || null,
    parse_method: document.parseMethod,
    metadata: document.metadata,
  };
}

function receiptFor(plan) {
  return {
    version: 1,
    plan_sha256: plan.hash,
    documents: plan.documents.length,
    blobs: plan.blobs.length,
    bytes: plan.blobs.reduce((sum, blob) => sum + blob.byteLength, 0),
  };
}

async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-local-backfill-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
