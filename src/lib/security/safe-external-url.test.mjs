import assert from 'node:assert/strict';
import test from 'node:test';

const {
  SafeExternalUrlError,
  createPinnedLookup,
  isPublicIpAddress,
  safeFetchExternalUrl,
  validateExternalUrl,
} = await import('./safe-external-url.ts');

const PUBLIC_IPV4 = { address: '93.184.216.34', family: 4 };
const PUBLIC_IPV6 = { address: '2606:4700:4700::1111', family: 6 };

test('safeFetchExternalUrl returns a capped text response and passes every validated address', async () => {
  let capturedRequest;
  const result = await safeFetchExternalUrl(
    'https://example.com/article#section',
    {},
    {
      resolver: async () => [PUBLIC_IPV4, PUBLIC_IPV6],
      requester: async request => {
        capturedRequest = request;
        return makeResponse({
          headers: { 'Content-Type': 'Text/Plain; charset=utf-8' },
          chunks: ['hello', ' world'],
        });
      },
    }
  );

  assert.equal(capturedRequest.url.hostname, 'example.com');
  assert.deepEqual(capturedRequest.addresses, [PUBLIC_IPV4, PUBLIC_IPV6]);
  assert.equal(result.finalUrl, 'https://example.com/article');
  assert.equal(result.contentType, 'text/plain');
  assert.equal(new TextDecoder().decode(result.body), 'hello world');
  assert.equal(result.redirectCount, 0);
});

for (const [label, url] of [
  ['file', 'file:///etc/passwd'],
  ['data', 'data:text/plain,secret'],
  ['gopher', 'gopher://example.com/'],
  ['ftp', 'ftp://example.com/file'],
  ['http by default', 'http://example.com/'],
]) {
  test(`rejects ${label} protocol`, async () => {
    await expectCode(
      validateExternalUrl(url, {}, { resolver: publicResolver }),
      'UNSUPPORTED_PROTOCOL'
    );
  });
}

test('allows explicitly enabled HTTP only on an allowed port', async () => {
  const result = await safeFetchExternalUrl(
    'http://example.com/page',
    { allowHttp: true },
    successDependencies()
  );
  assert.equal(result.finalUrl, 'http://example.com/page');

  await expectCode(
    validateExternalUrl('http://example.com:8080', { allowHttp: true }, {
      resolver: publicResolver,
    }),
    'PORT_NOT_ALLOWED'
  );
});

test('allows an explicitly configured non-default port', async () => {
  const validated = await validateExternalUrl(
    'https://example.com:8443/path',
    { allowedPorts: [8443] },
    { resolver: publicResolver }
  );
  assert.equal(validated.url.port, '8443');
});

test('rejects URL credentials before DNS or request execution', async () => {
  let resolverCalled = false;
  await expectCode(
    validateExternalUrl('https://user:password@example.com/', {}, {
      resolver: async () => {
        resolverCalled = true;
        return [PUBLIC_IPV4];
      },
    }),
    'CREDENTIALS_NOT_ALLOWED'
  );
  assert.equal(resolverCalled, false);
});

for (const hostname of [
  'localhost',
  'service',
  'api.local',
  'api.internal',
  'printer.lan',
  'service.home.arpa',
]) {
  test(`rejects internal or search-suffix hostname ${hostname}`, async () => {
    await expectCode(
      validateExternalUrl(`https://${hostname}/`, {}, { resolver: publicResolver }),
      'HOST_NOT_ALLOWED'
    );
  });
}

test('applies a caller hostname allowlist predicate after baseline host validation', async () => {
  await expectCode(
    validateExternalUrl(
      'https://other.example/path',
      { isHostnameAllowed: hostname => hostname === 'approved.example' },
      { resolver: publicResolver }
    ),
    'HOST_NOT_ALLOWED'
  );

  const validated = await validateExternalUrl(
    'https://approved.example/path',
    { isHostnameAllowed: hostname => hostname === 'approved.example' },
    { resolver: publicResolver }
  );
  assert.equal(validated.hostname, 'approved.example');
});

for (const url of [
  'https://127.0.0.1/',
  'https://127.1/',
  'https://2130706433/',
  'https://0x7f000001/',
  'https://10.0.0.1/',
  'https://100.64.0.1/',
  'https://169.254.169.254/latest/meta-data/',
  'https://172.16.0.1/',
  'https://192.168.1.1/',
  'https://198.18.0.1/',
  'https://224.0.0.1/',
  'https://255.255.255.255/',
]) {
  test(`rejects non-public IPv4 URL ${url}`, async () => {
    await expectCode(validateExternalUrl(url), 'PRIVATE_ADDRESS');
  });
}

