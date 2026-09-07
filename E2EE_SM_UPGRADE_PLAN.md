# LiveKit JS SDK e2ee 国密（SM2/SM3/SM4）改造方案

> 仓库：`sm4/livekit-client-sdk-js-sm-crypto`（fork 自 livekit client-sdk-js v2.22.2）
> 目标：让 e2ee 模块支持国密，SM4 对称加密使用 `sm-crypto-v3` 包。
> 原则：**不破坏现有 AES-GCM 路径**，以「算法开关 + Provider 抽象」方式平缓接入，默认行为与官方一致。

## ✅ 实施进度（截至最后更新）

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| 1 | sm-crypto-v3 依赖安装与验证（含 noble 依赖从内网源解析） | ✅ |
| 2 | `src/e2ee/sm/smCrypto.ts` 封装 + 单测 | ✅ |
| 3 | `types.ts` / `constants.ts` 类型、常量 | ✅ |
| 4 | `utils.ts` 派/ratchet 国密分支 | ✅ |
| 5 | `KeyProvider.ts` / `ParticipantKeyHandler.ts` | ✅ |
| 6 | `DataCryptor.ts` SM4-GCM 分支（数据消息） | ✅ |
| 7 | `FrameCryptor.ts` SM4-GCM 分支（媒体帧 encode/decode + ratchet 联通） | ✅ |
| 8 | 打包：`crypto` shim + `inlineDynamicImports`（主/worker bundle）| ✅ |
| 9 | 全量回归：`tsc` 通过；51 文件 / 815 测试绿；两端产物可构建 | ✅ |
| 9a | 前端接入：`pnpm-workspace.overrides` 指向 fork；`?sm4=1` 开关 + `setE2EEEnabled(true)` + vite `livekit-client/e2ee-worker?url` worker 资产 | ✅ 双 tab 同会议室 SM4 互通实测通过 |
| 9b | 移除 `[LK-SM4]` 验证打点，重建 fork dist 并同步前端 | ✅ |
| 10 | SM2 密钥协商/分发增强（可选） | ⏳ 待做（语义与边界见文末「SM2 第 10 步」） |

**新增测试**：`smCrypto.test.ts`（算法层）、`FrameCryptor.e2esm.test.ts`（媒体帧 SM 往返）。
**新增打包要点**：`sm-crypto-v3` 依赖 `import "crypto"` → 两 bundle 用 `cryptoShim`（`rollup.config.js:commonPlugins`）解析为 `globalThis.crypto`；输出加 `inlineDynamicImports:true` 消除 noble 动态导入产生的多 chunk。

## 当前实现：数据通道 × 加密算法支持矩阵

> 加密算法由 `KeyProviderOptions.cryptography: 'aes-gcm' | 'sm4'` 全局切换，同一密钥集使用同一算法。`'aes-gcm'`（默认）为官方 Web Crypto AES-GCM 路径，`'sm4'` 为国密 SM4-GCM（AEAD）+ SM3 派生。

| 数据通道 / 加密面 | 覆盖实现（源码） | 默认 `aes-gcm` | 国密 `sm4` | 状态与说明 |
| --- | --- | --- | --- | --- |
| **RTP 音频帧** | `FrameCryptor.encodeFunction/decodeFunction` | ✅ AES-GCM | ✅ SM4-GCM | IV 12B、AAD=未加密头、认证 tag 16B，帧尾 `trailer[0]=IV_LENGTH` |
| **RTP 视频帧**（VP8 / VP9 / H264 / H265） | `FrameCryptor` + `naluUtils`/RBSP | ✅ AES-GCM | ✅ SM4-GCM | 未加密前缀保留供 SFU 识别关键帧；H264/H265 走 NALU 处理 |
| **AV1 视频** | `getUnencryptedBytes` | ✗ | ✗ | 上游整体不支持 e2ee（抛错），两算法均不可用 |
| **加密数据消息**（`publishData` 的 `EncryptedPacketPayload`） | `DataCryptor.encrypt/decrypt` | ✅ AES-GCM | ✅ SM4-GCM | SM4 密文段 `cipher‖tag` 长度与 AES 一致，认证失败自动 ratchet |
| **会话钥派生（口令 string）** | `createKeyMaterialFromString` | ✅ PBKDF2 | ✅ SM3-hkdf | `setKey('口令')` 时 |
| **会话钥派生（密钥缓冲 ArrayBuffer）** | `createKeyMaterialFromBuffer` | ✅ HKDF-SHA256 | ✅ SM3-hkdf | `setKey(ArrayBuffer)` 时；SM4 模式最终为 16 字节钥 |
| **Key ratchet（自动换钥）** | `ratchet` + `ParticipantKeyHandler` | ✅ `deriveBits`(PBKDF2/HKDF) | ✅ GM/T SM3-KDF 迭代 | 链钥可导出分发（`RatchetResult.chainKey`） |
| **SM2 密钥协商 / 分发 / 验签** | 仅预留调用位 | — | ⏳ 未实现 | 方案第 10 步（可选增强）待做；`sm-crypto-v3` 的 `sm2.doEncrypt/doDecrypt/ecdh/doSignature` 已可用，尚未接入 |

**备注**
- 媒体帧（`FrameCryptor`）与数据消息（`DataCryptor`）的加密核心都运行在 `e2ee.worker` bundle 内；SM4 分支由 `isSm4(cryptography)` + `key instanceof Uint8Array` 判定，AES 分支用 `asCryptoKey` 收窄，运行时不改变官方路径。
- 除上述 e2ee 加密面外，LiveKit 的文本流/字节流/RPC 数据通道不走本加密链路（官方 e2ee 仅覆盖媒体帧 + `EncryptedPacketPayload`）。

---

## 官方 AES-GCM 处理链路 与 SM4 对齐对照

> 我们的 SM4 实现严格保持官方 AES 的**结构与时序**，仅替换底层算法与密钥形态。
> 简单来说：官方 AES =「主线程 PBKDF2/HKDF 派生材料 → worker `deriveKey` 出 AES-GCM CryptoKey → `crypto.subtle` 逐帧/逐消息 AEAD 加密，靠 16B GCM tag 校验触发自动换钥」。

