import { describe, expect, it } from 'vitest';
import {
  SM4_GCM_IV_LENGTH,
  SM4_KEY_LENGTH,
  SM4_TAG_LENGTH,
  deriveSM4Key,
  ratchetSM4Key,
  sm3Hash,
  sm4GcmDecrypt,
  sm4GcmEncrypt,
} from './smCrypto';

// 确定性测试向量（固定 key/iv/aad），便于不同端联调时对齐
const TEST_KEY = new Uint8Array(16).fill(0x2d);
const TEST_IV = new Uint8Array(SM4_GCM_IV_LENGTH).fill(0x4e);
const TEST_AAD = new TextEncoder().encode('LKFRAME');
const TEST_PLAIN_ALIGNED = new Uint8Array(16).map((_, i) => i); // 恰好 16 字节（=1 block）
const TEST_PLAIN_UNALIGNED = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 10, 11, 12, 13, 14, 15, 16, 17, 18]); // 19 字节

describe('sm4GcmEncrypt', () => {
  it('returns separable cipher & 16-byte tag; cipher length == plain length', () => {
    for (const plain of [TEST_PLAIN_ALIGNED, TEST_PLAIN_UNALIGNED]) {
      const { cipher, tag } = sm4GcmEncrypt(plain, TEST_KEY, TEST_IV, TEST_AAD);
      expect(cipher).toBeInstanceOf(Uint8Array);
      expect(cipher.byteLength).toBe(plain.byteLength); // GCM 为流式，密文长度==明文
      expect(tag).toBeInstanceOf(Uint8Array);
      expect(tag.byteLength).toBe(SM4_TAG_LENGTH);
    }
  });
});

describe('sm4GcmDecrypt', () => {
  it('round-trips (aligned & unaligned plain, with/without aad)', () => {
    const cases: { plain: Uint8Array; aad?: Uint8Array }[] = [
      { plain: TEST_PLAIN_ALIGNED, aad: TEST_AAD },
      { plain: TEST_PLAIN_UNALIGNED, aad: TEST_AAD },
      { plain: TEST_PLAIN_UNALIGNED }, // 无 AAD
      { plain: new Uint8Array(0) }, // 空明文
    ];
    for (const { plain, aad } of cases) {
      const { cipher, tag } = sm4GcmEncrypt(plain, TEST_KEY, TEST_IV, aad);
      const back = sm4GcmDecrypt(cipher, tag, TEST_KEY, TEST_IV, aad);
      expect(back).toEqual(plain);
    }
  });

  it('uses associated data as AAD (tampered aad fails decryption)', () => {
    const { cipher, tag } = sm4GcmEncrypt(TEST_PLAIN_UNALIGNED, TEST_KEY, TEST_IV, TEST_AAD);
    const wrongAad = new TextEncoder().encode('WRONG');
    expect(() => sm4GcmDecrypt(cipher, tag, TEST_KEY, TEST_IV, wrongAad)).toThrow(
      'authentication tag mismatch',
    );
  });

  it('rejects tampered tag', () => {
    const { cipher, tag } = sm4GcmEncrypt(TEST_PLAIN_UNALIGNED, TEST_KEY, TEST_IV);
    const reversed = new Uint8Array(tag).reverse();
    expect(() => sm4GcmDecrypt(cipher, reversed, TEST_KEY, TEST_IV)).toThrow(
      'authentication tag mismatch',
    );
  });

  it('rejects tampered ciphertext', () => {
    const { cipher, tag } = sm4GcmEncrypt(TEST_PLAIN_UNALIGNED, TEST_KEY, TEST_IV, TEST_AAD);
    const tampered = new Uint8Array(cipher);
    tampered[0] ^= 0xff;
    expect(() => sm4GcmDecrypt(tampered, tag, TEST_KEY, TEST_IV, TEST_AAD)).toThrow(
      'authentication tag mismatch',
    );
  });

  it('rejects wrong key / wrong iv', () => {
    const { cipher, tag } = sm4GcmEncrypt(TEST_PLAIN_UNALIGNED, TEST_KEY, TEST_IV, TEST_AAD);
    const wrongKey = new Uint8Array(16).fill(0x01);
    const wrongIv = new Uint8Array(SM4_GCM_IV_LENGTH).fill(0x01);
    expect(() => sm4GcmDecrypt(cipher, tag, wrongKey, TEST_IV, TEST_AAD)).toThrow(
      'authentication tag mismatch',
    );
    expect(() => sm4GcmDecrypt(cipher, tag, TEST_KEY, wrongIv, TEST_AAD)).toThrow(
      'authentication tag mismatch',
    );
  });
});

describe('deriveSM4Key (hkdf, base SM3)', () => {
  const MATERIAL = new Uint8Array(16).fill(0x11);
  const SALT = 'LKFrameEncryptionKey';
  const INFO = 'sm4-encryption';

  it('derives 16-byte key by default', () => {
    const key = deriveSM4Key(MATERIAL, SALT, INFO);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.byteLength).toBe(SM4_KEY_LENGTH);
  });

  it('is deterministic for same inputs', () => {
    const a = deriveSM4Key(MATERIAL, SALT, INFO);
    const b = deriveSM4Key(MATERIAL, SALT, INFO);
    expect(a).toEqual(b);
  });

  it('differs when salt or info changes (domain separation)', () => {
    const base = deriveSM4Key(MATERIAL, SALT, INFO);
    expect(deriveSM4Key(MATERIAL, `${SALT}.v2`, INFO)).not.toEqual(base);
    expect(deriveSM4Key(MATERIAL, SALT, `${INFO}.v2`)).not.toEqual(base);
  });

  it('accepts plain-string ikm (e.g. passphrase)', () => {
    const key = deriveSM4Key('my-shared-passphrase', SALT, INFO);
    expect(key.byteLength).toBe(SM4_KEY_LENGTH);
    const key2 = deriveSM4Key('my-shared-passphrase', SALT, INFO);
    expect(key).toEqual(key2);
  });
});

describe('ratchetSM4Key (GM/T SM3 KDF)', () => {
  it('derives 16-byte next chain key', () => {
    const chain = new Uint8Array(16).fill(0x5a);
    const next = ratchetSM4Key(chain);
    expect(next).toBeInstanceOf(Uint8Array);
    expect(next.byteLength).toBe(SM4_KEY_LENGTH);
  });

  it('advances the chain (subsequent keys differ)', () => {
    let chain = new Uint8Array(16).fill(0x5a);
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      chain = ratchetSM4Key(chain);
      seen.add(Array.from(chain).join(','));
    }
    expect(seen.size).toBe(8); // 每次推进都产生新链钥
  });
});

describe('sm3Hash', () => {
  it('matches the GB/T standard SM3("abc") prefix', () => {
    // GB/T 32905-2016 SM3("abc") = 66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0
    expect(sm3Hash('abc')).toMatch(/^66c7f0f4/);
  });

  it('accepts byte input', () => {
    expect(sm3Hash(new TextEncoder().encode('abc'))).toBe(sm3Hash('abc'));
  });
});