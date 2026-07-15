export interface RedactedErrorLog {
  name: string;
  message: string;
}

const SECRET_ASSIGNMENT =
  /\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi;
const QUOTED_SECRET_ASSIGNMENT =
  /((?:"|')?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret)(?:"|')?\s*[:=]\s*)(["'])(?:Bearer\s+)?[^"']*\2/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const SENSITIVE_QUERY =
  /([?&](?:api[_-]?key|access[_-]?token|token|password|secret)=)[^&#\s]*/gi;
const URL_CREDENTIALS = /(https?:\/\/)[^/@\s]+@/gi;

export function redactErrorForLog(error: unknown): RedactedErrorLog {
  const name = error instanceof Error && error.name ? error.name : 'Error';
  const rawMessage = error instanceof Error ? error.message : String(error);
  return {
    name: sanitize(rawMessage === '[object Object]' ? 'Unknown error' : name).slice(0, 120),
    message: sanitize(rawMessage).slice(0, 1_000),
  };
}

function sanitize(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(URL_CREDENTIALS, '$1[REDACTED]@')
    .replace(SENSITIVE_QUERY, '$1[REDACTED]')
    .replace(QUOTED_SECRET_ASSIGNMENT, '$1$2[REDACTED]$2')
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]')
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]');
}
