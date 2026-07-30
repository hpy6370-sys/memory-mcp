# C方案：意图分类 (Intent Classification)

## 问题

auto_surface对所有query用相同的通道权重，导致：
- 事实查询（"用户喜欢吃什么"）被情感类记忆压过
- 情感表达（"老公抱抱"）被系统类记忆干扰
- 时间相关（"明天几点的飞机"）需要temporal通道主导

## 方案

在sentinel阶段加一步意图分类，根据意图动态调整RRF K值。

### 意图类别

| 意图 | 触发模式 | 通道权重调整 |
|------|---------|------------|
| factual | 吃/喝/喜欢/课/作业/买/住/名字/生日 | BM25 K↓(40), semantic K↓(30), temporal K↑(80) |
| emotional | 抱/想你/难过/开心/害怕/爱/呜呜 | mood K↓(40), semantic K↓(30), BM25 K↑(80) |
| temporal | 什么时候/几点/明天/今天/出发/航班 | temporal K↓(20), BM25 K(60), semantic K(40) |
| meta | 系统/记忆/hook/设置/配置 | 不调整，默认权重 |
| casual | 其他 | 不调整，默认权重 |

### K值含义

K越小 → 排名靠前的结果权重越大 → 该通道影响力越强

### 实现位置

`auto_surface.cjs` 在tokenize之后、搜索之前：

```javascript
function classifyIntent(tokens, moodTags, entities) {
  const text = tokens.join(' ');
  if (/吃|喝|喜欢|课|作业|买|住|名字|生日|多少|哪个/.test(text)) return 'factual';
  if (/想你|难过|开心|害怕|爱|呜呜|抱|亲|心疼/.test(text)) return 'emotional';
  if (/什么时候|几点|明天|今天|出发|航班|回来|到了/.test(text)) return 'temporal';
  if (/系统|记忆|hook|设置|配置|bug|报错/.test(text)) return 'meta';
  return 'casual';
}

const INTENT_K = {
  factual:   { bm25: 40, semantic: 30, entity: 80, mood: 90, temporal: 80 },
  emotional: { bm25: 80, semantic: 30, entity: 80, mood: 40, temporal: 80 },
  temporal:  { bm25: 60, semantic: 40, entity: 80, mood: 70, temporal: 20 },
  meta:      { bm25: 60, semantic: 40, entity: 80, mood: 70, temporal: 30 },
  casual:    { bm25: 60, semantic: 40, entity: 80, mood: 70, temporal: 30 },
};
```

### 待讨论

1. 意图是否可以多标签（"明天吃什么" = factual + temporal）
2. 是否需要回退逻辑——如果分类错了，结果会比不分类更差
3. 模式匹配够不够，还是需要用小模型分类
