import { lookup as lookupHostname } from 'node:dns/promises';
import { request as requestHttp, type IncomingHttpHeaders } from 'node:http';
import { request as requestHttps } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

export const DEFAULT_EXTERNAL_URL_TIMEOUT_MS = 10_000;
export const DEFAULT_EXTERNAL_URL_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_EXTERNAL_URL_MAX_REDIRECTS = 3;
export const DEFAULT_EXTERNAL_URL_MAX_CHUNKS = 4_096;

const DEFAULT_MAX_DNS_ADDRESSES = 16;
const DEFAULT_MAX_URL_LENGTH = 2_048;
const DEFAULT_USER_AGENT = 'rag-system-safe-fetch/1.0';
const DEFAULT_CONTENT_TYPES = [
  'text/*',
  'application/json',
  'application/xml',
  'application/xhtml+xml',
] as const;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_HOSTNAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.home',
  '.home.arpa',
  '.test',
  '.invalid',
] as const;
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'broadcasthost',
]);

export type ExternalUrlErrorCode =
  | 'INVALID_OPTIONS'
  | 'INVALID_URL'
  | 'URL_TOO_LONG'
  | 'UNSUPPORTED_PROTOCOL'
  | 'CREDENTIALS_NOT_ALLOWED'
  | 'HOST_NOT_ALLOWED'
  | 'PORT_NOT_ALLOWED'
  | 'DNS_RESOLUTION_FAILED'
  | 'PRIVATE_ADDRESS'
  | 'TOO_MANY_DNS_ADDRESSES'
  | 'INVALID_REDIRECT'
  | 'TOO_MANY_REDIRECTS'
  | 'REDIRECT_LOOP'
  | 'REQUEST_TIMEOUT'
  | 'REQUEST_ABORTED'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'CONTENT_ENCODING_NOT_ALLOWED'
  | 'CONTENT_TYPE_NOT_ALLOWED'
  | 'RESPONSE_TOO_FRAGMENTED'
  | 'RESPONSE_TOO_LARGE';

export class SafeExternalUrlError extends Error {
  readonly code: ExternalUrlErrorCode;

  constructor(code: ExternalUrlErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SafeExternalUrlError';
    this.code = code;
  }
}

export interface ResolvedExternalAddress {
  address: string;
  family: 4 | 6;
}

export type ExternalHostnameResolver = (
  hostname: string
) => Promise<readonly ResolvedExternalAddress[]>;

export interface PinnedExternalRequest {
  url: URL;
  addresses: readonly ResolvedExternalAddress[];
  signal: AbortSignal;
  userAgent: string;
}

export interface PinnedExternalResponse {
  statusCode: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: AsyncIterable<Uint8Array>;
  cancel: (reason?: Error) => void;
}

export type PinnedExternalRequester = (
  request: PinnedExternalRequest
) => Promise<PinnedExternalResponse>;

export interface SafeExternalUrlTimer {
  set: (callback: () => void, delayMs: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface SafeExternalUrlDependencies {
  resolver?: ExternalHostnameResolver;
  requester?: PinnedExternalRequester;
  timer?: SafeExternalUrlTimer;
}

export interface SafeExternalUrlOptions {
  allowHttp?: boolean;
  allowedPorts?: readonly number[];
  allowedContentTypes?: readonly string[];
  isHostnameAllowed?: (hostname: string) => boolean;
  maxDnsAddresses?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  maxUrlLength?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  userAgent?: string;
}

export interface ValidatedExternalUrl {
  url: URL;
  hostname: string;
  addresses: readonly ResolvedExternalAddress[];
}

export interface SafeExternalUrlResult {
  finalUrl: string;
  statusCode: number;
  contentType: string;
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
  redirectCount: number;
}

interface NormalizedPolicy {
  allowHttp: boolean;
  allowedPorts: ReadonlySet<number>;
  allowedContentTypes: readonly string[];
  isHostnameAllowed?: (hostname: string) => boolean;
  maxDnsAddresses: number;
  maxRedirects: number;
  maxResponseBytes: number;
  maxUrlLength: number;
  timeoutMs: number;
  userAgent: string;
}

const defaultResolver: ExternalHostnameResolver = async hostname => {
  const addresses = await lookupHostname(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
};

const defaultTimer: SafeExternalUrlTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Performs one GET using only the addresses that were validated for this hop.
 * The original hostname remains on the URL, preserving the Host header and TLS SNI.
 */
export const nodePinnedRequester: PinnedExternalRequester = request =>
  new Promise((resolve, reject) => {
    const requestFunction = request.url.protocol === 'https:' ? requestHttps : requestHttp;
    const hostname = normalizeHostname(request.url.hostname);
    const requestHandle = requestFunction(
      request.url,
      {
        agent: false,
        headers: {
          accept:
            'text/html,text/plain,application/xhtml+xml,application/xml;q=0.9,text/xml;q=0.8,application/json;q=0.7',
          'accept-encoding': 'identity',
          'user-agent': request.userAgent,
        },
        insecureHTTPParser: false,
        lookup: createPinnedLookup(request.addresses),
        maxHeaderSize: 16 * 1024,
        method: 'GET',
        servername: request.url.protocol === 'https:' && isIP(hostname) === 0 ? hostname : undefined,
        signal: request.signal,
      },
      response => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: normalizeHeaders(response.headers),
          body: response as AsyncIterable<Uint8Array>,
          cancel: reason => response.destroy(reason),
        });
      }
    );

    requestHandle.once('error', reject);
    requestHandle.end();
  });