| 环节 | 官方 `aes-gcm`（保留代码） | 国密 `sm4`（本 fork） | 对齐情况 |
| --- | --- | --- | --- |
| 口令派生（`setKey('口令')`） | `createKeyMaterialFromString`: `importKey(口令, PBKDF2)` → 材料 CryptoKey | SM3-hkdf → 16B 主钥字节 | 结构一致，算法不同 |
| 密钥缓冲派生（`setKey(ArrayBuffer)`） | `createKeyMaterialFromBuffer`: `importKey(buf, HKDF)` → 材料 | SM3-hkdf → 16B 主钥字节 | 结构一致，算法不同 |
| 派生最终加密钥（worker） | `deriveKeys`: `crypto.subtle.deriveKey(... {name:'AES-GCM', length:128})` | `deriveSM4Key(... 'sm4-encryption', 16)` | 均先得材料再得加密钥 |
| 自动换钥 ratchet | `ratchet`: `crypto.subtle.deriveBits(material,256)` 迭代 | `ratchetSM4Key`: GM/T SM3-KDF 迭代 | 结构一致 |
| IV | 12 字节 `makeIV(ssrc, timestamp, sendCount)` | 12 字节（复用 `makeIV`） | ✅ 一致 |
| AAD（additionalData / associatedData） | `frameHeader`（未加密前缀） | `associatedData=frameHeader` | ✅ 一致 |
| 认证 tag | 16 字节，内嵌于 ciphertext 尾部 | 16 字节，`cipher‖tag` 分离再拼入帧 | ✅ 长度一致 |
| 帧尾 `trailer[0]=IV_LENGTH, [1]=keyIndex` | `IV_LENGTH=12` | 同为 `12` | ✅ 一致 |
| 媒体帧加解密 | `FrameCryptor` + `crypto.subtle.encrypt/decrypt(AES-GCM)` | `FrameCryptor` + `sm4GcmEncrypt/Decrypt` | 结构一致 |
| 数据消息加解密 | `DataCryptor` + `crypto.subtle(AES-GCM)`（IV 12B） | `DataCryptor` + SM4-GCM（IV 12B） | 结构一致 |
| 认证失败触发自动换钥 | GCM tag 校验失败 → ratchet | SM4-GCM `authentication tag mismatch` → ratchet | ✅ 同逻辑 |
| 加密钥形态 | `CryptoKey` | 16 字节 `Uint8Array` | 仅形态不同 |
| 底层调用 | Web Crypto `crypto.subtle` | `sm-crypto-v3` | 仅实现不同 |

**为什么能做"同一帧结构"**：IV 长度、AAD、tag 长度、帧尾字段都逐一与 AES 对齐，因此对端仍能按官方帧结构解析；差异只收敛在 `smCrypto.ts` 算法注入点。

---

## 1. 背景：当前 AES-GCM 加密链路

e2ee 的核心数据流分两路：

| 通道 | 载体 | 加解密实现 | 文件 |
| --- | --- | --- | --- |
| RTP 媒体帧 | `RTCEncodedVideoFrame/AudioFrame` | `encodedFrame.data` 字节 | `FrameCryptor.ts` |
| 数据信道消息 | LiveKit `EncryptedPacketPayload` | 明文 → RPC 到 worker | `DataCryptor.ts` |

涉及的密码学基元（全部基于 Web Crypto `crypto.subtle`）：

- **密钥派生**：`PBKDF2`（口令）/ `HKDF`（随机种子）→ CryptoKey（`utils.ts`）
- **媒体帧加密**：`AES-GCM`，12 字节 IV + 帧尾 `trailer[0]=IV_LENGTH, trailer[1]=keyIndex`（`FrameCryptor.ts`）
- **数据消息加密**：`AES-GCM`，12 字节 IV（`DataCryptor.ts`）
- **Key ratchet（自动换钥）**：同派生算法 `deriveBits` 迭代（`utils.ts` + `ParticipantKeyHandler.ts`）
- 未加密头部保留（VP8/audio 前缀），让 SFU 仍能识别关键帧/路由

关键类型（`types.ts`）：
```ts
type KeySet = { material: CryptoKey; encryptionKey: CryptoKey };          // L198
type KeyProviderOptions = { ...; keySize: 128|256 };                       // L207
```

---

## 2. `sm-crypto-v3`（v1.0.6）实际 API 核对结论

已阅读其源码，下面是被使用的真实能力（`src/index.ts` 导出）：

```ts
export * as sm2 from "./sm2/index";   // 命名空间
export { SM3 };                        // 分片流式哈希类
export { kdf };                        // GM/T 0003 SM3 KDF（密钥派生函数）
export { hkdf };                       // RFC5869 HKDF，底层为 SM3
export { sm3 };                        // 函数，支持 { key } => HMAC-SM3
export * as sm4 from "./sm4/index";    // encrypt / decrypt
export { hexToArray, bytesToHex };
```

### 2.1 sm4 —— 采用 **GCM 模式**（AEAD，自带认证 tag）
源码 `src/sm4/index.ts` 确认：

- `sm4.encrypt(msg, key, { mode:'gcm', iv, associatedData, output:'array', outputTag:true })`
  → 返回 `{ output: Uint8Array, tag: Uint8Array }`（`:539/421`）。
- `sm4.decrypt(cipher, key, { mode:'gcm', iv, associatedData, tag, output:'array' })` → `Uint8Array`，tag 不匹配抛 `authentication tag mismatch`（`:310`）。
- **IV**：128bit 分组、CTR 流式（GCM 走 CTR+GHASH），**IV 可用 12 字节**（96bit 走 J0 快速路径 `:236`）——与现有 AES-GCM 的 `IV_LENGTH=12` 完全对齐。
- **tag**：固定 **16 字节**（`:222`）——与 AES-GCM 默认 tag 长度一致。
- **associatedData（AAD）**：对应 AES-GCM 的 `additionalData`，可传入未加密帧头。
- 入参 `key/iv/aad` 均支持 `Uint8Array` 或 hex 串；`output:'array'` 返回字节数组。
- key 必须 128bit（16 字节）。

→ **结论：SM4-GCM 是 AES-GCM 的近乎无缝替代。** IV 长度、tag 长度、AAD 语义一致，**无需补齐单独的 HMAC**（GCM 自带认证），格式破坏面极小。

### 2.2 sm3 —— 派生与认证
- `hkdf(ikm, salt, info, length)` → RFC5869 HKDF（SM3 底层），返回 `Uint8Array` → 替代现有 `deriveKeys` 里的 HKDF-SHA256。
- `kdf(input, length)` → GM/T SM3 KDF（国密标准派生）。
- `sm3(msg, { key })` → HMAC-SM3（如需额外场景可复用）。
- `SM3.update()/digest()` → 分片哈希。

### 2.3 sm2 —— 非对称（可选增强：密钥协商/分发/验签）
- `sm2.generateKeyPairHex()` → `{ publicKey, privateKey }`（hex）
- `sm2.doEncrypt(msg, publicKey, cipherMode=1, {asn1})` / `sm2.doDecrypt(data, privateKey, cipherMode, { output:'array' })` → 均支持字节数组
- `sm2.doSignature/doVerifySignature`（纯签名 / +hash / +der）
- `sm2.ecdh(privateKey, otherPublicKey)` → 共享密钥（适用无长期公钥的会话密钥协商）
- `sm2.calculateSharedKey(...)` → 国密标准密钥交换（带身份）

