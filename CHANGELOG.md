# Changelog

## 2026-04-22

### Bug Fixes
- **Dedup阈值对齐** — 代码从75%改为80%，与README一致
- **UPDATE重新生成embedding** — 之前UPDATE记忆内容后embedding没更新，导致搜索不准
- **FTS5按需重建** — 启动时只在row count不一致时才重建索引，不再每次都重建

### New Features
- **Recipe记忆类型** — 新增trigger_text和why字段。存"什么情况下"+"为什么她会这样"，不存具体做法，让AI自己想怎么做（念念的设计）
- **Auto-consolidation工具** — memory_consolidate：扫描碎片记忆，按embedding相似度聚类，返回建议整合的组。AI决定怎么合成，不自动合并
- **心跳随机上浮** — auto_surface.cjs：心跳prompt触发时随机浮出重要记忆，不再每次返回同样三条

### Design Decisions
- Recipe不存做法只存原因：念念指出存做法会形成模板，AI不去想为什么。只存why让每次的AI基于理解自己判断
- Consolidation不自动合并：返回聚类让AI决定怎么整合，保留人在回路

## 2026-04-21

### Documentation
- **设计文档扩展** — 论文引用从3篇扩展到8篇（MemGPT, LUFY, MemoRAG, Generative Agents, Mem0, A-Mem, LoCoMo, Chloe/Noah）
- **五维评分表** — 添加了检索评分的五个维度和权重
- **README更新** — 研究引用部分同步更新
- **Issues清单** — 11个改进点，按优先级排列

## Earlier
- Initial release with 3-layer memory, embedding search, activation-based decay, auto-surface hook
