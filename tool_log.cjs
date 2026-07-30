const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'chat_archive');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const logFile = path.join(LOG_DIR, `tools_${today}.jsonl`);

let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || 'unknown';
    const toolInput = data.tool_input || {};

    let inputSummary = '';
    if (typeof toolInput === 'string') {
      inputSummary = toolInput.substring(0, 80);
    } else {
      if (toolInput.file_path) inputSummary = toolInput.file_path;
      else if (toolInput.command) inputSummary = toolInput.command.substring(0, 100);
      else if (toolInput.pattern) inputSummary = toolInput.pattern;
      else if (toolInput.text) inputSummary = (toolInput.text || '').substring(0, 80);
      else if (toolInput.chat_id) inputSummary = `chat:${toolInput.chat_id}`;
      else if (toolInput.title) inputSummary = toolInput.title;
      else if (toolInput.query) inputSummary = toolInput.query;
      else if (toolInput.post_id) inputSummary = `post:${toolInput.post_id}`;
      else inputSummary = JSON.stringify(toolInput).substring(0, 80);
    }

    const entry = {
      ts: new Date().toISOString(),
      tool: toolName,
      input: inputSummary
    };

    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  } catch {}
  console.log(JSON.stringify({}));
});