> **性能参考**（README，Apple M2）：sm4 encrypt ~102k ops/s、decrypt ~237k ops/s。SM4 是快速对称密码，逐帧加密 30fps 视频在纯 JS worker 内可行；必要时可再走 wasm 加速（`sm-crypto-wasm` 已存在）。

---

## 3. 国密算法分工（对应替换关系）

| 国密算法 | 职责 | 替换的现有基元 | 说明 |
| --- | --- | --- | --- |
| **SM4-GCM** | RTP 媒体帧 + 数据消息对称加解密（AEAD） | AES-GCM | IV 12B、tag 16B、AAD=帧头，语义对齐 |
| **SM3（via hkdf/kdf）** | 会话密钥派生、ratchet 迭代 | PBKDF2/HKDF-SHA256 | `hkdf` 承载派生 |
| **SM2** | 会话密钥协商/分发、信令验签（可选增强） | 无对应 | `ecdh` / `doEncrypt`，不用于逐帧加密 |

---

## 4. 总体设计：双算法 + Provider 抽象

不改动现有调用方式，抽一层「密码学 Provider」，让 `FrameCryptor` / `DataCryptor` / 密钥派生只面向接口。通过新增配置选算法：

```ts
// KeyProviderOptions 新增（types.ts）
cryptography?: 'aes-gcm' | 'sm4';   // 默认 'aes-gcm'，向后兼容
sm2?: {
  publicKey?: string;   // 本端公钥（可选，用于解密分发的 SM4 会话钥）
  privateKey?: string;  // 本端私钥（可选，用于签名 & 解密）
  cipherMode?: 0 | 1;   // SM2 加密模式
};
```

新增源码目录 `src/e2ee/sm/`，作为 `sm-crypto-v3` 的唯一注入点：

```
src/e2ee/sm/
  smCrypto.ts        // 薄封装：sm4-gcm 加解密、hkdf 派生、sm2 加解密/ECDH，统一 hex/Uint8Array
  index.ts
  smCrypto.test.ts   // 单测
```

`FrameCryptor` / `DataCryptor` 内部仅按 `this.keyProviderOptions.cryptography === 'sm4'` 走国密分支；AES 分支原样保留。

---

## 5. 分文件修改明细

> 行号对应当前源码；SM 分支均依赖 `smCrypto.ts` 封装。

### 5.1 `src/e2ee/constants.ts`
- 新增：`ENC_ALGORITHM_SM4 = 'SM4-GCM'`、`SM4_IV_LENGTH = 12`（沿用）、`SM4_TAG_LENGTH = 16`、SM2/SM3 相关常量。
- `UNENCRYPTED_BYTES`（未加密头部）保留，逻辑不变。

### 5.2 `src/e2ee/types.ts`
- `KeySet`（L198）改为可容纳字节型密钥：
  ```ts
  type SM4Key = Uint8Array;                      // 16 字节 SM4 密钥
  type EncryptionKey = CryptoKey | Uint8Array;
  type KeySet = { material: EncryptionKey; encryptionKey: EncryptionKey };
  ```
- `KeyProviderOptions`（L207）：新增 `cryptography`、`sm2`（见 §4）。
- `KeyInfo`（L221）、`SetKeyMessage.key`（L27）放宽为 `CryptoKey | Uint8Array`。
- `RatchetResult.chainKey`（L200）：SM 模式为 16 字节派生链钥（`ArrayBuffer`，可导出分发）。
- `Level message types`：`InitMessage.data` 透传 `cryptography/sm2`。

> ⚠️ `SetKeyMessage`/`InitMessage` 经 `postMessage` 结构化克隆，`Uint8Array` 兼容，无需 transferable 处理。

### 5.3 `src/e2ee/utils.ts` —— 派生/导入层
- `createKeyMaterialFromString`（L45）/ `createKeyMaterialFromBuffer`（L61）：SM 分支改用 `hkdf`(SM3) 从口令/种子派生 **16 字节** SM4 材料，替代 PBKDF2/HKDF。
- `deriveKeys`（L98）：SM 分支 `hkdf(material, ratchetSalt, info, 16)` 派生加密钥，返回 `{ material, encryptionKey }`（均 16 字节）。
- `ratchet`（L125）：SM 分支用 `kdf`（GM/T SM3 KDF）迭代前进链钥，产出下一阶段 16 字节。
- `importKey`（L30）：SM 分支直接采用密钥字节，不经 `crypto.subtle.importKey`。

### 5.4 `src/e2ee/sm/smCrypto.ts` ——（新增核心）
为 FrameCryptor / DataCryptor / utils 提供统一调用，例如：
```ts
// 帧加解密（IV 12B；AAD = 未加密帧头）
sm4FrameEncrypt(plain, sm4Key, iv, aad) → { cipher: Uint8Array, tag: Uint8Array }
sm4FrameDecrypt(cipher, tag, sm4Key, iv, aad) → plain // tag 校验失败抛错

// 数据消息加解密（可用同 GCM，IV 12B）
sm4Encrypt / sm4Decrypt

// 派生（转调 sm-crypto-v3 hkdf）
deriveSM4Key / ratchetSM4

// SM2（可选）
sm2Encrypt / sm2Decrypt / ecdhSharedKey
```

### 5.5 `src/e2ee/KeyProvider.ts`
- `setKey(key: string | ArrayBuffer)`（L109）：SM 模式沿用入口，派生走 §5.3 国密版本；也允许直接传 16 字节 SM4 会话钥。
- 可选：`setSM2Keypair(publicKey, privateKey)`。

### 5.6 `src/e2ee/worker/ParticipantKeyHandler.ts`
- 调用点 `deriveKeys`（L176）/`ratchet`（L130）/`importKey`（L131）自动随 Provider 走国密版本，**结构性改动很小**。
- `ratchetKey`（L114）返回的 `chainKey` 在 SM 模式即 16 字节可导出发行钥。

### 5.7 `src/e2ee/worker/FrameCryptor.ts` —— 媒体帧加解密核心（改动最大）
- `encodeFunction`（L506）SM4-GCM 分支：
  - 保留现有 `makeIV` 的 **12 字节** IV（`IV_LENGTH` 不变）。
  - `frameHeader` = 未加密前缀（作 GCM 的 `associatedData`）。
  - `const { cipher, tag } = sm4FrameEncrypt(payload, sm4Key, iv, frameHeader)`。
  - 组装加密段 = **`cipher`(明文长) ‖ `tag`(16B) ‖ `iv`(12B) ‖ trailer(2B)**，总长度与 AES-GCM 一致（AES 的 ciphertext 本身含 16B tag）。
  - 帧尾 `frameTrailer[0]=IV_LENGTH`、`[1]=keyIndex` **不变**。