/**
 * Produces a Node lookup callback that never performs DNS. This closes the gap
 * between address validation and socket creation that otherwise permits rebinding.
 */
export function createPinnedLookup(addresses: readonly ResolvedExternalAddress[]): LookupFunction {
  if (addresses.length === 0) {
    throw new SafeExternalUrlError('DNS_RESOLUTION_FAILED', 'No pinned addresses are available.');
  }

  const pinned = addresses.map(address => ({ ...address }));

  return (_hostname, options, callback) => {
    const requestedFamily = options.family === 4 || options.family === 6 ? options.family : undefined;
    const candidates = requestedFamily
      ? pinned.filter(address => address.family === requestedFamily)
      : pinned;

    if (candidates.length === 0) {
      const error = Object.assign(new Error('No pinned address matches the requested family.'), {
        code: 'ENOTFOUND',
      }) as NodeJS.ErrnoException;
      callback(error, '', 0);
      return;
    }

    if (options.all) {
      callback(null, candidates.map(address => ({ ...address })));
      return;
    }

    const selected = candidates[0];
    callback(null, selected.address, selected.family);
  };
}

export async function validateExternalUrl(
  input: string | URL,
  options: SafeExternalUrlOptions = {},
  dependencies: Pick<SafeExternalUrlDependencies, 'resolver'> = {}
): Promise<ValidatedExternalUrl> {
  const policy = normalizePolicy(options);
  return validateExternalUrlWithPolicy(
    input,
    policy,
    dependencies.resolver ?? defaultResolver,
    options.signal
  );
}

