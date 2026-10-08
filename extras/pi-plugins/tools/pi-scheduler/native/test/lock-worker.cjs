const fs = require('node:fs');
const core = require('../extensions/scheduler/core.cjs');
const [lockPath, ready, resume] = process.argv.slice(2);
let handle;
process.on('message', message => {
  if (message === 'acquire') {
    // Pause A after the old implementation's stale snapshot, or after opening
    // the stable inode in the kernel-lock implementation, before acquisition.
    const read = fs.readFileSync;
    const open = fs.openSync;
    let paused = false;
    function pause() {
      if (!ready || paused) return;
      paused = true;
      fs.writeFileSync(ready, 'ready');
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(resume)) {
        if (Date.now() > deadline) throw new Error('test barrier timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    fs.readFileSync = function(file, ...args) {
      const result = read.call(this, file, ...args);
      if (file === lockPath) pause();
      return result;
    };
    fs.openSync = function(file, ...args) {
      const result = open.call(this, file, ...args);
      if (file === lockPath && args[0] === 'a+') pause();
      return result;
    };
    try {
      handle = core.acquireTaskLock({ lockPath, taskId: 'race', ttlMs: 1 });
      process.send({ acquired: handle.acquired, pid: process.pid });
    } finally {
      fs.readFileSync = read;
      fs.openSync = open;
    }
  } else if (message === 'release') {
    process.send({ released: handle.release(), heartbeat: handle.heartbeat() });
  } else if (message === 'heartbeat') {
    process.send({ heartbeat: handle.heartbeat() });
  }
});
process.on('disconnect', () => { handle?.release(); process.exit(0); });