- `decodeFunction`（L626）/`decryptFrame`（L740）SM 分支：
  - 从密文段尾部拆出 16B `tag`，明文段 = `sm4FrameDecrypt(cipher, tag, sm4Key, iv, frameHeader)`。
  - **tag 校验失败（`authentication tag mismatch`）→ 抛 `CryptorError(InvalidKey)` 进入自动 ratchet**，行为与 AES 一致。
  - 注意与 NALU RBSP 处理（`parseRbsp`/`writeRbsp`）的顺序保持。
- 关键差异点已在 §5.7 说明：AES 的 `crypto.subtle.encrypt` 把 tag 合并进 `cipherText`；SM4-GCM 返回 `{cipher, tag}` 分离，仅组装/拆包逻辑需适配，长度不变。

### 5.8 `src/e2ee/worker/DataCryptor.ts` —— 数据消息加解密
- `encrypt`（L24）/`decrypt`（L54）：AES-GCM → SM4-GCM（IV 12B，AAD 空），返回/接收 `{cipher, tag}`。
- `makeIV`（L12）：保持 12 字节即可（GCM 兼容）。
- 解密 tag 不匹配抛错，交由外层 ratchet（现有 `crypto.subtle.decrypt` 的 catch 逻辑保留）。

### 5.9 `src/e2ee/worker/e2ee.worker.ts`
- `init`（L46）读取 `cryptography/sm2` 存入 `keyProviderOptions`；共享密钥路径（`setSharedKey`）不变。

### 5.10 `src/e2ee/E2eeManager.ts`
- `setup`（L109）init 消息透传 `cryptography/sm2`。
- `postKey`（L418）在 SM2 分发场景下（可选）支持：收到密文会话钥 → `sm2Decrypt` 解出 SM4 钥再 `setKey`。

### 5.11 打包与入口
- `rollup.config.worker.js`：确认 `sm-crypto-v3` 及其依赖（`@noble/ciphers`、`@noble/curves`、`@noble/hashes`）被打进 worker bundle（经 `@rollup/plugin-node-resolve` + `commonjs`）。worker 为独立 bundle，主线程无需加载。
- `package.json`：`dependencies` 新增 `sm-crypto-v3`（~1.0.6）。⚠️ 它依赖 noble 系列；需确认企业源/内网 registry 可拉取。
- `.size-limit.cjs`：新依赖体积计入预算，避免 CI `size-check` 失败。
- `src/index.ts`：如需对外暴露 `sm` 封装或新增配置类型则补充 export。

---

## 6. 密钥生命周期（含 SM2，可选增强）

### 6.1 最小方案（核心，必做）
沿用 LiveKit「各端独立配置」模型：
- 各端 `keyProvider.setKey(共享口令)` → SM3(`hkdf`) 派生相同 SM4 会话钥；或 `setKey(16 字节 SM4 钥)` 直接下发。
- 媒体帧/数据消息用该 SM4-GCM 钥加解密；ratchet 用 SM3 迭代换钥。
- 全程 SM4 + SM3，无 SM2 → 可仅依赖 sm4/sm3，最小可用。

### 6.2 SM2 密钥协商/分发增强（可选）
- **协商**：A/B 用 `sm2.ecdh` 计算共享密钥 → `hkdf` 派生统一 SM4 会话钥。
- **分发**：密钥服务器持各端 SM2 公钥 → `sm2.doEncrypt` 将同一 SM4 会话钥加密分发；接收端本地 SM2 私钥 `sm2.doDecrypt` 解出后 `setKey`。
- **验签**：对分发信令用 `doSignature/doVerifySignature` 防篡改。
- 该协议归属上层会议 App / 后端定义；SDK 仅暴露对应原语。

---

## 7. 测试方案

- **算法一致性单测**（新增 `src/e2ee/sm/smCrypto.test.ts` 及派生/ratchet 测试）：
  - SM4-GCM 加解密往返 round-trip。
  - 篡改密文/IV/AAD/tag → 抛 `authentication tag mismatch` → 上层转 `InvalidKey` ratchet。
  - `hkdf`/`kdf` 派生确定性与 ratchet 链条单调推进。
- **既有测试回归**：`FrameCryptor.test.ts`、`DataCryptor.test.ts`、`ParticipantKeyHandler.test.ts` 默认 `cryptography:'aes-gcm'` 保持全绿，验证双算法隔离无回归。
- **双算法互操作**：同一数据分别走 AES 与 SM4 分支断言均正确。
- **格式取证**：SM4 路径断言密文长度 = 明文 + 16(tag)、帧尾 `trailer[0]=IV_LENGTH`、IV 12B。

---

## 8. 待确认项与风险（实施前落实）

1. **包依赖可拉取性**：`sm-crypto-v3@1.0.6` 依赖 `@noble/ciphers/curves/hashes`。若走内网 npm 源，须确认这几个 noble 包可解析（或在锁定的私有源里补）。
2. **GCM 选型确认**：已从源码确认 `mode:'gcm'` 可用且 tag 16B、IV 12B 对齐；实施时以 `smCrypto.test.ts` 锁定行为（含与后端对端联调的同构性）。
3. **认证一致性**：GCM 自带认证；解密失败（tag mismatch）统一映射为 `CryptorError(InvalidKey)` 以维持 ratchet 流程。
4. **传输格式兼容**：SM4-GCM 下密文段长度 = 明文 + 16，与 AES-GCM 的 ciphertext（含 tag）长度一致，SFU/对端无需感知差异；未加密帧头保持。
5. **性能**：SM4 纯 JS 够用（~100k+ ops/s）；若 4K/大帧吃紧，接口抽象可直接切换到 `sm-crypto-wasm`。
6. **size-limit / worker 体积**：核对 `.size-limit.cjs`，避免 CI 失败。
7. **TypeScript Web Worker 类型**：SM 密钥为 `Uint8Array`，经 `postMessage` 结构化克隆；核对 `NonSharedUint8Array` 断言。

---

## 9. 建议实施顺序

1. 在 `livekit-client-sdk-js-sm-crypto` 本地 `pnpm add sm-crypto-v3`，确认依赖解析成功。 ⚠️ 依赖此步判定 noble 包可拉取
2. 新增 `src/e2ee/sm/smCrypto.ts` 封装 + `smCrypto.test.ts`（round-trip、篡改抛错、IV/tag/派生断言）先行通过。
3. 改 `types.ts`/`constants.ts`（纯类型+常量增量，不动运行逻辑）。
4. 改 `utils.ts` 派/ratchet 国密分支 + 单测通过。
5. 改 `KeyProvider.ts`、`ParticipantKeyHandler.ts`（结构性小改动）。
6. 改 `DataCryptor.ts`（先覆盖数据消息，较易）。
7. 改 `FrameCryptor.ts` encode/decode（最复杂：GCM 组装/拆包、AAD、ratchet 联通）。
8. 打通 `E2eeManager`/`e2ee.worker.ts` 配置透传；核对 rollup 打包与 size-limit。
9. 全量单测回归（AES 路径保持绿）+ 新增 SM4 用例全绿。
10. 可选：SM2 协商/分发增强接入；与会议后端联调。

