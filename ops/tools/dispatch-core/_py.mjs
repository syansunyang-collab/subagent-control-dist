// dispatch-core 的 Python 语义层：波 1 里九个模块各自私造的 Python 内建 / 标准库语义在此收敛为唯一真源。
// 命名规则：Python 名的 camelCase 加 py 前缀；每个导出的首行注释写它复刻的 Python 语义与已知偏差。
// _tool_common.mjs 已提供的 isAbsoluteLikePython / pathlibJoin / isRecord / pyError 只在此转出，不重复实现。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { isAbsoluteLikePython, isRecord, pathlibJoin, pyError, resolveLikePython } from "./_tool_common.mjs";

export { isRecord, pyError };

// PurePath.is_absolute()：Windows 要求盘符加根或完整 UNC（`//server` 缺共享名不算），`/foo` 是有根无盘。
export { isAbsoluteLikePython as pyIsAbsolute };

// pathlib 的 `base / other`：other 绝对时取 other，Windows 上有根无盘的 other 继承 base 的盘符，否则拼接。
// 已知偏差：盘符相对形态（`E:b`）Python 会按盘符归并，这里退化为普通相对路径拼接；返回的是拼接后的原样
// 字符串而不是 str(PurePath(...)) 的规范形态（分隔符方向、UNC 锚点的尾随分隔符可能不同），需要规范形态用 pyPureStr。
export { pathlibJoin as pyPathJoin };

// ---- 字符集常量 ----

// str.isspace() 的字符集；JS 的 \s 与之有出入（\s 多 U+FEFF，少 \x1c-\x1f 与 \x85）。
export const PY_SPACE_CLASS = "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
// 单个 str.isspace() 字符的匹配器；调用方要拼自己的正则时用 PY_SPACE_CLASS。
export const PY_SPACE_RE = new RegExp(`[${PY_SPACE_CLASS}]`);
// str.isalnum()：字母（L*）或数字（N*）。
export const PY_ALNUM_RE = /[\p{L}\p{N}]/u;

const RE_LSTRIP = new RegExp(`^[${PY_SPACE_CLASS}]+`);
const RE_RSTRIP = new RegExp(`[${PY_SPACE_CLASS}]+$`);
// str.splitlines() 的行边界集合；\x1f 不是行边界（与 isspace 集合的差别）。
const RE_LINE_BOUNDARY = /\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/;
// str.casefold() 与 toLowerCase() 有差异的常用码位（全折叠展开）。
const CASEFOLD_EXTRA = new Map([
  ["ß", "ss"], ["ﬀ", "ff"], ["ﬁ", "fi"], ["ﬂ", "fl"], ["ﬃ", "ffi"], ["ﬄ", "ffl"], ["ﬅ", "st"], ["ﬆ", "st"],
  ["ς", "σ"], ["ϐ", "β"], ["ϑ", "θ"], ["ϕ", "φ"], ["ϖ", "π"], ["ϰ", "κ"], ["ϱ", "ρ"], ["ϵ", "ε"], ["ẛ", "ṡ"],
  ["ﬓ", "մն"], ["ﬔ", "մե"], ["ﬕ", "մի"], ["ﬖ", "վն"], ["ﬗ", "մխ"],
]);
// str.isprintable() 取反：Cc/Cf/Cs/Co/Cn/Zl/Zp 与空格以外的 Zs 都不可打印，repr 要转义。
const NON_PRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

// ---- 字符串 ----

// str.strip()：两端剥 str.isspace() 字符；JS trim() 的字符集与之不同。
export function pyStrip(value) {
  return String(value ?? "").replace(RE_LSTRIP, "").replace(RE_RSTRIP, "");
}

// str.lstrip()。
export function pyLStrip(value) {
  return String(value ?? "").replace(RE_LSTRIP, "");
}

// str.rstrip()。
export function pyRStrip(value) {
  return String(value ?? "").replace(RE_RSTRIP, "");
}

