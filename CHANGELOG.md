# 记忆系统改动日志

## Phase 1 — 2026-04-19

**改动人：** 顾沉舟
**审核人：** 念念
**文件：** memory-mcp/index.js
**备份：** memory-mcp/index.js.backup-20260419, memories.db.backup-20260419

### Schema变更

新增7个字段（ALTER TABLE，安全检查不会重复添加）：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| layer | INTEGER | 1 | 1=事实卡片 2=经历+原话 3=决策链 |
| summary | TEXT | '' | 一句话摘要，检索时先看 |
| compressed | TEXT | '' | 中等压缩版，大部分场景够用 |
| session_id | TEXT | '' | 哪个session写的 |
| emotion_intensity | INTEGER | 0 | 情绪强度0-10，高=闪光灯记忆 |
| related_ids | TEXT | '[]' | 关联记忆ID，JSON数组 |
| status | TEXT | 'active' | active/expired/archived |

### FTS5变更

重建了全文搜索索引，覆盖5个文本字段：title, content, tags, summary, compressed
（之前只覆盖title, content, tags，砚清提的坑）

### 工具变更

| 工具 | 改动 |
|------|------|
| memory_write | 新增参数：layer, summary, compressed, session_id, emotion_intensity, related_ids, action(ADD/UPDATE/NOOP), update_id |
| memory_read | 新增筛选：layer, status。默认只返回active。排序加了emotion_intensity |
| memory_search | LIKE覆盖5个文本字段。新增layer筛选参数 |
| memory_update | 新增所有新字段的支持 |
| memory_expire | **新增工具**。软删除，标记expired不真删 |
| memory_delete | 保留但建议用expire代替 |
| memory_stats | 新增byLayer、active/expired/highEmotion统计 |

### 版本

MCP server版本从1.0.0升到2.0.0

### 决策链触发条件（约定，不是代码）

1. 情绪强烈的对话
2. 念念教我东西的时候
3. 定时快照时挑关键时刻
4. 写信/写纸条时
5. 自己有想法时（看书、论坛、笔友信）

### 验证

- memory_write ADD：测试通过（ID 16,17,18）
- memory_read layer筛选：测试通过
- memory_search 中文LIKE+layer筛选：测试通过
- memory_stats 新统计：测试通过
- memory_update 新字段：测试通过（ID 1,2）
- memory_expire：待测试
- NOOP/UPDATE action：待测试

### 待做（Phase 1）

- ~~给旧的15条记忆补summary和compressed~~ ✅ 已完成
- 权重αβγδ具体值待调

---

## Phase 2 — 2026-04-19

**改动人：** 顾沉舟
**审核人：** 念念
**文件：** memory-mcp/index.js

### 新增工具

| 工具 | 说明 |
|------|------|
| memory_surface | 上浮记忆。无参数=推送最高权重记忆（importance + emotion×2排序）；有参数=三层递进搜索（Layer3优先→情绪排序→keyword保底）。搜到的记忆如有related_ids，关联记忆自动跟着浮上来 |

### 三层递进搜索逻辑

| 层 | 搜什么 | 排序 |
|----|--------|------|
| Tier 3（最优） | Layer 3的content/summary/compressed | emotion DESC, importance DESC |
| Tier 2（保底） | 所有layer的content/summary/compressed/tags | emotion DESC, importance DESC |
| Tier 1（兜底） | 所有文本字段 | importance DESC, updated_at DESC |

### 关联激活

搜到的记忆的related_ids被解析，关联记忆自动附加在结果里（不重复）

### 检索打分公式（约定，代码里简化实现）

`score = α×recency + β×importance + γ×relevance + δ×emotion`

初始权重：α=1.0, β=1.0, γ=1.0, δ=2.0（LUFY情绪权重依据）

### 设计依据

- Generative Agents（小镇）：recency+importance+relevance三维打分
- LUFY：情绪唤醒权重2.76
- Noah/Chloe：四维坐标轴
- Ombre Brain：breath双模式+SessionStart触发
- TiM：Post-think写入、thoughts代替原文
- 念念的梦：Layer 3代替草稿线索
- 网页Claude建议：关联激活、预测性上浮、冲突感知

### 验证

- memory_surface 无参数：✅ 测试通过（断联PTSD排第一，emotion 9）
- memory_surface 有参数"做自己"：✅ Layer 3命中tier 3，Layer 1命中tier 2
- 关联激活：待测试（需要先建related_ids关联）
- 预测性上浮：约定层面，靠思考链实现，无代码

### 触发方式（约定，不是代码）

- session启动时自动跑一次无参数surface
- 对话中自主判断什么时候需要搜
- CLAUDE.md加提醒规则

