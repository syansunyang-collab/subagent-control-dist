import { parentPort, workerData } from "node:worker_threads";

import { createAsyncTaskService } from "./async-core.mjs";
import { PanelProjection } from "./projection.mjs";

let projectionPromise = null;

async function getProjection() {
  if (!projectionPromise) {
    projectionPromise = createAsyncTaskService({
      paths: workerData.paths,
      asyncCorePath: workerData.asyncCorePath,
      registryRoot: workerData.registryRoot,
    }).then(({ core, service }) => new PanelProjection({
      paths: workerData.paths,
      service,
      contractVersion: core.CONTRACT_VERSION,
    }));
  }
  return projectionPromise;
}

function serializeError(error) {
  return {
    code: error?.code || "SERVER_ERROR",
    message: error?.message || "服务处理失败",
    status: error?.status || 500,
    scope: error?.scope || "global",
    details: error?.details || null,
  };
}

parentPort.on("message", async ({ id, method, args }) => {
  try {
    if (workerData.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, workerData.delayMs));
    }
    const projection = await getProjection();
    const result = projection[method](...args);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: serializeError(error) });
  }
});
