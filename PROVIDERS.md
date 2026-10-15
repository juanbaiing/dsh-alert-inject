# 可替换组件总目录（PROVIDERS）

> **这份文件回答一个问题：这个插件用到了哪些"外部东西"，我能不能换成更好的？**
>
> ⚠️ **不写这份文件，使用者就被绑死在作者的选择上** —— 而作者本机装了什么，
> 跟别人要不要用它**没有任何关系**。
>
> 作者 2026-10-16 的要求：
> > 「这些模型或组件**有没有上位替代**，**要做成能替代的**，并**详细说明**，
> >   使用者**按需替换**，**一定要讲明白**。」

---

## 一、目录：用到的全部外部组件

| # | 组件 | 现在用什么 | 在哪 | **能不能换** | 怎么换 |
|---|---|---|---|---|---|
| 1 | **嵌入模型**（把文字变成"意思坐标"） | `bge-m3`（本机 Ollama） | `lib/provider.js` | ✅ **能** | 改配置（见 §二） |
| 2 | **生成模型**（分类／改写／摘要） | `qwen2.5:3b`（本机 Ollama） | `lib/provider.js` | ✅ **能** | 改配置 |
| 3 | **推理服务**（跑上面两个的进程） | Ollama（`localhost:11434`） | `lib/provider.js` | ✅ **能**（OpenAI 兼容协议通吃一大片） | 改配置 |
| 4 | **训练框架**（把样本变成判据） | **尚未接** | —— | ⏳ **待定** | 见 §四 |
| 5 | **存储**（三个库／样本库／整理稿） | **纯文本**（`jsonl` ＋ `md`） | `~/.dsh/memory/`、`~/.dsh/learning-samples.jsonl` | ✅ 能换（但**不建议**，见 §四） | —— |
| 6 | **检索方式**（从历史里找相似） | 质心分区 ＋ 区内细查（自研） | `lib/librarian.js` | ⚠️ 能换（但自研这套**零依赖**） | —— |
| 7 | **宿主**（跑这一切的地方） | DSH | —— | ❌ 不适用 | —— |

**⚠️ 只有 1／2／3 是"真的会绑住你"的** —— 它们决定你能不能在没有 Ollama 的机器上跑。

---

## 二、怎么换后端（**只改配置，不改代码**）

三种后端，**任选一种**：

| 值 | 走什么协议 | 适合谁 |
|---|---|---|
| **`ollama`**（默认） | Ollama 原生 `/api/embed` · `/api/generate` | 想**全本地、零 API key、数据不出机器** |
| **`openai`** | **OpenAI 兼容** `/v1/embeddings` · `/v1/chat/completions` | 想用云端，或想接 vLLM／LM Studio／llama.cpp server |
| **`none`** | **明确关掉** | 不想让它联网／不想装模型 ⇒ 依赖它的功能全部跳过（**并如实说明"被关掉了"，不是"失败"**） |

### 写法一：环境变量

```bash
# 全本地（默认，什么都不用配）
DSH_ALERT_PROVIDER=ollama

# 云端 —— 任何 OpenAI 兼容服务都行
DSH_ALERT_PROVIDER=openai
DSH_ALERT_BASE_URL=https://api.deepseek.com
DSH_ALERT_API_KEY=sk-你的key
DSH_ALERT_EMBED_MODEL=text-embedding-3-small     # 可换
DSH_ALERT_LLM_MODEL=deepseek-chat                # 可换

# 本地但不用 Ollama（vLLM / LM Studio / llama.cpp server 都提供 OpenAI 兼容接口）
DSH_ALERT_PROVIDER=openai
DSH_ALERT_BASE_URL=http://localhost:8000
DSH_ALERT_API_KEY=（这些本地服务通常不校验，随便填）
```

### 写法二：配置文件 `~/.dsh/alert-inject.json`

```json
{
  "provider": {
    "kind": "openai",
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "sk-...",
    "embedModel": "text-embedding-3-small",
    "llmModel": "deepseek-chat"
  }
}
```

**优先级**：环境变量 ＞ 配置文件 ＞ 内置默认。

**⚠️ 向后兼容**：老的 `LIBRARIAN_MODEL` 和 `OLLAMA_HOST` **仍然有效**。

---

## 三、⚠️ 换了之后**必须知道**的两件事

### ① 换嵌入模型 ⇒ **索引必须重建**（会自动重建，别慌）

因为向量**维度和尺度都变了** —— 拿旧索引配新模型，检索出来的是垃圾。
⇒ 系统**已经处理**：索引状态里记着"建档时用的是哪个模型"，模型一变就判**过期**
⇒ 自查时会说「**索引已过期（…）⇒ 已在后台重建**」，**不需要你手动删文件**。

**你怎么确认**：
```bash
node tools/health.mjs --project <你的项目>
```
看「语义检索」那一项是「正常」还是「过期／重建中」。

### ② 换生成模型 ⇒ **只影响"分类／改写"这类离线活**，不影响提醒

提醒（判据）不调模型；调模型的只有：索引重建、分类、负例生成。
⇒ 所以**换生成模型是安全的**，不会把已经在跑的提醒弄坏。

---

## 四、上位替代候选（**按需替换，别盲目追新**）

> **⚠️ 先说清**：下面列的是**候选方向**，**不是"哪个一定更好"**。
> 嵌入／生成模型的好坏**取决于你的任务和语言**，没有普适第一。
> **判断方法见 §五** —— 用你自己的数据测，别信榜单。

### 4.1 嵌入模型（第 1 项）

