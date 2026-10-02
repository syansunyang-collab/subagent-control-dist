import { clock, ids } from "../_tool_common.mjs";
import { pyStr, pyStrip, pyTruthy } from "../_py.mjs";
import { pySlice } from "./py-utils.mjs";

export function makeBatchId(_seeds) {
  const now = clock.now();
  const pad = (value, width) => String(value).padStart(width, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}T`
    + `${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}`
    + `${pad(now.getUTCMilliseconds(), 3)}Z`;
  return `batch-${stamp}-${ids.uuidHex().slice(0, 12)}`;
}

export function sliceMetadata(seed, index) {
  const sliceId = pyStrip(pyStr(
    pyTruthy(seed?.slice_id) ? seed.slice_id : (pyTruthy(seed?.slug) ? seed.slug : `slice-${String(index + 1).padStart(2, "0")}`),
  ));
  const displayTitle = pyStrip(pyStr(
    pyTruthy(seed?.title) ? seed.title : (pyTruthy(seed?.goal) ? seed.goal : sliceId),
  ));
  return [pySlice(sliceId, 120), pySlice(displayTitle, 240)];
}

/** display_title 会进 submit 回包；超长值（尤其长中文 goal）撑爆回包 token 预算，统一按字节截断。 */
export function clampDisplayTitle(text, limitBytes = 120) {
  const encoded = Buffer.from(pyStr(text), "utf8").subarray(0, limitBytes);
  return pyStrip(new TextDecoder("utf-8", { fatal: false }).decode(encoded).replace(/\uFFFD+$/, ""));
}
