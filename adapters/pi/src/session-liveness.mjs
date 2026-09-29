const REGISTRY_KEY = "@agegr/pi-web/session-liveness/v1";
const PROTOCOL_VERSION = 1;

const NO_RELEASE = () => {};

function hostRegistry() {
  const candidate = globalThis[Symbol.for(REGISTRY_KEY)];
  if (!candidate || typeof candidate !== "object") return null;
  if (candidate.version !== PROTOCOL_VERSION) return null;
  if (typeof candidate.register !== "function") return null;
  return candidate;
}

/**
 * 向宿主登记"本会话仍有脱离当前 agent run 的在途工作"，阻止空闲回收。
 * 只有 Pi Web 提供该注册表；TUI 与 RPC 宿主没有空闲回收，登记退化为无操作。
 * 登记失败不影响会话启动：拿不到租约的后果是回到未登记现状，而不是会话起不来。
 * 返回幂等的释放函数。
 */
export function registerSessionLiveness({ name, sessionId, sessionFile, isActive } = {}) {
  const registry = hostRegistry();
  if (!registry) return NO_RELEASE;
  const holder = String(name ?? "").trim();
  const id = String(sessionId ?? "").trim();
  const file = String(sessionFile ?? "").trim();
  if (!holder || !id || typeof isActive !== "function") return NO_RELEASE;
  try {
    const release = registry.register({
      name: holder,
      sessionId: id,
      ...(file ? { sessionFile: file } : {}),
      // 宿主要求同步、廉价、不抛错；内部状态读失败按"仍有在途"处理，宁可晚回收不可丢通知。
      isActive: () => {
        try {
          return isActive() === true;
        } catch {
          return true;
        }
      },
    });
    return typeof release === "function" ? release : NO_RELEASE;
  } catch {
    return NO_RELEASE;
  }
}

export function hasSessionLivenessHost() {
  return hostRegistry() !== null;
}
