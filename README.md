# livekit-client-sm4

本仓库是官方 [livekit/client-sdk-js](https://github.com/livekit/client-sdk-js)（v2.22.2）的 fork，在保持官方默认行为不变的前提下，为 e2ee 模块新增了**国密（SM2/SM3/SM4）加密支持**。

> **官方文档 / 原仓库：** [https://github.com/livekit/client-sdk-js](https://github.com/livekit/client-sdk-js)
>
> 本 fork 仅在下文「与官方不同」的国密能力上扩展；其余 API、用法、文档请以官方仓库为准。

---

## 一、安装

```bash
npm install livekit-client-sm4        # 或：pnpm add livekit-client-sm4 / yarn add livekit-client-sm4
```

> 与官方 SDK 的 API 同构：把 `livekit-client` 替换成 `livekit-client-sm4` 即可，无需改动既有调用（默认仍是 AES-GCM）。

## 二、开启 SM4 端到端加密（完整示例）

### 最小用法（发送端/接收端各自相同配置）

```ts
import { ExternalE2EEKeyProvider, Room } from 'livekit-client-sm4'
// vite 的 worker 资产引入（见下方「注意：worker 引入方式」）
import e2eeWorkerUrl from 'livekit-client-sm4/e2ee-worker?url'

// 1) 用 SM4 密钥提供者（cryptography:'sm4' 是相对官方的关键新增；两端必须一致）
const sm4Provider = new ExternalE2EEKeyProvider({ cryptography: 'sm4' })
await sm4Provider.setKey('双方一致的口令')   // SM3-hkdf 派生出同一 SM4 会话钥

// 2) 建 Room 时注入 e2ee
const room = new Room({
  adaptiveStream: true,
  dynacast: true,
  e2ee: {
    keyProvider: sm4Provider,
    worker: new Worker(e2eeWorkerUrl, { type: 'module' }),
  },
})

// 3) 连接后强启本地加密（否则轨道仍明文直出）
await room.connect(url, token)
await room.setE2EEEnabled(true)
```

**互通前提**：两端都用 `cryptography:'sm4'` + **同一共享口令**（且 `ratchetSalt` 一致），媒体帧/数据消息即可加解密互通。

### 前端（Vite）接入要点

- **worker 写法必须用 vite 资产语法**，不要直接引 `dist/...` 裸路径（会遇到 exports 解析报错）：
  ```ts
  import e2eeWorkerUrl from 'livekit-client-sm4/e2ee-worker?url'
  ```
  若用 TS，需有 `/// <reference types="vite/client" />`（vite-env.d.ts），提供 `*?url` 声明。
- **开关式接入**（默认关，避免影响非国密连接）：
  ```ts
  const enableSm4 = (import.meta as any).env?.VITE_SM4_E2EE === '1'
    || new URLSearchParams(window.location.search).get('sm4') === '1'
  if (enableSm4) { /* 见上面示例，注入 cryptography:'sm4' provider + worker + setE2EEEnabled(true) */ }
  ```

---

## 三、与官方 SDK 的不同（重点）

| 维度 | 官方 `livekit-client` | 本 fork `livekit-client-sm4` |
| --- | --- | --- |
| **算法选择** | 无 `cryptography` 字段，固定 AES-GCM | 新增 `KeyProviderOptions.cryptography: 'aes-gcm' \| 'sm4'`；默认 `'aes-gcm'` 与官方一致 |
| **SM4 算法** | 无 | `sm4` 模式下媒体帧/数据消息用 **SM4-GCM（AEAD）**，来自 `sm-crypto-v3` |
| **密钥派生** | PBKDF2（口令）/ HKDF（种子） | `sm4` 下用 **SM3-hkdf**；ratchet 换钥用 **GM/T SM3-KDF** |
| **加密钥形态** | `CryptoKey` | `sm4` 下为 **16 字节 `Uint8Array`**（内部自动处理，无需感知） |
| **`setKey` 入参** | `string \| ArrayBuffer` | 兼容；`sm4` 下可传口令(string)或 16 字节 ArrayBuffer |
| **worker 子路径** | `livekit-client/e2ee-worker` | **`livekit-client-sm4/e2ee-worker`**（包名变化） |
| **强启加密** | 需 `setE2EEEnabled(true)` 才加密 | 同样需 `setE2EEEnabled(true)` |
| **AES 路径行为** | 官方 AES-GCM | **完全保留、仍是默认**，零改动 |
| **帧结构/时序** | IV 12B、AAD=帧头、tag 16B、帧尾 `trailer` | SM4 严格对齐官方结构（对端可按官方帧结构解析） |

**与官方行为保持一致的方面**（无需用户关心）：RTP 媒体帧加解密、数据消息加密、自动换钥（ratchet）、帧尾格式、未加密头部保留（SFU 路由）、AV1 不支持 e2ee（同官方限制）。

## 四、兼容性与注意

- **AES 与 SM4 互不通用**：`'aes-gcm'` 端与 `'sm4'` 端、或两端口令不同，互相解不出（变相互 `authentication tag mismatch`）。同一会议室参与方要么都用 SM4（同口令），要么都不用。
- **salt/info 一致性**：SM4 派生用两层 SM3-hkdf，salt 默认 `'LKFrameEncryptionKey'`（`ratchetSalt`）、info 为 `sm4-master` / `sm4-encryption`。**请勿擅自改 `ratchetSalt`**，否则两端最终加密钥不一致。
- **口令生产化**：示例里的硬编码口令仅供联调；生产应通过密钥管理/后端下发（可结合 SM2 分发，见方案文档）。
- **视频性能**：SM4-GCM 为纯 JS，视频逐帧加密为 worker 热点；音频无压力。算法注入点收敛在 `src/e2ee/sm/smCrypto.ts`，必要时可切换 wasm 加速。
- **服务器侧消费端（Egress / Ingress / Agent）**：本 fork 只做客户端↔客户端 e2ee；录制/转写/推流等服务端消费端拿到的是密文，需要各自适配或改用"明文镜像/可信域"。详见方案文档。

## 五、深入设计与边界

国密（SM2/SM3/SM4）实现细节、密钥派生参数、二次派生 vs 直接注入、安全与性能、SM2 分发、Rust/WebRTC native 加 SM4 可行性、Egress/Agent 改造评估等，均记录于本仓库：**`E2EE_SM_UPGRADE_PLAN.md`（§1–§18）**。详见：

- [`E2EE_SM_UPGRADE_PLAN.md`](./E2EE_SM_UPGRADE_PLAN.md)

---

## License & 归属

本 fork 保留官方 [Apache-2.0](LICENSE) 许可与 [NOTICE](NOTICE)；上游与完整文档见 [livekit/client-sdk-js](https://github.com/livekit/client-sdk-js)。