// str.strip(chars)：两端逐字符剥掉 chars 里出现的字符。
export function pyStripChars(value, chars) {
  const text = String(value ?? "");
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start])) start += 1;
  while (end > start && chars.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

// str.rstrip(chars)：右端逐字符剥掉 chars 里出现的字符。
export function pyRStripChars(value, chars) {
  const text = String(value ?? "");
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

// str.casefold()：先 toLowerCase()，再对全折叠码位（ß→ss 等）展开；表外的稀有码位仍按 toLowerCase()。
export function pyCasefold(value) {
  let out = "";
  for (const ch of String(value ?? "").toLowerCase()) out += CASEFOLD_EXTRA.get(ch) ?? ch;
  return out;
}

// str.splitlines()：空串给空列表，行尾边界不产生末尾空串，\x1f 不算边界。
export function pySplitLines(value) {
  const text = String(value ?? "");
  if (!text) return [];
  const parts = text.split(RE_LINE_BOUNDARY);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// repr()：字符串默认单引号，含单引号且不含双引号时改双引号；不可打印字符按 \xNN / \uNNNN / \UNNNNNNNN 转义。
// 已知偏差：JS 只有一种数字类型，Python 的 repr(1.0)=="1.0" 在此写作 "1"。
export function pyRepr(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isRecord(value)) return `{${Object.entries(value).map(([key, item]) => `${pyRepr(key)}: ${pyRepr(item)}`).join(", ")}}`;
  const text = String(value);
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === " " || !NON_PRINTABLE_RE.test(ch)) out += ch;
    else if (code <= 0xff) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return out + quote;
}

// str()：None/True/False 有专门文案，容器退化为 repr()。
export function pyStr(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  return pyRepr(value);
}

// type(x).__name__：只覆盖 JSON 值域内的类型。
export function pyTypeName(value) {
  if (value === null || value === undefined) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  return "dict";
}

// bool(x)：None/False/0/""/[]/{} 为假；JS 的 Boolean([]) 与 Boolean({}) 为真，不能直接用。
export function pyTruthy(value) {
  if (value === null || value === undefined || value === false || value === "") return false;
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

// `a or b or c`：返回第一个真值，全假返回最后一个实参。
export function pyOr(...values) {
  for (const value of values.slice(0, -1)) {
    if (pyTruthy(value)) return value;
  }
  return values[values.length - 1];
}

// float()：接受 bool/数值/十进制字符串（含下划线分隔、inf/nan 别名）；Python 拒绝的 0x10 这里同样拒绝。
export function pyFloat(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const text = pyStrip(value).replace(/(?<=[0-9])_(?=[0-9])/g, "");
    if (/^[+-]?(?:inf|infinity)$/i.test(text)) return text.startsWith("-") ? -Infinity : Infinity;
    if (/^[+-]?nan$/i.test(text)) return Number.NaN;
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
      throw pyError("ValueError", `could not convert string to float: ${pyRepr(value)}`);
    }
    return Number(text);
  }
  throw pyError("TypeError", `float() argument must be a string or a real number, not '${pyTypeName(value)}'`);
}

// ---- 映射 ----

// str(KeyError(msg)) 是 msg 的 repr（带引号）；消费面（lint 的 `[str(exc)]`）直接吃这一形态。
export function pyKeyError(message) {
  return pyError("KeyError", pyRepr(message));
}

// dict[key]：缺键抛 KeyError，非映射按 Python 各自的下标错误文案抛 TypeError。
export function pyGetItem(container, key) {
  if (isRecord(container)) {
    if (!Object.hasOwn(container, key)) throw pyKeyError(key);
    return container[key];
  }
  if (Array.isArray(container)) {
    throw pyError("TypeError", `list indices must be integers or slices, not ${pyTypeName(key)}`);
  }
  if (typeof container === "string") {
    throw pyError("TypeError", `string indices must be integers, not '${pyTypeName(key)}'`);
  }
  throw pyError("TypeError", `'${pyTypeName(container)}' object is not subscriptable`);
}

// dict.get(key, default)：非映射时按缺键处理（Python 会抛 AttributeError，见各模块的异常映射表）。
export function pyGet(container, key, fallback = undefined) {
  return isRecord(container) && Object.hasOwn(container, key) ? container[key] : fallback;
}

// ---- JSON ----

// json.dumps(..., ensure_ascii=False)；compact 时用 separators=(",", ":")，否则用默认的 (", ", ": ")。
// 已知偏差：不排序键，float 1.0 写作 1。
export function pyJsonDumps(value, { compact = false } = {}) {
  const itemSep = compact ? "," : ", ";
  const keySep = compact ? ":" : ": ";
  const walk = (item) => {
    if (item === null || item === undefined) return "null";
    if (Array.isArray(item)) return `[${item.map(walk).join(itemSep)}]`;
    if (typeof item === "object") {
      return `{${Object.entries(item)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => `${JSON.stringify(String(key))}${keySep}${walk(entry)}`)
        .join(itemSep)}}`;
    }
    return JSON.stringify(item);
  };
  return walk(value);
}

