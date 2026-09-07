import type { FrameMetadataPayload } from '../frameMetadata/frameMetadata';
import type { FrameMetadataPublishOptions } from '../frameMetadata/types';
import type { LogLevel } from '../logger';
import type { VideoCodec } from '../room/track/options';
import type { NonSharedUint8Array } from '../type-polyfills/non-shared-typed-arrays';
import type { BaseE2EEManager } from './E2eeManager';
import type { BaseKeyProvider } from './KeyProvider';

export interface BaseMessage {
  kind: string;
  data?: unknown;
}

export interface InitMessage extends BaseMessage {
  kind: 'init';
  data: {
    keyProviderOptions: KeyProviderOptions;
    loglevel: LogLevel;
  };
}

export interface SetKeyMessage extends BaseMessage {
  kind: 'setKey';
  data: {
    participantIdentity?: string;
    isPublisher: boolean;
    key: EncryptionKey;
    keyIndex?: number;
    updateCurrentKeyIndex: boolean;
  };
}

export interface RTPVideoMapMessage extends BaseMessage {
  kind: 'setRTPMap';
  data: {
    map: Map<number, VideoCodec>;
    participantIdentity: string;
  };
}

export interface SifTrailerMessage extends BaseMessage {
  kind: 'setSifTrailer';
  data: {
    trailer: NonSharedUint8Array;
  };
}

export interface EncodeMessage extends BaseMessage {
  kind: 'decode' | 'encode';
  data: {
    participantIdentity: string;
    readableStream: ReadableStream;
    writableStream: WritableStream;
    trackId: string;
    codec?: VideoCodec;
    /**
     * Whether the published track advertises packet trailer features.
     * When false, the cryptor skips the per-frame trailer extraction path
     * entirely on decode.
     */
    hasPacketTrailer: boolean;
    /**
     * Packet trailer metadata to append on published video frames.
     */
    packetTrailer?: FrameMetadataPublishOptions;
  };
}

export interface RemoveTransformMessage extends BaseMessage {
  kind: 'removeTransform';
  data: {
    participantIdentity: string;
    trackId: string;
  };
}

export interface UpdateCodecMessage extends BaseMessage {
  kind: 'updateCodec';
  data: {
    participantIdentity: string;
    trackId: string;
    /** undefined for audio tracks */
    codec?: VideoCodec;
    /**
     * trackId this receiver's pipeline was previously set up for, set when a
     * transceiver gets reused for a new track. Lets the worker find the cryptor
     * that still owns the (already transferred) encoded streams and re-point it,
     * rather than creating a fresh cryptor with no pipeline at all.
     */
    previousTrackId?: string;
    hasPacketTrailer: boolean;
  };
}

export interface RatchetRequestMessage extends BaseMessage {
  kind: 'ratchetRequest';
  data: {
    participantIdentity?: string;
    keyIndex?: number;
  };
}

export interface RatchetMessage extends BaseMessage {
  kind: 'ratchetKey';
  data: {
    participantIdentity: string;
    keyIndex?: number;
    ratchetResult: RatchetResult;
  };
}

export interface ErrorMessage extends BaseMessage {
  kind: 'error';
  data: {
    error: Error;
    participantIdentity?: string;
    uuid?: string; // Optional: used for async operation errors (decrypt/encrypt)
  };
}

export interface EnableMessage extends BaseMessage {
  kind: 'enable';
  data: {
    participantIdentity: string;
    enabled: boolean;
  };
}

export interface InitAck extends BaseMessage {
  kind: 'initAck';
  data: {
    enabled: boolean;
  };
}

export interface DecryptDataRequestMessage extends BaseMessage {
  kind: 'decryptDataRequest';
  data: {
    uuid: string;
    payload: NonSharedUint8Array;
    iv: NonSharedUint8Array;
    participantIdentity: string;
    keyIndex: number;
  };
}

export interface DecryptDataResponseMessage extends BaseMessage {
  kind: 'decryptDataResponse';
  data: {
    uuid: string;
    payload: NonSharedUint8Array;
  };
}

export interface EncryptDataRequestMessage extends BaseMessage {
  kind: 'encryptDataRequest';
  data: {
    uuid: string;
    payload: NonSharedUint8Array;
    participantIdentity: string;
  };
}

export interface EncryptDataResponseMessage extends BaseMessage {
  kind: 'encryptDataResponse';
  data: {
    uuid: string;
    payload: NonSharedUint8Array;
    iv: NonSharedUint8Array;
    keyIndex: number;
  };
}