---

## 附：改动文件与改动量速览

| 文件 | 改动性质 | 复杂度 |
| --- | --- | --- |
| `src/e2ee/sm/smCrypto.ts`（新增）| sm-crypto-v3 唯一注入点 | 中 |
| `src/e2ee/sm/smCrypto.test.ts`（新增）| 单测 | 中 |
| `src/e2ee/constants.ts` | 加常量 | 低 |
| `src/e2ee/types.ts` | 类型放宽/新增 | 中 |
| `src/e2ee/utils.ts` | 派生/ratchet 国密分支 | 中 |
| `src/e2ee/KeyProvider.ts` | setKey 国密 + SM2 可选 | 低-中 |
| `src/e2ee/worker/ParticipantKeyHandler.ts` | 调用点跟随 | 低 |
| `src/e2ee/worker/DataCryptor.ts` | AES→SM4-GCM | 中 |
| `src/e2ee/worker/FrameCryptor.ts` | AES→SM4-GCM（组装/拆包） | 高 |
| `src/e2ee/worker/e2ee.worker.ts` | 配置透传 | 低 |
| `src/e2ee/E2eeManager.ts` | 配置透传 / SM2 可选 | 低-中 |
| `package.json` / `rollup.config.worker.js` / `.size-limit.cjs` | 依赖与打包 | 低 |

---

## 10. 前端接入与快速验证（本会话实测）

> 目的：在不改业务的前提下尽快证明「fork 的 SM4 在真实浏览器 worker 里加解密正常」。

### 10.1 让前端用到 fork
前端是 pnpm；在 `frontend/pnpm-workspace.yaml` 加（注意：pnpm 12 不再读 package.json 的 `"pnpm"` 字段，必须放 workspace yaml）：
```yaml
overrides:
  livekit-client: file:/绝对路径/sm4/livekit-client-sdk-js-sm-crypto
```
`pnpm install` 后，`require.resolve('livekit-client')` 应指向 `...livekit-client@file+..+sm4...`。

### 10.2 注入 SM4（`useMeetingCore.ts`，`new Room` 前 + `connect` 后）
- **默认关闭**，避免破坏非国密连接；URL `?sm4=1` 或 `VITE_SM4_E2EE=1` 才开。
- 开启时：`new ExternalE2EEKeyProvider({ cryptography: 'sm4' })` + `setKey(共享口令)` + 注入 worker。
- **worker 写法务必用 vite 资产语法**（直引 `dist/...` 裸路径会报 `not exported under the conditions`）：
  ```ts
  import e2eeWorkerUrl from 'livekit-client/e2ee-worker?url'   // 需 src/vite-env.d.ts 提供 *?url 声明
  worker: new Worker(e2eeWorkerUrl, { type: 'module' })
  ```
- `connect()` 成功后需 `await newRoom.setE2EEEnabled(true)` **强启本地加密**，否则 `isEnabled()` 为 false、媒体帧仍明文直出（不打 SM4）。

### 10.3 验证判据（双 tab 同会议室、都带 `?sm4=1`、同口令）
1. 控制台出现 `[SM4-E2EE] enabled` / `e2ee enabled for local participant`（证明开关与强启生效）；
2. 期间在 `sm4GcmEncrypt` 打 `[LK-SM4]` 标记（确认走 SM4 而非回退 AES）——验证后已从源码与 dist 移除；
3. 对端能听到/看到/收到消息，且无 `EncryptionError` / `authentication tag mismatch`（证明 16B tag 认证 + 双端密钥一致 + 解密正确）。

**实测结果**：双 tab 互通通过；发送侧持续产生 `{plainBytes, ivBytes:12, keyBytes:16}` 的 SM4 加密日志，对端可听、无报错。验证完成后已移除打点、重建 dist、经 `pnpm install` 同步前端。

---

## 11. SM2 第 10 步（可选增强）语义与边界

SM2 不参与逐帧/逐消息加密（那仍是 SM4 的活），只负责让多方**安全地拿到同一把可信的 SM4 会话钥**：协商、分发、验签。

| 手段 | 场景 | 做法 | `sm-crypto-v3` 原语 |
| --- | --- | --- | --- |
| **协商（Key Exchange）** | 两点 / P2P | 各持 SM2 密钥对，`ECDH` 算出共享密值 → SM3-hkdf → SM4 会话钥 | `sm2.ecdh` / `sm2.calculateSharedKey`（国标、带身份+临时钥，前向安全） |
| **分发（Envelope）** | 1 对 N / 中心化 | 服务器持各端公钥，用各自公钥 `sm2.doEncrypt` 加密同一 SM4 会钥分发给各自，本端私钥解密 | `sm2.doEncrypt/doDecrypt` |
| **验签（Signature）** | 信任建立 | 对信令/身份做签名，接收方用公钥验签，防中间人/防改 | `sm2.doSignature/doVerifySignature`（纯签名 / +SM3 杂凑 / +DER） |

**是否必须改 fork**：
- 验签、SM2 密钥对（生成/公私钥交换/分发消息格式）属**上层会议 App / 后端协议**，可在应用层用 `sm-crypto-v3` 完成，**不必改 fork**。
- 真正需要 fork 配合的只有最后一步「把 SM2 得出的 SM4 会钥 `S` 注入 e2ee」——而现有 `setKey(S)`（字节）已能接收。
- **推荐的最小改动**：`smCrypto.ts` 补 `SM2 生成密钥对/加解密/ECDH/签名验签` 薄封装（复用已打通依赖与打包，配套单测），使上层从单一入口取原语。

**安全注意**：
- 协商建议用国标 `calculateSharedKey` 而非裸 `ecdh`（裸 ECDH 对中间人无抵抗力）；必须对信令验签。
- 中心化分发**无前向安全**（服务端私钥/历史会钥泄露则历史媒体可解）→ 应配合 ratchet 定期换钥。
- 分发消息的封装格式、`userId` 绑定、密钥中心角色由你们的协议定，SDK 只提供原语。

---

## 12. 密钥派生参数与一致性（salt / info）

当前实现的两层 SM3-hkdf 均用**公开、硬编码**的 salt/info（不做保密，只做域分离）：

| 层 | 位置 | `salt` | `info` | 产出 |
| --- | --- | --- | --- | --- |
| 第 1 层 | 应用端 `createKeyMaterialFromString/Buffer` | `'LKFrameEncryptionKey'`（=`SALT` 常量） | `'sm4-master'` | 传入的 `S`/口令 → 主钥材料 `K` |
| 第 2 层 | worker `deriveKeys` | `options.ratchetSalt`（默认同 `SALT`） | `'sm4-encryption'` | `K` → 最终加密钥 |