for (const address of ['192.0.2.1', '198.51.100.1', '203.0.113.1']) {
  test(`treats documentation IPv4 ${address} as non-public`, () => {
    assert.equal(isPublicIpAddress(address), false);
  });
}

for (const url of [
  'https://[::]/',
  'https://[::1]/',
  'https://[::ffff:127.0.0.1]/',
  'https://[64:ff9b::7f00:1]/',
  'https://[fc00::1]/',
  'https://[fd00:ec2::254]/',
  'https://[fe80::1]/',
  'https://[ff02::1]/',
  'https://[2001:db8::1]/',
  'https://[2002:7f00:1::]/',
  'https://[3fff::1]/',
]) {
  test(`rejects non-public or transition IPv6 URL ${url}`, async () => {
    await expectCode(validateExternalUrl(url), 'PRIVATE_ADDRESS');
  });
}

test('accepts public IPv4 and IPv6 literals without invoking DNS', async () => {
  let resolverCalls = 0;
  const dependencies = {
    resolver: async () => {
      resolverCalls += 1;
      return [];
    },
  };

  const ipv4 = await validateExternalUrl('https://1.1.1.1/', {}, dependencies);
  const ipv6 = await validateExternalUrl('https://[2606:4700:4700::1111]/', {}, dependencies);

  assert.deepEqual(ipv4.addresses, [{ address: '1.1.1.1', family: 4 }]);
  assert.deepEqual(ipv6.addresses, [PUBLIC_IPV6]);
  assert.equal(resolverCalls, 0);
});

test('rejects a hostname when any A or AAAA result is non-public', async () => {
  let requesterCalls = 0;
  await expectCode(
    safeFetchExternalUrl('https://mixed.example/', {}, {
      resolver: async () => [PUBLIC_IPV4, { address: '10.0.0.2', family: 4 }],
      requester: async () => {
        requesterCalls += 1;
        return makeResponse();
      },
    }),
    'PRIVATE_ADDRESS'
  );
  assert.equal(requesterCalls, 0);
});

test('rejects empty, invalid, mismatched, and excessive DNS results', async t => {
  await t.test('empty result', async () => {
    await expectCode(
      validateExternalUrl('https://empty.example/', {}, { resolver: async () => [] }),
      'DNS_RESOLUTION_FAILED'
    );
  });
  await t.test('invalid address', async () => {
    await expectCode(
      validateExternalUrl('https://bad.example/', {}, {
        resolver: async () => [{ address: 'not-an-ip', family: 4 }],
      }),
      'DNS_RESOLUTION_FAILED'
    );
  });
  await t.test('family mismatch', async () => {
    await expectCode(
      validateExternalUrl('https://bad.example/', {}, {
        resolver: async () => [{ address: PUBLIC_IPV6.address, family: 4 }],
      }),
      'DNS_RESOLUTION_FAILED'
    );
  });
  await t.test('address count cap', async () => {
    await expectCode(
      validateExternalUrl(
        'https://many.example/',
        { maxDnsAddresses: 1 },
        { resolver: async () => [PUBLIC_IPV4, PUBLIC_IPV6] }
      ),
      'TOO_MANY_DNS_ADDRESSES'
    );
  });
});

test('wraps resolver failures without exposing their message as the public message', async () => {
  const error = await expectCode(
    validateExternalUrl('https://failure.example/', {}, {
      resolver: async () => {
        throw new Error('resolver-secret-detail');
      },
    }),
    'DNS_RESOLUTION_FAILED'
  );
  assert.doesNotMatch(error.message, /secret/);
});

test('createPinnedLookup returns only prevalidated addresses and never resolves the requested hostname', async () => {
  const lookup = createPinnedLookup([PUBLIC_IPV4, PUBLIC_IPV6]);
  const all = await invokeLookup(lookup, { all: true, family: 0 });
  assert.deepEqual(all, [PUBLIC_IPV4, PUBLIC_IPV6]);

  const ipv6 = await invokeLookup(lookup, { all: false, family: 6 });
  assert.deepEqual(ipv6, PUBLIC_IPV6);
});