export interface PTMetadataFromE2EEMessage extends BaseMessage {
  kind: 'packetTrailerMetadata';
  data: FrameMetadataPayload;
}

export interface LogMessage extends BaseMessage {
  kind: 'log';
  data: {
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
    msg: string;
    context?: object;
  };
}

export interface SetLogLevelMessage extends BaseMessage {
  kind: 'setLogLevel';
  data: {
    level: LogLevel;
  };
}

export type E2EEWorkerMessage =
  | InitMessage
  | SetKeyMessage
  | EncodeMessage
  | ErrorMessage
  | EnableMessage
  | RemoveTransformMessage
  | RTPVideoMapMessage
  | UpdateCodecMessage
  | RatchetRequestMessage
  | RatchetMessage
  | SifTrailerMessage
  | InitAck
  | DecryptDataRequestMessage
  | DecryptDataResponseMessage
  | EncryptDataRequestMessage
  | EncryptDataResponseMessage
  | PTMetadataFromE2EEMessage
  | LogMessage
  | SetLogLevelMessage;

/**
 * e2ee 使用的加密算法。
 * - `'aes-gcm'`：默认，Web Crypto AES-GCM（行为与官方 SDK 一致）。
 * - `'sm4'`：国密 SM4-GCM（AEAD，见 `src/e2ee/sm/smCrypto.ts`）。
 */
export type Cryptography = 'aes-gcm' | 'sm4';

/**
 * SM2 配置（仅在开启国密 / 启用 SM2 密钥协商或分发时使用）。
 * 密钥均为 16 进制串。
 */
export type SM2Options = {
  /** 本端 SM2 公钥；用于对分发来的会话钥信令验签等。 */
  publicKey?: string;
  /** 本端 SM2 私钥；用于解密被 SM2 加密保护的会话钥。 */
  privateKey?: string;
  /** SM2 密文结构：1 - C1C3C2（默认），0 - C1C2C3。 */
  cipherMode?: 0 | 1;
};

/**
 * 加密密钥形态。
 * - `aes-gcm` 路径为 Web Crypto 的 `CryptoKey`；
 * - `sm4` 路径为 16 字节 `Uint8Array`（SM4 密钥，sm-crypto-v3 直接使用字节）。
 */
export type EncryptionKey = CryptoKey | Uint8Array;

export type KeySet = { material: EncryptionKey; encryptionKey: EncryptionKey };

export type RatchetResult = {
  // The ratchet chain key, which is used to derive the next key.
  // Can be shared/exported to other participants.
  chainKey: ArrayBuffer;
  cryptoKey: EncryptionKey;
};

export type KeyProviderOptions = {
  sharedKey: boolean;
  ratchetSalt: string;
  ratchetWindowSize: number;
  failureTolerance: number;
  keyringSize: number;
  /**
   * Size of the encryption key in bits.
   * Defaults to 128. Note that 128 is currently the only value
   * supported by non-web SDKs.
   */
  keySize: 128 | 256;
  /**
   * 使用的加密算法，默认 `'aes-gcm'`。置为 `'sm4'` 时媒体帧与数据消息
   * 改用 SM4-GCM，会话密钥派生/换钥改用 SM3（见 `src/e2ee/sm/smCrypto.ts`）。
   */
  cryptography?: Cryptography;
  /** 国密 SM2 密钥协商 / 分发配置（可选）。 */
  sm2?: SM2Options;
};

export type KeyInfo = {
  key: EncryptionKey;
  participantIdentity?: string;
  keyIndex?: number;
};

export type E2EEManagerOptions = {
  keyProvider: BaseKeyProvider;
  worker: Worker;
};

export type E2EEOptions =
  | E2EEManagerOptions
  | {
      /** For react-native usage. */
      e2eeManager: BaseE2EEManager;
    };

export type DecodeRatchetOptions = {
  /** attempts  */
  ratchetCount: number;
  /** ratcheted key to try */
  encryptionKey?: EncryptionKey;
};

export type ScriptTransformOptions = {
  kind: 'decode' | 'encode';
  participantIdentity: string;
  trackId: string;
  codec?: VideoCodec;
  /**
   * Whether the published track advertises packet trailer features.
   * When false, the cryptor skips the per-frame trailer extraction path
   * entirely on decode.
   */
  hasPacketTrailer: boolean;
  /**
   * Packet trailer metadata to append on published video frames.
   */
  packetTrailer?: FrameMetadataPublishOptions;
};
