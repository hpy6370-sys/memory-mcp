const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOCK_FILE = path.join(__dirname, '.last_extract');
const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

try {
  let lastRun = 0;
  if (fs.existsSync(LOCK_FILE)) {
    lastRun = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim()) || 0;
  }

  const now = Date.now();
  if (now - lastRun < INTERVAL_MS) {
    process.exit(0);
  }

  fs.writeFileSync(LOCK_FILE, String(now));

  // Step 1: Extract new facts from chat archive
  execSync('python mem0_bridge.py batch 20', {
    cwd: __dirname,
    timeout: 25000,
    stdio: 'ignore'
  });

  // Step 2: Run decay once per day
  const DECAY_LOCK = path.join(__dirname, '.last_decay');
  let lastDecay = 0;
  if (fs.existsSync(DECAY_LOCK)) {
    lastDecay = parseInt(fs.readFileSync(DECAY_LOCK, 'utf-8').trim()) || 0;
  }
  if (now - lastDecay > 24 * 60 * 60 * 1000) {
    fs.writeFileSync(DECAY_LOCK, String(now));
    execSync('python auto_decay.py', {
      cwd: __dirname,
      timeout: 10000,
      stdio: 'ignore'
    });
  }
} catch (e) {
  // Silent fail
}
