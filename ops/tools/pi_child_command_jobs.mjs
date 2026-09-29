import * as fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveChildBash, terminateChildProcessTree, waitForChildProcess } from './pi_child_bash_process_tree.mjs';

export const COMMAND_JOBS_VERSION = 'pi-command-jobs/v1';
export const COMMAND_JOB_TOOL = 'command_job';
export const COMMAND_JOB_SCHEMA = {
  type: 'object', required: ['action'], additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['start', 'status', 'stop'], description: 'start启动；status查看一个或全部；stop停止指定作业并确认清理。' },
    command: { type: 'string', description: 'start必填。填写保持前台运行的Bash命令，由本工具负责后台化和任务内收尾。' },
    kind: { type: 'string', enum: ['command', 'service'], description: '省略为command：安装、构建等等待退出的作业。service用于本任务的临时服务；就绪由调用方检查，交付时收尾。' },
    timeout_seconds: { type: 'number', exclusiveMinimum: 0, maximum: 2147483.647, description: '可选执行期限，单位秒，例如1800为30分钟；省略不设命令期限，仍受所属任务预算和取消约束。与前台等待时间不同。' },
    job_id: { type: 'string', description: 'start返回的本任务作业标识；stop必填，status省略时分页列出作业。' },
    offset: { type: 'integer', minimum: 0, description: 'status列表的起始位置，省略为0，每页20项；查看单个job_id时不使用。' },
  },
};

export function readCommandJobsState(root) {
  if (!fs.existsSync(root)) return { version: COMMAND_JOBS_VERSION, jobs: [], active_commands: 0, active_services: 0, unsafe_jobs: 0 };
  const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
  if (state.version !== COMMAND_JOBS_VERSION || !Array.isArray(state.jobs)) throw new Error('command jobs state unavailable');
  return state;
}