export async function safeFetchExternalUrl(
  input: string | URL,
  options: SafeExternalUrlOptions = {},
  dependencies: SafeExternalUrlDependencies = {}
): Promise<SafeExternalUrlResult> {
  const policy = normalizePolicy(options);
  const resolver = dependencies.resolver ?? defaultResolver;
  const requester = dependencies.requester ?? nodePinnedRequester;
  const timer = dependencies.timer ?? defaultTimer;
  const controller = new AbortController();
  let timedOut = false;

  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    abortFromCaller();
  } else {
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  }

  const timerHandle = timer.set(() => {
    timedOut = true;
    controller.abort(new Error('External URL request timed out.'));
  }, policy.timeoutMs);

  try {
    throwIfAborted(controller.signal);

    let current = input;
    let redirectCount = 0;
    const visited = new Set<string>();

    while (true) {
      const validated = await validateExternalUrlWithPolicy(
        current,
        policy,
        resolver,
        controller.signal
      );
      const normalizedUrl = validated.url.href;

      if (visited.has(normalizedUrl)) {
        throw new SafeExternalUrlError('REDIRECT_LOOP', 'The external URL redirect chain loops.');
      }
      visited.add(normalizedUrl);

      const response = await abortable(
        requester({
          url: new URL(validated.url.href),
          addresses: validated.addresses,
          signal: controller.signal,
          userAgent: policy.userAgent,
        }),
        controller.signal
      );

      validateResponseStatus(response.statusCode, response);

      if (REDIRECT_STATUS_CODES.has(response.statusCode)) {
        response.cancel();
        if (redirectCount >= policy.maxRedirects) {
          throw new SafeExternalUrlError(
            'TOO_MANY_REDIRECTS',
            'The external URL exceeded the redirect limit.'
          );
        }

        const location = getHeader(response.headers, 'location');
        if (!location) {
          throw new SafeExternalUrlError(
            'INVALID_REDIRECT',
            'The external URL returned a redirect without a Location header.'
          );
        }

        try {
          current = new URL(location, validated.url);
        } catch (error) {
          throw new SafeExternalUrlError(
            'INVALID_REDIRECT',
            'The external URL returned an invalid redirect target.',
            { cause: error }
          );
        }

        redirectCount += 1;
        continue;
      }

      const contentEncoding = getHeader(response.headers, 'content-encoding')
        ?.trim()
        .toLowerCase();
      if (contentEncoding && contentEncoding !== 'identity') {
        response.cancel();
        throw new SafeExternalUrlError(
          'CONTENT_ENCODING_NOT_ALLOWED',
          'Encoded external responses are not allowed.'
        );
      }

      validateDeclaredContentLength(
        getHeader(response.headers, 'content-length'),
        policy.maxResponseBytes,
        response
      );

      const contentType = normalizeContentType(getHeader(response.headers, 'content-type'));
      if (!contentType || !isAllowedContentType(contentType, policy.allowedContentTypes)) {
        response.cancel();
        throw new SafeExternalUrlError(
          'CONTENT_TYPE_NOT_ALLOWED',
          'The external response Content-Type is not allowed.'
        );
      }

      const body = await collectBody(
        response,
        policy.maxResponseBytes,
        controller.signal
      );

      return {
        finalUrl: validated.url.href,
        statusCode: response.statusCode,
        contentType,
        headers: response.headers,
        body,
        redirectCount,
      };
    }
  } catch (error) {
    if (error instanceof SafeExternalUrlError) {
      throw error;
    }
    if (timedOut) {
      throw new SafeExternalUrlError(
        'REQUEST_TIMEOUT',
        'The external URL request timed out.',
        { cause: error }
      );
    }
    if (options.signal?.aborted || controller.signal.aborted) {
      throw new SafeExternalUrlError(
        'REQUEST_ABORTED',
        'The external URL request was aborted.',
        { cause: error }
      );
    }
    throw new SafeExternalUrlError('NETWORK_ERROR', 'The external URL request failed.', {
      cause: error,
    });
  } finally {
    timer.clear(timerHandle);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = normalizeIpLiteral(address);
  if (!normalized || normalized.includes('%')) return false;

  const family = isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family === 6) return isPublicIpv6(normalized);
  return false;
}

