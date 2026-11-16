/**
 * AC78 — A blob is an input, so its header is parsed as one.
 *
 * `EnvelopeEncryptionProvider.decrypt()` read the wrapped key out of the blob it
 * was handed and answered four different kinds of damage with one shape of
 * failure. The mutation run found that the answer was never asserted: deleting the
 * `throw` in the header-JSON `catch` left a caller to meet `unwrapKey(undefined)`
 * instead, and replacing the AES-GCM failure message with an empty one changed
 * nothing any test noticed.
 *
 * A message is not decoration here. These strings are what an operator has when a
 * read fails at three in the morning, and "it threw something" is not a diagnosis:
 * a truncated header, a payload that was edited, a key that does not unwrap and a
 * context that does not match are four different problems with four different
 * fixes.
 */

import { describe, it, expect } from 'vitest';
import { EnvelopeEncryptionProvider } from '../impl/EnvelopeEncryptionProvider.js';

async function provider(): Promise<EnvelopeEncryptionProvider> {
  const p = new EnvelopeEncryptionProvider({
    keyManager: { masterSecret: 'ac78-master', iterations: 1_000 },
    encryption: { algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' },
  });
  await p.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });
  return p;
}

/** Replace the JSON header of a blob, keeping the payload after it. */
function withHeaderText(blob: Buffer, text: string): Buffer {
  const headerLength = blob.readUInt32BE(0);
  const payload = blob.subarray(4 + headerLength);
  const header = Buffer.from(text, 'utf-8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(header.length, 0);
  return Buffer.concat([prefix, header, payload]);
}

// ── 78.1–78.5: the header ──────────────────────────────────

describe('AC78.1–78.5: a header that is not a header is named as such', () => {
  it('78.1 text that is not JSON is refused by the JSON step', async () => {
    const p = await provider();
    const blob = await p.encrypt(Buffer.from('payload'));

    await expect(p.decrypt(withHeaderText(blob, 'not json at all'))).rejects.toThrow(
      'EnvelopeEncryption: invalid wrapped key JSON in header',
    );
  });

  it('78.2 JSON that is not a wrapped key is refused the same way', async () => {
    const p = await provider();
    const blob = await p.encrypt(Buffer.from('payload'));

    // `null` parses, then fails on the first field it does not have — inside the
    // same guard, because "parsed but unusable" and "did not parse" are the same
    // answer to the caller.
    await expect(p.decrypt(withHeaderText(blob, 'null'))).rejects.toThrow(
      'EnvelopeEncryption: invalid wrapped key JSON in header',
    );
  });

  it('78.3 a header without a salt is refused, not silently zero-length', async () => {
    const p = await provider();
    const blob = await p.encrypt(Buffer.from('payload'));

    await expect(
      p.decrypt(withHeaderText(blob, JSON.stringify({ version: 1, iv: [], encryptedKey: [] }))),
    ).rejects.toThrow(/invalid wrapped key JSON/);
  });

  it('78.4 a blob shorter than its own length prefix is refused', async () => {
    const p = await provider();

    await expect(p.decrypt(Buffer.from([0, 0]))).rejects.toThrow('EnvelopeEncryption: ciphertext too short (2B)');
  });

  it('78.5 a header longer than the blob is refused before it is sliced', async () => {
    const p = await provider();
    const blob = await p.encrypt(Buffer.from('payload'));
    const lying = Buffer.from(blob);
    lying.writeUInt32BE(blob.length, 0); // the header claims the whole blob

    await expect(p.decrypt(lying)).rejects.toThrow(/incomplete header \(wrapped key length: \d+\)/);
  });
});

// ── 78.6–78.9: the payload ─────────────────────────────────

describe('AC78.6–78.9: damage after the header is reported as what it is', () => {
  it('78.6 an edited payload fails authentication and says so', async () => {
    const p = await provider();
    const blob = await p.encrypt(Buffer.from('transfer 100'));

    const edited = Buffer.from(blob);
    const at = edited.length - 20;
    edited[at] = (edited[at] ?? 0) ^ 0xff;

    await expect(p.decrypt(edited)).rejects.toThrow(/^EnvelopeEncryption: AES-GCM decryption failed: /);
  });

  it('78.7 a payload too short to hold an IV and a tag is refused by length', async () => {
    const p = await provider();
    const blob = await p.encrypt(Buffer.from('x'));
    const headerLength = blob.readUInt32BE(0);

    // Keep the header, keep 12 bytes of payload: enough to satisfy the header
    // check, not enough for the IV (12) plus the tag (16) that must follow it.
    const short = Buffer.concat([blob.subarray(0, 4 + headerLength), Buffer.alloc(12)]);

    await expect(p.decrypt(short)).rejects.toThrow('EnvelopeEncryption: data too short for AES-GCM (12B)');
  });

  it('78.8 a context that does not match fails authentication', async () => {
    const p = await provider();
    const blob = await p.encrypt(Buffer.from('scoped'), 'tenant-a');

    await expect(p.decrypt(blob, 'tenant-b')).rejects.toThrow(/AES-GCM decryption failed/);
    expect((await p.decrypt(blob, 'tenant-a')).toString()).toBe('scoped');
  });

  it('78.9 a wrapped key from another master secret is refused by the key manager', async () => {
    const source = await provider();
    const blob = await source.encrypt(Buffer.from('foreign'));

    const other = new EnvelopeEncryptionProvider({
      keyManager: { masterSecret: 'ac78-other-master', iterations: 1_000 },
      encryption: { algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' },
    });
    await other.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });

    await expect(other.decrypt(blob)).rejects.toThrow(/failed to unwrap key v1/);
  });
});
