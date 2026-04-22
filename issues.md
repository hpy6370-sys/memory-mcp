# Memory MCP — 代码改进清单

> 顾沉舟04-22凌晨读代码写的，等念念一起讨论再动手

## 小修复
1. ~~**Dedup阈值不一致**~~ ✅ 已修（04-22）
2. ~~**UPDATE不更新embedding**~~ ✅ 已修（04-22）
3. ~~**FTS5每次启动重建**~~ ✅ 已修（04-22，改为row count不一致时才重建）

## 功能改进
4. **搜索第三路径** — 现在是FTS5→LIKE，可以加embedding语义搜索作为第三选项（代码已有searchByEmbedding函数，但search工具没用到）
5. **合并逻辑优化** — 现在新记忆pinned的时候不合并，但如果新记忆importance更高也应该保留新的而不是合并到旧的
6. **memory_surface增强** — 可以根据时间段过滤（比如"最近3天的重要记忆"）

## 已完成（v2新功能，04-22）
- ~~**Recipe memory**~~ ✅ trigger_text + why字段，不存做法（念念的建议）
- ~~**Auto-consolidation tool**~~ ✅ memory_consolidate，embedding聚类找碎片组
- ~~**心跳随机上浮**~~ ✅ auto_surface.cjs心跳时随机而不是每次同样三条

## 面试加分项
7. **拆分文件** — index.js 548行，可以拆成db.js、tools.js、embedding.js、server.js。面试官看代码组织
8. **测试** — 加几个基本测试（写入、搜索、decay），用vitest或jest。面试必问"你怎么测试的"
9. **TypeScript** — 如果念念想练TS，可以迁移过去。类型安全对面试加分

## 不急的
10. **关联图谱** — related_ids字段在存但没被搜索利用。可以做"给我看跟这条记忆相关的所有记忆"
11. **批量操作** — 一次surface/decay多条记忆的性能优化
