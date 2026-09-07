/**
 * SM2/SM3/SM4 国密封装 —— `sm-crypto-v3` 的唯一注入点。
 *
 * 本文件不依赖 livekit 其它模块，只封装国密原语，并以「帧加解密 / 密钥派生」
 * 两级 API 对外暴露，供其它模块（`FrameCryptor` / `DataCryptor` / `utils`）按
 * `keyProviderOptions.cryptography === 'sm4'` 分支切换。
 *
 * 之所以统一收口到此处，是为了：
 *  - 后续切换到 wasm 加速（`sm-crypto-wasm`）时只改这一个文件；
 *  - 单测聚焦本文件即可锁定国密行为（round-trip / 篡改抛错 / 派生确定性）。
 */
import { hkdf, kdf, sm3, sm4 } from 'sm-crypto-v3';

/** SM4 密钥长度（128 bit / 16 字节）。 */
export const SM4_KEY_LENGTH = 16;

/** SM4-GCM 认证 tag 长度（16 字节，与 AES-GCM 默认 tag 一致）。 */
export const SM4_TAG_LENGTH = 16;

/** SM4-GCM 推荐 IV 长度（96 bit / 12 字节，走 J0 快速路径，与现有 AES-GCM 对齐）。 */
export const SM4_GCM_IV_LENGTH = 12;

const textEncoder = new TextEncoder();

/** 断言为「ArrayBuffer 承载」的 `Uint8Array`（sm-crypto-v3 的 .d.ts 要求）。 */
function ab(input: Uint8Array): Uint8Array<ArrayBuffer> {
  return input as Uint8Array<ArrayBuffer>;
}

/**
 * 统一为「ArrayBuffer 承载」的 `Uint8Array`。
 * sm-crypto-v3 的入参类型要求 `Uint8Array<ArrayBuffer>`；若上层传入的是
 * `SharedArrayBuffer` 承载的视图（`ArrayBufferLike`），在此深拷贝归一到普通
 * `ArrayBuffer`，既满足该包类型、也避免把共享内存直接交给密码库（安全兜底）。
 */
function toBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  if (input.buffer instanceof ArrayBuffer) {
    return ab(input);
  }
  return ab(Uint8Array.from(input));
}

/**
 * SM4-GCM 对称加密（AEAD）。
 *
 * @param plain       明文（如媒体帧负载或数据消息 payload）
 * @param key         16 字节 SM4 密钥
 * @param iv          推荐 12 字节 IV（同 AES-GCM 的 `IV_LENGTH`）
 * @param aad        附加认证数据（可选，对应 AES-GCM 的 `additionalData`，通常是未加密帧头）
 * @returns           分离的 `{ cipher, tag }`；`cipher` 长度与明文一致，`tag` 恒为 16 字节
 */
export function sm4GcmEncrypt(
  plain: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): { cipher: Uint8Array; tag: Uint8Array } {
  const { output, tag } = sm4.encrypt(toBytes(plain), toBytes(key), {
    mode: 'gcm',
    iv: toBytes(iv),
    associatedData: toBytes(aad),
    output: 'array',
    outputTag: true,
    padding: 'none',
  });
  if (!tag) {
    throw new Error('sm4 gcm encrypt did not produce an authentication tag');
  }
  return { cipher: output, tag };
}

/**
 * SM4-GCM 对称解密（AEAD）。认证失败（tag / iv / aad / key 任一不符）会抛出
 * `authentication tag mismatch`，调用方应借此触发 ratchet（同 AES 逻辑）。
 *
 * @param cipher      密文
 * @param tag         16 字节认证 tag
 * @param key         16 字节 SM4 密钥
 * @param iv          与加密时一致的 12 字节 IV
 * @param aad         与加密时一致的附加认证数据
 * @returns           明文
 */
export function sm4GcmDecrypt(
  cipher: Uint8Array,
  tag: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array {
  return sm4.decrypt(toBytes(cipher), toBytes(key), {
    mode: 'gcm',
    iv: toBytes(iv),
    associatedData: toBytes(aad),
    tag: toBytes(tag),
    output: 'array',
    padding: 'none',
  });
}

/**
 * 会话密钥派生：`hkdf`（RFC5869，底层为 SM3）。
 *
 * 替代原 AES 路径的 PBKDF2/HKDF-SHA256：
 *  - `createKeyMaterialFromString/Buffer`：从口令/种子派生 16 字节主钥材料；
 *  - `deriveKeys`：从主钥材料派生 16 字节 SM4 加密钥。
 *
 * @param ikm   输入密钥材料（口令字节 / 随机种子 / 上层主钥）
 * @param salt  盐值（如 `ratchetSalt`）
 * @param info  上下文信息（用于区分派生场景，避免两个派生结果相同）
 * @param length 输出字节数，默认 16（SM4 密钥长）
 */
export function deriveSM4Key(
  ikm: Uint8Array | string,
  salt: Uint8Array | string,
  info: Uint8Array | string,
  length: number = SM4_KEY_LENGTH,
): Uint8Array {
  const ikmBytes =
    typeof ikm === 'string' ? textEncoder.encode(ikm) : toBytes(ikm);
  const saltBytes =
    typeof salt === 'string' ? textEncoder.encode(salt) : toBytes(salt);
  const infoBytes =
    typeof info === 'string' ? textEncoder.encode(info) : toBytes(info);
  return hkdf(ab(ikmBytes), ab(saltBytes), ab(infoBytes), length);
}

/**
 * Key ratchet：用 `kdf`（GM/T 0003 SM3 KDF）从当前链钥推进出下一阶段 16 字节链钥。
 *
 * 替代原 AES 路径的 `deriveBits` 迭代；返回的链钥可导出分发（`RatchetResult.chainKey`）。
 *
 * @param chainKey  当前链钥（16+ 字节）
 * @param salt      `ratchetSalt`
 * @returns          推进一步的 16 字节链钥
 */
export function ratchetSM4Key(
  chainKey: Uint8Array,
  salt: Uint8Array | string = 'LKFrameEncryptionKey',
): Uint8Array {
  const saltBytes = typeof salt === 'string' ? textEncoder.encode(salt) : toBytes(salt);
  // kdf 输入按字节处理；以链钥 ‖ salt 作为输入，GM/T KDF 导出下一条链钥
  const input = new Uint8Array(chainKey.byteLength + saltBytes.byteLength);
  input.set(toBytes(chainKey), 0);
  input.set(saltBytes, chainKey.byteLength);
  return kdf(ab(input), SM4_KEY_LENGTH);
}

/** SM3 哈希/消息摘要，含 HMAC 能力（`key` 可省略）。后续如需额外认证可复用。 */
export function sm3Hash(data: Uint8Array | string): string {
  return typeof data === 'string' ? sm3(data) : sm3(toBytes(data));
}