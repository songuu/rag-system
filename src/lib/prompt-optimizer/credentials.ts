import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
const CONTEXT = 'rag-system:prompt-optimizer:credential:v1';
function keyFromEnvironment(env: Record<string, string | undefined> = process.env): Buffer {
  const secret = env.PROMPT_OPTIMIZER_CREDENTIAL_KEY || (env.NODE_ENV === 'production' ? undefined : env.RAG_SINGLE_TENANT_TOKEN);
  if (!secret || secret.length < 24) throw new Error('Prompt optimizer credential encryption key is not configured.');
  return createHash('sha256').update(CONTEXT).update('\0').update(secret).digest();
}
export function encryptPromptOptimizerCredential(value: string, binding = '', env: Record<string, string | undefined> = process.env): string {
  const token = value.trim(); if (!token || token.length > 4096) throw new Error('token is invalid.');
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', keyFromEnvironment(env), iv); cipher.setAAD(Buffer.from(binding)); const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}
export function decryptPromptOptimizerCredential(envelope: string, binding = '', env: Record<string, string | undefined> = process.env): string {
  const [version, ivText, tagText, encryptedText, extra] = envelope.split('.'); if (version !== 'v1' || !ivText || !tagText || !encryptedText || extra) throw new Error('Stored prompt optimizer credential is invalid.');
  try { const iv = Buffer.from(ivText, 'base64url'); const tag = Buffer.from(tagText, 'base64url'); if (iv.length !== 12 || tag.length !== 16) throw new Error(); const decipher = createDecipheriv('aes-256-gcm', keyFromEnvironment(env), iv); decipher.setAAD(Buffer.from(binding)); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8'); } catch { throw new Error('Stored prompt optimizer credential could not be decrypted.'); }
}
