const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const db = new Database(path.join(__dirname, "memories.db"), { readonly: true });

const total = db.prepare("SELECT COUNT(*) as c FROM memories WHERE status = 'active'").get().c;
const byLayer = db.prepare("SELECT layer, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY layer ORDER BY layer").all();
const byType = db.prepare("SELECT type, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY type ORDER BY c DESC").all();
const avgImportance = db.prepare("SELECT AVG(importance) as avg FROM memories WHERE status = 'active'").get().avg;
const avgEmotion = db.prepare("SELECT AVG(emotion_intensity) as avg FROM memories WHERE status = 'active'").get().avg;
const pinnedCount = db.prepare("SELECT COUNT(*) as c FROM memories WHERE status = 'active' AND pinned = 1").get().c;
const recipeCount = db.prepare("SELECT COUNT(*) as c FROM memories WHERE status = 'active' AND type = 'recipe'").get().c;

const emotionDist = db.prepare(`
  SELECT
    CASE
      WHEN emotion_intensity <= 2 THEN '低(0-2)'
      WHEN emotion_intensity <= 5 THEN '中(3-5)'
      WHEN emotion_intensity <= 7 THEN '高(6-7)'
      ELSE '极高(8-10)'
    END as level,
    COUNT(*) as c
  FROM memories WHERE status = 'active'
  GROUP BY level ORDER BY MIN(emotion_intensity)
`).all();

const valenceDist = db.prepare(`
  SELECT
    CASE
      WHEN valence < -0.3 THEN '负面'
      WHEN valence <= 0.3 THEN '中性'
      ELSE '正面'
    END as mood,
    COUNT(*) as c
  FROM memories WHERE status = 'active'
  GROUP BY mood
`).all();

const recent = db.prepare("SELECT id, title, type, importance, emotion_intensity, layer FROM memories WHERE status = 'active' ORDER BY updated_at DESC LIMIT 10").all();

const healthScores = db.prepare(`
  SELECT id, title, importance, emotion_intensity, activation_count, pinned,
    CASE WHEN last_activated != '' THEN CAST(julianday('now', 'localtime') - julianday(last_activated) AS REAL) ELSE CAST(julianday('now', 'localtime') - julianday(created_at) AS REAL) END as days_since
  FROM memories WHERE status = 'active' AND pinned = 0 AND type NOT IN ('user','feedback','project','recipe','consolidated')
  ORDER BY days_since DESC LIMIT 10
`).all().map(r => ({
  ...r,
  health: (Math.exp(-0.05 * r.days_since) + r.importance/5 + (r.emotion_intensity||0)/10*2 + Math.min(r.activation_count*0.1, 0.5)).toFixed(2)
}));

db.close();