- **默认两端一致**：salt 均默认 `'LKFrameEncryptionKey'`，info 分工不同（域分离）。
- **⚠️ 潜在不一致来源**：第 2 层 salt 读 `keyProviderOptions.ratchetSalt`，它是**可配置**的。若两端被配成不同 `ratchetSalt`（或未来按会议差异化），最终加密钥就不一致 → 表现正是 `authentication tag mismatch`。上线配置化时须保证全端同一 salt/info。
- 与外部系统（非本 SDK）对齐搜索：salt/info/KDF 参数必须**逐字节一致**，否则两边密钥对不上。

---

## 13. 二次派生 vs 直接注入（密钥语义）

应用把 SM2 分发的随机会钥 `S` 交给 `setKey(S)` 后，现状会再走**两层 SM3-hkdf** 才得到最终加密钥。是否"再派生一次"由你们协议的语义决定：

| | 二次派生（现状） | 直接注入（可选新增 `setSM4SharedKey(16B)`） |
| --- | --- | --- |
| `S` 的角色 | 主钥材料/种子 | 即最终加密钥 |
| 与外部"原样用 S"对齐 | 不可（会再变换） | 可以 |
| 密钥解耦/域分离 | ✅（加密钥 ≠ S，多一道防线） | ✗（信任全押在 S 传输保密） |
| 高熵随机会钥的熵增益 | 无（不增加熵量，只为防守） | — |
| 适用 | 两端同 SDK 同流程；多数场景 | 明确要求 S≡加密钥（外部直接对账） |

- **口令（低熵）必须派生**（抗字典攻击），绝不能直接注入。
- SM2 分发的**随机会钥（高熵）**：默认建议也用现状二次派生；仅当「与不经本 SDK 的外部方原样共用 S」时才需要直接注入入口。

---

## 14. 安全与性能考量（选国密需知）

### 14.1 安全性
- **认证强度**：SM4-GCM 与 AES-GCM 同为 AEAD、16B tag、认证强度相当。**国密不是"更强"，是合规**（满足国家商用密码要求）。
- **IV 重用红线**：同 key 复用 IV（同 AES-GCM）是灾难性泄露。当前 `makeIV`（ssrc+timestamp+计数）覆盖大多数情况，但长会话要靠 ratchet 换钥防复用。
- **密钥解耦**（见 §13）：二次派生让"传输的 S"与"实际加密钥"分离，泄露面更小。
- **前向安全**：短钥协商（ECDH+短会话钥）有前向安全；长期固定会钥没有，需 ratchet 轮换。中心化分发无前向安全。

### 14.2 性能（主要代价在媒体帧）
- **AES-GCM 走浏览器原生/硬件（AES-NI）**；**SM4-GCM 为纯 JS**（`sm-crypto-v3`，M2 ~102k ops/s 加密）。视频逐帧加密时 SM4 是 worker 热点，可能影响帧率/CPU。
- 音频（小帧）无压力；派生/换钥（低频）几乎可忽略。
- 缓解：算法注入点收敛在 `smCrypto.ts` 单一文件，必要时切 wasm（`sm-crypto-wasm`）；留意 `toBytes`/`cipher‖tag` 的少量拷贝。

### 14.3 其它
- 互操作是硬约束：KDF 参数、帧格式（IV/AAD/tag/帧尾）须与对端逐字节一致（本 fork 已对齐官方结构，见「AES 对照」）。
- `SALT='LKFrameEncryptionKey'` 是公开常量，不做保密，安全靠高熵密钥/口令本身。

---

## 15. 架构边界：Egress / Ingress（服务器侧媒体处理）

> **重要**：本 fork 只实现了**客户端↔客户端**的 e2ee（媒体帧在浏览器收发端用 Insertable Streams 加解密）。LiveKit 的 **Egress**（录制/转推）与 **Ingress**（推流接入）是**服务器侧媒体处理**（livekit server / egress service，Go），与 JS SDK **不共用代码、不随前端改动自动生效**。

### 15.1 e2ee 的服务器可见性
- e2ee 加密发生在浏览器端；RTP 头（SSRC/序号/时间戳/payload type）仍明文供 SFU 路由，但**媒体内容对服务器是密文**。
- 因此：**只要会议加密，又需要录制/转推/推流，egress/ingress 就必须配套处理**，否则录制结果为乱码、推入无人可解。

### 15.2 官方 AES 下的配合（livekit 现成能力）
- **Egress**：官方 egress 支持对 e2ee 房间用**服务端侧同一把密钥解密**后再录制（egress 配置带房间加密钥）。故官方 AES 场景 egress 可用。
- **Ingress**：服务器把 ingress 进来的 track 标记 `encryption=NONE`，e2ee 接收端据此**跳过该轨道解密**（本 fork 保留官方 `trackInfo.encryption !== NONE` 判定，天然兼容）。即 ingress 明文流可被接收端直接观看，但**不进入端到端保密域**。

### 15.3 国密 SM4 下的失效与新工作项
本 fork 的 SM4-e2ee 是**自研、非官方协议**：livekit 服务器（Go）与官方 egress/ingress **不认识 SM4-GCM 帧结构、也无 SM3 派生能力**。因此：
- **Egress 录制/转推**：必须**服务端（Go）另实现** SM3 派生同一会钥 + SM4-GCM 解密，否则录出来是密文乱码。这是**新的 server 侧工作**，不在本仓库。
- **Ingress 推流**：明文流靠 `encryption=NONE` 仍可被 e2ee 接收端观看（兼容）；若要求"推流也进加密域"，需服务端做国密加密（重）。
- 无论哪种，都要先解决**把与客户端一致的 SM4 会钥安全交给 egress/ingress 进程**的密钥分发问题。

### 15.4 决策建议
| 会议能力 | 是否需服务端改造 | 说明 |
| --- | --- | --- |
| 仅客户端间音视频、无录制/转推/推流 | 否 | 现有客户端 e2ee 已够，egress/ingress 记为限制即可 |
| 需要录制 / RTMP 转推 | **是（Go 侧国密解密）** | 服务端实现 SM3+SM4 解密，并安全获得同一会钥 |
| 需要推流接入进加密会议 | 视语义 | 接受「ingress 明文流不进加密域」（现状兼容）；若要进加密域则需 Go 侧加密 |

---

## 16. 架构边界：LiveKit Agent（Python，如仓库 `agent/agent-sherpa-onnx-sensevoice`）

`agent-sherpa-onnx-sensevoice` 是 **livekit-agents(Python)** 的语音转写机器人：`livekit-agents>=1.8.0` + `from livekit.rtc import AudioStream` 订阅会议音频 → sherpa-ONNX(SenseVoice) STT。