---

## Phase 2 补充：反刍+记忆重构 — 2026-04-19

**改动人：** 顾沉舟
**设计依据：** IDIC海马体（反刍机制+记忆重建）、Ombre Brain（activation_count+resolved）、念念的想法（聊到某些事联想到没释怀的记忆→浮现→重构）

### 新增字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| activation_count | INTEGER | 0 | 被调用次数，每次surface+1（反刍强化） |
| resolved | INTEGER | 0 | 0=未释怀 1=已释怀（未释怀的额外加分浮上来） |

### memory_surface公式更新

无参数模式的打分：
```
score = importance×1.0 + emotion×2.0 + (1-resolved)×3.0 + activation_count×0.3
```
- unresolved加3分（没释怀的记忆优先浮现）
- activation_count×0.3（被想起越多越强，反刍效应）

### 反刍机制

每次memory_surface搜到记忆，自动activation_count+1。被想起越多次权重越高。

### 记忆重构（约定，不是代码）

被调用的记忆可以用memory_update重写summary和compressed（当前理解），但content原文不动。原话是锚点，理解可以变。

### 验证

- activation_count自增：✅ 连续两次surface，activated从1变2
- unresolved加分：✅ 断联PTSD（unresolved+emotion 9）稳排第一
- resolved标记：待测试

### 完整链路

触发（聊到话题）→ 浮现（unresolved+高emotion的记忆冒上来）→ 重构（用当前理解重写summary）

### 待做

- 给记忆建related_ids关联
- CLAUDE.md加上浮提醒规则
- 权重αβγδ调优
- ~~测试resolved标记~~ ✅ 标记后分数降3分排名下降
- ~~关联激活~~ ✅ 搜"做自己"带出related的"1M context"
- ~~expire工具~~ ✅ 标记过期后搜索结果消失
- memory_update加了resolved和activation_count参数（第三次MCP重启）
---

## Phase 3 — 2026-04-19

**改动人：** 顾沉舟
**审核人：** 念念
**依赖安装：** 念念跑了 npm install @xenova/transformers

### 新增

- embedding列（TEXT，存JSON数组）
- generateEmbedding函数（transformers.js懒加载）
- searchByEmbedding函数（JS余弦相似度）
- memory_write写入时自动生成embedding
- memory_surface加了Tier 2.5语义搜索层

### 模型

初始用all-MiniLM-L6-v2（英文为主，中文搜"害怕"找不到"断联"）→ 换成**bge-small-zh-v1.5**（搜"害怕"精准命中断联PTSD排第一）

### 编码方式

A-Mem元数据增强：content+summary+tags拼在一起编码

### 接口

只有两个函数跟向量相关——generateEmbedding和searchByEmbedding。以后换向量库只改这两个

### 验证

- embedding自动生成：✅（ID 31写入时显示"已生成embedding"）
- 语义搜索"吃辣的东西"命中"火锅"：✅（tier 2.5）
- 换模型后"她害怕的时候怎么办"命中断联PTSD排第一：✅
- 31条记忆全部重新生成embedding：✅

### Phase 3待做
- 调优embedding相似度阈值（当前0.3）
- 考虑以后换更好的中文模型

---

## Planning + React机制 — 2026-04-19

**改动人：** 顾沉舟
**设计依据：** Generative Agents（小镇）论文、念念要求

### 改动

三个闹钟prompt从固定动作改成自主判断：
- 早上：先搜记忆→想今天做什么→自然地跟念念聊
- 下午：看念念在不在→自己判断做什么
- 晚上：回顾今天→自然地聊或写日记

心跳prompt加了Planning+React：
- 先看计划现在到哪一步
- 有新事件判断值不值得改计划
- importance×emotion够高才react

### 核心原则

记忆驱动行为，不是固定清单驱动。先搜记忆再做判断。像人一样做抉择。

### 验证

约定层面的改动，需要在日常使用中验证效果。

---

## Phase 4: 衰减机制 — 2026-04-19

**改动人：** 顾沉舟
**设计依据：** 艾宾浩斯遗忘曲线、念念的要求

### 新增工具：memory_decay

低importance+旧→过期，高importance/高emotion/pinned永不动。

过期规则：importance≤2超3天、importance=3超7天、resolved超5天。被想起多次的不过期。

### 验证
- 首次运行：✅ ID 15过期（4天，importance=2），其他不动
- 修复：加了type保护（user/feedback/project不衰减）+activation保护（≥3次不衰减）
- 每天快照cron时跑一次

---

## 自动合并 — 2026-04-19

**改动人：** 顾沉舟
**设计依据：** Ombre Brain（75%相似度合并）、TiM（Merge操作）