export function createCommandJobs({ root, cwd, owner, waitForExit = waitForChildProcess, shell = resolveChildBash(), env = process.env,
  spawnFn = spawn, stopTree = terminateChildProcessTree, notify = () => {} }) {
  if (typeof waitForExit !== 'function') throw new Error('command jobs require the Pi process wait implementation');
  const items = new Map();
  let closing = false;
  let shutdownPromise;
  let controlError = null;
  fs.mkdirSync(root, { recursive: true });
  const previous = fs.existsSync(path.join(root, 'state.json')) ? readCommandJobsState(root).jobs : [];
  for (const old of previous) {
    const record = { ...old };
    if (['starting', 'running', 'stopping'].includes(record.status)) {
      record.status = 'unknown'; record.cleanup_confirmed = false;
    }
    items.set(record.job_id, { record, child: null });
  }
  function summary() {
    const jobs = [...items.values()].map(({ record }) => ({ ...record }));
    const active = jobs.filter(r => ['starting', 'running', 'stopping'].includes(r.status));
    return { version: COMMAND_JOBS_VERSION, owner, jobs,
      active_commands: active.filter(r=>r.kind === 'command').length,
      active_services: active.filter(r=>r.kind === 'service').length,
      unsafe_jobs: jobs.filter(r=>r.cleanup_confirmed === false).length,
      ...(controlError && { control_error: controlError }) };
  }
  function persist() {
    const file = path.join(root, 'state.json'); const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(summary()));
    try { fs.renameSync(tmp, file); }
    finally { fs.rmSync(tmp, { force: true }); }
  }
  function tail(file) {
    if (!fs.existsSync(file)) return '';
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size; const bytes = Math.min(size, 8192); const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, size - bytes);
      return buf.subarray(0,n).toString('utf8').split('\n').slice(-120).join('\n');
    } finally { fs.closeSync(fd); }
  }
  function get(jobId) {
    const item = items.get(jobId);
    if (!item) throw new Error('job_id未在本任务登记；使用command_job action=status查看标识。');
    return { ...item.record, command: item.record.command.slice(0, 1000), command_truncated: item.record.command.length > 1000,
      stdout_tail: tail(item.record.stdout_path), stderr_tail: tail(item.record.stderr_path) };
  }
  function finish(item, code, error) {
    const r = item.record;
    clearTimeout(item.timer);
    r.exit_code = code; r.signal = item.child?.signalCode ?? null; r.finished_at = new Date().toISOString();
    if (error) r.error = error.message || String(error);
    r.status = r.cleanup_confirmed === false ? 'unknown'
      : r.stop_reason === 'deadline' ? 'timed_out'
      : r.stop_reason ? 'cancelled' : !error && code === 0 ? 'completed' : 'failed';
    if (!r.stop_reason) r.cleanup_confirmed = true;
    persist();
    if (!closing && !['requested', 'task_complete', 'start_failed'].includes(r.stop_reason)) {
      try { notify({ job_id: r.job_id, status: r.status, exit_code: r.exit_code, stop_reason: r.stop_reason,
        stdout_path: r.stdout_path, stderr_path: r.stderr_path }); }
      catch (e) { r.notification_error = String(e.message || e); persist(); }
    }
  }
  async function start({ command, kind = 'command', timeout_seconds } = {}) {
    if (closing) throw new Error('任务正在收尾；请将未完成命令交回主代理。');
    if (typeof command !== 'string' || !command.trim()) throw new Error('start需要非空command。');
    if (!['command','service'].includes(kind)) throw new Error('kind填写command或service。');
    if (timeout_seconds !== undefined && (!Number.isFinite(timeout_seconds) || timeout_seconds <= 0 || timeout_seconds > 2147483.647)) {
      throw new Error('timeout_seconds须为大于0的秒数，且不超过2147483.647。');
    }
    const job_id = randomUUID(); const dir = path.join(root, job_id);
    fs.mkdirSync(dir);
    const record = { job_id, owner, kind, command, cwd, status: 'starting', pid: null,
      started_at: new Date().toISOString(), timeout_seconds: timeout_seconds ?? null,
      stdout_path: path.join(dir, 'stdout.log'), stderr_path: path.join(dir, 'stderr.log'),
      exit_code: null, cleanup_confirmed: null };
    fs.writeFileSync(record.stdout_path, ''); fs.writeFileSync(record.stderr_path, '');
    const item = { record, child: null }; items.set(job_id, item); persist();
    try {
      const child = spawnFn(shell, ['-c', command], { cwd, env: { ...env, PI_COMMAND_JOB_ID: job_id },
        detached: process.platform !== 'win32', stdio: ['ignore','pipe','pipe'], windowsHide: true });
      item.child = child; record.pid = child.pid ?? null;
      let lastPersist = 0;
      const append = (file, data) => {
        fs.appendFileSync(file, data); record.last_output_at = new Date().toISOString();
        if (Date.now() - lastPersist >= 1000) { persist(); lastPersist = Date.now(); }
      };
      child.stdout?.on('data', d=>append(record.stdout_path,d));
      child.stderr?.on('data', d=>append(record.stderr_path,d));
      item.done = Promise.resolve(waitForExit(child)).then(code=>finish(item,code), error=>finish(item,null,error));
      // 终态写入失败保留磁盘上的活动记录，runner不会据此提前收口。
      item.done.catch(error=>{ record.storage_error = String(error.message || error); });
      await new Promise((resolve,reject)=>{ child.once('spawn',resolve); child.once('error',reject); });
      record.status = 'running'; persist();
      if (timeout_seconds !== undefined) item.timer = setTimeout(()=>{
        void stop(job_id, 'deadline').catch(error=>{ record.error=String(error.message||error); record.cleanup_confirmed=false; persist(); });
      }, timeout_seconds * 1000);
      return get(job_id);
    } catch (error) {
      if (item.child?.pid && item.child.exitCode === null) await stop(job_id,'start_failed');
      record.status = 'failed'; record.error = String(error.message || error); persist(); throw error;
    }
  }
  async function stop(jobId, reason = 'requested') {
    const item = items.get(jobId);
    if (!item) return get(jobId);
    if (item.stopping) { await item.stopping; return get(jobId); }
    if (!['starting','running','stopping','unknown'].includes(item.record.status)) return get(jobId);
    if (!item.child) throw new Error('原执行已不受当前管理器持有；保留证据，由主代理核对进程，不重放或按历史PID强杀。');
    if (item.child.exitCode !== null || item.child.signalCode) {
      await Promise.race([item.done, new Promise(resolve=>setTimeout(resolve,250))]);
      if (['starting','running','stopping'].includes(item.record.status)) {
        item.record.status='unknown'; item.record.cleanup_confirmed=false;
        item.record.error='主进程已退出，输出或后代收尾未确认；保留现场由主代理核对。'; persist();
      }
      return get(jobId);
    }
    item.stopping = (async () => {
      const r = item.record; r.status = 'stopping'; r.stop_reason = reason; persist();
      const proof = stopTree(item.child.pid);
      r.cleanup = proof; r.cleanup_confirmed = proof.confirmed === true;
      await Promise.race([item.done, new Promise(resolve=>{const timer=setTimeout(resolve,2000);timer.unref?.();})]);
      if (item.child.exitCode === null && !item.child.signalCode) { r.status='unknown';r.cleanup_confirmed=false; }
      persist();
    })();
    await item.stopping; return get(jobId);
  }
  async function stopServices() {
    for (const item of items.values()) if (item.record.kind === 'service' && ['running','starting','stopping'].includes(item.record.status)) {
      await stop(item.record.job_id,'task_complete');
    }
  }
  function shutdown() {
    closing = true;
    return shutdownPromise ??= (async () => {
      const errors = [];
      for (const item of items.values()) if (['running','starting','stopping','unknown'].includes(item.record.status)) {
        try { await stop(item.record.job_id,'task_shutdown'); } catch(e) { errors.push(String(e.message||e)); }
      }
      persist(); return { ...summary(), errors };
    })();
  }
  // 取消控制文件读不出时记最近一次错误，随 state.json 交给 runner 与 status。
  function recordControlError(error) {
    controlError = { message: String(error.message || error), code: error.code ?? null, at: new Date().toISOString() };
    persist();
  }
  persist();
  return { start, get, stop, stopServices, shutdown, summary, recordControlError };
}