// ---- CPython json 解码器的最小复刻：错误文案逐字一致，NaN/Infinity 与 Python 同样接受 ----
// JS 原生 JSON.parse 的错误文案与 Python 完全不同，而 parse_seed / parse_package / route_card 的
// ToolError 文案内嵌 JSONDecodeError 文案，故整段复刻扫描器。

const JSON_WS = " \t\n\r";
const JSON_BACKSLASH = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const JSON_NUMBER_RE = /(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?/y;

class ScanStop {
  constructor(idx) {
    this.idx = idx;
  }
}

function jsonDecodeError(msg, doc, pos) {
  let lineno = 1;
  for (let i = 0; i < pos && i < doc.length; i += 1) if (doc[i] === "\n") lineno += 1;
  const lastNewline = pos === 0 ? -1 : doc.lastIndexOf("\n", pos - 1);
  return pyError("JSONDecodeError", `${msg}: line ${lineno} column ${pos - lastNewline} (char ${pos})`);
}

function jsonSkipWs(s, idx) {
  let cur = idx;
  while (cur < s.length && JSON_WS.includes(s[cur])) cur += 1;
  return cur;
}

function decodeUXXXX(s, pos) {
  const esc = s.slice(pos + 1, pos + 5);
  if (esc.length === 4 && esc[1] !== "x" && esc[1] !== "X" && /^[0-9a-fA-F]{4}$/.test(esc)) {
    return Number.parseInt(esc, 16);
  }
  throw jsonDecodeError("Invalid \\uXXXX escape", s, pos);
}

function jsonScanString(s, start) {
  const begin = start - 1;
  let end = start;
  let out = "";
  for (;;) {
    let idx = end;
    while (idx < s.length) {
      const code = s.charCodeAt(idx);
      if (code === 0x22 || code === 0x5c || code <= 0x1f) break;
      idx += 1;
    }
    if (idx >= s.length) throw jsonDecodeError("Unterminated string starting at", s, begin);
    out += s.slice(end, idx);
    const terminator = s[idx];
    end = idx + 1;
    if (terminator === '"') break;
    // 文案取 CPython 的 C 扫描器（默认实现）：不带出错字符的 repr，位置指向出错字符本身。
    if (terminator !== "\\") throw jsonDecodeError("Invalid control character at", s, end - 1);
    if (end >= s.length) throw jsonDecodeError("Unterminated string starting at", s, begin);
    const esc = s[end];
    if (esc !== "u") {
      if (!Object.hasOwn(JSON_BACKSLASH, esc)) throw jsonDecodeError("Invalid \\escape", s, end - 1);
      out += JSON_BACKSLASH[esc];
      end += 1;
    } else {
      let uni = decodeUXXXX(s, end);
      end += 5;
      if (uni >= 0xd800 && uni <= 0xdbff && s.slice(end, end + 2) === "\\u") {
        const uni2 = decodeUXXXX(s, end + 1);
        if (uni2 >= 0xdc00 && uni2 <= 0xdfff) {
          uni = 0x10000 + (((uni - 0xd800) << 10) | (uni2 - 0xdc00));
          end += 6;
        }
      }
      out += String.fromCodePoint(uni);
    }
  }
  return [out, end];
}

function jsonSetKey(target, key, value) {
  if (key === "__proto__") Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  else target[key] = value;
}

function jsonObject(s, start) {
  const pairs = {};
  let end = start;
  let nextchar = s.slice(end, end + 1);
  if (nextchar !== '"') {
    if (nextchar && JSON_WS.includes(nextchar)) {
      end = jsonSkipWs(s, end);
      nextchar = s.slice(end, end + 1);
    }
    if (nextchar === "}") return [pairs, end + 1];
    if (nextchar !== '"') throw jsonDecodeError("Expecting property name enclosed in double quotes", s, end);
  }
  end += 1;
  for (;;) {
    let key;
    [key, end] = jsonScanString(s, end);
    if (s.slice(end, end + 1) !== ":") {
      end = jsonSkipWs(s, end);
      if (s.slice(end, end + 1) !== ":") throw jsonDecodeError("Expecting ':' delimiter", s, end);
    }
    end += 1;
    if (end < s.length && JSON_WS.includes(s[end])) {
      end += 1;
      if (end < s.length && JSON_WS.includes(s[end])) end = jsonSkipWs(s, end + 1);
    }
    let value;
    try {
      [value, end] = jsonScanOnce(s, end);
    } catch (error) {
      if (error instanceof ScanStop) throw jsonDecodeError("Expecting value", s, error.idx);
      throw error;
    }
    jsonSetKey(pairs, key, value);
    if (end < s.length) {
      nextchar = s[end];
      if (JSON_WS.includes(nextchar)) {
        end = jsonSkipWs(s, end + 1);
        nextchar = end < s.length ? s[end] : "";
      }
    } else {
      nextchar = "";
    }
    end += 1;
    if (nextchar === "}") break;
    if (nextchar !== ",") throw jsonDecodeError("Expecting ',' delimiter", s, end - 1);
    end = jsonSkipWs(s, end);
    nextchar = s.slice(end, end + 1);
    end += 1;
    if (nextchar !== '"') throw jsonDecodeError("Expecting property name enclosed in double quotes", s, end - 1);
  }
  return [pairs, end];
}

function jsonArray(s, start) {
  const values = [];
  let end = start;
  let nextchar = s.slice(end, end + 1);
  if (nextchar && JSON_WS.includes(nextchar)) {
    end = jsonSkipWs(s, end + 1);
    nextchar = s.slice(end, end + 1);
  }
  if (nextchar === "]") return [values, end + 1];
  for (;;) {
    let value;
    try {
      [value, end] = jsonScanOnce(s, end);
    } catch (error) {
      if (error instanceof ScanStop) throw jsonDecodeError("Expecting value", s, error.idx);
      throw error;
    }
    values.push(value);
    nextchar = s.slice(end, end + 1);
    if (nextchar && JSON_WS.includes(nextchar)) {
      end = jsonSkipWs(s, end + 1);
      nextchar = s.slice(end, end + 1);
    }
    end += 1;
    if (nextchar === "]") break;
    if (nextchar !== ",") throw jsonDecodeError("Expecting ',' delimiter", s, end - 1);
    if (end < s.length && JSON_WS.includes(s[end])) {
      end += 1;
      if (end < s.length && JSON_WS.includes(s[end])) end = jsonSkipWs(s, end + 1);
    }
  }
  return [values, end];
}

function jsonScanOnce(s, idx) {
  if (idx >= s.length) throw new ScanStop(idx);
  const nextchar = s[idx];
  if (nextchar === '"') return jsonScanString(s, idx + 1);
  if (nextchar === "{") return jsonObject(s, idx + 1);
  if (nextchar === "[") return jsonArray(s, idx + 1);
  if (nextchar === "n" && s.slice(idx, idx + 4) === "null") return [null, idx + 4];
  if (nextchar === "t" && s.slice(idx, idx + 4) === "true") return [true, idx + 4];
  if (nextchar === "f" && s.slice(idx, idx + 5) === "false") return [false, idx + 5];
  JSON_NUMBER_RE.lastIndex = idx;
  const match = JSON_NUMBER_RE.exec(s);
  if (match) {
    const [whole, integer, frac, exp] = match;
    // Python int("-0") 是 0，JS Number("-0") 是 -0；整数分支归一掉负零。
    const value = frac || exp ? Number.parseFloat(integer + (frac || "") + (exp || "")) : Number(integer) || 0;
    return [value, idx + whole.length];
  }
  if (nextchar === "N" && s.slice(idx, idx + 3) === "NaN") return [Number.NaN, idx + 3];
  if (nextchar === "I" && s.slice(idx, idx + 8) === "Infinity") return [Number.POSITIVE_INFINITY, idx + 8];
  if (nextchar === "-" && s.slice(idx, idx + 9) === "-Infinity") return [Number.NEGATIVE_INFINITY, idx + 9];
  throw new ScanStop(idx);
}

// json.loads()：成功返回值，失败抛 name 为 JSONDecodeError、message 与 Python str(exc) 逐字相同的错误。
export function pyJsonLoads(text) {
  const s = String(text);
  let obj;
  let end;
  try {
    [obj, end] = jsonScanOnce(s, jsonSkipWs(s, 0));
  } catch (error) {
    if (error instanceof ScanStop) throw jsonDecodeError("Expecting value", s, error.idx);
    throw error;
  }
  end = jsonSkipWs(s, end);
  if (end !== s.length) throw jsonDecodeError("Extra data", s, end);
  return obj;
}

// ---- 文件读取 ----

// Path.read_text(encoding="utf-8")：严格 UTF-8，非法字节抛错；文本模式 newline=None，\r\n 与 \r 归一为 \n。
// 已知偏差：UnicodeDecodeError 的 message 不逐字复刻（Python 带字节偏移，Node 拿不到）。
export function pyReadText(file) {
  const raw = readFileSync(file);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw pyError("UnicodeDecodeError", `'utf-8' codec can't decode file: ${String(file)}`);
  }
  return text.replace(/\r\n?/g, "\n");
}