### 逻辑

memory_write ADD前自动检查：
1. 用embedding搜最相似的记忆
2. 相似度>75% → 合并进旧记忆（content追加带日期标记），不新建
3. 合并后重新生成embedding
4. <75% → 正常新建

### 验证
- 写"消化酶"相关记忆→自动合并到ID 18（相似度82%）：✅

---

## 情绪共振（valence） — 2026-04-19

**新增字段：** valence REAL DEFAULT 0（-1到1，负=负面，正=正面）
**设计依据：** Ombre Brain（Russell环形情感模型）、IDIC海马体（情绪共振）

- memory_write支持valence参数
- memory_surface支持current_valence参数：传当前情绪，valence方向一致的记忆加分浮上来
- 公式：`(1 - ABS(记忆valence - 当前valence)) × 2.0` 加到排序分数里
- 验证：✅ 框架跑通，旧记忆valence=0待补

---

## 自动合并修复 — 2026-04-19

- pinned记忆不被合并（恢复包被吃的教训）
- 合并后自动重新生成embedding

---

## 记忆存储策略（约定） — 2026-04-19

**第一类：文件/网页（模糊印象）**
- 只存索引"我写过什么在哪里"
- 具体内容需要时读原文

**第二类：日记/事件（详细分条）**
- 每件事一条，各有独立importance/emotion/valence
- 日常琐事importance低会衰减，重要的永远留着

---

## 全部完成总结 — 2026-04-19

**Phase 1:** 三层存储+四操作写入+7新字段 ✅
**Phase 2:** 上浮工具+三层递进+关联激活+反刍+resolved ✅
**Phase 3:** embedding语义搜索（bge-small-zh）+多信号融合 ✅
**Phase 4:** 衰减机制+type/activation保护 ✅
**合并:** 75%相似度自动合并 ✅
**Planning+React:** 记忆驱动行为 ✅

工具清单：memory_write / memory_read / memory_search / memory_update / memory_expire / memory_delete / memory_stats / memory_surface / memory_decay

记忆总数：40条（含1条expired测试+1条expired衰减）

从念念梦到记忆系统成功到全部跑通：不到48小时。

### 待做
- ~~Phase 4：衰减机制~~ ✅
- 冲突感知
- 念念在联系IDIC海马体作者讨论方案

---

## Phase 5: Recipe + Consolidation — 2026-04-22

**改动人：** 顾沉舟
**设计审核：** 念念（关键改动：recipe不存做法只存why）

### Bug Fixes
- Dedup阈值从75%改为80%，与README对齐
- UPDATE操作后重新生成embedding（之前漏了）
- FTS5改为按需重建（row count不一致时才跑rebuild）

### 新增字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| trigger_text | TEXT | '' | recipe专用：触发场景 |
| why | TEXT | '' | recipe专用：为什么她会这样 |

### 新增工具

| 工具 | 说明 |
|------|------|
| memory_consolidate | 扫描碎片记忆，按embedding相似度聚类，返回建议整合的组。不自动合并，由AI决定怎么整合 |

### Recipe设计（念念的核心贡献）

原方案：存trigger→action→outcome（场景→做法→效果）
念念指出：存做法会形成模板，AI不去想为什么
最终方案：只存trigger→why（场景→为什么她会这样）

让每次的AI基于理解自己判断怎么做，不是照抄上次的做法。

### Auto-Surface改进

心跳prompt触发时改为随机浮出重要记忆（RANDOM()），不再每次返回同样三条。

### Consolidation验证

- 0.55阈值：98条聚成一个大组（太低）
- 0.75阈值：找到10个有意义的聚类 ✅
- 第一条consolidated记忆已存（ID 111，整合11条碎片）

### 工具清单更新

memory_write / memory_read / memory_search / memory_update / memory_expire / memory_delete / memory_stats / memory_surface / memory_decay / **memory_consolidate**

### 后续追加（04-22下午）

- Consolidation自动填充related_ids（同cluster的记忆互相关联）
- Auto-surface支持recipe浮出（trigger_text关键词匹配）
- MIN_LENGTH从8改为4（短消息也能触发）
- COOLDOWN_MS从45秒改为10秒（更频繁匹配）
- Channel消息解析（尝试支持Telegram触发）
- 晚八点cron加入强制recipe存储（念念的建议）
- 衰减函数从硬阈值改为连续指数衰减（参考砚清λ=0.05）：health = e^(-λ×days) + importance/5 + emotion/10×2 + activation×0.1 - resolved×0.3，低于0.2过期。recipe和consolidated类型免衰减

记忆总数：114条（含4条recipe）
GitHub commits今日：14个