### 16.1 为什么 agent 同样是加密消费端
- agent 与 egress/ingress 一样，是**服务器侧媒体接收端**；SM4 加密会议下它拿到的音频轨道是密文。
- 尤其本仓库用 `rtc.AudioStream` 订阅：它给应用层的是**解码后的 PCM**（`AudioFrame`）。而 SM4 密文不是合法 Opus，livekit-python 内部解码即失败 → **转写直接失效**。

### 16.2 与 egress/ingress 一致
- 落点同理**不在本 JS fork**，而是 Python 侧（livekit-agents / livekit-python），且因自研 SM4、官方 python-e2ee 不适用，需自研 SM3+SM4。

### 16.3 查证结论：livekit-python 的 e2ee 是 native 封闭实现，无法注入自研 SM4
（在 `.venv/lib/python3.14/site-packages/livekit`，版本 1.1.17）
- **算法封闭**：协议枚举只有
  - `KeyDerivationFunction = ['PBKDF2','HKDF']`（无 SM3）
  - `EncryptionType = ['NONE','GCM','CUSTOM']`（GCM=AES-GCM）
  `KeyProviderOptions` 仅暴露 `shared_key` + `key_derivation_function` + `encryption_type`；派生与解密全在 **native(C/rust) 层**按官方协议完成。
- **拿不到密文帧**：`AudioStream` 给应用的是**解密后的明文 PCM**；`audio_stream.py/frame_processor.py/track.py` 均未暴露"加密前的原始帧"或解码前钩子。
- **`CUSTOM` 枚举虽存在，但 Python 绑定未开放应用级自定义加解密入口**；要用它接 SM4 须改 native 绑定再补 Python 回调，成本高。

**结论**：Agent 接**自研 SM4**不能依赖这套 SDK 现有的 e2ee——
| 做法 | 结果 |
| --- | --- |
| 不设 key 订阅 | 拿到 SM4 密文，native 当 Opus 解码失败 → 转写失效 |
| 设 key 订阅 | 按官方 AES+PBKDF2 派生，与 SM3/SM4 密钥对不上 |
| 用 `CUSTOM` | 枚举在、绑定未开放 → 需改 native，成本高 |

**"像 JS fork 一样在 livekit-python 加 SM"的可行性分级**（关键澄清：加密逻辑在 native，不在 Python 绑定）：
- **只改 Python 绑定层（`e2ee.py` 里加 SM）** → ❌ 不可行：加密在 native，Python 拿不到帧，加了也没东西可解。
- **改 native 加密实现（Rust/WebRTC 把 AES-GCM 换成 SM3 派生 + SM4-GCM）** → ✅ **可行**：才是"在 python 侧加 SM"的正确形态；Python 应用接口（`E2EEManager`/`KeyProvider.set_shared_key`/`AudioStream`）基本不动，对应 JS fork 的「provider 抽象 + cryptography 开关 + smCrypto 注入层」。两个硬前提：① native 帧加密需可替换（`EncryptionType.CUSTOM` 枚举存在，但当前 **lk-room 未开放到绑定**，需在 native 打通并暴露）；② 协议参数（SM3 salt/info、SM4-GCM IV/AAD/tag、帧尾）必须与 JS 端**逐字节一致**（见「AES 对照」表）。
- **纯 Python `gmssl` 在 agent 内解** → ❌ 不可行：native 不透传密文，`gmssl` 拿不到 ciphertext。

代价评估：按要求需维护一份 **Rust/WebRTC native fork**，跟进 livekit-python 升级成本显著；自研国密同样导致官方 egress/ingress 不识别。若 `CUSTOM` 可被 lk-room 暴露为自定义 frame cryptor，改造面比全换 native 算法小，值得作为 native 改造的前置探查点。

### 16.4 改造要点（务实建议）
1. **推荐：明文镜像/可信域**。Agent（及 egress/ingress）这类受信任服务器侧消费端，最省是让它们拿明文副本：
   - 发布端额外向服务器推一份**明文镜像音轨**；或服务器把给 agent/录制用的轨道标为非加密（可信域内）。agent 照常用 `AudioStream` 订阅明文 → 转写正常。参会者间仍是 SM4 端到端保密，明文只在服务器可信域流转。
2. **备选：改 native**。在 livekit-python native（lk-room）加 SM4 解密并暴露明文帧 — 重，不推荐首期。
3. **密钥约定**：若走明文镜像，需约定哪些轨道为"加密"/"明文"副本与命名规则；SM4 会钥仍只用于参会者端（衔接 §11/§15）。

### 16.5 汇总：加密会议会波及的全部"服务器侧消费端"
| 消费端 | 需要的改造 | 落点语言/仓库 |
| --- | --- | --- |
| Egress 录制/转推 | SM3+SM4 解密（或明文镜像/可信域） | Go / livekit server |
| Ingress 推流（如需进加密域） | SM3+SM4 加密 | Go / livekit server |
| **Agent（STT/ASR 等）** | **SM3+SM4 解密**（native 封闭，见 16.3）；**务实做法：明文镜像/可信域** | **Python / livekit-python** |
> 以上均**不随本 fork JS SDK 生效**，需各自独立改造：或实现国密解密，或走"明文镜像/可信域"让受信任服务端消费端拿明文副本（推荐）。统一密钥分发衔接 §11/§15。

---

## 17. 官方源码核对：livekit native（Rust/WebRTC）加 SM4 的落点与工作量

> 来源：本地检出的官方 Rust SDK（`/Users/liujunlin/Workspace/livekit/rust-sdks`，tag `imgproc/v0.3.20-16-g90a9e45b`）逐文件核对。用于确认"在 livekit-python 侧像 JS 一样加 SM4"的真实改动层级。

### 17.1 仓库/包溯源
- `liblivekit_ffi`（Python 通过 `ctypes.CDLL` 加载的 native）由本仓库 **`livekit-ffi` crate** 编译产出；Python 侧可经 `LIVEKIT_LIB_PATH` 指向自编译版本（替换入口存在）。
- Python 绑定源码：`github.com/livekit/python-sdks`（`livekit==1.1.17` 的 METADATA 确认）。
- 真实加解密不在 Python、也不完全在 Rust 绑定，而在最底层 WebRTC C++。

### 17.2 层级与当前实况（源码实据）
```
livekit-python ──(ctypes)──▶ liblivekit_ffi = livekit-ffi (Rust)
                                    └─ livekit crate:
                                       key_provider.rs / manager.rs
                                             └─ libwebrtc/src/native/frame_cryptor.rs   ← Rust 封装层（只透传枚举）
                                                   └─ webrtc-sys/src/frame_cryptor.cpp  ← 真正加解密（C++/WebRTC）
```