test('createPinnedLookup fails closed when the requested family has no pinned address', async () => {
  const lookup = createPinnedLookup([PUBLIC_IPV4]);
  await assert.rejects(
    invokeLookup(lookup, { all: false, family: 6 }),
    error => error?.code === 'ENOTFOUND'
  );
});

test('revalidates and repins every relative redirect hop', async () => {
  let resolution = 0;
  const observed = [];
  const result = await safeFetchExternalUrl('https://redirect.example/start', {}, {
    resolver: async () => {
      resolution += 1;
      return resolution === 1 ? [PUBLIC_IPV4] : [{ address: '1.1.1.1', family: 4 }];
    },
    requester: async request => {
      observed.push(request.addresses[0].address);
      if (request.url.pathname === '/start') {
        return makeResponse({ statusCode: 302, headers: { location: '/final' } });
      }
      return makeResponse({ chunks: ['done'] });
    },
  });

  assert.equal(resolution, 2);
  assert.deepEqual(observed, [PUBLIC_IPV4.address, '1.1.1.1']);
  assert.equal(result.finalUrl, 'https://redirect.example/final');
  assert.equal(result.redirectCount, 1);
});

test('blocks a public redirect that resolves to a private target before the second request', async () => {
  let requesterCalls = 0;
  let firstCancelled = false;
  await expectCode(
    safeFetchExternalUrl('https://public.example/start', {}, {
      resolver: async hostname =>
        hostname === 'public.example'
          ? [PUBLIC_IPV4]
          : [{ address: '169.254.169.254', family: 4 }],
      requester: async () => {
        requesterCalls += 1;
        return makeResponse({
          statusCode: 302,
          headers: { location: 'https://metadata.example/latest' },
          onCancel: () => {
            firstCancelled = true;
          },
        });
      },
    }),
    'PRIVATE_ADDRESS'
  );
  assert.equal(requesterCalls, 1);
  assert.equal(firstCancelled, true);
});

test('blocks DNS rebinding between redirect hops on the same hostname', async () => {
  let resolutions = 0;
  let requests = 0;
  await expectCode(
    safeFetchExternalUrl('https://rebind.example/first', {}, {
      resolver: async () => {
        resolutions += 1;
        return resolutions === 1
          ? [PUBLIC_IPV4]
          : [{ address: '127.0.0.1', family: 4 }];
      },
      requester: async () => {
        requests += 1;
        return makeResponse({ statusCode: 302, headers: { location: '/second' } });
      },
    }),
    'PRIVATE_ADDRESS'
  );
  assert.equal(resolutions, 2);
  assert.equal(requests, 1);
});

test('rejects redirect loops, missing locations, invalid locations, and excess hops', async t => {
  await t.test('loop', async () => {
    await expectCode(
      safeFetchExternalUrl('https://loop.example/a', {}, {
        resolver: publicResolver,
        requester: async request =>
          makeResponse({
            statusCode: 302,
            headers: { location: request.url.pathname === '/a' ? '/b' : '/a' },
          }),
      }),
      'REDIRECT_LOOP'
    );
  });
  await t.test('missing Location', async () => {
    await expectCode(
      safeFetchExternalUrl('https://redirect.example/', {}, {
        resolver: publicResolver,
        requester: async () => makeResponse({ statusCode: 302, headers: {} }),
      }),
      'INVALID_REDIRECT'
    );
  });
  await t.test('invalid Location', async () => {
    await expectCode(
      safeFetchExternalUrl('https://redirect.example/', {}, {
        resolver: publicResolver,
        requester: async () =>
          makeResponse({ statusCode: 302, headers: { location: 'http://[invalid' } }),
      }),
      'INVALID_REDIRECT'
    );
  });
  await t.test('maximum redirects', async () => {
    await expectCode(
      safeFetchExternalUrl('https://redirect.example/0', { maxRedirects: 1 }, {
        resolver: publicResolver,
        requester: async request =>
          makeResponse({
            statusCode: 302,
            headers: { location: `/${Number(request.url.pathname.slice(1)) + 1}` },
          }),
      }),
      'TOO_MANY_REDIRECTS'
    );
  });
});

