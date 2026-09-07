import { type DataPacket, EncryptedPacketPayload } from '@livekit/protocol';
import type { NonSharedUint8Array } from '../type-polyfills/non-shared-typed-arrays';
import { ENCRYPTION_ALGORITHM } from './constants';
import { SM4_KEY_LENGTH, deriveSM4Key, ratchetSM4Key } from './sm/smCrypto';
import type { Cryptography, EncryptionKey, KeyProviderOptions } from './types';

export function isE2EESupported() {
  return isInsertableStreamSupported() || isScriptTransformSupported();
}

export function isScriptTransformSupported() {
  // @ts-ignore
  return typeof window !== 'undefined' && typeof window.RTCRtpScriptTransform !== 'undefined';
}

export function isInsertableStreamSupported() {
  return (
    typeof window !== 'undefined' &&
    typeof window.RTCRtpSender !== 'undefined' &&
    // @ts-ignore
    typeof window.RTCRtpSender.prototype.createEncodedStreams !== 'undefined'
  );
}

export function isVideoFrame(
  frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame,
): frame is RTCEncodedVideoFrame {
  return 'type' in frame;
}

export async function importKey(
  keyBytes: NonSharedUint8Array | ArrayBuffer,
  algorithm: string | { name: string } = { name: ENCRYPTION_ALGORITHM },
  usage: 'derive' | 'encrypt' = 'encrypt',
) {
  // 注意：国密（sm4）路径不使用 CryptoKey，不需要 importKey——密钥即字节本身。
  // https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/importKey
  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    algorithm,
    false,
    usage === 'derive' ? ['deriveBits', 'deriveKey'] : ['encrypt', 'decrypt'],
  );
}

/** 判断给定 KeyProviderOptions 是否采用国密（SM4-GCM）。 */
export function isSm4(cryptography: Cryptography | undefined): boolean {
  return cryptography === 'sm4';
}

/**
 * AES 路径的密钥收窄：确认 `key` 是 Web Crypto 的 `CryptoKey`。
 * 仅在真正需要调用 `crypto.subtle`（AES-GCM）的代码点使用；国密分支请先用
 * {@link isSm4} 分流，不要在此收窄后再判断字节。
 */
export function asCryptoKey(key: EncryptionKey): CryptoKey {
  if (!isCryptoKeyLike(key)) {
    throw new TypeError('expected a CryptoKey for the AES-GCM path, got raw bytes');
  }
  return key;
}

/** 轻量特征判断，避免在无 `CryptoKey` 全局的环境（单元测试）抛 ReferenceError。 */
function isCryptoKeyLike(key: EncryptionKey): key is CryptoKey {
  return (
    !!key &&
    typeof key === 'object' &&
    typeof (key as CryptoKey).algorithm === 'object' &&
    (key as CryptoKey).algorithm !== null
  );
}

/**
 * 会话密钥派生：从口令（SM3-hkdf）或随机种子（SM3-hkdf）派生密钥材料。
 * AES 路径返回 Web Crypto CryptoKey；SM4 路径返回 16 字节 SM4 密钥材料。
 */
export async function createKeyMaterialFromString(
  password: string,
  cryptography: Cryptography = 'aes-gcm',
): Promise<EncryptionKey> {
  if (cryptography === 'sm4') {
    // GM/T 场景无 PBKDF2；以口令为 IKM、固定盐做 SM3-hkdf，导出 16 字节主钥材料
    return deriveSM4Key(password, 'LKFrameEncryptionKey', 'sm4-master', SM4_KEY_LENGTH);
  }
  let enc = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    {
      name: 'PBKDF2',
    },
    false,
    ['deriveBits', 'deriveKey'],
  );

  return keyMaterial;
}

export async function createKeyMaterialFromBuffer(
  cryptoBuffer: ArrayBuffer,
  cryptography: Cryptography = 'aes-gcm',
): Promise<EncryptionKey> {
  if (cryptography === 'sm4') {
    return deriveSM4Key(new Uint8Array(cryptoBuffer), 'LKFrameEncryptionKey', 'sm4-master', SM4_KEY_LENGTH);
  }
  const keyMaterial = await crypto.subtle.importKey('raw', cryptoBuffer, 'HKDF', false, [
    'deriveBits',
    'deriveKey',
  ]);

  return keyMaterial;
}

function getAlgoOptions(algorithmName: string, salt: string) {
  const textEncoder = new TextEncoder();
  const encodedSalt = textEncoder.encode(salt);
  switch (algorithmName) {
    case 'HKDF':
      return {
        name: 'HKDF',
        salt: encodedSalt,
        hash: 'SHA-256',
        info: new ArrayBuffer(128),
      };
    case 'PBKDF2': {
      return {
        name: 'PBKDF2',
        salt: encodedSalt,
        hash: 'SHA-256',
        iterations: 100000,
      };
    }
    default:
      throw new Error(`algorithm ${algorithmName} is currently unsupported`);
  }
}