| 方向 | 候选 | 什么时候值得换 |
|---|---|---|
| **保持** | `bge-m3` | **中文／多语言检索**，本地，1024 维 —— 已经很强，**多数人不必换** |
| 本地更大 | `Qwen3-Embedding` 系列、`bge-large` | 你机器够强，且**实测**它在你数据上更好 |
| 云端 | `text-embedding-3-large`（OpenAI）、`voyage-3`、`gemini-embedding` | 愿意付钱换准确率；⚠️ **数据会离开你的机器** |

### 4.2 生成模型（第 2 项）

| 方向 | 候选 | 什么时候值得换 |
|---|---|---|
| **本机 3B**（现默认） | `qwen2.5:3b` | **快**（2~3 秒/条），但**判"意图"不够准**（实测：把"纠正笔误"判成"纠正"） |
| 本机更大 | `qwen3:4b`、`deepseek-r1:7b` | ⚠️ **实测 100 秒/条**（推理模型会先"想"一大段）⇒ 只适合**后台整夜跑** |
| 云端 | `deepseek-chat`、`gpt-4o-mini`、`claude-haiku` | **又快又准**，但**按量付费**、数据出机器 |

### 4.3 推理服务（第 3 项）

| 换法 | 适合 |
|---|---|
| Ollama（现默认） | 零配置、跨平台、**最适合本机** |
| vLLM / LM Studio / llama.cpp server | 有更好的 GPU，想要更高吞吐；**都提供 OpenAI 兼容接口** ⇒ 直接按 §二 换 |

### 4.4 还没定的：**训练框架**（第 4 项）

「用你自己的纠正，长成你自己的判据」这一步**还没接**。可选方向：

| 方向 | 特点 |
|---|---|
| **SetFit** | 门槛低（**每类 8 条**，本项目的门槛就是引它）；**无 GPU 也能跑** |
| sentence-transformers ＋ 分类头 | 更自由，代码更多 |
| LoRA 微调 | 更强，但**要 GPU**、成本高 |

⇒ ⚠️ **这一项的选择还没定**，定了会补进本文件。

### 4.5 存储（第 5 项）：**建议别换**

现在用**纯文本**（`jsonl` ＋ `md`）是有意的：

- **你随时能用记事本打开、能自己核对** —— 这正符合本项目「使用者从行为验证」的原则
- 换成数据库 ⇒ **普通使用者再也无法自己看一眼**
- ⇒ 除非你有**几十万条**，否则**文本够用**

---

## 五、怎么自己判断"换得对不对"（**别信榜单，信你的数据**）

本项目已经有一套现成的对照方法（用过的，不是新造的）：

### 测嵌入模型

```bash
# 同一份索引、同一个问题，换模型前后各跑一次
LIBRARIAN_MODEL=bge-m3       node lib/librarian.js <会话文件> "这个之前好像发生过"
DSH_ALERT_EMBED_MODEL=xxx    node lib/librarian.js <会话文件>
```

**判据**（本项目实测用过）：
- 拿**相关**的话去查 ⇒ 相似度应当**高**
- 拿**无关**的话去查（"红烧肉怎么做"）⇒ 相似度应当**低**
- ⇒ **看两者的差**。差得开 = 能用；差不开 = 换它没意义。
  （实测参考：`bge-m3` 相关 64~69% ／ 无关 40~53%）

### 测生成模型

```bash
node tools/filter-corrections.mjs --n 20 --model <你要试的模型>
node tools/classify-corrections.mjs --n 20 --model <你要试的模型>
```

⇒ 它会**把结果连同原文一起打出来**，**你自己判它归得对不对** —— 不用懂代码。
> 实测教训：`qwen2.5:3b` 把「我叫 juanbaiing，不是 juanbaing」（纠正**自己笔误**）
> 判成了"纠正"，也把「好，先试试，另外，你去搜一下」（**下新指令**）判成了"纠正"。

---

## 六、一张速查表（贴在这里，不用翻上面）

```bash
# 看我现在用的是什么
node -e "import('./lib/provider.js').then(p=>console.log(p.renderProvider()))"

# 它到底通不通（不是"配了没"）
node -e "import('./lib/provider.js').then(async p=>console.log(await p.healthCheck()))"
```

| 我想…… | 改这个 |
|---|---|
| 换成云端（DeepSeek／OpenAI） | `DSH_ALERT_PROVIDER=openai` ＋ `BASE_URL` ＋ `API_KEY` |
| 换成 vLLM／LM Studio | `DSH_ALERT_PROVIDER=openai` ＋ `BASE_URL=http://localhost:8000` |
| 换嵌入模型 | `DSH_ALERT_EMBED_MODEL=...`（⚠️ 会触发索引重建，自动的） |
| 换生成模型 | `DSH_ALERT_LLM_MODEL=...` |
| 全部关掉（不联网、不装模型） | `DSH_ALERT_PROVIDER=none` |
| 只是换端口 | `DSH_ALERT_BASE_URL=http://localhost:11434` |

---

## 七、⚠️ 三条纪律（换之前先看）

1. **换完先跑一次探活**，别等它出错才发现配错了：
   `node -e "import('./lib/provider.js').then(async p=>console.log(await p.healthCheck()))"`
2. **换嵌入模型 ⇒ 索引会重建**（自动），**别以为它坏了** —— 自查里会说清楚
3. **数据出机器前先想清楚**：云端 API 意味着**你的对话内容会发到对方服务器**
   ⇒ 介意的话就用 `ollama`（全本地）

---

*本文件随「可替代层」一起建立于 2026-10-16。*
*凡是这里写的组件，**都应该能用配置换掉** —— 如果哪个换不了，那是缺陷，请报上来。*