export function installCommandJobs(pi, { jobs, controlFile, attemptId } = {}) {
  pi.registerTool({
    name: COMMAND_JOB_TOOL, label: '后台命令',
    description: '在本任务内启动、查看或停止受管理的后台Bash作业。用于长安装、构建和临时服务。start立即返回job_id，命令结束自动通知；静默不自动终止。status返回有界日志尾部及完整日志路径。沿用本任务命令/写入/网络授权，不是额外沙箱。',
    promptSnippet: '管理长命令与任务内临时服务',
    parameters: COMMAND_JOB_SCHEMA,
    async execute(_id, args, signal) {
      if (signal?.aborted) throw new Error('调用已取消，未启动新作业。');
      const { action, job_id } = args;
      let value;
      if (action === 'start') value = await jobs.start(args);
      else if (action === 'status') {
        if (job_id) value = jobs.get(job_id);
        else {
          const state = jobs.summary(); const offset = args.offset ?? 0;
          value = { ...state, total_jobs: state.jobs.length, offset, next_offset: offset + 20 < state.jobs.length ? offset + 20 : null,
            jobs: state.jobs.slice(offset, offset + 20).map(({ job_id, kind, status, pid, exit_code, cleanup_confirmed }) =>
              ({ job_id, kind, status, pid, exit_code, cleanup_confirmed })) };
        }
      }
      else if (action === 'stop') {
        if (!job_id) throw new Error('stop需要job_id；先用status查看。');
        value = await jobs.stop(job_id);
      } else throw new Error('action填写start、status或stop。');
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
    },
  });
  pi.on('tool_call', async event => {
    if (!['submit_task_result','submit_review_result'].includes(event.toolName)) return;
    if (jobs.summary().active_commands > 0) return { block: true, reason: '后台命令尚未收尾。用command_job status查看，完成消息会自动接续；先完成其他不冲突工作，或结束当前回合等待。需要放弃该命令时用stop。' };
    await jobs.stopServices();
  });
  pi.on('tool_result', event => {
    if (!['submit_task_result','submit_review_result'].includes(event.toolName) || jobs.summary().unsafe_jobs === 0) return;
    return { content: [...event.content, {type:'text',text:'后台作业清理有未确认项；已有成果可以交付，资源占有仍保留，由主代理继续核对。'}] };
  });
  let timer;
  if (controlFile) {
    // 定时器回调不抛出：ENOENT 表示尚无请求；其它读/解析错误记入作业状态，下一拍重读。
    timer = setInterval(()=>{
      try {
        const request = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
        if (request.type === 'abort' && request.attempt_id === attemptId) { clearInterval(timer); void jobs.shutdown(); }
      } catch (e) {
        if (e.code === 'ENOENT') return;
        // state.json 写失败时错误仍留在内存态，status 可见，下一拍重记。
        try { jobs.recordControlError(e); } catch {}
      }
    }, 250);
    timer.unref?.();
  }
  pi.on('session_shutdown', async ()=>{ clearInterval(timer); await jobs.shutdown(); });
}

export default function commandJobsExtension(pi) {
  const config = JSON.parse(process.env.PI_COMMAND_JOBS_CONFIG || 'null');
  if (!config) return;
  pi.on('session_start', () => {
    const jobs = createCommandJobs({ ...config, waitForExit: waitForChildProcess,
      notify: record => pi.sendMessage({ customType: 'command-job-result',
        content: '后台作业结束：' + JSON.stringify(record) + '。未查验时查看日志并验证产物；已查验并交付时复用已有结论，无需重复提交。', display: true },
      { deliverAs: 'followUp', triggerTurn: true }) });
    installCommandJobs(pi, { jobs, controlFile: config.controlFile, attemptId: config.attemptId });
  });
}
