"""隔离验收用的 protocol 4 客户端；只运行显式指定的 helper。"""
import json
import queue
import subprocess
import threading
from pathlib import Path


class Bridge:
    def __init__(self, helper, output):
        self.output = Path(output)
        self.error_log = (self.output / 'helper.stderr.log').open('w', encoding='utf-8')
        self.process = subprocess.Popen([str(Path(helper).resolve())], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=self.error_log, text=True, encoding='utf-8')
        self.lines = queue.Queue()
        self.serial = 0
        self.trace = []
        threading.Thread(target=self.read_lines, daemon=True).start()

    def read_lines(self):
        for line in self.process.stdout:
            self.lines.put(line)
        self.lines.put(None)

    def call(self, name, arguments):
        self.serial += 1
        request = {'protocolVersion': 4, 'id': str(self.serial), 'cmd': name, 'args': arguments}
        self.process.stdin.write(json.dumps(request, ensure_ascii=False) + '\n')
        self.process.stdin.flush()
        line = self.lines.get(timeout=25)
        if line is None:
            raise RuntimeError(f'helper exited: {self.process.poll()}')
        reply = json.loads(line)
        assert reply['id'] == request['id'], reply
        self.trace.append({'request': request, 'reply': reply})
        return reply

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.error_log.close()
        (self.output / 'protocol-trace.json').write_text(
            json.dumps(self.trace, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

