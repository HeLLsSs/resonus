/**
 * `expo-crypto` on Node's own crypto. Real digests and real AES-GCM, so a
 * backup sealed with a passphrase can be opened again by the same code, and
 * a wrong passphrase fails the tag the way it does on the phone. The
 * combined layout (iv, ciphertext, tag) is this file's and need not match the
 * phone's: nothing here reads a file the phone wrote.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** A plain object rather than the package's enum: Node strips types and does not compile enums. */
export const CryptoDigestAlgorithm = { SHA256: 'SHA-256' } as const;

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function getRandomBytes(byteCount: number): Uint8Array {
  return new Uint8Array(randomBytes(byteCount));
}

export async function digest(algorithm: string, data: BufferSource): Promise<ArrayBuffer> {
  if (algorithm !== CryptoDigestAlgorithm.SHA256) throw new Error(`unsupported digest ${algorithm}`);
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const out = createHash('sha256').update(bytes).digest();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

export class AESEncryptionKey {
  private constructor(readonly bytes: Uint8Array) {}

  static import(bytes: Uint8Array): AESEncryptionKey {
    if (bytes.length !== 32) throw new Error('a 256-bit key is expected');
    return new AESEncryptionKey(bytes);
  }
}

export class AESSealedData {
  private constructor(readonly combined: Uint8Array) {}

  static fromCombined(base64: string): AESSealedData {
    return new AESSealedData(new Uint8Array(Buffer.from(base64, 'base64')));
  }

  static of(combined: Uint8Array): AESSealedData {
    return new AESSealedData(combined);
  }
}

/** What `aesEncryptAsync` resolves to: the sealed bytes, exportable as text. */
export interface Sealed {
  combined(encoding: 'base64'): Promise<string>;
}

export async function aesEncryptAsync(plain: Uint8Array, key: AESEncryptionKey): Promise<Sealed> {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.bytes, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const combined = Buffer.concat([iv, body, cipher.getAuthTag()]);
  return { combined: async () => combined.toString('base64') };
}

export async function aesDecryptAsync(sealed: AESSealedData, key: AESEncryptionKey): Promise<Uint8Array> {
  const all = Buffer.from(sealed.combined);
  if (all.length < IV_BYTES + TAG_BYTES) throw new Error('sealed data is too short');
  const iv = all.subarray(0, IV_BYTES);
  const tag = all.subarray(all.length - TAG_BYTES);
  const body = all.subarray(IV_BYTES, all.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key.bytes, iv);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
}