async function validateExternalUrlWithPolicy(
  input: string | URL,
  policy: NormalizedPolicy,
  resolver: ExternalHostnameResolver,
  signal?: AbortSignal
): Promise<ValidatedExternalUrl> {
  const url = parseExternalUrl(input, policy);
  const hostname = validateHostname(url.hostname, policy);
  const literalFamily = isIP(hostname);

  if (literalFamily === 4 || literalFamily === 6) {
    if (!isPublicIpAddress(hostname)) {
      throw new SafeExternalUrlError(
        'PRIVATE_ADDRESS',
        'The external URL resolves to a non-public address.'
      );
    }
    return {
      url,
      hostname,
      addresses: [{ address: hostname, family: literalFamily }],
    };
  }

  let resolved: readonly ResolvedExternalAddress[];
  try {
    resolved = await abortable(Promise.resolve(resolver(hostname)), signal);
  } catch (error) {
    throwIfAborted(signal);
    throw new SafeExternalUrlError(
      'DNS_RESOLUTION_FAILED',
      'The external hostname could not be resolved.',
      { cause: error }
    );
  }

  if (resolved.length === 0) {
    throw new SafeExternalUrlError(
      'DNS_RESOLUTION_FAILED',
      'The external hostname did not resolve to an address.'
    );
  }
  if (resolved.length > policy.maxDnsAddresses) {
    throw new SafeExternalUrlError(
      'TOO_MANY_DNS_ADDRESSES',
      'The external hostname returned too many addresses.'
    );
  }

  const addresses: ResolvedExternalAddress[] = [];
  const seen = new Set<string>();
  for (const candidate of resolved) {
    const address = normalizeIpLiteral(candidate.address);
    const family = isIP(address);
    if ((family !== 4 && family !== 6) || family !== candidate.family) {
      throw new SafeExternalUrlError(
        'DNS_RESOLUTION_FAILED',
        'The external hostname returned an invalid address.'
      );
    }
    if (!isPublicIpAddress(address)) {
      throw new SafeExternalUrlError(
        'PRIVATE_ADDRESS',
        'The external hostname resolved to a non-public address.'
      );
    }

    const key = `${family}:${address.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      addresses.push({ address, family });
    }
  }

  return { url, hostname, addresses };
}

function parseExternalUrl(input: string | URL, policy: NormalizedPolicy): URL {
  const raw = input instanceof URL ? input.href : input;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new SafeExternalUrlError('INVALID_URL', 'An external URL is required.');
  }
  if (raw.length > policy.maxUrlLength) {
    throw new SafeExternalUrlError('URL_TOO_LONG', 'The external URL is too long.');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new SafeExternalUrlError('INVALID_URL', 'The external URL is invalid.', {
      cause: error,
    });
  }

  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) {
    throw new SafeExternalUrlError(
      'UNSUPPORTED_PROTOCOL',
      'The external URL protocol is not allowed.'
    );
  }
  if (url.username || url.password) {
    throw new SafeExternalUrlError(
      'CREDENTIALS_NOT_ALLOWED',
      'Credentials are not allowed in external URLs.'
    );
  }

  const effectivePort = url.port
    ? Number.parseInt(url.port, 10)
    : url.protocol === 'https:'
      ? 443
      : 80;
  if (!policy.allowedPorts.has(effectivePort)) {
    throw new SafeExternalUrlError('PORT_NOT_ALLOWED', 'The external URL port is not allowed.');
  }

  // Fragments are client-side only; removing them also makes redirect-loop checks stable.
  url.hash = '';
  return url;
}

function validateHostname(rawHostname: string, policy: NormalizedPolicy): string {
  const hostname = normalizeHostname(rawHostname);
  if (!hostname || hostname.length > 253) {
    throw new SafeExternalUrlError('HOST_NOT_ALLOWED', 'The external URL hostname is invalid.');
  }

  const family = isIP(hostname);
  if (family === 0) {
    if (
      BLOCKED_HOSTNAMES.has(hostname) ||
      BLOCKED_HOSTNAME_SUFFIXES.some(suffix => hostname.endsWith(suffix)) ||
      !hostname.includes('.')
    ) {
      throw new SafeExternalUrlError(
        'HOST_NOT_ALLOWED',
        'The external URL hostname is not allowed.'
      );
    }

    const labels = hostname.split('.');
    if (
      labels.some(
        label =>
          label.length === 0 ||
          label.length > 63 ||
          !/^[a-z0-9-]+$/.test(label) ||
          label.startsWith('-') ||
          label.endsWith('-')
      )
    ) {
      throw new SafeExternalUrlError('HOST_NOT_ALLOWED', 'The external URL hostname is invalid.');
    }
  }

  if (policy.isHostnameAllowed && !policy.isHostnameAllowed(hostname)) {
    throw new SafeExternalUrlError('HOST_NOT_ALLOWED', 'The external URL hostname is not allowed.');
  }

  return hostname;
}

function normalizePolicy(options: SafeExternalUrlOptions): NormalizedPolicy {
  const allowHttp = options.allowHttp ?? false;
  const defaultPorts = allowHttp ? [80, 443] : [443];
  const allowedPorts = options.allowedPorts ?? defaultPorts;
  for (const port of allowedPorts) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new SafeExternalUrlError('INVALID_OPTIONS', 'allowedPorts contains an invalid port.');
    }
  }

  const allowedContentTypes = options.allowedContentTypes ?? DEFAULT_CONTENT_TYPES;
  if (
    allowedContentTypes.length === 0 ||
    allowedContentTypes.some(contentType => !isValidContentTypePattern(contentType))
  ) {
    throw new SafeExternalUrlError(
      'INVALID_OPTIONS',
      'allowedContentTypes contains an invalid media type.'
    );
  }

  return {
    allowHttp,
    allowedPorts: new Set(allowedPorts),
    allowedContentTypes: allowedContentTypes.map(contentType => contentType.toLowerCase()),
    isHostnameAllowed: options.isHostnameAllowed,
    maxDnsAddresses: normalizePositiveInteger(
      options.maxDnsAddresses,
      DEFAULT_MAX_DNS_ADDRESSES,
      'maxDnsAddresses',
      128
    ),
    maxRedirects: normalizeNonNegativeInteger(
      options.maxRedirects,
      DEFAULT_EXTERNAL_URL_MAX_REDIRECTS,
      'maxRedirects',
      10
    ),
    maxResponseBytes: normalizePositiveInteger(
      options.maxResponseBytes,
      DEFAULT_EXTERNAL_URL_MAX_BYTES,
      'maxResponseBytes',
      50 * 1024 * 1024
    ),
    maxUrlLength: normalizePositiveInteger(
      options.maxUrlLength,
      DEFAULT_MAX_URL_LENGTH,
      'maxUrlLength',
      16_384
    ),
    timeoutMs: normalizePositiveInteger(
      options.timeoutMs,
      DEFAULT_EXTERNAL_URL_TIMEOUT_MS,
      'timeoutMs',
      120_000
    ),
    userAgent: normalizeUserAgent(options.userAgent),
  };
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum: number
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new SafeExternalUrlError(
      'INVALID_OPTIONS',
      `${name} must be an integer between 1 and ${maximum}.`
    );
  }
  return resolved;
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum: number
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > maximum) {
    throw new SafeExternalUrlError(
      'INVALID_OPTIONS',
      `${name} must be an integer between 0 and ${maximum}.`
    );
  }
  return resolved;
}

function normalizeUserAgent(userAgent: string | undefined): string {
  const resolved = userAgent?.trim() || DEFAULT_USER_AGENT;
  if (resolved.length > 256 || /[\r\n]/.test(resolved)) {
    throw new SafeExternalUrlError('INVALID_OPTIONS', 'userAgent is invalid.');
  }
  return resolved;
}

function normalizeHostname(hostname: string): string {
  const withoutBrackets = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/, '');
}

function normalizeIpLiteral(address: string): string {
  const withoutBrackets = address.startsWith('[') && address.endsWith(']')
    ? address.slice(1, -1)
    : address;
  return withoutBrackets.toLowerCase();
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4ToInteger(address);
  return !NON_PUBLIC_IPV4_RANGES.some(([base, prefixLength]) =>
    isInIpv4Cidr(value, base, prefixLength)
  );
}

const NON_PUBLIC_IPV4_RANGES: readonly [number, number][] = [
  [ipv4ToInteger('0.0.0.0'), 8],
  [ipv4ToInteger('10.0.0.0'), 8],
  [ipv4ToInteger('100.64.0.0'), 10],
  [ipv4ToInteger('127.0.0.0'), 8],
  [ipv4ToInteger('169.254.0.0'), 16],
  [ipv4ToInteger('172.16.0.0'), 12],
  [ipv4ToInteger('192.0.0.0'), 24],
  [ipv4ToInteger('192.0.2.0'), 24],
  [ipv4ToInteger('192.88.99.0'), 24],
  [ipv4ToInteger('192.168.0.0'), 16],
  [ipv4ToInteger('198.18.0.0'), 15],
  [ipv4ToInteger('198.51.100.0'), 24],
  [ipv4ToInteger('203.0.113.0'), 24],
  [ipv4ToInteger('224.0.0.0'), 4],
  [ipv4ToInteger('240.0.0.0'), 4],
];

function ipv4ToInteger(address: string): number {
  return address
    .split('.')
    .reduce((value, octet) => ((value << 8) | Number.parseInt(octet, 10)) >>> 0, 0);
}

function isInIpv4Cidr(value: number, base: number, prefixLength: number): boolean {
  const mask = prefixLength === 0 ? 0 : (0xffff_ffff << (32 - prefixLength)) >>> 0;
  return (value & mask) >>> 0 === (base & mask) >>> 0;
}

function isPublicIpv6(address: string): boolean {
  const words = parseIpv6(address);
  if (!words) return false;

  // Public IPv6 unicast currently lives in 2000::/3. Reject known special-use
  // subranges inside it, including transition and documentation prefixes.
  if ((words[0] & 0xe000) !== 0x2000) return false;
  if (words[0] === 0x2001 && (words[1] & 0xfe00) === 0) return false; // 2001::/23
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false; // documentation
  if (words[0] === 0x2002) return false; // 6to4 can tunnel an unsafe IPv4 target
  if (words[0] === 0x3fff && (words[1] & 0xf000) === 0) return false; // documentation
  return true;
}

function parseIpv6(address: string): number[] | undefined {
  if (address.includes('%')) return undefined;

  let normalized = address.toLowerCase();
  const ipv4Match = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match) {
    if (isIP(ipv4Match[1]) !== 4) return undefined;
    const ipv4 = ipv4ToInteger(ipv4Match[1]);
    normalized = `${normalized.slice(0, -ipv4Match[1].length)}${(
      ipv4 >>> 16
    ).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return undefined;

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (left.some(isInvalidIpv6Word) || right.some(isInvalidIpv6Word)) return undefined;

  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) {
    return undefined;
  }

  return [
    ...left.map(word => Number.parseInt(word, 16)),
    ...Array.from({ length: omitted }, () => 0),
    ...right.map(word => Number.parseInt(word, 16)),
  ];
}

function isInvalidIpv6Word(word: string): boolean {
  return !/^[0-9a-f]{1,4}$/.test(word);
}

function validateResponseStatus(
  statusCode: number,
  response: PinnedExternalResponse
): void {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    response.cancel();
    throw new SafeExternalUrlError(
      'INVALID_RESPONSE',
      'The external server returned an invalid status code.'
    );
  }
}