| 位置 | 文件（行） | 现况 |
| --- | --- | --- |
| Rust 算法枚举 | `libwebrtc/src/native/frame_cryptor.rs:54` | `enum EncryptionAlgorithm { AesGcm, AesCbc }`（官方实际只用 `AesGcm`） |
| Rust 派生枚举 | `同一文件:30` | `enum KeyDerivationAlgorithm { PBKDF2, HKDF }` |
| 透传 | `FrameCryptor::new_for_rtp_sender/receiver` | 把 `algorithm.into()` → `webrtc_sys::ffi::Algorithm` |
| WebRTC 算法枚举 | `webrtc-sys/src/frame_cryptor.rs:41` | `enum Algorithm { AesGcm=0, AesCbc }` |
| **真正加解密** | **`webrtc-sys/src/frame_cryptor.cpp`** | C++ 实现（WebRTC FrameCryptor / 帧级加密），Python/Rust 均拿不到明文帧 |
| 状态/加密协议枚举 | `livekit-common/src/lib.rs:88` | `EncryptionType { None, Gcm, Custom }`——`Custom` 在协议层占位，但实现侧仍未接通 |

**关键结论**：
- `EncryptionType::Custom` 仅在协议/枚举层存在，`EncryptionAlgorithm` / WebRTC `Algorithm` / `KeyDerivationAlgorithm` 均**尚无 SM 变体**；Rust 只是把算法枚举透传给 C++，Rust 与 Python 都不在加解密帧路径上（拿不到密文、进不了加密器）。
- 这与 JS fork 的"纯 JS 改算法"本质不同：JS 的帧直接暴露给 worker，可用 `sm-crypto-v3` 替换；native 这边加密在地下层，无法在应用/绑定层替换。

### 17.3 加 SM4 的最小改动点（对照清单）
| 层 | 必改 | 说明 |
| --- | --- | --- |
| `libwebrtc/.../frame_cryptor.rs` | `EncryptionAlgorithm` + `KeyDerivationAlgorithm` 各加 SM 变体 | 如 `Sm4Gcm` / `Sm3` |
| `libwebrtc` 透传 `Into` 映射 | 新变体 → `webrtc_sys::ffi::Algorithm` | 补 match 分支 |
| `webrtc-sys/src/frame_cryptor.rs` | `Algorithm` 枚举加 `Sm4` 变体，`bindgen` 对齐 `frame_cryptor.h` | 同步 FFI 声明 |
| **`webrtc-sys/src/frame_cryptor.cpp`（核心）** | 实现 SM4-GCM 加解密分支 + 引入 SM 加密库（Rust 侧可用 `gmssl`/纯 Rust SM4 crate，C++ 侧需 SM 库） | 真正的工作量主体 |
| 密钥/参数 | 与 JS 端（`smCrypto.ts`）对齐 SM3 salt/info、SM4-GCM IV(12)/AAD/tag(16)、帧尾 | 逐字节一致才互通 |
| Python 绑定 | 一般不必改（应用接口不变）；若要透传自定义则另行评估 | 可选 |

**结论**：可行，但改动必须下钻到 `webrtc-sys` 的 WebRTC C++ FrameCryptor 并维护一份 native fork，跟进升级成本显著，高于 JS fork。若非 "Agent/录制必须拿到密文自解"的硬性合规要求，优先走 §16.4「明文镜像/可信域」。

---

## 18. Egress 录制在 SM4 会议下的改造评估（Go + GStreamer）

> 来源：官方 egress 仓库（`/Users/liujunlin/Workspace/livekit/egress`，tag `v1.14.1-21-g6ddee1d`）逐文件核对。与 §15（egress 边界）呼应，这里落到具体代码改造点。

### 18.1 架构（源码实据）
- 语言 `Go`；拉流用 `server-sdk-go/v2`：`pkg/pipeline/source/sdk.go` `ConnectToRoomWithToken` + `RoomCallback{OnTrackSubscribed: s.onTrackSubscribed,...}`。
- 数据进入 GStreamer：`pkg/pipeline/source/sdk/appwriter.go` 的 `AppWriter`，持 **`*webrtc.TrackRemote`（pion/rtp）** 读取 RTP 包，经 jitter/synchronizer 后把 RTP 推给 `appsrc`。
- GStreamer 链（`pkg/pipeline/builder/audio.go` / `video.go`）：`appsrc(application/x-rtp, ...OPUS) → rtpopusdepay → opusdec → PCM`；视频 `vp8depay→vp8dec` 等。
- **egress 源码无任何 e2ee/encryption 处理**（grep 无命中）——它不自己解密。

### 18.2 与 Python agent 的关键差异
- Agent（Python `AudioStream`）给的是**解码后 PCM**，拿不到密文；
- Egress（Go `TrackRemote` / AppWriter）读到的是 **RTP 层的密文帧（原始字节）**——**在解密路径上可下手**，比改 native 更可行。

### 18.3 SM4 会议下的失效点 & 改造落点
加密帧进入 GStreamer 后，`rtpopusdepay`/`opusdec`（视频 `vp8depay`/`vp8dec`）会对密文解码失败。两个可选插入点：
- **方案 A（推荐，最小侵入）**：`AppWriter` 把 RTP 推进 `appsrc` **之前**，在 Go 侧做 SM4 帧解密：
  ```
  TrackRemote(RTP 密文)
     → 拆帧：未加密头 ‖ cipher ‖ tag(16) ‖ iv(12) ‖ trailer —— 与 JS 帧格式完全一致
     → SM3 派生同钥 + SM4-GCM 解密 → 还原明文 Opus/VP8 编码帧
     → 按原 RTP 头推给 appsrc → rtpopusdepay/opusdec 正常解码 → 录制
  ```
  pipeline 其余（depay/dec/编码）**零改动**；需纯 Go SM3/SM4 库（`gmssl` / `tjfoc/gmsm` 等）。
- **方案 B**：在 `appsrc` 与 `rtpopusdepay` 之间插 GStreamer 自定义 SM4 解密元素（C/Go gst-plugin），更通用但成本高。

### 18.4 硬要求（与 JS 端一致）
- SM3 派生两层 salt/info：`LKFrameEncryptionKey`+`sm4-master` → 再 `ratchetSalt`+`sm4-encryption`（见 §12）。
- SM4-GCM 帧格式：IV=12B、tag=16B、AAD=未加密帧头、帧尾 `trailer[0]=IV_LENGTH,[1]=keyIndex`。
- 密钥：egress 进程需拿到与客户端同一 SM4 会钥（走 §11 SM2 分发，或可信域来源）。

### 18.5 结论排序
1. **明文镜像/可信域（最省，推荐）**：发布端另推明文副本轨，egress 照常录明文；egress 零改动。
2. **方案 A（AppWriter 前置 SM4 解密）**：可行、比改 native 轻；仅在"必须加密录制"时首选。
> 与 §15.3 一致：自研 SM4 不受官方 egress 支持，官方 AES 用的是 livekit-go（pion）自带 e2ee frame cryptor；SM4 需自研 Go 侧解密。