test('timeout aborts a pending requester and clears the timer', async () => {
  let fireTimer;
  let timerCleared = false;
  let requestCancelled = false;
  const timer = {
    set(callback) {
      fireTimer = callback;
      return 1;
    },
    clear() {
      timerCleared = true;
    },
  };

  await expectCode(
    safeFetchExternalUrl('https://slow.example/', {}, {
      resolver: publicResolver,
      timer,
      requester: async ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              requestCancelled = true;
              reject(signal.reason);
            },
            { once: true }
          );
          queueMicrotask(fireTimer);
        }),
    }),
    'REQUEST_TIMEOUT'
  );

  assert.equal(requestCancelled, true);
  assert.equal(timerCleared, true);
});

test('timeout also covers a resolver that never settles', async () => {
  const timer = {
    set(callback) {
      queueMicrotask(callback);
      return 1;
    },
    clear() {},
  };
  await expectCode(
    safeFetchExternalUrl('https://dns-timeout.example/', {}, {
      resolver: async () => new Promise(() => {}),
      requester: async () => makeResponse(),
      timer,
    }),
    'REQUEST_TIMEOUT'
  );
});

test('propagates caller cancellation as REQUEST_ABORTED', async () => {
  const controller = new AbortController();
  controller.abort(new Error('caller cancelled'));
  await expectCode(
    safeFetchExternalUrl('https://example.com/', { signal: controller.signal }, successDependencies()),
    'REQUEST_ABORTED'
  );
});

test('accepts a response exactly at the byte cap', async () => {
  const result = await safeFetchExternalUrl(
    'https://size.example/',
    { maxResponseBytes: 5 },
    successDependencies({ chunks: ['12', '345'] })
  );
  assert.equal(result.body.byteLength, 5);
});

test('cancels single-chunk and streamed responses above the byte cap', async t => {
  for (const chunks of [['123456'], ['123', '456']]) {
    await t.test(chunks.join('|'), async () => {
      let cancelReason;
      await expectCode(
        safeFetchExternalUrl('https://large.example/', { maxResponseBytes: 5 }, {
          resolver: publicResolver,
          requester: async () =>
            makeResponse({
              chunks,
              onCancel: reason => {
                cancelReason = reason;
              },
            }),
        }),
        'RESPONSE_TOO_LARGE'
      );
      assert.equal(cancelReason?.code, 'RESPONSE_TOO_LARGE');
    });
  }
});

test('cancels excessively fragmented bodies below the byte cap', async () => {
  let cancelReason;
  await expectCode(
    safeFetchExternalUrl('https://fragmented.example/', {}, {
      resolver: publicResolver,
      requester: async () => makeResponse({
        chunks: Array.from({ length: 4_097 }, () => new Uint8Array()),
        onCancel: reason => {
          cancelReason = reason;
        },
      }),
    }),
    'RESPONSE_TOO_FRAGMENTED'
  );
  assert.equal(cancelReason?.code, 'RESPONSE_TOO_FRAGMENTED');
});

test('rejects missing and disallowed Content-Type while accepting parameters and text wildcards', async t => {
  await t.test('missing', async () => {
    await expectCode(
      safeFetchExternalUrl('https://type.example/', {}, {
        resolver: publicResolver,
        requester: async () => makeResponse({ headers: {} }),
      }),
      'CONTENT_TYPE_NOT_ALLOWED'
    );
  });
  await t.test('binary', async () => {
    await expectCode(
      safeFetchExternalUrl('https://type.example/', {}, {
        resolver: publicResolver,
        requester: async () =>
          makeResponse({ headers: { 'content-type': 'application/octet-stream' } }),
      }),
      'CONTENT_TYPE_NOT_ALLOWED'
    );
  });
  await t.test('text wildcard', async () => {
    const result = await safeFetchExternalUrl(
      'https://type.example/',
      {},
      successDependencies({ headers: { 'content-type': 'Text/Csv; charset=UTF-8' } })
    );
    assert.equal(result.contentType, 'text/csv');
  });
});

test('rejects encoded bodies so the byte cap cannot be bypassed by decompression', async () => {
  let cancelled = false;
  await expectCode(
    safeFetchExternalUrl('https://encoded.example/', {}, {
      resolver: publicResolver,
      requester: async () =>
        makeResponse({
          headers: {
            'content-type': 'text/plain',
            'content-encoding': 'gzip',
          },
          onCancel: () => {
            cancelled = true;
          },
        }),
    }),
    'CONTENT_ENCODING_NOT_ALLOWED'
  );
  assert.equal(cancelled, true);
});