/**
 * Derives a set of keys from the master key.
 * See https://tools.ietf.org/html/draft-omara-sframe-00#section-4.3.1
 *
 * 国密分支：`cryptography === 'sm4'` 或用字节作为 material 时，用 SM3-hkdf
 * 派生 16 字节 SM4 加密钥。
 */
export async function deriveKeys(material: EncryptionKey, options: KeyProviderOptions) {
  if (isSm4(options.cryptography) || material instanceof Uint8Array) {
    const materialBytes =
      material instanceof Uint8Array ? material : new Uint8Array(0);
    const encryptionKey = deriveSM4Key(
      materialBytes,
      options.ratchetSalt,
      'sm4-encryption',
      SM4_KEY_LENGTH,
    );
    return { material: materialBytes, encryptionKey };
  }
  const aesMaterial = asCryptoKey(material);
  const algorithmOptions = getAlgoOptions(aesMaterial.algorithm.name, options.ratchetSalt);

  // https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey#HKDF
  // https://developer.mozilla.org/en-US/docs/Web/API/HkdfParams
  const encryptionKey = await crypto.subtle.deriveKey(
    algorithmOptions,
    aesMaterial,
    {
      name: ENCRYPTION_ALGORITHM,
      length: options.keySize,
    },
    false,
    ['encrypt', 'decrypt'],
  );

  return { material: aesMaterial, encryptionKey };
}

export function createE2EEKey(): NonSharedUint8Array {
  return window.crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Ratchets a key. See
 * https://tools.ietf.org/html/draft-omara-sframe-00#section-4.3.5.1
 *
 * 国密分支：用 GM/T SM3-KDF 从链钥推进出 16 字节新链钥（返回其底层 ArrayBuffer，
 * 便于作为 `RatchetResult.chainKey` 分发）。
 */
export async function ratchet(material: EncryptionKey, salt: string): Promise<ArrayBuffer> {
  if (material instanceof Uint8Array) {
    const next = ratchetSM4Key(material, salt);
    return next.buffer.slice(
      next.byteOffset,
      next.byteOffset + next.byteLength,
    ) as ArrayBuffer;
  }
  const aesMaterial = asCryptoKey(material);
  const algorithmOptions = getAlgoOptions(aesMaterial.algorithm.name, salt);

  // https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveBits
  return crypto.subtle.deriveBits(algorithmOptions, aesMaterial, 256);
}

export function needsRbspUnescaping(frameData: NonSharedUint8Array) {
  for (var i = 0; i < frameData.length - 3; i++) {
    if (frameData[i] == 0 && frameData[i + 1] == 0 && frameData[i + 2] == 3) return true;
  }
  return false;
}

export function parseRbsp(stream: NonSharedUint8Array): NonSharedUint8Array {
  const dataOut: number[] = [];
  var length = stream.length;
  for (var i = 0; i < stream.length;) {
    // Be careful about over/underflow here. byte_length_ - 3 can underflow, and
    // i + 3 can overflow, but byte_length_ - i can't, because i < byte_length_
    // above, and that expression will produce the number of bytes left in
    // the stream including the byte at i.
    if (length - i >= 3 && !stream[i] && !stream[i + 1] && stream[i + 2] == 3) {
      // Two rbsp bytes.
      dataOut.push(stream[i++]);
      dataOut.push(stream[i++]);
      // Skip the emulation byte.
      i++;
    } else {
      // Single rbsp byte.
      dataOut.push(stream[i++]);
    }
  }
  return new Uint8Array(dataOut);
}

const kZerosInStartSequence = 2;
const kEmulationByte = 3;

export function writeRbsp(data_in: NonSharedUint8Array): NonSharedUint8Array {
  const dataOut: number[] = [];
  var numConsecutiveZeros = 0;
  for (var i = 0; i < data_in.length; ++i) {
    var byte = data_in[i];
    if (byte <= kEmulationByte && numConsecutiveZeros >= kZerosInStartSequence) {
      // Need to escape.
      dataOut.push(kEmulationByte);
      numConsecutiveZeros = 0;
    }
    dataOut.push(byte);
    if (byte == 0) {
      ++numConsecutiveZeros;
    } else {
      numConsecutiveZeros = 0;
    }
  }
  return new Uint8Array(dataOut);
}

export function asEncryptablePacket(packet: DataPacket): EncryptedPacketPayload | undefined {
  if (
    packet.value?.case !== 'sipDtmf' &&
    packet.value?.case !== 'metrics' &&
    packet.value?.case !== 'speaker' &&
    packet.value?.case !== 'transcription' &&
    packet.value?.case !== 'encryptedPacket'
  ) {
    return new EncryptedPacketPayload({
      value: packet.value,
    });
  }
  return undefined;
}
