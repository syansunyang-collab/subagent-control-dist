import { parentPort, workerData } from "node:worker_threads";
import { createConfigStore } from "./config-store.mjs";
import { createSelectionStore } from "./selection-store.mjs";

// TOML 解析、复验和写入留在同一个 worker；所有配置写操作共用一条队列。
const store = createConfigStore(workerData);
const selection = createSelectionStore({ ...workerData, faultInjector: workerData.selectionFaultInjector });
const methods = new Set(["state", "configState", "resourceCatalog", "refreshCatalogs", "saveRole", "saveImports", "selectionState", "saveSelection", "sync", "close"]);
const writes = new Set(["saveRole", "saveImports", "saveSelection", "sync"]);
let writeTail = Promise.resolve();
parentPort.on("message", async ({ id, method, args }) => {
  try {
    if (!methods.has(method)) throw new Error("unsupported config method");
    const invoke = () => method === "selectionState"
      ? selection.selectionState({ catalogs: store.catalogs() }, ...args)
      : method === "saveSelection"
        ? selection.saveSelection(args[0], { catalogs: store.catalogs() }, args[1])
        : method === "sync" ? selection.sync()
        : store[method](...args);
    let result;
    if (method === "close") {
      await writeTail;
      result = await invoke();
    } else if (writes.has(method)) {
      const queued = writeTail.then(invoke);
      writeTail = queued.catch(() => {});
      result = await queued;
    } else result = await invoke();
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: {
      code: error.code || "CONFIG_SERVICE_FAILED",
      message: error.code ? error.message : "配置处理失败",
      status: error.status || 503,
      scope: "local",
      details: error.details || null,
    } });
  }
});
