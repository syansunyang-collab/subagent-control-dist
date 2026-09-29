// Fleet 的跨解释器 OS 锁。锁文件是永久载体，不是 owner/PID 文件；绝不 unlink 或按年龄回收。
// Windows: 与 msvcrt.locking(fd, LK_NBLCK, 1) 相同的 [0, 1) 独占区间。
// POSIX: 与 fcntl.flock(fd, LOCK_EX | LOCK_NB) 相同的 open-file-description 锁。
// Koffi 必须作为外部原生依赖随部署携带，不能仅将 JS 打成单文件。
import { closeSync, openSync } from "node:fs";
import { constants } from "node:os";
import koffi from "koffi";

let backend;

function osError(operation, code, target) {
  const error = new Error(`${operation} failed (${code}): ${target}`);
  error.code = code;
  return error;
}

function nativeBackend() {
  if (backend) return backend;
  if (process.platform === "win32") {
    const kernel = koffi.load("kernel32.dll");
    const create = kernel.func("intptr_t __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, intptr_t)");
    const lock = kernel.func("int __stdcall LockFileEx(intptr_t, uint32_t, uint32_t, uint32_t, uint32_t, void *)");
    const close = kernel.func("int __stdcall CloseHandle(intptr_t)");
    const lastError = kernel.func("uint32_t __stdcall GetLastError()");
    backend = (target) => {
      // OPEN_ALWAYS, GENERIC_READ|WRITE, SHARE_READ|WRITE. Non-inheritable handle.
      // No FILE_SHARE_DELETE: prevents path replacement while this handle is open.
      const handle = create(target, 0xc0000000, 3, null, 4, 0x80, 0);
      if (handle === -1 || handle === -1n) throw osError("CreateFileW", lastError(), target);
      let held = false;
      try {
        // Zeroed OVERLAPPED: Offset/OffsetHigh=0, hEvent=NULL; synchronous handle.
        const overlapped = Buffer.alloc(koffi.sizeof("uintptr_t") * 3 + 8);
        held = Boolean(lock(handle, 3, 0, 1, 0, overlapped)); // EXCLUSIVE | FAIL_IMMEDIATELY
        if (!held) {
          const code = lastError();
          if (code === 33) return null; // ERROR_LOCK_VIOLATION, not an arbitrary I/O error
          throw osError("LockFileEx", code, target);
        }
        return () => {
          if (!close(handle)) throw osError("CloseHandle", lastError(), target);
        };
      } finally {
        if (!held) close(handle);
      }
    };
  } else {
    // The current process exports libc symbols on POSIX (glibc and musl included).
    const libc = koffi.load(null);
    const flock = libc.func("int flock(int, int)");
    backend = (target) => {
      const fd = openSync(target, "a+");
      let held = false;
      try {
        let result;
        do { result = flock(fd, 2 | 4); } while (result !== 0 && koffi.errno() === constants.errno.EINTR);
        held = result === 0;
        if (!held) {
          const code = koffi.errno();
          if (code === constants.errno.EAGAIN || code === constants.errno.EWOULDBLOCK) return null;
          throw osError("flock", code, target);
        }
        return () => closeSync(fd); // Closing the last descriptor releases flock, including on crash.
      } finally {
        if (!held) closeSync(fd);
      }
    };
  }
  return backend;
}

/** One nonblocking attempt. Returns an opaque release token, or null only for contention. */
export function tryFileLock(target) {
  const release = nativeBackend()(target);
  if (release === null) return null;
  let released = false;
  return Object.freeze({
    release() {
      if (released) return;
      released = true;
      release();
    },
  });
}