async function collectBody(
  response: PinnedExternalResponse,
  maximumBytes: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let chunkCount = 0;
  const iterator = response.body[Symbol.asyncIterator]();

  try {
    while (true) {
      const next = await abortable(iterator.next(), signal);
      if (next.done) break;

      if (!(next.value instanceof Uint8Array)) {
        throw new SafeExternalUrlError(
          'INVALID_RESPONSE',
          'The external response body contained an invalid chunk.'
        );
      }
      chunkCount += 1;
      if (chunkCount > DEFAULT_EXTERNAL_URL_MAX_CHUNKS) {
        throw new SafeExternalUrlError(
          'RESPONSE_TOO_FRAGMENTED',
          'The external response contained too many body chunks.'
        );
      }
      totalBytes += next.value.byteLength;
      if (totalBytes > maximumBytes) {
        throw new SafeExternalUrlError(
          'RESPONSE_TOO_LARGE',
          'The external response exceeded the byte limit.'
        );
      }
      chunks.push(next.value);
    }
  } catch (error) {
    response.cancel(error instanceof Error ? error : undefined);
    try {
      // Cancellation is best effort. Awaiting an adversarial iterator's return()
      // would let it defeat the request timeout after the socket was cancelled.
      const returnResult = iterator.return?.();
      void Promise.resolve(returnResult).catch(() => undefined);
    } catch {
      // The original body error is more useful than a cleanup failure.
    }
    throw error;
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return normalized;
}

function getHeader(
  headers: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  const expected = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === expected) return value;
  }
  return undefined;
}