// Path.read_text(encoding="utf-8", errors="replace")：非法字节换成 U+FFFD，同样按 newline=None 归一换行。
export function pyReadTextReplace(file) {
  return readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
}

// ---- 路径 ----

// os.path.normcase()：Windows 上小写并把 "/" 统一成 "\"，其它平台原样返回。
export function pyNormcase(value) {
  const text = String(value);
  return process.platform === "win32" ? text.replace(/\//g, "\\").toLowerCase() : text;
}

// PurePath 的相等：按 normcase 后的整串比较，Windows 上大小写与分隔符都不敏感。
export function pySamePath(left, right) {
  return pyNormcase(left) === pyNormcase(right);
}

// PurePath.anchor：分隔符归一（Windows 用 \），UNC 共享名后补回 pathlib 会带的根分隔符。
function pathAnchor(root) {
  if (process.platform !== "win32") return root;
  const anchor = root.replace(/\//g, "\\");
  return /^\\\\[^\\]+\\[^\\]+$/.test(anchor) ? `${anchor}\\` : anchor;
}

// PurePath 的 anchor / parts 拆解；"." 分段按 pathlib 丢弃，".." 保留。
function pathParts(value) {
  const raw = String(value);
  const root = path.parse(raw).root;
  const rest = raw.slice(root.length).split(/[\\/]+/).filter((part) => part && part !== ".");
  return { anchor: pathAnchor(root), parts: rest };
}

// str(PurePath(value))：分隔符归一、折叠重复分隔符与 "." 段、去掉尾随分隔符；空串给 "."。
export function pyPureStr(value) {
  const { anchor, parts } = pathParts(value);
  if (!parts.length) return anchor || ".";
  return anchor + parts.join(process.platform === "win32" ? "\\" : "/");
}

// PurePath.is_relative_to()：纯词法比较，不做 resolve。
export function pyIsRelativeTo(child, parent) {
  const left = pathParts(child);
  const right = pathParts(parent);
  if (pyNormcase(left.anchor) !== pyNormcase(right.anchor)) return false;
  if (right.parts.length > left.parts.length) return false;
  return right.parts.every((part, index) => pyNormcase(part) === pyNormcase(left.parts[index]));
}

// PurePath.relative_to().as_posix()；不在子路径时抛 Python 的 ValueError，文案逐字相同。
export function pyRelativeToPosix(child, parent) {
  if (!pyIsRelativeTo(child, parent)) {
    throw pyError("ValueError", `${pyRepr(pyPureStr(child))} is not in the subpath of ${pyRepr(pyPureStr(parent))}`);
  }
  const tail = pathParts(child).parts.slice(pathParts(parent).parts.length);
  return tail.length ? tail.join("/") : ".";
}

// `try: Path(child).relative_to(parent).as_posix() except ValueError: None` 的组合。
export function pyRelativeTo(child, parent) {
  return pyIsRelativeTo(child, parent) ? pyRelativeToPosix(child, parent) : null;
}

// `Path(v).resolve() if Path(v).is_absolute() else (base / v).resolve()`。
export function pyResolveUnder(value, base) {
  return resolveLikePython(pathlibJoin(base, value));
}

// ---- 子进程 ----

// subprocess.run(argv) 的 Windows 等价：Node 从 v18 起拒绝直接 spawn .cmd/.bat，
// 而 Python 的 CreateProcess 能直接执行它们；这里对批处理包装器改走 cmd.exe 并自行加引号。
export function pySpawnSync(command, args, options) {
  const cmd = String(command);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd)) {
    const quote = (value) => {
      const text = String(value);
      return /[\s"^&|<>()%!]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
    };
    const line = [cmd, ...args].map(quote).join(" ");
    return spawnSync(line, [], { ...options, shell: true });
  }
  return spawnSync(cmd, args, options);
}