test('rejects oversized or malformed Content-Length before consuming the stream', async t => {
  for (const [contentLength, code] of [
    ['6', 'RESPONSE_TOO_LARGE'],
    ['5, 6', 'INVALID_RESPONSE'],
    ['9007199254740992', 'INVALID_RESPONSE'],
  ]) {
    await t.test(contentLength, async () => {
      let cancelled = false;
      await expectCode(
        safeFetchExternalUrl('https://length.example/', { maxResponseBytes: 5 }, {
          resolver: publicResolver,
          requester: async () =>
            makeResponse({
              headers: {
                'content-type': 'text/plain',
                'content-length': contentLength,
              },
              onCancel: () => {
                cancelled = true;
              },
            }),
        }),
        code
      );
      assert.equal(cancelled, true);
    });
  }
});

test('a body iterator cannot defeat timeout by hanging in return()', { timeout: 1_000 }, async () => {
  let fireTimer;
  let cancelled = false;
  const timer = {
    set(callback) {
      fireTimer = callback;
      return 1;
    },
    clear() {},
  };

  await expectCode(
    safeFetchExternalUrl('https://body-timeout.example/', {}, {
      resolver: publicResolver,
      timer,
      requester: async () => ({
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        body: {
          [Symbol.asyncIterator]() {
            return {
              next() {
                queueMicrotask(fireTimer);
                return new Promise(() => {});
              },
              return() {
                return new Promise(() => {});
              },
            };
          },
        },
        cancel() {
          cancelled = true;
        },
      }),
    }),
    'REQUEST_TIMEOUT'
  );
  assert.equal(cancelled, true);
});

test('rejects malformed status codes and cancels the response', async () => {
  let cancelled = false;
  await expectCode(
    safeFetchExternalUrl('https://status.example/', {}, {
      resolver: publicResolver,
      requester: async () =>
        makeResponse({
          statusCode: 0,
          onCancel: () => {
            cancelled = true;
          },
        }),
    }),
    'INVALID_RESPONSE'
  );
  assert.equal(cancelled, true);
});

test('wraps requester failures in a stable error without reflecting secret details', async () => {
  const error = await expectCode(
    safeFetchExternalUrl('https://network.example/', {}, {
      resolver: publicResolver,
      requester: async () => {
        throw new Error('token=super-secret');
      },
    }),
    'NETWORK_ERROR'
  );
  assert.doesNotMatch(error.message, /secret|token/);
});

test('rejects unsafe option values and header injection', async t => {
  for (const [options, label] of [
    [{ maxRedirects: -1 }, 'negative redirects'],
    [{ timeoutMs: 0 }, 'zero timeout'],
    [{ maxResponseBytes: Number.POSITIVE_INFINITY }, 'infinite byte cap'],
    [{ allowedPorts: [0] }, 'invalid port'],
    [{ allowedContentTypes: ['not-a-media-type'] }, 'invalid content type'],
    [{ userAgent: 'safe\r\ninjected: true' }, 'header injection'],
  ]) {
    await t.test(label, async () => {
      await expectCode(
        safeFetchExternalUrl('https://example.com/', options, successDependencies()),
        'INVALID_OPTIONS'
      );
    });
  }
});

test('rejects overlong URLs before DNS resolution', async () => {
  await expectCode(
    validateExternalUrl(`https://example.com/${'a'.repeat(100)}`, { maxUrlLength: 50 }, {
      resolver: publicResolver,
    }),
    'URL_TOO_LONG'
  );
});

async function publicResolver() {
  return [PUBLIC_IPV4];
}

function successDependencies(responseOptions = {}) {
  return {
    resolver: publicResolver,
    requester: async () => makeResponse(responseOptions),
  };
}

function makeResponse({
  statusCode = 200,
  headers = { 'content-type': 'text/plain' },
  chunks = ['ok'],
  onCancel = () => {},
} = {}) {
  return {
    statusCode,
    headers,
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          yield typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
        }
      },
    },
    cancel: onCancel,
  };
}

async function expectCode(promise, code) {
  try {
    await promise;
    assert.fail(`Expected ${code}`);
  } catch (error) {
    assert(error instanceof SafeExternalUrlError);
    assert.equal(error.code, code);
    return error;
  }
}

function invokeLookup(lookup, options) {
  return new Promise((resolve, reject) => {
    lookup('attacker-controlled.example', options, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }
      if (Array.isArray(address)) {
        resolve(address);
        return;
      }
      resolve({ address, family });
    });
  });
}