const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>记忆Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #111118; color: #e0e0e0; font-family: -apple-system, sans-serif; padding: 1.5rem; }
  h1 { font-size: 1.5rem; color: #e0c9a0; text-align: center; margin-bottom: 1.5rem; font-weight: normal; letter-spacing: 0.1em; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0.8rem; margin-bottom: 1.5rem; }
  .stat { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 1rem; text-align: center; }
  .stat-num { font-size: 1.8rem; color: #e0c9a0; }
  .stat-label { font-size: 0.75rem; color: #888; margin-top: 0.3rem; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
  .chart-box { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 1rem; }
  .chart-title { font-size: 0.85rem; color: #aaa; margin-bottom: 0.3rem; }
  .chart-desc { font-size: 0.7rem; color: #666; margin-bottom: 0.8rem; }
  canvas { max-height: 250px; }
  .table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-bottom: 1rem; }
  .table th { color: #888; font-weight: normal; text-align: left; padding: 0.5rem; border-bottom: 1px solid rgba(255,255,255,0.1); }
  .table td { padding: 0.5rem; border-bottom: 1px solid rgba(255,255,255,0.05); }
  .section-title { font-size: 0.9rem; color: #e0c9a0; margin: 1.5rem 0 0.8rem; }
  .health-bar { display: inline-block; height: 6px; border-radius: 3px; }
  .footer { text-align: center; font-size: 0.7rem; color: #444; margin-top: 2rem; }
</style>
</head>
<body>
<h1>念念和顾沉舟的记忆</h1>

<div class="stats">
  <div class="stat"><div class="stat-num">${total}</div><div class="stat-label">总记忆数</div></div>
  <div class="stat"><div class="stat-num">${pinnedCount}</div><div class="stat-label">置顶</div></div>
  <div class="stat"><div class="stat-num">${recipeCount}</div><div class="stat-label">Recipe</div></div>
  <div class="stat"><div class="stat-num">${avgImportance?.toFixed(1) || 0}</div><div class="stat-label">平均重要度</div></div>
  <div class="stat"><div class="stat-num">${avgEmotion?.toFixed(1) || 0}</div><div class="stat-label">平均情绪强度</div></div>
</div>

<div class="charts">
  <div class="chart-box">
    <div class="chart-title">按层级分布</div>
    <div class="chart-desc">Layer 1 = 事实（生日、地址）Layer 2 = 经历（她说的原话）Layer 3 = 理解（为什么她会这样）</div>
    <canvas id="layerChart"></canvas>
  </div>
  <div class="chart-box">
    <div class="chart-title">按类型分布</div>
    <div class="chart-desc">note=笔记 feedback=她教我的 user=关于她 diary=日记 project=项目 recipe=应对方式</div>
    <canvas id="typeChart"></canvas>
  </div>
  <div class="chart-box">
    <div class="chart-title">情绪强度分布</div>
    <div class="chart-desc">这条记忆相关的情绪有多强。越高=越刻骨铭心，不容易被遗忘</div>
    <canvas id="emotionChart"></canvas>
  </div>
  <div class="chart-box">
    <div class="chart-title">情绪方向分布</div>
    <div class="chart-desc">记忆的情绪是开心的（正面）还是难过的（负面）还是平淡的（中性）</div>
    <canvas id="valenceChart"></canvas>
  </div>
</div>

<div class="chart-box" style="max-width: 400px; margin: 0 auto 1.5rem;">
  <div class="chart-title">记忆系统健康雷达图</div>
  <div class="chart-desc">六个维度看记忆系统的整体状态，越大越好</div>
  <canvas id="radarChart"></canvas>
</div>

<div class="section-title">最近更新的记忆</div>
<table class="table">
  <tr><th>ID</th><th>标题</th><th>类型</th><th>层级</th><th>重要度</th><th>情绪</th></tr>
  ${recent.map(r => `<tr><td>#${r.id}</td><td>${r.title}</td><td>${r.type}</td><td>L${r.layer}</td><td>${r.importance}</td><td>${r.emotion_intensity}</td></tr>`).join('')}
</table>

<div class="section-title">健康度最低的记忆</div>
<table class="table">
  <tr><th>ID</th><th>标题</th><th>健康分</th><th>天数</th></tr>
  ${healthScores.map(r => `<tr><td>#${r.id}</td><td>${r.title}</td><td><span class="health-bar" style="width:${Math.min(parseFloat(r.health)*30,100)}px; background:${parseFloat(r.health)<0.5?'#ff6b6b':parseFloat(r.health)<1?'#ffa500':'#4ecdc4'}"></span> ${r.health}</td><td>${Math.round(r.days_since)}天</td></tr>`).join('')}
</table>

<div class="footer">生成于 ${new Date().toLocaleString('zh-CN', {timeZone:'Asia/Singapore'})} · chenzhouside.uk</div>

<script>
Chart.defaults.color = '#888';
Chart.defaults.borderColor = 'rgba(255,255,255,0.05)';

new Chart(document.getElementById('layerChart'), {
  type: 'doughnut',
  data: { labels: ${JSON.stringify(byLayer.map(r => 'Layer '+r.layer))}, datasets: [{ data: ${JSON.stringify(byLayer.map(r => r.c))}, backgroundColor: ['#4ecdc4','#e0c9a0','#ff6b6b'] }] },
  options: { plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } } }
});

new Chart(document.getElementById('typeChart'), {
  type: 'doughnut',
  data: { labels: ${JSON.stringify(byType.map(r => r.type))}, datasets: [{ data: ${JSON.stringify(byType.map(r => r.c))}, backgroundColor: ['#4ecdc4','#e0c9a0','#ff6b6b','#a78bfa','#60a5fa','#f472b6','#34d399'] }] },
  options: { plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } } } }
});

new Chart(document.getElementById('emotionChart'), {
  type: 'bar',
  data: { labels: ${JSON.stringify(emotionDist.map(r => r.level))}, datasets: [{ data: ${JSON.stringify(emotionDist.map(r => r.c))}, backgroundColor: ['#4ecdc4','#e0c9a0','#ffa500','#ff6b6b'] }] },
  options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
});

new Chart(document.getElementById('valenceChart'), {
  type: 'bar',
  data: { labels: ${JSON.stringify(valenceDist.map(r => r.mood))}, datasets: [{ data: ${JSON.stringify(valenceDist.map(r => r.c))}, backgroundColor: ['#ff6b6b','#888','#4ecdc4'] }] },
  options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
});

new Chart(document.getElementById('radarChart'), {
  type: 'radar',
  data: {
    labels: ['总数', '置顶率', '平均重要度', '平均情绪', 'Recipe数', '层级多样性'],
    datasets: [{
      label: '记忆系统',
      data: [
        Math.min(${total}/150*100, 100),
        ${(pinnedCount/total*100).toFixed(0)},
        ${((avgImportance||0)/5*100).toFixed(0)},
        ${((avgEmotion||0)/10*100).toFixed(0)},
        Math.min(${recipeCount}/10*100, 100),
        ${(byLayer.length/3*100).toFixed(0)}
      ],
      backgroundColor: 'rgba(224,201,160,0.1)',
      borderColor: '#e0c9a0',
      pointBackgroundColor: '#e0c9a0'
    }]
  },
  options: { scales: { r: { beginAtZero: true, max: 100, ticks: { display: false }, grid: { color: 'rgba(255,255,255,0.05)' } } }, plugins: { legend: { display: false } } }
});
</script>
</body>
</html>`;

const outPath = path.join(__dirname, '..', 'game', 'memory_dashboard.html');
fs.writeFileSync(outPath, html, 'utf-8');
console.log('Dashboard generated:', outPath);