function normalizeContentType(contentType: string | undefined): string | undefined {
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType || undefined;
}

function validateDeclaredContentLength(
  contentLength: string | undefined,
  maximumBytes: number,
  response: PinnedExternalResponse
): void {
  if (contentLength === undefined) return;

  const normalized = contentLength.trim();
  if (!/^\d+$/.test(normalized)) {
    response.cancel();
    throw new SafeExternalUrlError(
      'INVALID_RESPONSE',
      'The external response Content-Length is invalid.'
    );
  }

  const declaredBytes = Number(normalized);
  if (!Number.isSafeInteger(declaredBytes)) {
    response.cancel();
    throw new SafeExternalUrlError(
      'INVALID_RESPONSE',
      'The external response Content-Length is invalid.'
    );
  }
  if (declaredBytes > maximumBytes) {
    response.cancel();
    throw new SafeExternalUrlError(
      'RESPONSE_TOO_LARGE',
      'The external response exceeded the byte limit.'
    );
  }
}

function isAllowedContentType(contentType: string, allowed: readonly string[]): boolean {
  return allowed.some(pattern => {
    if (pattern.endsWith('/*')) return contentType.startsWith(pattern.slice(0, -1));
    return contentType === pattern;
  });
}

function isValidContentTypePattern(contentType: string): boolean {
  return /^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/i.test(contentType);
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
}
