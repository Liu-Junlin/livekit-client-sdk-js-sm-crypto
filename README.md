# livekit-client（SM4 国密 fork）

本仓库是官方 [livekit/client-sdk-js](https://github.com/livekit/client-sdk-js)（v2.22.2）的 fork，在保持官方默认行为不变的前提下，为 e2ee 模块新增了**国密（SM2/SM3/SM4）加密支持**。

> **官方文档 / 原仓库：** [https://github.com/livekit/client-sdk-js](https://github.com/livekit/client-sdk-js)
>
> 本 fork 仅在后文所述国密能力上相对官方扩展；其余 API、用法、文档请以官方仓库为准。

---

## 一、本 fork 做了什么

通过「算法开关 + Provider 抽象」为 e2ee 接入国密，**且不破坏原 AES-GCM 路径**：

- 默认仍是官方 `AES-GCM`（`KeyProviderOptions.cryptography: 'aes-gcm'`），行为与官方完全一致；
- 显式设为 `'sm4'` 时，媒体帧与数据消息改用 **SM4-GCM（AEAD）**，会话钥派生/换钥改用 **SM3**，SM4 加解密由 `sm-crypto-v3` 提供；
- 加密逻辑全部收敛在 `src/e2ee/sm/smCrypto.ts` 单一注入点，差异化最小化。

## 二、当前状态

| 能力 | 状态 |
| --- | --- |
| 媒体帧 / 数据消息 SM4-GCM | ✅ 已实现并通过双端互通实测 |
| 密钥派生（SM3-hkdf）、ratchet（GM/T SM3-KDF） | ✅ |
| 打包（worker `crypto` shim + `inlineDynamicImports`） | ✅ |
| 回归（`tsc` + 815 单测） | ✅ 全绿 |
| SM2 密钥协商 / 分发 / 验签 | ⏳ 待做（可选增强） |

## 三、数据通道 × 加密算法支持矩阵

> 由 `cryptography: 'aes-gcm' | 'sm4'` 全局面切换，同一密钥集固定同一算法。

| 数据通道 / 加密面 | 默认 `aes-gcm` | 国密 `sm4` |
| --- | --- | --- |
| RTP 音频帧 | ✅ AES-GCM | ✅ SM4-GCM |
| RTP 视频帧（VP8/VP9/H264/H265） | ✅ AES-GCM | ✅ SM4-GCM |
| AV1 视频 | ✗ | ✗（上游 e2ee 暂不支持） |
| 加密数据消息（`publishData`） | ✅ AES-GCM | ✅ SM4-GCM |
| 会话钥派生（口令 / 密钥缓冲） | ✅ PBKDF2 / HKDF-SHA256 | ✅ SM3-hkdf |
| Key ratchet（换钥） | ✅ `deriveBits` | ✅ GM/T SM3-KDF |
| SM2 协商/分发/验签 | — | ⏳ 未实现（可选） |

## 四、国密算法分工

| 算法 | 职责 | 替换的现有基元 |
| --- | --- | --- |
| **SM4-GCM** | 媒体帧 + 数据消息对称加解密（AEAD） | AES-GCM |
| **SM3**（`hkdf`/`kdf`） | 会话钥派生、ratchet 迭代 | PBKDF2/HKDF-SHA256 |
| **SM2** | 会话钥协商/分发、信令验签（可选） | 无对应（新增） |

## 五、与官方 AES 的关键对齐

SM4 实现严格保持官方 AES 的**结构与帧时序**：IV 12 字节、AAD=未加密帧头、认证 tag 16 字节、帧尾 `trailer[0]=IV_LENGTH,[1]=keyIndex`、认证失败均触发自动换钥（ratchet）。差异只收敛在 `smCrypto.ts` 算法注入点，因此对端仍可按官方帧结构解析。

## 六、如何使用（SM4 开启示例）

```ts
import { ExternalE2EEKeyProvider } from 'livekit-client'

const sm4Provider = new ExternalE2EEKeyProvider({ cryptography: 'sm4' })
await sm4Provider.setKey('双方一致的共享口令')   // 两端相同 → SM3 派生出同一 SM4 会话钥

const room = new Room({
  e2ee: {
    keyProvider: sm4Provider,
    worker: new Worker(new URL('livekit-client/e2ee-worker?url', import.meta.url), { type: 'module' }),
  },
})
await room.connect(url, token)
await room.setE2EEEnabled(true)   // 强启本地加密
```

**两端互通**：同一会议室、（各自）`cryptography:'sm4'` + 相同口令，媒体帧/数据消息即可加解密互通。

## 七、架构边界：服务器侧媒体消费端

本 fork 只实现**客户端↔客户端** e2ee。**Egress（录制/转推）、Ingress、Agent（STT 等）** 是服务器侧媒体消费端，SM4 加密会议下它们拿到的是密文，需要各自适配（且自研 SM4 不受官方支持，需另补充国密解密）：

| 消费端 | 结论 |
| --- | --- |
| **Egress 录制/转推** | 需 Go 侧 SM3+SM4 解密（推荐在 `AppWriter` 进 GStreamer 前解密）；或走明文镜像/可信域 |
| **Ingress 推流** | 明文流可按 `encryption=NONE` 被 e2ee 接收端观看（兼容）；若要进加密域需 Go 侧加密 |
| **Agent（Python）** | `AudioStream` 只给解码后 PCM、拿不到密文；以自研 SM4 接入需改 native，成本高 → 优先明文镜像/可信域 |

> **明文镜像/可信域（推荐的最省路径）**：发布端另起一个不带 e2ee 的连接，把同一 `MediaStreamTrack` 以 `name='mirror'` 明文发布一份，供 Agent/Egress 订阅；参会者间仍保持 SM4 端到端保密。

## 八、深入设计参考

密钥派生参数（salt/info）、二次派生 vs 直接注入、安全与性能、SM2 分发、Rust/WebRTC native 加 SM4 的可行性等，均记录于本仓库的 `E2EE_SM_UPGRADE_PLAN.md`（§1–§18），可作为国密改造的完整方案与评估参考。详见：

- [`E2EE_SM_UPGRADE_PLAN.md`](./E2EE_SM_UPGRADE_PLAN.md)

---

## License & 归属

本 fork 保留官方 [Apache-2.0](LICENSE) 许可与 [NOTICE](NOTICE)；上游与完整文档见 [livekit/client-sdk-js](https://github.com/livekit/client-sdk-js)。