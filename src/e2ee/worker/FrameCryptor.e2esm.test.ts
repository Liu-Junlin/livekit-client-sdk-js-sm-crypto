import { afterEach, describe, expect, it, vitest } from 'vitest';
import type { NonSharedUint8Array } from '../../type-polyfills/non-shared-typed-arrays';
import { IV_LENGTH, KEY_PROVIDER_DEFAULTS } from '../constants';
import { FrameCryptor, encryptionEnabledMap } from './FrameCryptor';
import { ParticipantKeyHandler } from './ParticipantKeyHandler';

/**
 * SM4-GCM 媒体的帧加密 / 解密往返（`cryptography: 'sm4'`）。
 * 复用真实的 ParticipantKeyHandler + FrameCryptor，走 encodeFunction → decodeFunction。
 */
const SM4_KEY = new Uint8Array(16).fill(0x2d);
const SM4_IV = new Uint8Array(12).fill(0x4e);
const AAD = new TextEncoder().encode('LKHEADER');

function makeSmOptions() {
  return {
    ...KEY_PROVIDER_DEFAULTS,
    cryptography: 'sm4' as const,
    ratchetWindowSize: 0, // 简化：不自动 ratchet
    failureTolerance: -1,
  };
}

function mockAudioFrame(data: NonSharedUint8Array): RTCEncodedAudioFrame {
  return {
    data: data.buffer,
    timestamp: 1000,
    getMetadata(): RTCEncodedAudioFrameMetadata {
      return { synchronizationSource: 7 };
    },
  };
}

async function makeSmCryptor() {
  const options = makeSmOptions();
  const keys = new ParticipantKeyHandler('smParticipant', options);
  await keys.setKey(new Uint8Array(SM4_KEY), 0, true);
  const cryptor = new FrameCryptor({
    keys,
    participantIdentity: 'smParticipant',
    keyProviderOptions: options,
  });
  return { cryptor, keys, options };
}

afterEach(() => {
  encryptionEnabledMap.delete('smParticipant');
});

describe('FrameCryptor SM4-GCM (helpers)', () => {
  it('encryptFramePayload → decryptFramePayload round-trips', async () => {
    const { cryptor } = await makeSmCryptor();
    const plain = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    // @ts-expect-error testing private helper
    const sealed = await cryptor.encryptFramePayload(plain, SM4_KEY, SM4_IV, AAD);
    // 密文段长度 = 明文 + 16B tag，与 AES-GCM 一致
    expect(sealed.byteLength).toBe(plain.byteLength + 16);

    // @ts-expect-error testing private helper
    const back = await cryptor.decryptFramePayload(sealed, SM4_IV, SM4_KEY, AAD);
    expect(new Uint8Array(back)).toEqual(plain);
  });

  it('encrypt / decrypt disagree when AAD differs (auth check)', async () => {
    const { cryptor } = await makeSmCryptor();
    const plain = new Uint8Array([9, 9, 9]);
    // @ts-expect-error testing private helper
    const sealed = await cryptor.encryptFramePayload(plain, SM4_KEY, SM4_IV, AAD);
    const wrongAad = new TextEncoder().encode('WRONG');
    await expect(
      // @ts-expect-error testing private helper
      cryptor.decryptFramePayload(sealed, SM4_IV, SM4_KEY, wrongAad),
    ).rejects.toThrow('authentication tag mismatch');
  });
});

describe('FrameCryptor SM4-GCM (full encode/decode round-trip)', () => {
  it('encodes an audio frame and decodes it back, matching the wire format', async () => {
    const { cryptor, keys } = await makeSmCryptor();
    encryptionEnabledMap.set('smParticipant', true);

    // audio 帧：1 字节未加密头（UNENCRYPTED_BYTES.audio）+ 8 字节负载
    const original = new Uint8Array([0x42, 11, 12, 13, 14, 15, 16, 17, 18]);
    const frame = mockAudioFrame(original);

    const encoderController = { enqueue: vitest.fn() } as unknown as TransformStreamDefaultController;
    await (cryptor as FrameCryptor).encodeFunction(frame, encoderController);
    const encrypted = encoderController.enqueue.mock.calls[0][0] as RTCEncodedAudioFrame;
    const encBytes = new Uint8Array(encrypted.data);

    // 帧结构：header(1) ‖ cipher(8) ‖ tag(16) ‖ iv(12) ‖ trailer(2)
    expect(encBytes.byteLength).toBe(1 + 8 + 16 + 12 + 2);
    // 未加密头原样保留
    expect(encBytes[0]).toBe(0x42);
    // 帧尾：trailer[0]=IV_LENGTH(12, 与 AES 对齐)、trailer[1]=keyIndex(0)
    expect(encBytes[encBytes.byteLength - 2]).toBe(IV_LENGTH);
    expect(encBytes[encBytes.byteLength - 1]).toBe(keys.getCurrentKeyIndex());

    // 解码还原
    const decoderController = {
      enqueue: vitest.fn(),
    } as unknown as TransformStreamDefaultController;
    await (cryptor as FrameCryptor).decodeFunction(encrypted, decoderController);
    const decoded = decoderController.enqueue.mock.calls[0][0] as RTCEncodedAudioFrame;
    expect(new Uint8Array(decoded.data)).toEqual(original);
  });
});