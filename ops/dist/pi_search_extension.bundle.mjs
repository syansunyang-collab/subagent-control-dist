var __defProp = Object.defineProperty;
var __export = (target, all4) => {
  for (var name in all4)
    __defProp(target, name, { get: all4[name], enumerable: true });
};

// ops/node_modules/@tian.zuo/pi-find/lib/tools.ts
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ops/node_modules/@tian.zuo/pi-find/lib/prompt.ts
var GREP_RESULT_LIMIT = 100;
var GREP_FILE_LIMIT = 200;
var FIND_RESULT_LIMIT = 200;
var AUTO_CONTEXT_LINES = 5;
var AUTO_CONTEXT_MAX_MATCHES = 3;
var SEARCH_TIMEOUT_MS = 3e4;
var GREP_TOOL_DESCRIPTION = "Search file contents by case-sensitive regex; respects .gitignore; skips hidden paths. Up to 100 lines or 200 files.";
var GREP_PROMPT_SNIPPET = "Search file contents with a regex";
var GREP_PARAMETER_DESCRIPTIONS = {
  pattern: "Case-sensitive ripgrep regex; prefix (?i) to ignore case.",
  path: "File or directory; defaults to cwd; name hidden paths explicitly ('.github').",
  glob: "Case-sensitive glob: basename (any depth) or path relative to the search root; ! to exclude.",
  output: "Matching lines (default), or file paths only.",
  literal: "Treat pattern as exact text, not regex."
};
var FIND_TOOL_DESCRIPTION = "Find files by case-insensitive glob; respects .gitignore; skips hidden paths. Up to 200 files.";
var FIND_PROMPT_SNIPPET = "Find files with a glob";
var FIND_PARAMETER_DESCRIPTIONS = {
  pattern: "Case-insensitive glob: basename (any depth) or path relative to the search root; ! to exclude.",
  path: "Directory; defaults to cwd; name hidden paths explicitly ('.github')."
};
var QUOTED_PATH_NOTICE = "[JSON-decode quoted paths before read/edit.]";
var FILE_SIZE_LIMIT_NOTICE = "[Files >4 MiB are skipped during traversal.]";
var HIDDEN_PATH_NOTICE = '[Default searches skip hidden paths; set path explicitly to search one (e.g. ".github").]';
var SLASH_GLOB_NOTICE = "[Globs containing / are relative to the search root, not the working directory.]";
var AUTO_CONTEXT_NOTICE = "[Added up to 5 surrounding lines automatically.]";
var NO_GREP_MATCHES = "No matches found.";
var NO_FILES_FOUND = "No files found.";
var EMPTY_PATTERN_ERROR = "Search pattern cannot be empty.";
var GIT_PATH_ERROR = "Searches inside .git are excluded; choose a working-tree path.";
function missingSearchPathError(searchPath) {
  return `Search path does not exist: ${searchPath}.`;
}
function findPathNotDirectoryError(searchPath) {
  return `Find path is not a directory: ${searchPath}.`;
}
function grepResultHeader(matchCount, fileCount, partial = false) {
  const counts = `${matchCount} match${matchCount === 1 ? "" : "es"} in ${fileCount} file${fileCount === 1 ? "" : "s"}`;
  return partial ? `Showing ${counts} (partial results)` : counts;
}
function findResultHeader(fileCount, partial = false) {
  const count = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
  return partial ? `Showing ${count} (partial results)` : count;
}
function resultLimitNotice(kind, limit) {
  return `[Result limit reached at ${limit} ${kind}; narrow pattern, path, or glob.]`;
}
function outputLimitNotice(kind) {
  const unit = kind === "grep" ? "matches" : "files";
  return `[Output limit reached; narrow the search to see the omitted ${unit}.]`;
}
function searchTimeoutNotice(timeoutMs) {
  const seconds2 = Math.round(timeoutMs / 1e3);
  return `[Search timed out after ${seconds2}s; results are partial. Narrow the path, pattern, or glob.]`;
}
function globPrefixNotice(glob, path3, suggestion) {
  return `[Glob ${JSON.stringify(glob)} is relative to path ${JSON.stringify(path3)}; try ${JSON.stringify(suggestion)}.]`;
}
function unreadablePathNotice(detail) {
  return `[Some paths could not be read (${detail}); results may be incomplete.]`;
}
function oversizedRecordNotice(limitBytes) {
  return `[Skipped a record larger than ${Math.round(limitBytes / (1024 * 1024))} MiB; narrow the search.]`;
}

// ops/node_modules/@tian.zuo/pi-find/src/runtime.ts
import { existsSync, realpathSync, statSync as statSync3 } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";

// ops/node_modules/effect/dist/Pipeable.js
var pipeArguments = (self, args2) => {
  switch (args2.length) {
    case 0:
      return self;
    case 1:
      return args2[0](self);
    case 2:
      return args2[1](args2[0](self));
    case 3:
      return args2[2](args2[1](args2[0](self)));
    case 4:
      return args2[3](args2[2](args2[1](args2[0](self))));
    case 5:
      return args2[4](args2[3](args2[2](args2[1](args2[0](self)))));
    case 6:
      return args2[5](args2[4](args2[3](args2[2](args2[1](args2[0](self))))));
    case 7:
      return args2[6](args2[5](args2[4](args2[3](args2[2](args2[1](args2[0](self)))))));
    case 8:
      return args2[7](args2[6](args2[5](args2[4](args2[3](args2[2](args2[1](args2[0](self))))))));
    case 9:
      return args2[8](args2[7](args2[6](args2[5](args2[4](args2[3](args2[2](args2[1](args2[0](self)))))))));
    default: {
      let ret = self;
      for (let i = 0, len = args2.length; i < len; i++) {
        ret = args2[i](ret);
      }
      return ret;
    }
  }
};
var Prototype = {
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var Class = /* @__PURE__ */ (function() {
  function PipeableBase() {
  }
  PipeableBase.prototype = Prototype;
  return PipeableBase;
})();

// ops/node_modules/effect/dist/Function.js
var dual = function(arity, body) {
  if (typeof arity === "function") {
    return function() {
      return arity(arguments) ? body.apply(this, arguments) : (self) => body(self, ...arguments);
    };
  }
  switch (arity) {
    case 0:
    case 1:
      throw new RangeError(`Invalid arity ${arity}`);
    case 2:
      return function(a, b) {
        if (arguments.length >= 2) {
          return body(a, b);
        }
        return function(self) {
          return body(self, a);
        };
      };
    case 3:
      return function(a, b, c) {
        if (arguments.length >= 3) {
          return body(a, b, c);
        }
        return function(self) {
          return body(self, a, b);
        };
      };
    default:
      return function() {
        if (arguments.length >= arity) {
          return body.apply(this, arguments);
        }
        const args2 = arguments;
        return function(self) {
          return body(self, ...args2);
        };
      };
  }
};
var identity = (a) => a;
var constant = (value) => () => value;
var constTrue = /* @__PURE__ */ constant(true);
var constFalse = /* @__PURE__ */ constant(false);
var constNull = /* @__PURE__ */ constant(null);
var constUndefined = /* @__PURE__ */ constant(void 0);
var constVoid = constUndefined;

// ops/node_modules/effect/dist/internal/equal.js
var getAllObjectKeys = (obj) => {
  const keys = new Set(Reflect.ownKeys(obj));
  if (obj.constructor === Object) return keys;
  if (obj instanceof Error) {
    keys.delete("stack");
  }
  const proto = Object.getPrototypeOf(obj);
  let current = proto;
  while (current !== null && current !== Object.prototype) {
    const ownKeys = Reflect.ownKeys(current);
    for (let i = 0; i < ownKeys.length; i++) {
      keys.add(ownKeys[i]);
    }
    current = Object.getPrototypeOf(current);
  }
  if (keys.has("constructor") && typeof obj.constructor === "function" && proto === obj.constructor.prototype) {
    keys.delete("constructor");
  }
  return keys;
};
var byReferenceInstances = /* @__PURE__ */ new WeakSet();

// ops/node_modules/effect/dist/Predicate.js
function isString(input) {
  return typeof input === "string";
}
function isNumber(input) {
  return typeof input === "number";
}
function isFunction(input) {
  return typeof input === "function";
}
function isUndefined(input) {
  return input === void 0;
}
function isNotUndefined(input) {
  return input !== void 0;
}
function isObjectKeyword(input) {
  return typeof input === "object" && input !== null || isFunction(input);
}
var hasProperty = /* @__PURE__ */ dual(2, (self, property) => isObjectKeyword(self) && property in self);
var isTagged = /* @__PURE__ */ dual(2, (self, tag) => hasProperty(self, "_tag") && self["_tag"] === tag);
function isIterable(input) {
  return hasProperty(input, Symbol.iterator) || isString(input);
}

// ops/node_modules/effect/dist/Hash.js
var symbol = "~effect/Hash";
var hash = (self) => {
  switch (typeof self) {
    case "number":
      return number(self);
    case "bigint":
      return string(self.toString(10));
    case "string":
      return string(self);
    case "undefined":
      return string("undefined");
    case "function":
    case "object": {
      if (self === null) {
        return string("null");
      } else if (self instanceof Date) {
        if (Number.isNaN(self.getTime())) {
          return string("Invalid Date");
        }
        return string(self.toISOString());
      } else if (self instanceof RegExp) {
        return string(self.toString());
      } else {
        if (byReferenceInstances.has(self)) {
          return random(self);
        }
        if (hashCache.has(self)) {
          return hashCache.get(self);
        }
        const h = withVisitedTracking(self, () => {
          if (isHash(self)) {
            return self[symbol]();
          } else if (typeof self === "function") {
            return random(self);
          } else if (self instanceof DataView) {
            return array(new Uint8Array(self.buffer, self.byteOffset, self.byteLength));
          } else if (Array.isArray(self) || ArrayBuffer.isView(self)) {
            return array(self);
          } else if (self instanceof Map) {
            return hashMap(self);
          } else if (self instanceof Set) {
            return hashSet(self);
          }
          return structure(self);
        });
        hashCache.set(self, h);
        return h;
      }
    }
    default:
      return string(String(self));
  }
};
var random = (self) => {
  if (!randomHashCache.has(self)) {
    randomHashCache.set(self, number(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)));
  }
  return randomHashCache.get(self);
};
var combine = /* @__PURE__ */ dual(2, (self, b) => self * 53 ^ b);
var optimize = (n) => n & 3221225471 | n >>> 1 & 1073741824;
var isHash = (u) => hasProperty(u, symbol);
var number = (n) => {
  if (n !== n || n === Infinity || n === -Infinity) {
    return string(String(n));
  }
  let h = n | 0;
  if (h !== n) {
    h ^= n * 4294967295;
  }
  while (n > 4294967295) {
    h ^= n /= 4294967295;
  }
  return optimize(h);
};
var string = (str) => {
  let h = 5381, i = str.length;
  while (i) {
    h = h * 33 ^ str.charCodeAt(--i);
  }
  return optimize(h);
};
var structureKeys = (o, keys) => {
  let h = 12289;
  for (const key of keys) {
    h ^= combine(hash(key), hash(o[key]));
  }
  return optimize(h);
};
var structure = (o) => structureKeys(o, getAllObjectKeys(o));
var iterableWith = (seed, f) => (iter) => {
  let h = seed;
  for (const element of iter) {
    h ^= f(element);
  }
  return optimize(h);
};
var array = /* @__PURE__ */ iterableWith(6151, hash);
var hashMap = /* @__PURE__ */ iterableWith(/* @__PURE__ */ string("Map"), ([k, v]) => combine(hash(k), hash(v)));
var hashSet = /* @__PURE__ */ iterableWith(/* @__PURE__ */ string("Set"), hash);
var randomHashCache = /* @__PURE__ */ new WeakMap();
var hashCache = /* @__PURE__ */ new WeakMap();
var visitedObjects = /* @__PURE__ */ new WeakSet();
function withVisitedTracking(obj, fn3) {
  if (visitedObjects.has(obj)) {
    return string("[Circular]");
  }
  visitedObjects.add(obj);
  const result3 = fn3();
  visitedObjects.delete(obj);
  return result3;
}

// ops/node_modules/effect/dist/Equal.js
var symbol2 = "~effect/Equal";
function equals() {
  if (arguments.length === 1) {
    return (self) => compareBoth(self, arguments[0]);
  }
  return compareBoth(arguments[0], arguments[1]);
}
function compareBoth(self, that) {
  if (self === that) return true;
  if (self == null || that == null) return false;
  const selfType = typeof self;
  if (selfType !== typeof that) {
    return false;
  }
  if (selfType === "number" && self !== self && that !== that) {
    return true;
  }
  if (selfType !== "object" && selfType !== "function") {
    return false;
  }
  if (byReferenceInstances.has(self) || byReferenceInstances.has(that)) {
    return false;
  }
  return withCache(self, that, compareObjects);
}
function withVisitedTracking2(self, that, fn3) {
  const hasLeft = visitedLeft.has(self);
  const hasRight = visitedRight.has(that);
  if (hasLeft && hasRight) {
    return true;
  }
  if (hasLeft || hasRight) {
    return false;
  }
  visitedLeft.add(self);
  visitedRight.add(that);
  const result3 = fn3();
  visitedLeft.delete(self);
  visitedRight.delete(that);
  return result3;
}
var visitedLeft = /* @__PURE__ */ new WeakSet();
var visitedRight = /* @__PURE__ */ new WeakSet();
function compareObjects(self, that) {
  if (hash(self) !== hash(that)) {
    return false;
  } else if (self instanceof Date) {
    if (!(that instanceof Date)) return false;
    const selfTime = self.getTime();
    const thatTime = that.getTime();
    return selfTime === thatTime || Number.isNaN(selfTime) && Number.isNaN(thatTime);
  } else if (self instanceof RegExp) {
    if (!(that instanceof RegExp)) return false;
    return self.toString() === that.toString();
  }
  const selfIsEqual = isEqual(self);
  const thatIsEqual = isEqual(that);
  if (selfIsEqual !== thatIsEqual) return false;
  const bothEquals = selfIsEqual && thatIsEqual;
  if (typeof self === "function" && !bothEquals) {
    return false;
  }
  return withVisitedTracking2(self, that, () => {
    if (bothEquals) {
      return self[symbol2](that);
    } else if (Array.isArray(self)) {
      if (!Array.isArray(that) || self.length !== that.length) {
        return false;
      }
      return compareArrays(self, that);
    } else if (ArrayBuffer.isView(self)) {
      const selfIsDataView = self instanceof DataView;
      if (!ArrayBuffer.isView(that) || self.byteLength !== that.byteLength || selfIsDataView !== that instanceof DataView) {
        return false;
      }
      if (selfIsDataView) {
        const thatDataView = that;
        return compareTypedArrays(new Uint8Array(self.buffer, self.byteOffset, self.byteLength), new Uint8Array(thatDataView.buffer, thatDataView.byteOffset, thatDataView.byteLength));
      }
      return compareTypedArrays(self, that);
    } else if (self instanceof Map) {
      if (!(that instanceof Map) || self.size !== that.size) {
        return false;
      }
      return compareMaps(self, that);
    } else if (self instanceof Set) {
      if (!(that instanceof Set) || self.size !== that.size) {
        return false;
      }
      return compareSets(self, that);
    }
    return compareRecords(self, that);
  });
}
function withCache(self, that, f) {
  let selfMap = equalityCache.get(self);
  if (!selfMap) {
    selfMap = /* @__PURE__ */ new WeakMap();
    equalityCache.set(self, selfMap);
  } else if (selfMap.has(that)) {
    return selfMap.get(that);
  }
  const result3 = f(self, that);
  selfMap.set(that, result3);
  let thatMap = equalityCache.get(that);
  if (!thatMap) {
    thatMap = /* @__PURE__ */ new WeakMap();
    equalityCache.set(that, thatMap);
  }
  thatMap.set(self, result3);
  return result3;
}
var equalityCache = /* @__PURE__ */ new WeakMap();
function compareArrays(self, that) {
  for (let i = 0; i < self.length; i++) {
    if (!compareBoth(self[i], that[i])) {
      return false;
    }
  }
  return true;
}
function compareTypedArrays(self, that) {
  if (self.length !== that.length) {
    return false;
  }
  for (let i = 0; i < self.length; i++) {
    if (self[i] !== that[i]) {
      return false;
    }
  }
  return true;
}
function compareRecords(self, that) {
  const selfKeys = getAllObjectKeys(self);
  const thatKeys = getAllObjectKeys(that);
  if (selfKeys.size !== thatKeys.size) {
    return false;
  }
  for (const key of selfKeys) {
    if (!thatKeys.has(key) || !compareBoth(self[key], that[key])) {
      return false;
    }
  }
  return true;
}
function makeCompareMap(keyEquivalence, valueEquivalence) {
  return function compareMaps2(self, that) {
    const thatEntries = Array.from(that);
    for (const [selfKey, selfValue] of self) {
      let found = false;
      for (let i = 0; i < thatEntries.length; i++) {
        const [thatKey, thatValue] = thatEntries[i];
        if (keyEquivalence(selfKey, thatKey) && valueEquivalence(selfValue, thatValue)) {
          thatEntries[i] = thatEntries[thatEntries.length - 1];
          thatEntries.pop();
          found = true;
          break;
        }
      }
      if (!found) {
        return false;
      }
    }
    return true;
  };
}
var compareMaps = /* @__PURE__ */ makeCompareMap(compareBoth, compareBoth);
function makeCompareSet(equivalence) {
  return function compareSets2(self, that) {
    const thatValues = Array.from(that);
    for (const selfValue of self) {
      let found = false;
      for (let i = 0; i < thatValues.length; i++) {
        const thatValue = thatValues[i];
        if (equivalence(selfValue, thatValue)) {
          thatValues[i] = thatValues[thatValues.length - 1];
          thatValues.pop();
          found = true;
          break;
        }
      }
      if (!found) {
        return false;
      }
    }
    return true;
  };
}
var compareSets = /* @__PURE__ */ makeCompareSet(compareBoth);
var isEqual = (u) => hasProperty(u, symbol2);
var byReferenceUnsafe = (obj) => {
  byReferenceInstances.add(obj);
  return obj;
};

// ops/node_modules/effect/dist/Equivalence.js
var make = (isEquivalent) => (self, that) => self === that || isEquivalent(self, that);

// ops/node_modules/effect/dist/internal/array.js
var isArrayNonEmpty = (self) => self.length > 0;

// ops/node_modules/effect/dist/internal/doNotation.js
var let_ = (map6) => dual(3, (self, name, f) => map6(self, (a) => ({
  ...a,
  [name]: f(a)
})));
var bindTo = (map6) => dual(2, (self, name) => map6(self, (a) => ({
  [name]: a
})));
var bind = (map6, flatMap5) => dual(3, (self, name, f) => flatMap5(self, (a) => map6(f(a), (b) => ({
  ...a,
  [name]: b
}))));

// ops/node_modules/effect/dist/internal/record.js
function assignProperty(self, key, value) {
  if (key === "__proto__") {
    Object.defineProperty(self, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true
    });
  } else {
    ;
    self[key] = value;
  }
}
function assignProperties(self, source) {
  for (const key of Reflect.ownKeys(source)) {
    if (Object.prototype.propertyIsEnumerable.call(source, key)) {
      assignProperty(self, key, source[key]);
    }
  }
}

// ops/node_modules/effect/dist/Redactable.js
var symbolRedactable = /* @__PURE__ */ Symbol.for("~effect/Redactable");
var isRedactable = (u) => hasProperty(u, symbolRedactable);
function redact(u) {
  if (isRedactable(u)) return getRedacted(u);
  return u;
}
function getRedacted(redactable) {
  return redactable[symbolRedactable](globalThis[currentFiberTypeId]?.context ?? emptyContext);
}
var currentFiberTypeId = "~effect/Fiber/currentFiber";
var emptyMap = /* @__PURE__ */ new Map();
var emptyContext = {
  "~effect/Context": {},
  base: emptyMap,
  depth: 0,
  mapUnsafe: emptyMap,
  pipe() {
    return pipeArguments(this, arguments);
  }
};

// ops/node_modules/effect/dist/Formatter.js
function format(input, options) {
  const space = options?.space ?? 0;
  const ancestors = /* @__PURE__ */ new WeakSet();
  const gap = !space ? "" : typeof space === "number" ? " ".repeat(space) : space;
  const ind = (d) => gap.repeat(d);
  const wrap = (v, body) => {
    const ctor = v?.constructor;
    return ctor && ctor !== Object.prototype.constructor && ctor.name ? `${ctor.name}(${body})` : body;
  };
  const ownKeys = (o) => {
    try {
      return Reflect.ownKeys(o);
    } catch {
      return ["[ownKeys threw]"];
    }
  };
  function recur(v, d = 0) {
    try {
      return recurUnsafe(v, d);
    } catch {
      if (typeof v === "object" && v !== null || typeof v === "function") ancestors.delete(v);
      return "[inspection threw]";
    }
  }
  function recurUnsafe(v, d = 0) {
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" || v == null || typeof v === "boolean" || typeof v === "symbol") return String(v);
    if (typeof v === "bigint") return String(v) + "n";
    if (typeof v === "object" || typeof v === "function") {
      if (ancestors.has(v)) return CIRCULAR;
      ancestors.add(v);
      let output;
      if (symbolRedactable in v) {
        output = recur(getRedacted(v), d);
      } else if (Array.isArray(v)) {
        output = !gap || v.length <= 1 ? `[${v.map((x) => recur(x, d)).join(",")}]` : `[
${ind(d + 1)}${v.map((x) => recur(x, d + 1)).join(",\n" + ind(d + 1))}
${ind(d)}]`;
      } else if (v instanceof Date) {
        output = formatDate(v);
      } else if (!options?.ignoreToString && hasProperty(v, "toString") && typeof v["toString"] === "function" && v["toString"] !== Object.prototype.toString && v["toString"] !== Array.prototype.toString) {
        const s = safeToString(v);
        output = v instanceof Error && v.cause !== void 0 ? `${s} (cause: ${recur(v.cause, d)})` : s;
      } else if (Symbol.iterator in v) {
        output = `${v.constructor.name}(${recur(Array.from(v), d)})`;
      } else {
        const keys = ownKeys(v);
        if (!gap || keys.length <= 1) {
          const body = `{${keys.map((k) => `${formatPropertyKey(k)}:${recur(safeGet(v, k), d)}`).join(",")}}`;
          output = wrap(v, body);
        } else {
          const body = `{
${keys.map((k) => `${ind(d + 1)}${formatPropertyKey(k)}: ${recur(safeGet(v, k), d + 1)}`).join(",\n")}
${ind(d)}}`;
          output = wrap(v, body);
        }
      }
      ancestors.delete(v);
      return output;
    }
    return String(v);
  }
  return recur(input, 0);
}
var CIRCULAR = "[Circular]";
function formatPropertyKey(name) {
  return typeof name === "string" ? JSON.stringify(name) : String(name);
}
function formatDate(date) {
  try {
    return date.toISOString();
  } catch {
    return "Invalid Date";
  }
}
function safeToString(input) {
  try {
    const s = input.toString();
    return typeof s === "string" ? s : String(s);
  } catch {
    return "[toString threw]";
  }
}
function safeGet(input, key) {
  try {
    return input[key];
  } catch {
    return "[property access threw]";
  }
}
function formatJson(input, options) {
  const ancestors = [];
  return JSON.stringify(input, function(key, value) {
    const original = Object.getOwnPropertyDescriptor(this, key)?.value;
    const redacted = hasProperty(original, symbolRedactable) ? redact(original) : redact(value);
    if (typeof redacted === "bigint") {
      return format(redacted);
    }
    if (typeof redacted !== "object" || redacted === null) {
      return redacted;
    }
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
      ancestors.pop();
    }
    if (ancestors.includes(redacted)) {
      return void 0;
    }
    ancestors.push(redacted);
    return redacted;
  }, options?.space) ?? "null";
}

// ops/node_modules/effect/dist/Inspectable.js
var NodeInspectSymbol = /* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom");
var toJson = (input) => {
  try {
    input = redact(input);
    if (hasProperty(input, "toJSON") && isFunction(input["toJSON"]) && input["toJSON"].length === 0) {
      return input.toJSON();
    } else if (Array.isArray(input)) {
      return input.map(toJson);
    }
    return input;
  } catch {
    return "[toJSON threw]";
  }
};
var toStringUnknown = (u, whitespace = 2) => {
  if (typeof u === "string") {
    return u;
  }
  try {
    return typeof u === "object" ? formatJson(u, {
      space: whitespace
    }) : format(u, {
      space: whitespace
    });
  } catch {
    return String(u);
  }
};
var BaseProto = {
  toJSON() {
    return toJson(this);
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  toString() {
    return format(this.toJSON());
  }
};
var Class2 = class {
  /**
   * Node.js custom inspection method.
   *
   * **When to use**
   *
   * Use to expose the class JSON representation to Node.js inspection.
   *
   * @since 2.0.0
   */
  [NodeInspectSymbol]() {
    return this.toJSON();
  }
  /**
   * Returns a formatted string representation of this object.
   *
   * **When to use**
   *
   * Use to format the class JSON representation as a string.
   *
   * @since 2.0.0
   */
  toString() {
    return format(this.toJSON());
  }
};

// ops/node_modules/effect/dist/internal/stackTraceLimit.js
var isStackTraceLimitWritable = () => {
  const desc = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
  if (desc === void 0) {
    return Object.isExtensible(Error);
  }
  return Object.hasOwn(desc, "writable") ? desc.writable === true : desc.set !== void 0;
};
var canWriteStackTraceLimit = /* @__PURE__ */ isStackTraceLimitWritable();
var getStackTraceLimit = () => Error.stackTraceLimit;
var setStackTraceLimit = (value) => {
  if (canWriteStackTraceLimit) {
    ;
    Error.stackTraceLimit = value;
  }
};

// ops/node_modules/effect/dist/Utils.js
var SingleShotGen = class _SingleShotGen {
  called = false;
  self;
  constructor(self) {
    this.self = self;
  }
  /**
   * Yields the stored value once, then completes with the value sent back in.
   *
   * **When to use**
   *
   * Use to advance a `SingleShotGen` through its single yield and completion
   * step.
   *
   * @since 2.0.0
   */
  next(a) {
    return this.called ? {
      value: a,
      done: true
    } : (this.called = true, {
      value: this.self,
      done: false
    });
  }
  /**
   * Creates a fresh single-shot iterator over the stored value.
   *
   * **When to use**
   *
   * Use to iterate the wrapped value again without reusing the consumed
   * iterator state.
   *
   * @since 2.0.0
   */
  [Symbol.iterator]() {
    return new _SingleShotGen(this.self);
  }
};
var pickInternalCall = () => {
  const InternalTypeId = "~effect/Utils/internal";
  const standard = {
    [InternalTypeId]: (body) => {
      return body();
    }
  };
  const forced = {
    [InternalTypeId]: (body) => {
      try {
        return body();
      } finally {
      }
    }
  };
  const isNotOptimizedAway = getStackTraceLimit() !== 0 && standard[InternalTypeId](() => new Error().stack)?.includes(InternalTypeId) === true;
  return isNotOptimizedAway ? standard[InternalTypeId] : forced[InternalTypeId];
};
var internalCall = /* @__PURE__ */ pickInternalCall();

// ops/node_modules/effect/dist/internal/core.js
var EffectTypeId = `~effect/Effect`;
var ExitTypeId = `~effect/Exit`;
var effectVariance = {
  _A: identity,
  _E: identity,
  _R: identity
};
var identifier = `${EffectTypeId}/identifier`;
var args = `${EffectTypeId}/args`;
var evaluate = `${EffectTypeId}/evaluate`;
var contA = `${EffectTypeId}/successCont`;
var contE = `${EffectTypeId}/failureCont`;
var contAll = `${EffectTypeId}/ensureCont`;
var Yield = /* @__PURE__ */ Symbol.for("effect/Effect/Yield");
var PipeInspectableProto = {
  pipe() {
    return pipeArguments(this, arguments);
  },
  toJSON() {
    return {
      ...this
    };
  },
  toString() {
    return format(this.toJSON(), {
      ignoreToString: true,
      space: 2
    });
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  }
};
var StructuralProto = {
  [symbol]() {
    return structureKeys(this, Object.keys(this));
  },
  [symbol2](that) {
    const selfKeys = Object.keys(this);
    const thatKeys = Object.keys(that);
    if (selfKeys.length !== thatKeys.length) return false;
    for (let i = 0; i < selfKeys.length; i++) {
      if (selfKeys[i] !== thatKeys[i] || !equals(this[selfKeys[i]], that[selfKeys[i]])) {
        return false;
      }
    }
    return true;
  }
};
var EffectProto = {
  [EffectTypeId]: effectVariance,
  ...PipeInspectableProto,
  [Symbol.iterator]() {
    return new SingleShotGen(this);
  },
  toJSON() {
    return {
      _id: "Effect",
      op: this[identifier],
      ...args in this ? {
        args: this[args]
      } : void 0
    };
  }
};
var isEffect = (u) => hasProperty(u, EffectTypeId);
var isExit = (u) => hasProperty(u, ExitTypeId);
var CauseTypeId = "~effect/Cause";
var CauseReasonTypeId = "~effect/Cause/Reason";
var isCause = (self) => hasProperty(self, CauseTypeId);
var isCauseReason = (self) => hasProperty(self, CauseReasonTypeId);
var CauseImpl = class {
  constructor(failures) {
    this[CauseTypeId] = CauseTypeId;
    this.reasons = failures;
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
  toJSON() {
    return {
      _id: "Cause",
      failures: this.reasons.map((f) => f.toJSON())
    };
  }
  toString() {
    return `Cause(${format(this.reasons)})`;
  }
  [NodeInspectSymbol]() {
    return this.toJSON();
  }
  [symbol2](that) {
    return isCause(that) && this.reasons.length === that.reasons.length && this.reasons.every((e, i) => equals(e, that.reasons[i]));
  }
  [symbol]() {
    return array(this.reasons);
  }
};
var annotationsMap = /* @__PURE__ */ new WeakMap();
var ReasonBase = class {
  [CauseReasonTypeId];
  annotations;
  _tag;
  constructor(_tag, annotations2, originalError) {
    this[CauseReasonTypeId] = CauseReasonTypeId;
    this._tag = _tag;
    if (annotations2 !== constEmptyAnnotations && typeof originalError === "object" && originalError !== null && annotations2.size > 0) {
      const prevAnnotations = annotationsMap.get(originalError);
      if (prevAnnotations) {
        annotations2 = new Map([...prevAnnotations, ...annotations2]);
      }
      annotationsMap.set(originalError, annotations2);
    }
    this.annotations = annotations2;
  }
  annotate(annotations2, options) {
    if (annotations2.mapUnsafe.size === 0) return this;
    const newAnnotations = new Map(this.annotations);
    annotations2.mapUnsafe.forEach((value, key) => {
      if (options?.overwrite !== true && newAnnotations.has(key)) return;
      newAnnotations.set(key, value);
    });
    const self = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    self.annotations = newAnnotations;
    return self;
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
  toString() {
    return format(this);
  }
  [NodeInspectSymbol]() {
    return this.toString();
  }
};
var constEmptyAnnotations = /* @__PURE__ */ new Map();
var Fail = class extends ReasonBase {
  constructor(error, annotations2 = constEmptyAnnotations) {
    super("Fail", annotations2, error);
    this.error = error;
  }
  toString() {
    return `Fail(${format(this.error)})`;
  }
  toJSON() {
    return {
      _tag: "Fail",
      error: this.error
    };
  }
  [symbol2](that) {
    return isFailReason(that) && equals(this.error, that.error) && equals(this.annotations, that.annotations);
  }
  [symbol]() {
    return combine(string(this._tag))(combine(hash(this.error))(hash(this.annotations)));
  }
};
var causeFromReasons = (reasons) => new CauseImpl(reasons);
var causeEmpty = /* @__PURE__ */ new CauseImpl([]);
var causeFail = (error) => new CauseImpl([new Fail(error)]);
var Die = class extends ReasonBase {
  constructor(defect, annotations2 = constEmptyAnnotations) {
    super("Die", annotations2, defect);
    this.defect = defect;
  }
  toString() {
    return `Die(${format(this.defect)})`;
  }
  toJSON() {
    return {
      _tag: "Die",
      defect: this.defect
    };
  }
  [symbol2](that) {
    return isDieReason(that) && equals(this.defect, that.defect) && equals(this.annotations, that.annotations);
  }
  [symbol]() {
    return combine(string(this._tag))(combine(hash(this.defect))(hash(this.annotations)));
  }
};
var causeDie = (defect) => new CauseImpl([new Die(defect)]);
var causeAnnotate = /* @__PURE__ */ dual((args2) => isCause(args2[0]), (self, annotations2, options) => {
  if (annotations2.mapUnsafe.size === 0) return self;
  return new CauseImpl(self.reasons.map((f) => f.annotate(annotations2, options)));
});
var isFailReason = (self) => self._tag === "Fail";
var isDieReason = (self) => self._tag === "Die";
var isInterruptReason = (self) => self._tag === "Interrupt";
function defaultEvaluate(_fiber) {
  return exitDie(`Effect.evaluate: Not implemented`);
}
var makePrimitiveProto = (options) => ({
  ...EffectProto,
  [identifier]: options.op,
  [evaluate]: options[evaluate] ?? defaultEvaluate,
  [contA]: options[contA],
  [contE]: options[contE],
  [contAll]: options[contAll]
});
var makePrimitive = (options) => {
  const Proto3 = makePrimitiveProto(options);
  const PrimitiveImpl = function(value) {
    this[args] = value;
  };
  PrimitiveImpl.prototype = Proto3;
  return function(value) {
    return new PrimitiveImpl(value);
  };
};
var makeExit = (options) => {
  const Proto3 = {
    [ExitTypeId]: ExitTypeId,
    _tag: options.op,
    get [options.prop]() {
      return this[args];
    },
    ...makePrimitiveProto(options),
    toString() {
      return `${options.op}(${format(this[args])})`;
    },
    toJSON() {
      return {
        _id: "Exit",
        _tag: options.op,
        [options.prop]: this[args]
      };
    },
    [symbol2](that) {
      return isExit(that) && that._tag === this._tag && equals(this[args], that[args]);
    },
    [symbol]() {
      return combine(string(options.op), hash(this[args]));
    }
  };
  const ExitPrimitive = function(value) {
    this[args] = value;
  };
  ExitPrimitive.prototype = Proto3;
  return function(value) {
    return new ExitPrimitive(value);
  };
};
var exitSucceed = /* @__PURE__ */ makeExit({
  op: "Success",
  prop: "value",
  [evaluate](fiber3) {
    const cont = fiber3.getCont(contA);
    return cont ? cont[contA](this[args], fiber3, this) : fiber3.yieldWith(this);
  }
});
var StackTraceKey = {
  key: "effect/Cause/StackTrace"
};
var InterruptorStackTrace = {
  key: "effect/Cause/InterruptorStackTrace"
};
var exitFailCause = /* @__PURE__ */ makeExit({
  op: "Failure",
  prop: "cause",
  [evaluate](fiber3) {
    let cause = this[args];
    let annotated = false;
    if (fiber3.cache.stackFrame) {
      cause = causeAnnotate(cause, {
        mapUnsafe: /* @__PURE__ */ new Map([[StackTraceKey.key, fiber3.cache.stackFrame]])
      });
      annotated = true;
    }
    let cont = fiber3.getCont(contE);
    while (fiber3.interruptible && fiber3._interruptedCause && cont) {
      cont = fiber3.getCont(contE);
    }
    return cont ? cont[contE](cause, fiber3, annotated ? void 0 : this) : fiber3.yieldWith(annotated ? exitFailCause(cause) : this);
  }
});
var exitFail = (e) => exitFailCause(causeFail(e));
var exitDie = (defect) => exitFailCause(causeDie(defect));
var withFiber = /* @__PURE__ */ makePrimitive({
  op: "WithFiber",
  [evaluate](fiber3) {
    return this[args](fiber3);
  }
});
var withFiberSucceed = /* @__PURE__ */ makePrimitive({
  op: "WithFiberSucceed",
  [evaluate](fiber3) {
    const value = this[args](fiber3);
    const cont = fiber3.getCont(contA);
    return cont ? cont[contA](value, fiber3) : fiber3.yieldWith(exitSucceed(value));
  }
});
var YieldableError = /* @__PURE__ */ (function() {
  class YieldableError2 extends globalThis.Error {
  }
  const proto = /* @__PURE__ */ makePrimitiveProto({
    op: "YieldableError",
    [evaluate]() {
      return exitFail(this);
    }
  });
  delete proto.toString;
  Object.assign(YieldableError2.prototype, proto);
  return YieldableError2;
})();
var Error2 = /* @__PURE__ */ (function() {
  const plainArgsSymbol = /* @__PURE__ */ Symbol.for("effect/Data/Error/plainArgs");
  return class Base extends YieldableError {
    constructor(args2) {
      super(args2?.message, args2?.cause ? {
        cause: args2.cause
      } : void 0);
      if (args2) {
        assignProperties(this, args2);
        Object.defineProperty(this, plainArgsSymbol, {
          value: args2,
          enumerable: false
        });
      }
    }
    toJSON() {
      return {
        ...this[plainArgsSymbol],
        ...this
      };
    }
  };
})();
var TaggedError = (tag) => {
  class Base extends Error2 {
    _tag = tag;
  }
  ;
  Base.prototype.name = tag;
  return Base;
};
var NoSuchElementErrorTypeId = "~effect/Cause/NoSuchElementError";
var isNoSuchElementError = (u) => hasProperty(u, NoSuchElementErrorTypeId);
var NoSuchElementError = class extends (/* @__PURE__ */ TaggedError("NoSuchElementError")) {
  [NoSuchElementErrorTypeId] = NoSuchElementErrorTypeId;
  constructor(message) {
    super({
      message
    });
  }
};
var DoneTypeId = "~effect/Cause/Done";
var isDone = (u) => hasProperty(u, DoneTypeId);
var DoneVoid = {
  [DoneTypeId]: DoneTypeId,
  _tag: "Done",
  value: void 0
};
var Done = (value) => {
  if (value === void 0) return DoneVoid;
  return {
    [DoneTypeId]: DoneTypeId,
    _tag: "Done",
    value
  };
};
var doneVoid = /* @__PURE__ */ exitFail(DoneVoid);
var done = (value) => {
  if (value === void 0) return doneVoid;
  return exitFail(Done(value));
};

// ops/node_modules/effect/dist/internal/option.js
var TypeId = "~effect/Option";
var CommonProto = {
  [TypeId]: {
    _A: (_) => _
  },
  ...PipeInspectableProto,
  [Symbol.iterator]() {
    return new SingleShotGen(this);
  }
};
var SomeProto = /* @__PURE__ */ Object.defineProperty(/* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(CommonProto), {
  _tag: "Some",
  _op: "Some",
  [symbol2](that) {
    return isOption(that) && isSome(that) && equals(this.value, that.value);
  },
  [symbol]() {
    return combine(hash(this._tag))(hash(this.value));
  },
  toString() {
    return `some(${format(this.value)})`;
  },
  toJSON() {
    return {
      _id: "Option",
      _tag: this._tag,
      value: toJson(this.value)
    };
  }
}), "valueOrUndefined", {
  get() {
    return this.value;
  }
});
var NoneHash = /* @__PURE__ */ hash("None");
var NoneProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(CommonProto), {
  _tag: "None",
  _op: "None",
  valueOrUndefined: void 0,
  [symbol2](that) {
    return isOption(that) && isNone(that);
  },
  [symbol]() {
    return NoneHash;
  },
  toString() {
    return `none()`;
  },
  toJSON() {
    return {
      _id: "Option",
      _tag: this._tag
    };
  }
});
var isOption = (input) => hasProperty(input, TypeId);
var isNone = (fa) => fa._tag === "None";
var isSome = (fa) => fa._tag === "Some";
var none = /* @__PURE__ */ Object.create(NoneProto);
var SomeImpl = function(value) {
  this.value = value;
};
SomeImpl.prototype = SomeProto;
var some = (value) => new SomeImpl(value);

// ops/node_modules/effect/dist/internal/result.js
var TypeId2 = "~effect/Result";
var CommonProto2 = {
  [TypeId2]: {
    /* v8 ignore next 2 */
    _A: (_) => _,
    _E: (_) => _
  },
  ...PipeInspectableProto,
  [Symbol.iterator]() {
    return new SingleShotGen(this);
  }
};
var SuccessProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(CommonProto2), {
  _tag: "Success",
  _op: "Success",
  [symbol2](that) {
    return isResult(that) && isSuccess(that) && equals(this.success, that.success);
  },
  [symbol]() {
    return combine(hash(this._tag))(hash(this.success));
  },
  toString() {
    return `success(${format(this.success)})`;
  },
  toJSON() {
    return {
      _id: "Result",
      _tag: this._tag,
      value: toJson(this.success)
    };
  }
});
var FailureProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(CommonProto2), {
  _tag: "Failure",
  _op: "Failure",
  [symbol2](that) {
    return isResult(that) && isFailure(that) && equals(this.failure, that.failure);
  },
  [symbol]() {
    return combine(hash(this._tag))(hash(this.failure));
  },
  toString() {
    return `failure(${format(this.failure)})`;
  },
  toJSON() {
    return {
      _id: "Result",
      _tag: this._tag,
      failure: toJson(this.failure)
    };
  }
});
var isResult = (input) => hasProperty(input, TypeId2);
var isFailure = (result3) => result3._tag === "Failure";
var isSuccess = (result3) => result3._tag === "Success";
var FailureImpl = function(failure) {
  this.failure = failure;
};
FailureImpl.prototype = FailureProto;
var fail = (failure) => new FailureImpl(failure);
var SuccessImpl = function(success) {
  this.success = success;
};
SuccessImpl.prototype = SuccessProto;
var succeed = (success) => new SuccessImpl(success);
var getFailure = (self) => isSuccess(self) ? none : some(self.failure);
var getSuccess = (self) => isFailure(self) ? none : some(self.success);
var fromOption = /* @__PURE__ */ dual(2, (self, onNone) => isNone(self) ? fail(onNone()) : succeed(self.value));

// ops/node_modules/effect/dist/Order.js
function make2(compare) {
  return (self, that) => self === that ? 0 : compare(self, that);
}
var Number2 = /* @__PURE__ */ make2((self, that) => {
  if (globalThis.Number.isNaN(self) && globalThis.Number.isNaN(that)) return 0;
  if (globalThis.Number.isNaN(self)) return -1;
  if (globalThis.Number.isNaN(that)) return 1;
  return self < that ? -1 : 1;
});
var mapInput = /* @__PURE__ */ dual(2, (self, f) => make2((b1, b2) => self(f(b1), f(b2))));
var isGreaterThan = (O) => dual(2, (self, that) => O(self, that) === 1);

// ops/node_modules/effect/dist/Option.js
var none2 = () => none;
var some2 = some;
var isOption2 = isOption;
var isNone2 = isNone;
var isSome2 = isSome;
var getOrElse = /* @__PURE__ */ dual(2, (self, onNone) => isNone2(self) ? onNone() : self.value);
var getOrUndefined = /* @__PURE__ */ getOrElse(constUndefined);

// ops/node_modules/effect/dist/Result.js
var Result_exports = {};
__export(Result_exports, {
  Do: () => Do,
  all: () => all,
  andThen: () => andThen,
  bind: () => bind2,
  bindTo: () => bindTo2,
  fail: () => fail2,
  failVoid: () => failVoid,
  filterOrFail: () => filterOrFail,
  flatMap: () => flatMap,
  flip: () => flip,
  fromNullishOr: () => fromNullishOr,
  fromOption: () => fromOption2,
  gen: () => gen,
  getFailure: () => getFailure2,
  getOrElse: () => getOrElse2,
  getOrNull: () => getOrNull,
  getOrThrow: () => getOrThrow,
  getOrThrowWith: () => getOrThrowWith,
  getOrUndefined: () => getOrUndefined2,
  getSuccess: () => getSuccess2,
  isFailure: () => isFailure2,
  isResult: () => isResult2,
  isSuccess: () => isSuccess2,
  let: () => let_2,
  liftPredicate: () => liftPredicate,
  makeEquivalence: () => makeEquivalence,
  map: () => map,
  mapBoth: () => mapBoth,
  mapError: () => mapError,
  match: () => match,
  merge: () => merge,
  orElse: () => orElse,
  succeed: () => succeed2,
  succeedNone: () => succeedNone,
  succeedSome: () => succeedSome,
  tap: () => tap,
  transposeMapOption: () => transposeMapOption,
  transposeOption: () => transposeOption,
  try: () => try_,
  void: () => void_
});
var succeed2 = succeed;
var fail2 = fail;
var void_ = /* @__PURE__ */ succeed2(void 0);
var failVoid = /* @__PURE__ */ fail2(void 0);
var fromNullishOr = /* @__PURE__ */ dual(2, (self, onNullish) => self == null ? fail2(onNullish(self)) : succeed2(self));
var fromOption2 = fromOption;
var try_ = (evaluate2) => {
  if (isFunction(evaluate2)) {
    try {
      return succeed2(evaluate2());
    } catch (e) {
      return fail2(e);
    }
  } else {
    try {
      return succeed2(evaluate2.try());
    } catch (e) {
      return fail2(evaluate2.catch(e));
    }
  }
};
var isResult2 = isResult;
var isFailure2 = isFailure;
var isSuccess2 = isSuccess;
var getSuccess2 = getSuccess;
var getFailure2 = getFailure;
var makeEquivalence = (success, failure) => make((x, y) => isFailure2(x) ? isFailure2(y) && failure(x.failure, y.failure) : isSuccess2(y) && success(x.success, y.success));
var mapBoth = /* @__PURE__ */ dual(2, (self, {
  onFailure,
  onSuccess
}) => isFailure2(self) ? fail2(onFailure(self.failure)) : succeed2(onSuccess(self.success)));
var mapError = /* @__PURE__ */ dual(2, (self, f) => isFailure2(self) ? fail2(f(self.failure)) : self);
var map = /* @__PURE__ */ dual(2, (self, f) => isSuccess2(self) ? succeed2(f(self.success)) : self);
var match = /* @__PURE__ */ dual(2, (self, {
  onFailure,
  onSuccess
}) => isFailure2(self) ? onFailure(self.failure) : onSuccess(self.success));
var liftPredicate = /* @__PURE__ */ dual(3, (a, predicate, orFailWith) => predicate(a) ? succeed2(a) : fail2(orFailWith(a)));
var filterOrFail = /* @__PURE__ */ dual(3, (self, predicate, orFailWith) => flatMap(self, (a) => predicate(a) ? succeed2(a) : fail2(orFailWith(a))));
var merge = /* @__PURE__ */ match({
  onFailure: identity,
  onSuccess: identity
});
var getOrElse2 = /* @__PURE__ */ dual(2, (self, onFailure) => isFailure2(self) ? onFailure(self.failure) : self.success);
var getOrNull = /* @__PURE__ */ getOrElse2(constNull);
var getOrUndefined2 = /* @__PURE__ */ getOrElse2(constUndefined);
var getOrThrowWith = /* @__PURE__ */ dual(2, (self, onFailure) => {
  if (isSuccess2(self)) {
    return self.success;
  }
  throw onFailure(self.failure);
});
var getOrThrow = /* @__PURE__ */ getOrThrowWith(identity);
var orElse = /* @__PURE__ */ dual(2, (self, that) => isFailure2(self) ? that(self.failure) : succeed2(self.success));
var flatMap = /* @__PURE__ */ dual(2, (self, f) => isFailure2(self) ? fail2(self.failure) : f(self.success));
var andThen = /* @__PURE__ */ dual(2, (self, f) => flatMap(self, (a) => {
  const out = isFunction(f) ? f(a) : f;
  return isResult2(out) ? out : succeed2(out);
}));
var all = (input) => {
  if (Symbol.iterator in input) {
    const out2 = [];
    for (const e of input) {
      if (isFailure2(e)) {
        return e;
      }
      out2.push(e.success);
    }
    return succeed2(out2);
  }
  const out = {};
  for (const key of Object.keys(input)) {
    const e = input[key];
    if (isFailure2(e)) {
      return e;
    }
    assignProperty(out, key, e.success);
  }
  return succeed2(out);
};
var flip = (self) => isFailure2(self) ? succeed2(self.failure) : fail2(self.success);
var gen = (...args2) => {
  const f = args2.length === 1 ? args2[0] : args2[1].bind(args2[0]);
  const iterator = f();
  let state = iterator.next();
  while (!state.done) {
    const current = state.value;
    if (isFailure2(current)) {
      return current;
    }
    state = iterator.next(current.success);
  }
  return succeed2(state.value);
};
var Do = /* @__PURE__ */ succeed2({});
var bind2 = /* @__PURE__ */ bind(map, flatMap);
var bindTo2 = /* @__PURE__ */ bindTo(map);
var let_2 = /* @__PURE__ */ let_(map);
var transposeOption = (self) => {
  return isNone(self) ? succeedNone : map(self.value, some);
};
var transposeMapOption = /* @__PURE__ */ dual(2, (self, f) => isNone(self) ? succeedNone : map(f(self.value), some));
var succeedNone = /* @__PURE__ */ succeed2(none);
var succeedSome = (a) => succeed2(some(a));
var tap = /* @__PURE__ */ dual(2, (self, f) => {
  if (isSuccess2(self)) {
    f(self.success);
  }
  return self;
});

// ops/node_modules/effect/dist/Iterable.js
var filter = /* @__PURE__ */ dual(2, (self, predicate) => ({
  [Symbol.iterator]() {
    const iterator = self[Symbol.iterator]();
    let i = 0;
    return {
      next() {
        let result3 = iterator.next();
        while (!result3.done) {
          if (predicate(result3.value, i++)) {
            return {
              done: false,
              value: result3.value
            };
          }
          result3 = iterator.next();
        }
        return {
          done: true,
          value: void 0
        };
      }
    };
  }
}));

// ops/node_modules/effect/dist/Array.js
var Array2 = globalThis.Array;
var fromIterable = (collection) => Array2.isArray(collection) ? collection : Array2.from(collection);
var isArray = Array2.isArray;
var isArrayNonEmpty2 = isArrayNonEmpty;
var empty = () => [];
var partition = /* @__PURE__ */ dual(2, (self, f) => {
  const excluded = [];
  const satisfying = [];
  let i = 0;
  for (const a of self) {
    const result3 = f(a, i++);
    if (isSuccess2(result3)) {
      satisfying.push(result3.success);
    } else {
      excluded.push(result3.failure);
    }
  }
  return [excluded, satisfying];
});

// ops/node_modules/effect/dist/Cause.js
var Cause_exports = {};
__export(Cause_exports, {
  AsyncFiberError: () => AsyncFiberError2,
  AsyncFiberErrorTypeId: () => AsyncFiberErrorTypeId2,
  Done: () => Done2,
  DoneTypeId: () => DoneTypeId2,
  ExceededCapacityError: () => ExceededCapacityError2,
  ExceededCapacityErrorTypeId: () => ExceededCapacityErrorTypeId2,
  IllegalArgumentError: () => IllegalArgumentError2,
  IllegalArgumentErrorTypeId: () => IllegalArgumentErrorTypeId2,
  InterruptorStackTrace: () => InterruptorStackTrace2,
  NoSuchElementError: () => NoSuchElementError2,
  NoSuchElementErrorTypeId: () => NoSuchElementErrorTypeId2,
  ReasonTypeId: () => ReasonTypeId,
  StackTrace: () => StackTrace,
  TimeoutError: () => TimeoutError2,
  TimeoutErrorTypeId: () => TimeoutErrorTypeId2,
  TypeId: () => TypeId5,
  UnknownError: () => UnknownError2,
  UnknownErrorTypeId: () => UnknownErrorTypeId2,
  annotate: () => annotate,
  annotations: () => annotations,
  combine: () => combine2,
  die: () => die2,
  done: () => done2,
  empty: () => empty3,
  fail: () => fail4,
  filterInterruptors: () => filterInterruptors,
  findDefect: () => findDefect2,
  findDie: () => findDie2,
  findError: () => findError2,
  findErrorOption: () => findErrorOption2,
  findFail: () => findFail2,
  findInterrupt: () => findInterrupt2,
  fromReasons: () => fromReasons,
  hasDies: () => hasDies2,
  hasFails: () => hasFails2,
  hasInterrupts: () => hasInterrupts2,
  hasInterruptsOnly: () => hasInterruptsOnly2,
  interrupt: () => interrupt2,
  interruptors: () => interruptors,
  isAsyncFiberError: () => isAsyncFiberError2,
  isCause: () => isCause2,
  isDieReason: () => isDieReason2,
  isDone: () => isDone2,
  isExceededCapacityError: () => isExceededCapacityError2,
  isFailReason: () => isFailReason2,
  isIllegalArgumentError: () => isIllegalArgumentError2,
  isInterruptReason: () => isInterruptReason2,
  isNoSuchElementError: () => isNoSuchElementError2,
  isReason: () => isReason,
  isTimeoutError: () => isTimeoutError2,
  isUnknownError: () => isUnknownError2,
  makeDieReason: () => makeDieReason,
  makeFailReason: () => makeFailReason,
  makeInterruptReason: () => makeInterruptReason2,
  map: () => map3,
  pretty: () => pretty,
  prettyErrors: () => prettyErrors,
  reasonAnnotations: () => reasonAnnotations2,
  squash: () => squash
});

// ops/node_modules/effect/dist/Context.js
var Context_exports = {};
__export(Context_exports, {
  Reference: () => Reference,
  Service: () => Service,
  ServiceTypeId: () => ServiceTypeId,
  add: () => add,
  addOrOmit: () => addOrOmit,
  addUnsafe: () => addUnsafe,
  empty: () => empty2,
  get: () => get,
  getOption: () => getOption,
  getOrElse: () => getOrElse3,
  getOrUndefined: () => getOrUndefined3,
  getOrUndefinedUnsafe: () => getOrUndefinedUnsafe,
  getUnsafe: () => getUnsafe,
  hasSameCache: () => hasSameCache,
  isContext: () => isContext,
  isKey: () => isKey,
  isReference: () => isReference,
  make: () => make3,
  makeUnsafe: () => makeUnsafe,
  merge: () => merge2,
  mergeAll: () => mergeAll,
  omit: () => omit,
  pick: () => pick
});

// ops/node_modules/effect/dist/Effectable.js
var Prototype2 = (options) => makePrimitiveProto({
  op: options.label,
  [evaluate]: options.evaluate
});

// ops/node_modules/effect/dist/Context.js
var ServiceTypeId = "~effect/Context/Service";
var Service = function() {
  function KeyClass() {
  }
  const self = KeyClass;
  Object.setPrototypeOf(self, ServiceProto);
  const init = (key, options) => {
    self.key = key;
    if (options?.defaultValue) {
      self[ReferenceTypeId] = ReferenceTypeId;
      self.defaultValue = options.defaultValue;
    }
    if (options?.make) {
      ;
      self.make = options.make;
    }
    if (options?.fiberCached) {
      cacheKeys.add(key);
    }
    return self;
  };
  return arguments.length > 0 ? init(arguments[0], arguments[1]) : init;
};
var ServiceProto = {
  [ServiceTypeId]: ServiceTypeId,
  .../* @__PURE__ */ Prototype2({
    label: "Service",
    evaluate(fiber3) {
      return exitSucceed(get(fiber3.context, this));
    }
  }),
  toJSON() {
    return {
      _id: "Service",
      key: this.key
    };
  },
  of(self) {
    return self;
  },
  context(self) {
    return make3(this, self);
  },
  use(f) {
    return withFiber((fiber3) => f(get(fiber3.context, this)));
  },
  useSync(f) {
    return withFiber((fiber3) => exitSucceed(f(get(fiber3.context, this))));
  }
};
var cacheKeys = /* @__PURE__ */ new Set();
var ReferenceTypeId = "~effect/Context/Reference";
var TypeId3 = "~effect/Context";
var MaxDepth = 8;
var FlattenAfterBaseHits = 8;
var makeImpl = (cacheRoot, base, overlay, depth) => {
  const self = Object.create(Proto);
  self.cacheRoot = cacheRoot ?? self;
  self.base = base;
  self.overlay = overlay;
  self.depth = depth;
  self._flat = void 0;
  self.baseHits = 0;
  return self;
};
var applyOverlays = (map6, overlay) => {
  if (!overlay) return;
  applyOverlays(map6, overlay.parent);
  map6.set(overlay.key, overlay.value);
};
var flatten = (self) => {
  if (self._flat) return self._flat;
  if (!self.overlay) return self._flat = self.base;
  const map6 = new Map(self.base);
  applyOverlays(map6, self.overlay);
  return self._flat = map6;
};
var withFlat = (self, f) => {
  const map6 = new Map(self.mapUnsafe);
  f(map6);
  return makeUnsafe(map6);
};
var notFound = /* @__PURE__ */ Symbol();
var lookup = (self, key) => {
  const impl = self;
  for (let overlay = impl.overlay; overlay; overlay = overlay.parent) {
    if (overlay.key === key) return overlay.value;
  }
  const value = impl.base.get(key);
  if (value === void 0 && !impl.base.has(key)) return notFound;
  if (impl.overlay && ++impl.baseHits >= FlattenAfterBaseHits) {
    impl.base = flatten(impl);
    impl.overlay = void 0;
    impl.depth = 0;
  }
  return value;
};
var makeUnsafe = (mapUnsafe) => makeImpl(void 0, mapUnsafe, void 0, 0);
var Proto = {
  get mapUnsafe() {
    return flatten(this);
  },
  ...PipeInspectableProto,
  [TypeId3]: {
    _Services: (_) => _
  },
  toJSON() {
    return {
      _id: "Context",
      services: Array.from(this.mapUnsafe).map(([key, value]) => ({
        key,
        value
      }))
    };
  },
  [symbol2](that) {
    if (!isContext(that)) return false;
    const self = this.mapUnsafe;
    const other = that.mapUnsafe;
    if (self.size !== other.size) return false;
    for (const [key, value] of self) {
      if (!other.has(key) || !equals(value, other.get(key))) return false;
    }
    return true;
  },
  [symbol]() {
    return number(this.mapUnsafe.size);
  }
};
var hasSameCache = (self, that) => self.cacheRoot === that.cacheRoot;
var isContext = (u) => hasProperty(u, TypeId3);
var isKey = (u) => hasProperty(u, ServiceTypeId);
var isReference = (u) => !!u[ReferenceTypeId];
var empty2 = () => emptyContext2;
var emptyContext2 = /* @__PURE__ */ makeUnsafe(/* @__PURE__ */ new Map());
var make3 = (key, service3) => makeUnsafe(/* @__PURE__ */ new Map([[key.key, service3]]));
var add = /* @__PURE__ */ dual(3, (self, key, service3) => addUnsafe(self, key.key, service3));
var addUnsafe = (self, key, service3) => {
  const impl = self;
  const cacheRoot = cacheKeys.has(key) ? void 0 : impl.cacheRoot;
  if (impl.depth >= MaxDepth) {
    const map6 = new Map(impl.mapUnsafe);
    map6.set(key, service3);
    return makeImpl(cacheRoot, map6, void 0, 0);
  }
  return makeImpl(cacheRoot, impl.base, {
    key,
    value: service3,
    parent: impl.overlay
  }, impl.depth + 1);
};
var addOrOmit = /* @__PURE__ */ dual(3, (self, key, service3) => service3._tag === "None" ? omit(key)(self) : add(self, key, service3.value));
var getOrElse3 = /* @__PURE__ */ dual(3, (self, key, orElse2) => {
  const value = lookup(self, key.key);
  if (value !== notFound) return value;
  return isReference(key) ? getDefaultValue(key) : orElse2();
});
var getOrUndefined3 = /* @__PURE__ */ dual(2, (self, key) => getOrUndefinedUnsafe(self, key.key));
var getOrUndefinedUnsafe = (self, key) => {
  const value = lookup(self, key);
  return value === notFound ? void 0 : value;
};
var getUnsafe = /* @__PURE__ */ dual(2, (self, service3) => {
  const value = lookup(self, service3.key);
  if (value === notFound) {
    if (isReference(service3)) return getDefaultValue(service3);
    throw serviceNotFoundError(service3);
  }
  return value;
});
var get = getUnsafe;
var defaultValueCacheKey = "~effect/Context/defaultValue";
var getDefaultValue = (ref) => {
  if (defaultValueCacheKey in ref) {
    return ref[defaultValueCacheKey];
  }
  return ref[defaultValueCacheKey] = ref.defaultValue();
};
var serviceNotFoundError = (service3) => {
  const error = new Error(`Service not found${service3.key ? `: ${String(service3.key)}` : ""}`);
  if (error.stack) {
    const lines = error.stack.split("\n");
    lines.splice(1, 3);
    error.stack = lines.join("\n");
  }
  return error;
};
var getOption = /* @__PURE__ */ dual(2, (self, service3) => {
  const value = lookup(self, service3.key);
  if (value !== notFound) return some2(value);
  return isReference(service3) ? some2(getDefaultValue(service3)) : none2();
});
var merge2 = /* @__PURE__ */ dual(2, (self, that) => {
  if (self.mapUnsafe.size === 0) return that;
  if (that.mapUnsafe.size === 0) return self;
  return withFlat(self, (map6) => that.mapUnsafe.forEach((value, key) => map6.set(key, value)));
});
var mergeAll = (...ctxs) => {
  const map6 = /* @__PURE__ */ new Map();
  for (let i = 0; i < ctxs.length; i++) {
    ctxs[i].mapUnsafe.forEach((value, key) => {
      map6.set(key, value);
    });
  }
  return makeUnsafe(map6);
};
var pick = (...services) => (self) => {
  const keep = new Set(services.map((key) => key.key));
  return withFlat(self, (map6) => map6.forEach((_, key) => {
    if (!keep.has(key)) map6.delete(key);
  }));
};
var omit = (...keys) => (self) => withFlat(self, (map6) => {
  for (let i = 0; i < keys.length; i++) {
    map6.delete(keys[i].key);
  }
});
var Reference = Service;

// ops/node_modules/effect/dist/Duration.js
var TypeId4 = "~effect/Duration";
var bigint0 = /* @__PURE__ */ BigInt(0);
var bigint1 = /* @__PURE__ */ BigInt(1);
var bigint2 = /* @__PURE__ */ BigInt(2);
var bigint10 = /* @__PURE__ */ BigInt(10);
var bigint24 = /* @__PURE__ */ BigInt(24);
var bigint60 = /* @__PURE__ */ BigInt(60);
var bigint1e3 = /* @__PURE__ */ BigInt(1e3);
var bigint1e6 = /* @__PURE__ */ BigInt(1e6);
var roundTiesAwayFromZero = (input) => BigInt(input < 0 ? Math.ceil(input - 0.5) : Math.floor(input + 0.5));
var roundMillisToNanos = (millis2) => roundTiesAwayFromZero(millis2 * 1e6);
var parseNanos = (input, scale) => {
  const decimalIndex = input.indexOf(".");
  if (decimalIndex === -1) return BigInt(input) * scale;
  const isNegative2 = input[0] === "-";
  const fractional = input.slice(decimalIndex + 1);
  const fractionalScale = bigint10 ** BigInt(fractional.length);
  const scaled = (BigInt(input.slice(isNegative2 ? 1 : 0, decimalIndex)) * fractionalScale + BigInt(fractional)) * scale;
  const rounded = scaled / fractionalScale + (scaled % fractionalScale * bigint2 >= fractionalScale ? bigint1 : bigint0);
  return isNegative2 ? -rounded : rounded;
};
var DURATION_REGEXP = /^(-?\d+(?:\.\d+)?)\s+(nanos?|micros?|millis?|seconds?|minutes?|hours?|days?|weeks?)$/;
var fromInputUnsafe = (input) => {
  switch (typeof input) {
    case "number":
      return millis(input);
    case "bigint":
      return nanos(input);
    case "string": {
      if (input === "Infinity") {
        return infinity;
      }
      if (input === "-Infinity") {
        return negativeInfinity;
      }
      const match7 = DURATION_REGEXP.exec(input);
      if (!match7) break;
      const [_, valueStr, unit] = match7;
      if (unit === "nano" || unit === "nanos") {
        return nanos(parseNanos(valueStr, bigint1));
      }
      if (unit === "micro" || unit === "micros") {
        return nanos(parseNanos(valueStr, bigint1e3));
      }
      const value = Number(valueStr);
      switch (unit) {
        case "milli":
        case "millis":
          return millis(value);
        case "second":
        case "seconds":
          return seconds(value);
        case "minute":
        case "minutes":
          return minutes(value);
        case "hour":
        case "hours":
          return hours(value);
        case "day":
        case "days":
          return days(value);
        case "week":
        case "weeks":
          return weeks(value);
      }
      break;
    }
    case "object": {
      if (input === null) break;
      if (TypeId4 in input) return input;
      if (Array.isArray(input)) {
        if (input.length !== 2 || !input.every(isNumber)) {
          return invalid(input);
        }
        if (Number.isNaN(input[0]) || Number.isNaN(input[1])) {
          return zero;
        }
        if (input[0] === -Infinity || input[1] === -Infinity) {
          return negativeInfinity;
        }
        if (input[0] === Infinity || input[1] === Infinity) {
          return infinity;
        }
        return make4(roundTiesAwayFromZero(input[0] * 1e9 + input[1]));
      }
      const obj = input;
      let millis2 = 0;
      if (obj.weeks) millis2 += obj.weeks * 6048e5;
      if (obj.days) millis2 += obj.days * 864e5;
      if (obj.hours) millis2 += obj.hours * 36e5;
      if (obj.minutes) millis2 += obj.minutes * 6e4;
      if (obj.seconds) millis2 += obj.seconds * 1e3;
      if (obj.milliseconds) millis2 += obj.milliseconds;
      if (!obj.microseconds && !obj.nanoseconds) return make4(millis2);
      return make4(roundTiesAwayFromZero(millis2 * 1e6 + (obj.microseconds ?? 0) * 1e3 + (obj.nanoseconds ?? 0)));
    }
  }
  return invalid(input);
};
var invalid = (input) => {
  throw new Error(`Invalid Input: ${input}`);
};
var zeroDurationValue = {
  _tag: "Millis",
  millis: 0
};
var infinityDurationValue = {
  _tag: "Infinity"
};
var negativeInfinityDurationValue = {
  _tag: "NegativeInfinity"
};
var DurationProto = {
  [TypeId4]: TypeId4,
  [symbol]() {
    switch (this.value._tag) {
      case "Millis": {
        const nanos2 = this.value.millis * 1e6;
        return Number.isFinite(nanos2) ? hash(roundTiesAwayFromZero(nanos2)) : number(this.value.millis);
      }
      case "Nanos":
        return hash(this.value.nanos);
      default:
        return structure(this.value);
    }
  },
  [symbol2](that) {
    return isDuration(that) && equals2(this, that);
  },
  toString() {
    switch (this.value._tag) {
      case "Infinity":
        return "Infinity";
      case "NegativeInfinity":
        return "-Infinity";
      case "Nanos":
        return `${this.value.nanos} nanos`;
      case "Millis":
        return `${this.value.millis} millis`;
    }
  },
  toJSON() {
    switch (this.value._tag) {
      case "Millis":
        return {
          _id: "Duration",
          _tag: "Millis",
          millis: this.value.millis
        };
      case "Nanos":
        return {
          _id: "Duration",
          _tag: "Nanos",
          nanos: String(this.value.nanos)
        };
      case "Infinity":
        return {
          _id: "Duration",
          _tag: "Infinity"
        };
      case "NegativeInfinity":
        return {
          _id: "Duration",
          _tag: "NegativeInfinity"
        };
    }
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var make4 = (input) => {
  const duration = Object.create(DurationProto);
  if (typeof input === "number") {
    if (isNaN(input) || input === 0 || Object.is(input, -0)) {
      duration.value = zeroDurationValue;
    } else if (!Number.isFinite(input)) {
      duration.value = input > 0 ? infinityDurationValue : negativeInfinityDurationValue;
    } else if (!Number.isInteger(input)) {
      duration.value = {
        _tag: "Nanos",
        nanos: roundMillisToNanos(input)
      };
    } else {
      duration.value = {
        _tag: "Millis",
        millis: input
      };
    }
  } else if (input === bigint0) {
    duration.value = zeroDurationValue;
  } else {
    duration.value = {
      _tag: "Nanos",
      nanos: input
    };
  }
  return duration;
};
var isDuration = (u) => hasProperty(u, TypeId4);
var isZero = (self) => {
  switch (self.value._tag) {
    case "Millis":
      return self.value.millis === 0;
    case "Nanos":
      return self.value.nanos === bigint0;
    case "Infinity":
    case "NegativeInfinity":
      return false;
  }
};
var isNegative = (self) => {
  switch (self.value._tag) {
    case "Millis":
      return self.value.millis < 0;
    case "Nanos":
      return self.value.nanos < bigint0;
    case "NegativeInfinity":
      return true;
    case "Infinity":
      return false;
  }
};
var abs = (self) => {
  switch (self.value._tag) {
    case "Infinity":
    case "NegativeInfinity":
      return infinity;
    case "Millis":
      return self.value.millis < 0 ? make4(-self.value.millis) : self;
    case "Nanos":
      return self.value.nanos < bigint0 ? make4(-self.value.nanos) : self;
  }
};
var zero = /* @__PURE__ */ make4(0);
var infinity = /* @__PURE__ */ make4(Infinity);
var negativeInfinity = /* @__PURE__ */ make4(-Infinity);
var nanos = (nanos2) => make4(nanos2);
var millis = (millis2) => make4(millis2);
var seconds = (seconds2) => make4(seconds2 * 1e3);
var minutes = (minutes2) => make4(minutes2 * 6e4);
var hours = (hours2) => make4(hours2 * 36e5);
var days = (days2) => make4(days2 * 864e5);
var weeks = (weeks2) => make4(weeks2 * 6048e5);
var toMillis = (self) => match2(fromInputUnsafe(self), {
  onMillis: identity,
  onNanos: (nanos2) => Number(nanos2) / 1e6,
  onInfinity: () => Infinity,
  onNegativeInfinity: () => -Infinity
});
var toNanosUnsafe = (input) => {
  const self = fromInputUnsafe(input);
  switch (self.value._tag) {
    case "Infinity":
    case "NegativeInfinity":
      throw new Error("Cannot convert infinite duration to nanos");
    case "Nanos":
      return self.value.nanos;
    case "Millis":
      return roundMillisToNanos(self.value.millis);
  }
};
var match2 = /* @__PURE__ */ dual(2, (self, options) => {
  switch (self.value._tag) {
    case "Millis":
      return options.onMillis(self.value.millis);
    case "Nanos":
      return options.onNanos(self.value.nanos);
    case "Infinity":
      return options.onInfinity();
    case "NegativeInfinity":
      return (options.onNegativeInfinity ?? options.onInfinity)();
  }
});
var matchPair = /* @__PURE__ */ dual(3, (self, that, options) => {
  if (self.value._tag === "Infinity" || self.value._tag === "NegativeInfinity" || that.value._tag === "Infinity" || that.value._tag === "NegativeInfinity") return options.onInfinity(self, that);
  if (self.value._tag === "Millis") {
    return that.value._tag === "Millis" ? options.onMillis(self.value.millis, that.value.millis) : options.onNanos(toNanosUnsafe(self), that.value.nanos);
  } else {
    return options.onNanos(self.value.nanos, toNanosUnsafe(that));
  }
});
var Equivalence = (self, that) => matchPair(self, that, {
  onMillis: (self2, that2) => self2 === that2,
  onNanos: (self2, that2) => self2 === that2,
  onInfinity: (self2, that2) => self2.value._tag === that2.value._tag
});
var subtract = /* @__PURE__ */ dual(2, (self, that) => matchPair(self, that, {
  onMillis: (self2, that2) => make4(self2 - that2),
  onNanos: (self2, that2) => make4(self2 - that2),
  onInfinity: (self2, that2) => {
    const s = self2.value._tag;
    const t = that2.value._tag;
    if (s === "Infinity") return t === "Infinity" ? zero : infinity;
    if (s === "NegativeInfinity") return t === "NegativeInfinity" ? zero : negativeInfinity;
    return t === "Infinity" ? negativeInfinity : infinity;
  }
}));
var equals2 = /* @__PURE__ */ dual(2, (self, that) => Equivalence(self, that));
var parts = (self) => {
  if (self.value._tag === "Infinity") {
    return {
      days: Infinity,
      hours: Infinity,
      minutes: Infinity,
      seconds: Infinity,
      millis: Infinity,
      nanos: Infinity
    };
  }
  if (self.value._tag === "NegativeInfinity") {
    return {
      days: -Infinity,
      hours: -Infinity,
      minutes: -Infinity,
      seconds: -Infinity,
      millis: -Infinity,
      nanos: -Infinity
    };
  }
  const n = toNanosUnsafe(self);
  const neg = n < bigint0;
  const a = neg ? -n : n;
  const ms = a / bigint1e6;
  const sec = ms / bigint1e3;
  const min2 = sec / bigint60;
  const hr = min2 / bigint60;
  const d = hr / bigint24;
  const sign = neg ? -1 : 1;
  return {
    days: sign * Number(d),
    hours: sign * Number(hr % bigint24),
    minutes: sign * Number(min2 % bigint60),
    seconds: sign * Number(sec % bigint60),
    millis: sign * Number(ms % bigint1e3),
    nanos: sign * Number(a % bigint1e6)
  };
};
var format2 = (self) => {
  if (self.value._tag === "Infinity") {
    return "Infinity";
  }
  if (self.value._tag === "NegativeInfinity") {
    return "-Infinity";
  }
  if (isZero(self)) {
    return "0";
  }
  if (isNegative(self)) {
    return "-" + format2(abs(self));
  }
  const fragments = parts(self);
  const pieces = [];
  if (fragments.days !== 0) {
    pieces.push(`${fragments.days}d`);
  }
  if (fragments.hours !== 0) {
    pieces.push(`${fragments.hours}h`);
  }
  if (fragments.minutes !== 0) {
    pieces.push(`${fragments.minutes}m`);
  }
  if (fragments.seconds !== 0) {
    pieces.push(`${fragments.seconds}s`);
  }
  if (fragments.millis !== 0) {
    pieces.push(`${fragments.millis}ms`);
  }
  if (fragments.nanos !== 0) {
    pieces.push(`${fragments.nanos}ns`);
  }
  return pieces.join(" ");
};

// ops/node_modules/effect/dist/Filter.js
var composePassthrough = /* @__PURE__ */ dual(2, (left, right) => (input) => {
  const leftOut = left(input);
  if (isFailure2(leftOut)) return fail2(input);
  const rightOut = right(leftOut.success);
  if (isFailure2(rightOut)) return fail2(input);
  return rightOut;
});
var toOption = (self) => (input) => {
  const result3 = self(input);
  return isFailure2(result3) ? none2() : some2(result3.success);
};

// ops/node_modules/effect/dist/Scheduler.js
var Scheduler = /* @__PURE__ */ Reference("effect/Scheduler", {
  fiberCached: true,
  defaultValue: () => new MixedScheduler()
});
var setMicrotask = (f) => {
  let cancelled = false;
  Promise.resolve().then(() => {
    if (!cancelled) f();
  });
  return () => {
    cancelled = true;
  };
};
var setTimer = "setImmediate" in globalThis ? (f) => {
  const timer = globalThis.setImmediate(f);
  return () => globalThis.clearImmediate(timer);
} : (f) => {
  const timer = setTimeout(f, 0);
  return () => clearTimeout(timer);
};
var setImmediate = (f) => {
  try {
    return setTimer(f);
  } catch {
    return setMicrotask(f);
  }
};
var PriorityBuckets = class {
  buckets = [];
  scheduleTask(task, priority) {
    const buckets = this.buckets;
    const len = buckets.length;
    let bucket;
    let index = 0;
    for (; index < len; index++) {
      if (buckets[index][0] > priority) break;
      bucket = buckets[index];
    }
    if (bucket && bucket[0] === priority) {
      bucket[1].push(task);
    } else if (index === len) {
      buckets.push([priority, [task]]);
    } else {
      buckets.splice(index, 0, [priority, [task]]);
    }
  }
  drain() {
    const buckets = this.buckets;
    this.buckets = [];
    return buckets;
  }
};
var MixedScheduler = class {
  executionMode;
  setImmediate;
  constructor(executionMode = "async", setImmediateFn) {
    this.executionMode = executionMode;
    this.setImmediate = setImmediateFn ?? (executionMode === "sync" ? setMicrotask : setImmediate);
  }
  /**
   * Returns whether the fiber has reached its operation budget and should yield.
   *
   * **When to use**
   *
   * Use to decide whether a fiber should yield after consuming its current
   * operation budget.
   *
   * @since 2.0.0
   */
  shouldYield(fiber3) {
    return fiber3.currentOpCount >= fiber3.cache.maxOpsBeforeYield;
  }
  /**
   * Creates a dispatcher that schedules work through this scheduler.
   *
   * **When to use**
   *
   * Use when you need a standalone dispatcher from a scheduler instance, for
   * example in tests that enqueue tasks and then flush them deterministically.
   *
   * @since 4.0.0
   */
  makeDispatcher() {
    return new MixedSchedulerDispatcher(this.setImmediate);
  }
};
var MixedSchedulerDispatcher = class {
  tasks = /* @__PURE__ */ new PriorityBuckets();
  running = void 0;
  setImmediate;
  constructor(setImmediateFn = setImmediate) {
    this.setImmediate = setImmediateFn;
  }
  /**
   * @since 2.0.0
   */
  scheduleTask(task, priority) {
    this.tasks.scheduleTask(task, priority);
    if (this.running === void 0) {
      this.running = this.setImmediate(this.afterScheduled);
    }
  }
  /**
   * @since 2.0.0
   */
  afterScheduled = () => {
    this.running = void 0;
    this.runTasks();
  };
  /**
   * @since 2.0.0
   */
  runTasks() {
    const buckets = this.tasks.drain();
    for (let i = 0; i < buckets.length; i++) {
      const toRun = buckets[i][1];
      for (let j = 0; j < toRun.length; j++) {
        toRun[j]();
      }
    }
  }
  /**
   * @since 2.0.0
   */
  flush() {
    while (this.tasks.buckets.length > 0) {
      if (this.running !== void 0) {
        this.running();
        this.running = void 0;
      }
      this.runTasks();
    }
  }
};
var MaxOpsBeforeYield = /* @__PURE__ */ Reference("effect/Scheduler/MaxOpsBeforeYield", {
  fiberCached: true,
  defaultValue: () => 2048
});
var PreventSchedulerYield = /* @__PURE__ */ Reference("effect/Scheduler/PreventSchedulerYield", {
  fiberCached: true,
  defaultValue: () => false
});

// ops/node_modules/effect/dist/Data.js
var Data_exports = {};
__export(Data_exports, {
  Class: () => Class3,
  Error: () => Error3,
  TaggedClass: () => TaggedClass,
  TaggedError: () => TaggedError2,
  taggedEnum: () => taggedEnum
});
var Class3 = class extends Class {
  constructor(props) {
    super();
    if (props) {
      assignProperties(this, props);
    }
  }
};
var TaggedClass = (tag) => class extends Class3 {
  _tag = tag;
};
var taggedEnum = () => new Proxy({}, {
  get(_target, tag, _receiver) {
    if (tag === "$is") {
      return isTagged;
    } else if (tag === "$match") {
      return taggedMatch;
    }
    return (props) => ({
      ...props,
      _tag: tag
    });
  }
});
function taggedMatch() {
  if (arguments.length === 1) {
    const cases2 = arguments[0];
    return function(value2) {
      return cases2[value2._tag](value2);
    };
  }
  const value = arguments[0];
  const cases = arguments[1];
  return cases[value._tag](value);
}
var Error3 = Error2;
var TaggedError2 = TaggedError;

// ops/node_modules/effect/dist/Encoding.js
var EncodingErrorTypeId = "~effect/Encoding/EncodingError";
var EncodingError = class extends (/* @__PURE__ */ TaggedError2("EncodingError")) {
  /**
   * Marks this value as an encoding or decoding error for runtime guards.
   *
   * **When to use**
   *
   * Use to identify `EncodingError` instances through `isEncodingError`.
   *
   * @since 4.0.0
   */
  [EncodingErrorTypeId] = EncodingErrorTypeId;
};
var randomHex = (length) => {
  switch (length) {
    case 16:
      return randomHex16();
    case 32:
      return randomHex32();
    default: {
      let result3 = "";
      for (let i = length >>> 3; i > 0; i--) {
        result3 += randomHex8();
      }
      return result3;
    }
  }
};
var hexCharCodes = /* @__PURE__ */ Uint8Array.from("0123456789abcdef", (c) => c.charCodeAt(0));
var randomWord = () => Math.random() * 4294967296 >>> 0;
var randomHex8 = () => {
  const a = randomWord();
  return String.fromCharCode(hexCharCodes[a >>> 28], hexCharCodes[a >>> 24 & 15], hexCharCodes[a >>> 20 & 15], hexCharCodes[a >>> 16 & 15], hexCharCodes[a >>> 12 & 15], hexCharCodes[a >>> 8 & 15], hexCharCodes[a >>> 4 & 15], hexCharCodes[a & 15]);
};
var randomHex16 = () => {
  const a = randomWord();
  const b = randomWord();
  return String.fromCharCode(hexCharCodes[a >>> 28], hexCharCodes[a >>> 24 & 15], hexCharCodes[a >>> 20 & 15], hexCharCodes[a >>> 16 & 15], hexCharCodes[a >>> 12 & 15], hexCharCodes[a >>> 8 & 15], hexCharCodes[a >>> 4 & 15], hexCharCodes[a & 15], hexCharCodes[b >>> 28], hexCharCodes[b >>> 24 & 15], hexCharCodes[b >>> 20 & 15], hexCharCodes[b >>> 16 & 15], hexCharCodes[b >>> 12 & 15], hexCharCodes[b >>> 8 & 15], hexCharCodes[b >>> 4 & 15], hexCharCodes[b & 15]);
};
var randomHex32 = () => {
  const a = randomWord();
  const b = randomWord();
  const c = randomWord();
  const d = randomWord();
  return String.fromCharCode(hexCharCodes[a >>> 28], hexCharCodes[a >>> 24 & 15], hexCharCodes[a >>> 20 & 15], hexCharCodes[a >>> 16 & 15], hexCharCodes[a >>> 12 & 15], hexCharCodes[a >>> 8 & 15], hexCharCodes[a >>> 4 & 15], hexCharCodes[a & 15], hexCharCodes[b >>> 28], hexCharCodes[b >>> 24 & 15], hexCharCodes[b >>> 20 & 15], hexCharCodes[b >>> 16 & 15], hexCharCodes[b >>> 12 & 15], hexCharCodes[b >>> 8 & 15], hexCharCodes[b >>> 4 & 15], hexCharCodes[b & 15], hexCharCodes[c >>> 28], hexCharCodes[c >>> 24 & 15], hexCharCodes[c >>> 20 & 15], hexCharCodes[c >>> 16 & 15], hexCharCodes[c >>> 12 & 15], hexCharCodes[c >>> 8 & 15], hexCharCodes[c >>> 4 & 15], hexCharCodes[c & 15], hexCharCodes[d >>> 28], hexCharCodes[d >>> 24 & 15], hexCharCodes[d >>> 20 & 15], hexCharCodes[d >>> 16 & 15], hexCharCodes[d >>> 12 & 15], hexCharCodes[d >>> 8 & 15], hexCharCodes[d >>> 4 & 15], hexCharCodes[d & 15]);
};

// ops/node_modules/effect/dist/Tracer.js
var ParentSpanKey = "effect/Tracer/ParentSpan";
var ParentSpan = class extends (/* @__PURE__ */ Service()(ParentSpanKey, {
  fiberCached: true
})) {
};
var make5 = (options) => options;
var DisablePropagation = /* @__PURE__ */ Reference("effect/Tracer/DisablePropagation", {
  defaultValue: constFalse
});
var CurrentTraceLevel = /* @__PURE__ */ Reference("effect/Tracer/CurrentTraceLevel", {
  defaultValue: () => "Info"
});
var MinimumTraceLevel = /* @__PURE__ */ Reference("effect/Tracer/MinimumTraceLevel", {
  defaultValue: () => "All"
});
var TracerKey = "effect/Tracer";
var Tracer = /* @__PURE__ */ Reference(TracerKey, {
  fiberCached: true,
  defaultValue: () => nativeTracer
});
var nativeTracer = /* @__PURE__ */ make5({
  span: (options) => new NativeSpan(options)
});
var NativeSpan = class {
  _tag = "Span";
  sampled;
  name;
  parent;
  annotations;
  links;
  startTime;
  kind;
  status;
  _traceId = void 0;
  _spanId = void 0;
  _attributes = void 0;
  _events = void 0;
  constructor(options) {
    this.name = options.name;
    this.parent = options.parent;
    this.annotations = options.annotations;
    this.links = options.links;
    this.startTime = options.startTime;
    this.kind = options.kind;
    this.sampled = options.sampled;
    this.status = {
      _tag: "Started",
      startTime: options.startTime
    };
  }
  get traceId() {
    return this._traceId ??= getOrUndefined(this.parent)?.traceId ?? randomHex(32);
  }
  get spanId() {
    return this._spanId ??= randomHex(16);
  }
  get attributes() {
    return this._attributes ??= /* @__PURE__ */ new Map();
  }
  get events() {
    return this._events ??= [];
  }
  end(endTime, exit3) {
    this.status = {
      _tag: "Ended",
      endTime,
      exit: exit3,
      startTime: this.status.startTime
    };
  }
  attribute(key, value) {
    this.attributes.set(key, value);
  }
  event(name, startTime, attributes) {
    this.events.push([name, startTime, attributes ?? {}]);
  }
  addLinks(links) {
    this.links.push(...links);
  }
};

// ops/node_modules/effect/dist/internal/metric.js
var FiberRuntimeMetricsKey = "effect/Metric/FiberRuntimeMetrics";

// ops/node_modules/effect/dist/internal/references.js
var CurrentErrorReporters = /* @__PURE__ */ Reference("effect/ErrorReporter/CurrentErrorReporters", {
  defaultValue: () => /* @__PURE__ */ new Set()
});
var CurrentStackFrame = /* @__PURE__ */ Reference("effect/References/CurrentStackFrame", {
  fiberCached: true,
  defaultValue: constUndefined
});
var TracerEnabled = /* @__PURE__ */ Reference("effect/References/TracerEnabled", {
  fiberCached: true,
  defaultValue: constTrue
});
var TracerTimingEnabled = /* @__PURE__ */ Reference("effect/References/TracerTimingEnabled", {
  defaultValue: constTrue
});
var TracerSpanAnnotations = /* @__PURE__ */ Reference("effect/References/TracerSpanAnnotations", {
  defaultValue: () => ({})
});
var TracerSpanLinks = /* @__PURE__ */ Reference("effect/References/TracerSpanLinks", {
  defaultValue: () => []
});
var CurrentLogAnnotations = /* @__PURE__ */ Reference("effect/References/CurrentLogAnnotations", {
  defaultValue: () => ({})
});
var CurrentLogLevel = /* @__PURE__ */ Reference("effect/References/CurrentLogLevel", {
  fiberCached: true,
  defaultValue: () => "Info"
});
var MinimumLogLevel = /* @__PURE__ */ Reference("effect/References/MinimumLogLevel", {
  fiberCached: true,
  defaultValue: () => "Info"
});
var CurrentLogSpans = /* @__PURE__ */ Reference("effect/References/CurrentLogSpans", {
  defaultValue: () => []
});

// ops/node_modules/effect/dist/internal/tracer.js
var addSpanStackTrace = (options) => {
  if (options?.captureStackTrace === false) {
    return options;
  } else if (options?.captureStackTrace !== void 0 && typeof options.captureStackTrace !== "boolean") {
    return options;
  }
  const limit = getStackTraceLimit();
  if (limit === 0 && options?.captureStackTrace !== true) {
    return {
      ...options,
      captureStackTrace: false
    };
  }
  setStackTraceLimit(3);
  const traceError = new Error();
  setStackTraceLimit(limit);
  return {
    ...options,
    captureStackTrace: spanCleaner(() => traceError.stack)
  };
};
var makeStackCleaner = (line) => (stack) => {
  let cache2;
  return () => {
    if (cache2 !== void 0) return cache2;
    const trace = stack();
    if (!trace) return void 0;
    const lines = trace.split("\n");
    if (lines[line] !== void 0) {
      cache2 = lines[line].trim();
      return cache2;
    }
  };
};
var spanCleaner = /* @__PURE__ */ makeStackCleaner(3);

// ops/node_modules/effect/dist/internal/effect.js
var Interrupt = class extends ReasonBase {
  constructor(fiberId3, annotations2 = constEmptyAnnotations) {
    super("Interrupt", annotations2, "Interrupted");
    this.fiberId = fiberId3;
  }
  toString() {
    return `Interrupt(${this.fiberId})`;
  }
  toJSON() {
    return {
      _tag: "Interrupt",
      fiberId: this.fiberId
    };
  }
  [symbol2](that) {
    return isInterruptReason(that) && this.fiberId === that.fiberId && this.annotations === that.annotations;
  }
  [symbol]() {
    return combine(string(`${this._tag}:${this.fiberId}`))(random(this.annotations));
  }
};
var makeInterruptReason = (fiberId3) => new Interrupt(fiberId3);
var causeInterrupt = (fiberId3) => new CauseImpl([new Interrupt(fiberId3)]);
var hasFails = (self) => self.reasons.some(isFailReason);
var findFail = (self) => {
  const reason = self.reasons.find(isFailReason);
  return reason ? succeed2(reason) : fail2(self);
};
var findError = (self) => {
  for (let i = 0; i < self.reasons.length; i++) {
    const reason = self.reasons[i];
    if (reason._tag === "Fail") {
      return succeed2(reason.error);
    }
  }
  return fail2(self);
};
var findErrorOption = /* @__PURE__ */ toOption(findError);
var hasDies = (self) => self.reasons.some(isDieReason);
var findDie = (self) => {
  const reason = self.reasons.find(isDieReason);
  return reason ? succeed2(reason) : fail2(self);
};
var findDefect = (self) => {
  const reason = self.reasons.find(isDieReason);
  return reason ? succeed2(reason.defect) : fail2(self);
};
var hasInterrupts = (self) => self.reasons.some(isInterruptReason);
var findInterrupt = (self) => {
  const reason = self.reasons.find(isInterruptReason);
  return reason ? succeed2(reason) : fail2(self);
};
var causeFilterInterruptors = (self) => {
  let interruptors2;
  for (let i = 0; i < self.reasons.length; i++) {
    const f = self.reasons[i];
    if (f._tag !== "Interrupt") continue;
    interruptors2 ??= /* @__PURE__ */ new Set();
    if (f.fiberId !== void 0) {
      interruptors2.add(f.fiberId);
    }
  }
  return interruptors2 ? succeed2(interruptors2) : fail2(self);
};
var causeInterruptors = (self) => {
  const result3 = causeFilterInterruptors(self);
  return isFailure2(result3) ? emptySet : result3.success;
};
var emptySet = /* @__PURE__ */ new Set();
var hasInterruptsOnly = (self) => self.reasons.length > 0 && self.reasons.every(isInterruptReason);
var reasonAnnotations = (self) => makeUnsafe(self.annotations);
var causeAnnotations = (self) => {
  const map6 = /* @__PURE__ */ new Map();
  for (const f of self.reasons) {
    if (f.annotations.size > 0) {
      for (const [key, value] of f.annotations) {
        map6.set(key, value);
      }
    }
  }
  return makeUnsafe(map6);
};
var dedupeReasons = (self, that) => {
  const buckets = /* @__PURE__ */ new Map();
  const out = [];
  for (const reason of self.concat(that)) {
    const hash2 = hash(reason);
    const bucket = buckets.get(hash2);
    if (bucket === void 0) {
      buckets.set(hash2, [reason]);
    } else if (bucket.some((previous) => equals(previous, reason))) {
      continue;
    } else {
      bucket.push(reason);
    }
    out.push(reason);
  }
  return out;
};
var causeCombine = /* @__PURE__ */ dual(2, (self, that) => {
  if (self.reasons.length === 0) {
    return that;
  } else if (that.reasons.length === 0) {
    return self;
  }
  const newCause = new CauseImpl(dedupeReasons(self.reasons, that.reasons));
  return equals(self, newCause) ? self : newCause;
});
var causeMap = /* @__PURE__ */ dual(2, (self, f) => {
  let hasFail = false;
  const failures = self.reasons.map((failure) => {
    if (isFailReason(failure)) {
      hasFail = true;
      return new Fail(f(failure.error), failure.annotations);
    }
    return failure;
  });
  return hasFail ? causeFromReasons(failures) : self;
});
var causePartition = (self) => {
  const obj = {
    Fail: [],
    Die: [],
    Interrupt: []
  };
  for (let i = 0; i < self.reasons.length; i++) {
    obj[self.reasons[i]._tag].push(self.reasons[i]);
  }
  return obj;
};
var causeSquash = (self) => {
  const partitioned = causePartition(self);
  if (partitioned.Fail.length > 0) {
    return partitioned.Fail[0].error;
  } else if (partitioned.Die.length > 0) {
    return partitioned.Die[0].defect;
  } else if (partitioned.Interrupt.length > 0) {
    return new globalThis.Error("All fibers interrupted without error");
  }
  return new globalThis.Error("Empty cause");
};
var causePrettyErrors = (self, options) => {
  const errors = [];
  const interrupts = [];
  if (self.reasons.length === 0) return errors;
  const prevStackLimit = getStackTraceLimit();
  if (prevStackLimit !== 0) setStackTraceLimit(1);
  for (const failure of self.reasons) {
    if (failure._tag === "Interrupt") {
      interrupts.push(failure);
      continue;
    }
    errors.push(causePrettyError(failure._tag === "Die" ? failure.defect : failure.error, failure.annotations, options));
  }
  if (errors.length === 0) {
    const cause = new Error("The fiber was interrupted by:");
    cause.name = "InterruptCause";
    cause.stack = interruptCauseStack(cause, interrupts);
    const error = new globalThis.Error("All fibers interrupted without error", {
      cause
    });
    error.name = "InterruptError";
    error.stack = `${error.name}: ${error.message}`;
    errors.push(causePrettyError(error, interrupts[0].annotations, options));
  }
  if (prevStackLimit !== 0) setStackTraceLimit(prevStackLimit);
  return errors;
};
var causePrettyError = (original, annotations2, options) => {
  const kind = typeof original;
  let error;
  if (original && kind === "object") {
    error = new globalThis.Error(causePrettyMessage(original), {
      cause: original.cause ? causePrettyError(original.cause) : void 0
    });
    if (typeof original.name === "string") {
      error.name = original.name;
    }
    if (typeof original.stack === "string") {
      error.stack = cleanErrorStack(original.stack, error, annotations2);
    } else {
      const stack = `${error.name}: ${error.message}`;
      error.stack = annotations2 ? addStackAnnotations(stack, annotations2) : stack;
    }
    if (options?.includeCauseInStack) {
      error.stack = renderPrettyError(error);
    }
    for (const key of Object.keys(original)) {
      if (!(key in error)) {
        ;
        error[key] = original[key];
      }
    }
  } else {
    error = new globalThis.Error(!original ? `Unknown error: ${original}` : kind === "string" ? original : formatJson(original));
  }
  return error;
};
var causePrettyMessage = (u) => {
  if (typeof u.message === "string") {
    return u.message;
  } else if (typeof u.toString === "function" && u.toString !== Object.prototype.toString && u.toString !== Array.prototype.toString) {
    try {
      return u.toString();
    } catch {
    }
  }
  return formatJson(u);
};
var locationRegExp = /\((.*)\)/g;
var cleanErrorStack = (stack, error, annotations2) => {
  const message = `${error.name}: ${error.message}`;
  const lines = (stack.startsWith(message) ? stack.slice(message.length) : stack).split("\n");
  const out = [message];
  for (let i = 1; i < lines.length; i++) {
    if (/(?:Generator\.next|~effect\/Effect)/.test(lines[i])) {
      break;
    }
    out.push(lines[i]);
  }
  return annotations2 ? addStackAnnotations(out.join("\n"), annotations2) : out.join("\n");
};
var addStackAnnotations = (stack, annotations2) => {
  const frame = annotations2?.get(StackTraceKey.key);
  if (frame) {
    stack = `${stack}
${currentStackTrace(frame)}`;
  }
  return stack;
};
var interruptCauseStack = (error, interrupts) => {
  const out = [`${error.name}: ${error.message}`];
  for (const current of interrupts) {
    const fiberId3 = current.fiberId !== void 0 ? `#${current.fiberId}` : "unknown";
    const frame = current.annotations.get(InterruptorStackTrace.key);
    out.push(`    at fiber (${fiberId3})`);
    if (frame) out.push(currentStackTrace(frame));
  }
  return out.join("\n");
};
var currentStackTrace = (frame) => {
  const out = [];
  let current = frame;
  let i = 0;
  while (current && i < 10) {
    const stack = current.stack();
    if (stack) {
      const locationMatchAll = stack.matchAll(locationRegExp);
      let match7 = false;
      for (const [, location] of locationMatchAll) {
        match7 = true;
        out.push(`    at ${current.name} (${location})`);
      }
      if (!match7) {
        out.push(`    at ${current.name} (${stack.replace(/^at /, "")})`);
      }
    } else {
      out.push(`    at ${current.name}`);
    }
    current = current.parent;
    i++;
  }
  return out.join("\n");
};
var causePretty = (cause) => causePrettyErrors(cause).map(renderPrettyError).join("\n");
var renderPrettyError = (e) => e.cause ? `${e.stack} {
${renderErrorCause(e.cause, "  ")}
}` : e.stack;
var renderErrorCause = (cause, prefix) => {
  const lines = cause.stack.split("\n");
  let stack = `${prefix}[cause]: ${lines[0]}`;
  for (let i = 1, len = lines.length; i < len; i++) {
    stack += `
${prefix}${lines[i]}`;
  }
  if (cause.cause) {
    stack += ` {
${renderErrorCause(cause.cause, `${prefix}  `)}
${prefix}}`;
  }
  return stack;
};
var FiberTypeId = "~effect/Fiber";
var fiberVariance = {
  _A: identity,
  _E: identity
};
var fiberIdStore = {
  id: 0
};
var getCurrentFiber = () => globalThis[currentFiberTypeId];
var FiberImpl = class {
  constructor(context3, interruptible3 = true) {
    this[FiberTypeId] = fiberVariance;
    this.setContext(context3);
    this.id = ++fiberIdStore.id;
    this.currentOpCount = 0;
    this.interruptible = interruptible3;
    this._stack = [];
    this._observers = void 0;
    this._exit = void 0;
    this._children = void 0;
    this._interruptedCause = void 0;
    this._yielded = void 0;
    this._running = false;
    this._deferredInterrupt = false;
    this._parent = void 0;
    this.cache.runtimeMetrics?.recordFiberStart(this.context);
  }
  [FiberTypeId];
  id;
  interruptible;
  currentOpCount;
  _stack;
  _observers;
  _exit;
  _children;
  _interruptedCause;
  _yielded;
  _running;
  _deferredInterrupt;
  _parent;
  // set in setContext
  context;
  cache;
  _dispatcher = void 0;
  get currentDispatcher() {
    return this._dispatcher ??= this.cache.scheduler.makeDispatcher();
  }
  getRef(ref) {
    return get(this.context, ref);
  }
  addObserver(cb) {
    if (this._exit) {
      cb(this._exit);
      return constVoid;
    }
    if (this._observers === void 0) {
      this._observers = [cb];
    } else {
      this._observers.push(cb);
    }
    return () => {
      if (this._exit || this._observers === void 0) return;
      const index = this._observers.indexOf(cb);
      if (index >= 0) {
        this._observers.splice(index, 1);
      }
    };
  }
  interruptUnsafe(fiberId3, annotations2) {
    if (this._exit) {
      return;
    }
    let cause = causeInterrupt(fiberId3);
    if (this.cache.stackFrame) {
      cause = causeAnnotate(cause, make3(StackTraceKey, this.cache.stackFrame));
    }
    if (annotations2) {
      cause = causeAnnotate(cause, annotations2);
    }
    this._interruptedCause = this._interruptedCause ? causeCombine(this._interruptedCause, cause) : cause;
    if (this.interruptible) {
      if (this._running) {
        this._deferredInterrupt = true;
      } else {
        this.evaluate(failCause(this._interruptedCause));
      }
    }
  }
  pollUnsafe() {
    return this._exit;
  }
  evaluate(effect2) {
    if (this._exit) {
      return;
    } else if (this._yielded !== void 0) {
      const yielded = this._yielded;
      this._yielded = void 0;
      yielded();
    }
    const exit3 = this.runLoop(effect2);
    if (exit3 === Yield) {
      return;
    }
    const interruptChildren = fiberMiddleware.interruptChildren && fiberMiddleware.interruptChildren(this);
    if (interruptChildren !== void 0) {
      return this.evaluate(flatMap2(interruptChildren, () => exit3));
    }
    this._exit = exit3;
    this.cache.runtimeMetrics?.recordFiberEnd(this.context, this._exit);
    if (this._parent) {
      this._parent._children?.delete(this);
      this._parent = void 0;
    }
    if (this._observers !== void 0) {
      const observers = this._observers;
      this._observers = void 0;
      for (let i = 0; i < observers.length; i++) {
        observers[i](exit3);
      }
    }
    this._stack.length = 0;
    this._children = void 0;
    this.context = empty2();
  }
  runLoop(effect2) {
    const prevFiber = globalThis[currentFiberTypeId];
    globalThis[currentFiberTypeId] = this;
    const prevRunning = this._running;
    this._running = true;
    let yielding = false;
    let current = effect2;
    this.currentOpCount = 0;
    try {
      while (true) {
        if (this._deferredInterrupt) {
          this._deferredInterrupt = false;
          current = failCause(this._interruptedCause);
        }
        this.currentOpCount++;
        const cache2 = this.cache;
        if (!yielding && !cache2.preventYield && cache2.scheduler.shouldYield(this)) {
          yielding = true;
          const prev = current;
          current = flatMap2(yieldNow, () => prev);
        }
        current = cache2.tracerContext ? cache2.tracerContext(current, this) : current[evaluate](this);
        if (current === Yield) {
          const yielded = this._yielded;
          if (ExitTypeId in yielded) {
            this._deferredInterrupt = false;
            this._yielded = void 0;
            return yielded;
          } else if (this._deferredInterrupt) {
            this._yielded = void 0;
            yielded();
            continue;
          }
          return Yield;
        }
      }
    } catch (error) {
      if (!hasProperty(current, evaluate)) {
        return exitDie(`Fiber.runLoop: Not a valid effect: ${String(current)}`);
      }
      return this.runLoop(exitDie(error));
    } finally {
      this._running = prevRunning;
      globalThis[currentFiberTypeId] = prevFiber;
    }
  }
  getCont(symbol3) {
    if (this._deferredInterrupt) {
      this._deferredInterrupt = false;
      return deferredInterruptCont;
    }
    while (true) {
      const op = this._stack.pop();
      if (!op) return void 0;
      const all4 = op[contAll];
      if (all4 !== void 0) {
        const cont = all4.call(op, this);
        if (cont) {
          ;
          cont[symbol3] = cont;
          return cont;
        }
      }
      if (op[symbol3]) return op;
    }
  }
  yieldWith(value) {
    this._yielded = value;
    return Yield;
  }
  children() {
    return this._children ??= /* @__PURE__ */ new Set();
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
  setContext(context3) {
    const previous = this.context;
    this.context = context3;
    if (previous !== void 0 && hasSameCache(previous, context3)) return;
    const root = context3.cacheRoot;
    const cache2 = root._fiberCache ??= makeFiberContextCache(context3);
    if (this.cache !== void 0 && this.cache.scheduler !== cache2.scheduler) {
      this._dispatcher = void 0;
    }
    this.cache = cache2;
  }
  get currentSpanLocal() {
    const span2 = this.cache.span;
    return span2?._tag === "Span" ? span2 : void 0;
  }
};
var makeFiberContextCache = (context3) => {
  const currentTracer = getOrUndefinedUnsafe(context3, TracerKey);
  return {
    scheduler: get(context3, Scheduler),
    tracer: currentTracer,
    tracerContext: currentTracer ? currentTracer["context"] : void 0,
    tracerEnabled: get(context3, TracerEnabled),
    span: getOrUndefinedUnsafe(context3, ParentSpanKey),
    logLevel: get(context3, CurrentLogLevel),
    minimumLogLevel: get(context3, MinimumLogLevel),
    stackFrame: get(context3, CurrentStackFrame),
    runtimeMetrics: getOrUndefinedUnsafe(context3, FiberRuntimeMetricsKey),
    maxOpsBeforeYield: get(context3, MaxOpsBeforeYield),
    preventYield: get(context3, PreventSchedulerYield)
  };
};
var deferredInterruptCont = {
  [contA](_value, fiber3) {
    return failCause(fiber3._interruptedCause);
  },
  [contE](_cause, fiber3) {
    return failCause(fiber3._interruptedCause);
  }
};
var fiberMiddleware = {
  interruptChildren: void 0
};
var fiberStackAnnotations = (fiber3) => {
  if (!fiber3.cache.stackFrame) return void 0;
  const annotations2 = /* @__PURE__ */ new Map();
  annotations2.set(InterruptorStackTrace.key, fiber3.cache.stackFrame);
  return makeUnsafe(annotations2);
};
var fiberInterruptChildren = (fiber3) => {
  if (fiber3._children === void 0 || fiber3._children.size === 0) {
    return void 0;
  }
  return fiberInterruptAll(fiber3._children);
};
var fiberAwait = (self) => {
  const impl = self;
  if (impl._exit) return succeed3(impl._exit);
  return callback((resume) => {
    if (impl._exit) return resume(succeed3(impl._exit));
    return sync(self.addObserver((exit3) => resume(succeed3(exit3))));
  });
};
var fiberAwaitAll = (self) => callback((resume) => {
  const iter = self[Symbol.iterator]();
  const exits = [];
  let cancel = void 0;
  function loop() {
    let result3 = iter.next();
    while (!result3.done) {
      if (result3.value._exit) {
        exits.push(result3.value._exit);
        result3 = iter.next();
        continue;
      }
      cancel = result3.value.addObserver((exit3) => {
        exits.push(exit3);
        loop();
      });
      return;
    }
    resume(succeed3(exits));
  }
  loop();
  return sync(() => cancel?.());
});
var fiberInterrupt = (self) => withFiber((fiber3) => fiberInterruptAs(self, fiber3.id));
var fiberInterruptAs = /* @__PURE__ */ dual((args2) => hasProperty(args2[0], FiberTypeId), (self, fiberId3, annotations2) => withFiber((parent) => {
  let ann = fiberStackAnnotations(parent);
  ann = ann && annotations2 ? merge2(ann, annotations2) : ann ?? annotations2;
  self.interruptUnsafe(fiberId3, ann);
  return asVoid(fiberAwait(self));
}));
var fiberInterruptAll = (fibers) => withFiber((parent) => {
  const annotations2 = fiberStackAnnotations(parent);
  let fiberArr = empty();
  for (const fiber3 of fibers) {
    fiber3.interruptUnsafe(parent.id, annotations2);
    fiberArr.push(fiber3);
  }
  return asVoid(fiberAwaitAll(fiberArr));
});
var succeed3 = exitSucceed;
var failCause = exitFailCause;
var fail3 = exitFail;
var sync = /* @__PURE__ */ makePrimitive({
  op: "Sync",
  [evaluate](fiber3) {
    const value = this[args]();
    const cont = fiber3.getCont(contA);
    return cont ? cont[contA](value, fiber3) : fiber3.yieldWith(exitSucceed(value));
  }
});
var suspend = /* @__PURE__ */ makePrimitive({
  op: "Suspend",
  [evaluate](_fiber) {
    return this[args]();
  }
});
var fromOption3 = /* @__PURE__ */ dual((args2) => args2.length >= 2 || isOption2(args2[0]), (option3, onNone) => isNone2(option3) ? fail3(onNone ? onNone() : new NoSuchElementError("Effect.fromOption: Option.none")) : succeed3(option3.value));
var fromResult = /* @__PURE__ */ match({
  onFailure: fail3,
  onSuccess: succeed3
});
var fromNullishOr2 = (value) => value == null ? fail3(new NoSuchElementError()) : succeed3(value);
var yieldNowWith = /* @__PURE__ */ makePrimitive({
  op: "Yield",
  [evaluate](fiber3) {
    let resumed = false;
    fiber3.currentDispatcher.scheduleTask(() => {
      if (resumed) return;
      fiber3.evaluate(exitVoid);
    }, this[args] ?? 0);
    return fiber3.yieldWith(() => {
      resumed = true;
    });
  }
});
var yieldNow = /* @__PURE__ */ yieldNowWith(0);
var succeedSome2 = (a) => succeed3(some2(a));
var succeedNone2 = /* @__PURE__ */ succeed3(/* @__PURE__ */ none2());
var transposeOption2 = (self) => isNone2(self) ? succeedNone2 : map2(self.value, some2);
var failCauseSync = (evaluate2) => suspend(() => failCause(internalCall(evaluate2)));
var die = (defect) => exitDie(defect);
var failSync = (error) => suspend(() => fail3(internalCall(error)));
var void_2 = /* @__PURE__ */ succeed3(void 0);
var try_2 = (options) => {
  const evaluate2 = typeof options === "function" ? options : options.try;
  const catcher = typeof options === "function" ? (cause) => new UnknownError(cause, "An error occurred in Effect.try") : options.catch;
  return suspend(() => {
    try {
      return succeed3(internalCall(evaluate2));
    } catch (err) {
      return fail3(internalCall(() => catcher(err)));
    }
  });
};
var promise = (evaluate2) => callbackOptions(function(resume, signal) {
  internalCall(() => evaluate2(signal)).then((a) => resume(succeed3(a)), (e) => resume(die(e)));
}, evaluate2.length !== 0);
var tryPromise = (options) => {
  const f = typeof options === "function" ? options : options.try;
  const catcher = typeof options === "function" ? (cause) => new UnknownError(cause, "An error occurred in Effect.tryPromise") : options.catch;
  return callbackOptions(function(resume, signal) {
    const failWithCatch = (cause) => {
      try {
        resume(fail3(internalCall(() => catcher(cause))));
      } catch (err) {
        resume(die(err));
      }
    };
    try {
      internalCall(() => f(signal)).then((a) => resume(succeed3(a)), failWithCatch);
    } catch (err) {
      failWithCatch(err);
    }
  }, f.length !== 0);
};
var withFiberId = (f) => withFiber((fiber3) => f(fiber3.id));
var fiber = /* @__PURE__ */ withFiber(succeed3);
var fiberId = /* @__PURE__ */ withFiberId(succeed3);
var callbackOptions = /* @__PURE__ */ (function() {
  const Proto3 = /* @__PURE__ */ makePrimitiveProto({
    op: "Async",
    [evaluate](fiber3) {
      const register = internalCall(() => this.register.bind(fiber3.cache.scheduler));
      let resumed = false;
      let yielded = false;
      const controller = this.withSignal ? new AbortController() : void 0;
      const onCancel = register((effect2) => {
        if (resumed) return;
        resumed = true;
        if (yielded) {
          fiber3.evaluate(effect2);
        } else {
          yielded = effect2;
        }
      }, controller?.signal);
      if (yielded !== false) return yielded;
      yielded = true;
      fiber3._yielded = () => {
        resumed = true;
      };
      if (controller === void 0 && onCancel === void 0) {
        return Yield;
      }
      fiber3._stack.push(asyncFinalizer(() => {
        resumed = true;
        controller?.abort();
        return onCancel ?? exitVoid;
      }));
      return Yield;
    }
  });
  const AsyncImpl = function(register, withSignal) {
    this.register = register;
    this.withSignal = withSignal;
  };
  AsyncImpl.prototype = Proto3;
  return function(register, withSignal) {
    return new AsyncImpl(register, withSignal);
  };
})();
var asyncFinalizer = /* @__PURE__ */ makePrimitive({
  op: "AsyncFinalizer",
  [contAll](fiber3) {
    if (fiber3.interruptible) {
      fiber3.interruptible = false;
      fiber3._stack.push(setInterruptibleTrue);
    }
  },
  [contE](cause, _fiber) {
    return hasInterrupts(cause) ? flatMap2(this[args](), () => failCause(cause)) : failCause(cause);
  }
});
var callback = (register) => callbackOptions(register, register.length >= 2);
var never = /* @__PURE__ */ callback(constVoid);
var gen2 = (...args2) => {
  if (args2.length === 1) {
    const body2 = args2[0];
    return suspend(() => fromIteratorUnsafe(body2()));
  }
  const [options, body] = args2;
  return suspend(() => fromIteratorUnsafe(body.call(options.self)));
};
var fnUntraced = (body, ...pipeables) => {
  const fn3 = pipeables.length === 0 ? function() {
    return suspend(() => fromIteratorUnsafe(body.apply(this, arguments)));
  } : function() {
    let effect2 = suspend(() => fromIteratorUnsafe(body.apply(this, arguments)));
    for (let i = 0; i < pipeables.length; i++) {
      effect2 = pipeables[i](effect2, ...arguments);
    }
    return effect2;
  };
  return defineFunctionLength(body.length, fn3);
};
var defineFunctionLength = (length, fn3) => Object.defineProperty(fn3, "length", {
  value: length,
  configurable: true
});
var fnStackCleaner = /* @__PURE__ */ makeStackCleaner(2);
var fn = function() {
  const nameFirst = typeof arguments[0] === "string";
  const name = nameFirst ? arguments[0] : "Effect.fn";
  const spanOptions = nameFirst ? arguments[1] : void 0;
  const prevLimit = getStackTraceLimit();
  let defError;
  if (prevLimit !== 0) {
    setStackTraceLimit(2);
    defError = new globalThis.Error();
    setStackTraceLimit(prevLimit);
  }
  if (nameFirst) {
    return (body, ...pipeables) => makeFn(name, body, defError, pipeables, nameFirst, spanOptions);
  }
  return makeFn(name, arguments[0], defError, Array.prototype.slice.call(arguments, 1), nameFirst, spanOptions);
};
var makeFn = (name, bodyOrOptions, defError, pipeables, addSpan, spanOptions) => {
  const body = typeof bodyOrOptions === "function" ? bodyOrOptions : pipeables.shift().bind(bodyOrOptions.self);
  return defineFunctionLength(body.length, function(...args2) {
    let result3 = suspend(() => {
      const iter = body.apply(this, arguments);
      return isEffect(iter) ? iter : fromIteratorUnsafe(iter);
    });
    for (let i = 0; i < pipeables.length; i++) {
      result3 = pipeables[i](result3, ...args2);
    }
    if (!isEffect(result3)) {
      return result3;
    }
    const prevLimit = getStackTraceLimit();
    let callError;
    if (prevLimit !== 0) {
      setStackTraceLimit(2);
      callError = new globalThis.Error();
      setStackTraceLimit(prevLimit);
    }
    return updateService(addSpan ? useSpan(name, spanOptions, (span2) => provideParentSpan(result3, span2)) : result3, CurrentStackFrame, (prev) => ({
      name,
      stack: callError ? fnStackCleaner(() => callError.stack) : constUndefined,
      parent: {
        name: `${name} (definition)`,
        stack: defError ? fnStackCleaner(() => defError.stack) : constUndefined,
        parent: prev
      }
    }));
  });
};
var fnUntracedEager = (body, ...pipeables) => defineFunctionLength(body.length, pipeables.length === 0 ? function() {
  return fromIteratorEagerUnsafe(() => body.apply(this, arguments));
} : function() {
  let effect2 = fromIteratorEagerUnsafe(() => body.apply(this, arguments));
  for (const pipeable of pipeables) {
    effect2 = pipeable(effect2, ...arguments);
  }
  return effect2;
});
var fromIteratorEagerUnsafe = (evaluate2) => {
  try {
    const iterator = evaluate2();
    let value = void 0;
    while (true) {
      const state = iterator.next(value);
      if (state.done) {
        return succeed3(state.value);
      }
      const primitive = state.value;
      if (primitive && primitive._tag === "Success") {
        value = primitive.value;
        continue;
      } else if (primitive && primitive._tag === "Failure") {
        return state.value;
      } else {
        let isFirstExecution = true;
        return suspend(() => {
          if (isFirstExecution) {
            isFirstExecution = false;
            return flatMap2(state.value, (value2) => fromIteratorUnsafe(iterator, value2));
          } else {
            return suspend(() => fromIteratorUnsafe(evaluate2()));
          }
        });
      }
    }
  } catch (error) {
    return die(error);
  }
};
var fromIteratorUnsafe = /* @__PURE__ */ (function() {
  const Proto3 = /* @__PURE__ */ makePrimitiveProto({
    op: "Iterator",
    [contA](value, fiber3) {
      const iter = this.iterator;
      while (true) {
        const state = iter.next(value);
        if (state.done) return succeed3(state.value);
        if (!effectIsExit(state.value)) {
          fiber3._stack.push(this);
          return state.value;
        } else if (state.value._tag === "Failure") {
          return state.value;
        }
        value = state.value.value;
      }
    },
    [evaluate](fiber3) {
      return this[contA](this.initial, fiber3);
    }
  });
  const IteratorImpl = function(iterator, initial) {
    this.iterator = iterator;
    this.initial = initial;
  };
  IteratorImpl.prototype = Proto3;
  return function(iterator, initial) {
    return new IteratorImpl(iterator, initial);
  };
})();
var as = /* @__PURE__ */ dual(2, (self, value) => new ContImpl(self, returnPayload, succeed3(value)));
var evaluateCont = function(fiber3) {
  fiber3._stack.push(this);
  return this[args];
};
var OnSuccessProto = /* @__PURE__ */ makePrimitiveProto({
  op: "OnSuccess",
  [evaluate]: evaluateCont
});
var OnSuccessImpl = function(self, f) {
  this[args] = self;
  this[contA] = f;
};
OnSuccessImpl.prototype = OnSuccessProto;
var ContImpl = function(self, cont, payload) {
  this[args] = self;
  this[contA] = cont;
  this.payload = payload;
};
ContImpl.prototype = OnSuccessProto;
var returnPayload = function() {
  return this.payload;
};
var mapCont = function(value) {
  const f = this.payload;
  return succeed3(internalCall(() => f(value)));
};
var andThenCont = function(value) {
  const f = this.payload;
  return internalCall(() => f(value));
};
var tapCont = function(value) {
  const f = this.payload;
  return new ContImpl(internalCall(() => f(value)), returnPayload, exitSucceed(value));
};
var tapEffectCont = function(value) {
  return new ContImpl(this.payload, returnPayload, exitSucceed(value));
};
var asSome = (self) => map2(self, some2);
var flip2 = (self) => matchEffect(self, {
  onFailure: succeed3,
  onSuccess: fail3
});
var andThen2 = /* @__PURE__ */ dual(2, (self, f) => new ContImpl(self, isEffect(f) ? returnPayload : andThenCont, f));
var tap2 = /* @__PURE__ */ dual(2, (self, f) => new ContImpl(self, isEffect(f) ? tapEffectCont : tapCont, f));
var asVoid = (self) => new ContImpl(self, returnPayload, exitVoid);
var sandbox = (self) => catchCause(self, fail3);
var raceAll = (all4, options) => withFiber((parent) => callback((resume) => {
  const effects = fromIterable(all4);
  const len = effects.length;
  let doneCount = 0;
  let done4 = false;
  const fibers = /* @__PURE__ */ new Set();
  const failures = [];
  const onExit3 = (exit3, fiber3, i) => {
    doneCount++;
    if (exit3._tag === "Failure") {
      failures.push(...exit3.cause.reasons);
      if (doneCount >= len) {
        resume(failCause(causeFromReasons(failures)));
      }
      return;
    }
    const isWinner = !done4;
    done4 = true;
    resume(fibers.size === 0 ? exit3 : flatMap2(uninterruptible(fiberInterruptAll(fibers)), () => exit3));
    if (isWinner && options?.onWinner) {
      options.onWinner({
        fiber: fiber3,
        index: i,
        parentFiber: parent
      });
    }
  };
  for (let i = 0; i < len; i++) {
    const fiber3 = forkUnsafe(parent, effects[i], true, true, false);
    fibers.add(fiber3);
    fiber3.addObserver((exit3) => {
      fibers.delete(fiber3);
      onExit3(exit3, fiber3, i);
    });
    if (done4) break;
  }
  return fiberInterruptAll(fibers);
}));
var raceAllFirst = (all4, options) => withFiber((parent) => callback((resume) => {
  let done4 = false;
  const fibers = /* @__PURE__ */ new Set();
  const onExit3 = (exit3) => {
    done4 = true;
    resume(fibers.size === 0 ? exit3 : flatMap2(uninterruptible(fiberInterruptAll(fibers)), () => exit3));
  };
  let i = 0;
  for (const effect2 of all4) {
    if (done4) break;
    const index = i++;
    const fiber3 = forkUnsafe(parent, effect2, true, true, false);
    fibers.add(fiber3);
    fiber3.addObserver((exit3) => {
      fibers.delete(fiber3);
      const isWinner = !done4;
      onExit3(exit3);
      if (isWinner && options?.onWinner) {
        options.onWinner({
          fiber: fiber3,
          index,
          parentFiber: parent
        });
      }
    });
  }
  return fiberInterruptAll(fibers);
}));
var race = /* @__PURE__ */ dual((args2) => isEffect(args2[1]), (self, that, options) => raceAll([self, that], options));
var raceFirst = /* @__PURE__ */ dual((args2) => isEffect(args2[1]), (self, that, options) => raceAllFirst([self, that], options));
var flatMap2 = /* @__PURE__ */ dual(2, (self, f) => new OnSuccessImpl(self, f.length !== 1 ? (a) => f(a) : f));
var matchCauseEffectEager = /* @__PURE__ */ dual(2, (self, options) => {
  if (effectIsExit(self)) {
    return self._tag === "Success" ? options.onSuccess(self.value) : options.onFailure(self.cause);
  }
  return matchCauseEffect(self, options);
});
var effectIsExit = (effect2) => effect2[ExitTypeId] !== void 0;
var flatMapEager = /* @__PURE__ */ dual(2, (self, f) => {
  if (effectIsExit(self)) {
    return self._tag === "Success" ? f(self.value) : self;
  }
  return flatMap2(self, f);
});
var flatten2 = (self) => flatMap2(self, identity);
var map2 = /* @__PURE__ */ dual(2, (self, f) => new ContImpl(self, mapCont, f));
var mapEager = /* @__PURE__ */ dual(2, (self, f) => effectIsExit(self) ? exitMap(self, f) : map2(self, f));
var mapErrorEager = /* @__PURE__ */ dual(2, (self, f) => effectIsExit(self) ? exitMapError(self, f) : mapError2(self, f));
var mapBothEager = /* @__PURE__ */ dual(2, (self, options) => effectIsExit(self) ? exitMapBoth(self, options) : mapBoth2(self, options));
var catchEager = /* @__PURE__ */ dual(2, (self, f) => {
  if (effectIsExit(self)) {
    if (self._tag === "Success") return self;
    const error = findError(self.cause);
    if (isFailure2(error)) return self;
    return f(error.success);
  }
  return catch_(self, f);
});
var exitInterrupt = (fiberId3) => exitFailCause(causeInterrupt(fiberId3));
var exitIsSuccess = (self) => self._tag === "Success";
var exitFilterSuccess = (self) => self._tag === "Success" ? succeed2(self) : fail2(self);
var exitFilterValue = (self) => self._tag === "Success" ? succeed2(self.value) : fail2(self);
var exitIsFailure = (self) => self._tag === "Failure";
var exitFilterFailure = (self) => self._tag === "Failure" ? succeed2(self) : fail2(self);
var exitFilterCause = (self) => self._tag === "Failure" ? succeed2(self.cause) : fail2(self);
var exitFindError = /* @__PURE__ */ composePassthrough(exitFilterCause, findError);
var exitFindDefect = /* @__PURE__ */ composePassthrough(exitFilterCause, findDefect);
var exitHasInterrupts = (self) => self._tag === "Failure" && hasInterrupts(self.cause);
var exitHasDies = (self) => self._tag === "Failure" && hasDies(self.cause);
var exitHasFails = (self) => self._tag === "Failure" && hasFails(self.cause);
var exitVoid = /* @__PURE__ */ exitSucceed(void 0);
var exitMap = /* @__PURE__ */ dual(2, (self, f) => self._tag === "Success" ? exitSucceed(f(self.value)) : self);
var exitMapError = /* @__PURE__ */ dual(2, (self, f) => {
  if (self._tag === "Success") return self;
  const error = findError(self.cause);
  if (isFailure2(error)) return self;
  return exitFail(f(error.success));
});
var exitMapBoth = /* @__PURE__ */ dual(2, (self, options) => {
  if (self._tag === "Success") return exitSucceed(options.onSuccess(self.value));
  const error = findError(self.cause);
  if (isFailure2(error)) return self;
  return exitFail(options.onFailure(error.success));
});
var exitAs = /* @__PURE__ */ dual(2, (self, b) => exitIsSuccess(self) ? exitSucceed(b) : self);
var exitMatch = /* @__PURE__ */ dual(2, (self, options) => exitIsSuccess(self) ? options.onSuccess(self.value) : options.onFailure(self.cause));
var exitAsVoid = /* @__PURE__ */ exitAs(void 0);
var exitAsVoidAll = (exits) => {
  const failures = [];
  for (const exit3 of exits) {
    if (exit3._tag === "Failure") {
      failures.push(...exit3.cause.reasons);
    }
  }
  return failures.length === 0 ? exitVoid : exitFailCause(causeFromReasons(failures));
};
var exitGetSuccess = (self) => exitIsSuccess(self) ? some2(self.value) : none2();
var exitGetCause = (self) => exitIsFailure(self) ? some2(self.cause) : none2();
var exitFindErrorOption = (self) => {
  const error = exitFindError(self);
  return isFailure2(error) ? none2() : some2(error.success);
};
var service = (service3) => service3;
var serviceOption = (service3) => withFiber((fiber3) => succeed3(getOption(fiber3.context, service3)));
var serviceOptional = (service3) => withFiber((fiber3) => fromOption3(getOption(fiber3.context, service3)));
var updateContext = /* @__PURE__ */ dual(2, (self, f) => withFiber((fiber3) => {
  const prevContext = fiber3.context;
  const nextContext = f(prevContext);
  if (prevContext === nextContext) return self;
  fiber3.setContext(nextContext);
  return onExitPrimitive(self, () => {
    fiber3.setContext(prevContext);
    return void 0;
  });
}));
var updateService = /* @__PURE__ */ dual(3, (self, service3, f) => updateContext(self, (s) => {
  const prev = getUnsafe(s, service3);
  const next = f(prev);
  if (prev === next) return s;
  return add(s, service3, next);
}));
var updateServiceScoped = (service3, update2, options) => uninterruptible(withFiber((fiber3) => {
  const original = getUnsafe(fiber3.context, service3);
  const updated = update2(original);
  fiber3.setContext(add(fiber3.context, service3, updated));
  return scopeAddFinalizerExit(getUnsafe(fiber3.context, scopeTag), (_) => {
    const currentOption = getOption(fiber3.context, service3);
    if (isNone2(currentOption)) return void_2;
    const current = currentOption.value;
    let next;
    if (options?.reset === void 0) {
      if (current !== updated) return void_2;
      next = original;
    } else {
      next = options.reset(original, updated, current);
    }
    fiber3.setContext(add(fiber3.context, service3, next));
    return void_2;
  });
}));
var context = () => getContext;
var getContext = /* @__PURE__ */ withFiber((fiber3) => succeed3(fiber3.context));
var contextWith = (f) => withFiber((fiber3) => f(fiber3.context));
var setContext = /* @__PURE__ */ dual(2, (self, context3) => updateContext(self, constant(context3)));
var provideContext = /* @__PURE__ */ dual(2, (self, context3) => {
  if (effectIsExit(self)) return self;
  return updateContext(self, merge2(context3));
});
var provideService = function() {
  if (arguments.length === 1) {
    return dual(2, (self, impl) => provideServiceImpl(self, arguments[0], impl));
  }
  return dual(3, (self, service3, impl) => provideServiceImpl(self, service3, impl)).apply(this, arguments);
};
var provideServiceImpl = (self, service3, implementation) => updateContext(self, add(service3, implementation));
var provideServiceEffect = /* @__PURE__ */ dual(3, (self, service3, acquire) => flatMap2(acquire, (implementation) => provideService(self, service3, implementation)));
var zip = /* @__PURE__ */ dual((args2) => isEffect(args2[1]), (self, that, options) => zipWith(self, that, (a, a2) => [a, a2], options));
var zipWith = /* @__PURE__ */ dual((args2) => isEffect(args2[1]), (self, that, f, options) => options?.concurrent ? map2(all2([self, that], {
  concurrency: 2
}), ([a, a2]) => internalCall(() => f(a, a2))) : flatMap2(self, (a) => map2(that, (a2) => internalCall(() => f(a, a2)))));
var filterOrFail2 = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, predicate, orFailWith) => filterOrElse(self, predicate, orFailWith ? (a) => fail3(orFailWith(a)) : () => fail3(new NoSuchElementError())));
var when = /* @__PURE__ */ dual(2, (self, condition) => flatMap2(condition, (pass) => pass ? asSome(self) : succeedNone2));
var replicate = /* @__PURE__ */ dual(2, (self, n) => Array.from({
  length: n
}, () => self));
var replicateEffect = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, n, options) => all2(replicate(self, n), options));
var forever = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, options) => whileLoop({
  while: constTrue,
  body: constant(options?.disableYield ? self : flatMap2(self, (_) => yieldNow)),
  step: constVoid
}));
var catchCause = /* @__PURE__ */ dual(2, (self, f) => new OnFailureImpl(self, f.length !== 1 ? (cause) => f(cause) : f));
var OnFailureProto = /* @__PURE__ */ makePrimitiveProto({
  op: "OnFailure",
  [evaluate]: evaluateCont
});
var OnFailureImpl = function(self, f) {
  this[args] = self;
  this[contE] = f;
};
OnFailureImpl.prototype = OnFailureProto;
var catchCauseIf = /* @__PURE__ */ dual(3, (self, predicate, f) => catchCause(self, (cause) => {
  if (!predicate(cause)) {
    return failCause(cause);
  }
  return internalCall(() => f(cause));
}));
var catchCauseFilter = /* @__PURE__ */ dual(3, (self, filter5, f) => catchCause(self, (cause) => {
  const eb = filter5(cause);
  return isFailure2(eb) ? failCause(eb.failure) : internalCall(() => f(eb.success, cause));
}));
var catch_ = /* @__PURE__ */ dual(2, (self, f) => catchCauseFilter(self, findError, (e) => f(e)));
var catchNoSuchElement = (self) => matchEffect(self, {
  onFailure: (error) => isNoSuchElementError(error) ? succeedNone2 : fail3(error),
  onSuccess: succeedSome2
});
var catchDefect = /* @__PURE__ */ dual(2, (self, f) => catchCauseFilter(self, findDefect, f));
var tapCause = /* @__PURE__ */ dual(2, (self, f) => catchCause(self, (cause) => andThen2(internalCall(() => f(cause)), failCause(cause))));
var tapCauseIf = /* @__PURE__ */ dual(3, (self, predicate, f) => catchCauseIf(self, predicate, (cause) => andThen2(internalCall(() => f(cause)), failCause(cause))));
var tapCauseFilter = /* @__PURE__ */ dual(3, (self, filter5, f) => catchCause(self, (cause) => {
  const result3 = filter5(cause);
  if (isFailure2(result3)) {
    return failCause(cause);
  }
  return andThen2(internalCall(() => f(result3.success, cause)), failCause(cause));
}));
var tapError = /* @__PURE__ */ dual(2, (self, f) => tapCauseFilter(self, findError, (e) => f(e)));
var tapErrorTag = /* @__PURE__ */ dual(3, (self, k, f) => {
  const predicate = Array.isArray(k) ? (e) => hasProperty(e, "_tag") && k.includes(e._tag) : isTagged(k);
  return tapError(self, (error) => predicate(error) ? f(error) : void_2);
});
var tapDefect = /* @__PURE__ */ dual(2, (self, f) => tapCauseFilter(self, findDefect, (_) => f(_)));
var catchIf = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, predicate, f, orElse2) => catchCause(self, (cause) => {
  const error = findError(cause);
  if (isFailure2(error)) return failCause(error.failure);
  if (!predicate(error.success)) {
    return orElse2 ? internalCall(() => orElse2(error.success)) : failCause(cause);
  }
  return internalCall(() => f(error.success));
}));
var catchFilter = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, filter5, f, orElse2) => catchCause(self, (cause) => {
  const error = findError(cause);
  if (isFailure2(error)) return failCause(error.failure);
  const result3 = filter5(error.success);
  if (isFailure2(result3)) {
    return orElse2 ? internalCall(() => orElse2(result3.failure)) : failCause(cause);
  }
  return internalCall(() => f(result3.success));
}));
var catchTag = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, k, f, orElse2) => {
  const pred = Array.isArray(k) ? (e) => hasProperty(e, "_tag") && k.includes(e._tag) : isTagged(k);
  return catchIf(self, pred, f, orElse2);
});
var catchTags = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, cases, orElse2) => {
  let keys;
  return catchFilter(self, (e) => {
    keys ??= Object.keys(cases);
    return hasProperty(e, "_tag") && isString(e["_tag"]) && keys.includes(e["_tag"]) ? succeed2(e) : fail2(e);
  }, (e) => internalCall(() => cases[e["_tag"]](e)), orElse2);
});
var catchReason = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, errorTag, reasonTag, f, orElse2) => catchIf(self, (e) => isTagged(e, errorTag) && hasProperty(e, "reason") && (orElse2 !== void 0 || isTagged(e.reason, reasonTag)), (e) => {
  const reason = e.reason;
  if (isTagged(reason, reasonTag)) return f(reason, e);
  return orElse2 ? internalCall(() => orElse2(reason, e)) : fail3(e);
}));
var catchReasons = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, errorTag, cases, orElse2) => {
  let keys;
  return catchIf(self, (e) => isTagged(e, errorTag) && hasProperty(e, "reason") && hasProperty(e.reason, "_tag") && isString(e.reason._tag) && (orElse2 !== void 0 || (keys ??= Object.keys(cases)).includes(e.reason._tag)), (e) => {
    const reason = e.reason;
    keys ??= Object.keys(cases);
    if (keys.includes(reason._tag)) {
      return internalCall(() => cases[reason._tag](reason, e));
    }
    return orElse2 ? internalCall(() => orElse2(reason, e)) : fail3(e);
  });
});
var unwrapReason = /* @__PURE__ */ dual(2, (self, errorTag) => catchFilter(self, (e) => {
  if (isTagged(e, errorTag) && hasProperty(e, "reason")) {
    return succeed2(e.reason);
  }
  return fail2(e);
}, fail3));
var mapError2 = /* @__PURE__ */ dual(2, (self, f) => catch_(self, (error) => failSync(() => f(error))));
var mapBoth2 = /* @__PURE__ */ dual(2, (self, options) => matchEffect(self, {
  onFailure: (e) => failSync(() => options.onFailure(e)),
  onSuccess: (a) => sync(() => options.onSuccess(a))
}));
var orDie = (self) => catch_(self, die);
var orElseSucceed = /* @__PURE__ */ dual(2, (self, f) => catch_(self, (_) => sync(f)));
var firstSuccessOf = (effects) => suspend(() => {
  const iterator = effects[Symbol.iterator]();
  let state = iterator.next();
  if (state.done) {
    return die(new Error("Received an empty collection of effects"));
  }
  function loop(current) {
    const next = iterator.next();
    if (next.done) return current.value;
    return catch_(current.value, (_) => loop(next));
  }
  return loop(state);
});
var eventually = (self) => catch_(self, (_) => flatMap2(yieldNow, () => eventually(self)));
var ignore = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, options) => {
  if (!options?.log) {
    return matchEffect(self, {
      onFailure: (_) => void_2,
      onSuccess: (_) => void_2
    });
  }
  const logEffect = logWithLevel(options.log === true ? void 0 : options.log);
  return matchCauseEffect(self, {
    onFailure(cause) {
      const failure = findFail(cause);
      return isFailure2(failure) ? failCause(failure.failure) : options.message === void 0 ? logEffect(cause) : logEffect(options.message, cause);
    },
    onSuccess: (_) => void_2
  });
});
var ignoreCause = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, options) => {
  if (!options?.log) {
    return matchCauseEffect(self, {
      onFailure: (_) => void_2,
      onSuccess: (_) => void_2
    });
  }
  const logEffect = logWithLevel(options.log === true ? void 0 : options.log);
  return matchCauseEffect(self, {
    onFailure: (cause) => options.message === void 0 ? logEffect(cause) : logEffect(options.message, cause),
    onSuccess: (_) => void_2
  });
});
var option = (self) => match3(self, {
  onFailure: none2,
  onSuccess: some2
});
var result = (self) => matchEager(self, {
  onFailure: fail2,
  onSuccess: succeed2
});
var matchCauseEffect = /* @__PURE__ */ dual(2, (self, options) => new OnSuccessAndFailureImpl(self, options.onSuccess.length !== 1 ? (a) => options.onSuccess(a) : options.onSuccess, options.onFailure.length !== 1 ? (cause) => options.onFailure(cause) : options.onFailure));
var OnSuccessAndFailureProto = /* @__PURE__ */ makePrimitiveProto({
  op: "OnSuccessAndFailure",
  [evaluate]: evaluateCont
});
var OnSuccessAndFailureImpl = function(self, onSuccess, onFailure) {
  this[args] = self;
  this[contA] = onSuccess;
  this[contE] = onFailure;
};
OnSuccessAndFailureImpl.prototype = OnSuccessAndFailureProto;
var matchCause = /* @__PURE__ */ dual(2, (self, options) => matchCauseEffect(self, {
  onFailure: (cause) => sync(() => options.onFailure(cause)),
  onSuccess: (value) => sync(() => options.onSuccess(value))
}));
var matchEffect = /* @__PURE__ */ dual(2, (self, options) => matchCauseEffect(self, {
  onFailure: (cause) => {
    const fail7 = cause.reasons.find(isFailReason);
    return fail7 ? internalCall(() => options.onFailure(fail7.error)) : failCause(cause);
  },
  onSuccess: options.onSuccess
}));
var match3 = /* @__PURE__ */ dual(2, (self, options) => matchEffect(self, {
  onFailure: (error) => sync(() => options.onFailure(error)),
  onSuccess: (value) => sync(() => options.onSuccess(value))
}));
var matchEager = /* @__PURE__ */ dual(2, (self, options) => {
  if (effectIsExit(self)) {
    if (self._tag === "Success") return exitSucceed(options.onSuccess(self.value));
    const error = findError(self.cause);
    if (isFailure2(error)) return self;
    return exitSucceed(options.onFailure(error.success));
  }
  return match3(self, options);
});
var matchCauseEager = /* @__PURE__ */ dual(2, (self, options) => {
  if (effectIsExit(self)) {
    if (self._tag === "Success") return exitSucceed(options.onSuccess(self.value));
    return exitSucceed(options.onFailure(self.cause));
  }
  return matchCause(self, options);
});
var exit = (self) => effectIsExit(self) ? exitSucceed(self) : exitPrimitive(self);
var exitPrimitive = /* @__PURE__ */ makePrimitive({
  op: "Exit",
  [evaluate](fiber3) {
    fiber3._stack.push(this);
    return this[args];
  },
  [contA](value, _, exit3) {
    return succeed3(exit3 ?? exitSucceed(value));
  },
  [contE](cause, _, exit3) {
    return succeed3(exit3 ?? exitFailCause(cause));
  }
});
var isFailure3 = /* @__PURE__ */ matchEager({
  onFailure: () => true,
  onSuccess: () => false
});
var isSuccess3 = /* @__PURE__ */ matchEager({
  onFailure: () => false,
  onSuccess: () => true
});
var delay = /* @__PURE__ */ dual(2, (self, duration) => andThen2(sleep(duration), self));
var timeoutOrElse = /* @__PURE__ */ dual(2, (self, options) => flatMap2(timeoutOption(self, options.duration), (option3) => isNone2(option3) ? options.orElse() : succeed3(option3.value)));
var timeoutErrorFromDuration = (duration) => new TimeoutError(`Operation timed out after '${format2(duration)}'`);
var timeout = /* @__PURE__ */ dual(2, (self, duration) => {
  const decoded = fromInputUnsafe(duration);
  return timeoutOrElse(self, {
    duration: decoded,
    orElse: () => fail3(timeoutErrorFromDuration(decoded))
  });
});
var timeoutOption = /* @__PURE__ */ dual(2, (self, duration) => raceFirst(asSome(self), as(sleep(duration), none2())));
var timed = (self) => clockWith((clock) => {
  const start = clock.monotonicTimeNanosUnsafe();
  return map2(self, (a) => [nanos(clock.monotonicTimeNanosUnsafe() - start), a]);
});
var ScopeTypeId = "~effect/Scope";
var ScopeCloseableTypeId = "~effect/Scope/Closeable";
var scopeTag = /* @__PURE__ */ Service("effect/Scope");
var scopeClose = (self, exit_) => suspend(() => scopeCloseUnsafe(self, exit_) ?? void_2);
var scopeCloseUnsafe = (self, exit_) => {
  if (self.state._tag === "Closed") return;
  const closed = {
    _tag: "Closed",
    exit: exit_
  };
  if (self.state._tag === "Empty") {
    self.state = closed;
    return;
  }
  const state = self.state;
  self.state = closed;
  if (state.finalizer !== void 0) {
    return state.finalizer(exit_);
  }
  const finalizers = state.finalizers;
  if (finalizers === void 0 || finalizers.size === 0) {
    return;
  } else if (finalizers.size === 1) {
    return finalizers.values().next().value(exit_);
  }
  return scopeCloseFinalizers(self, finalizers, exit_);
};
var combineFinalizerCause = (exit_, finalizer) => exitIsSuccess(exit_) ? finalizer : catchCause(finalizer, (cause) => failCause(causeCombine(exit_.cause, cause)));
var scopeCloseFinalizers = /* @__PURE__ */ fnUntraced(function* (self, finalizers, exit_) {
  let exits = [];
  const fibers = [];
  const arr = Array.from(finalizers.values());
  const parent = getCurrentFiber();
  for (let i = arr.length - 1; i >= 0; i--) {
    const finalizer = arr[i];
    if (self.strategy === "sequential") {
      exits.push(yield* exit(finalizer(exit_)));
    } else {
      fibers.push(forkUnsafe(parent, finalizer(exit_), true, true, "inherit"));
    }
  }
  if (fibers.length > 0) {
    exits = yield* fiberAwaitAll(fibers);
  }
  return yield* exitAsVoidAll(exits);
});
var scopeForkUnsafe = (scope3, finalizerStrategy) => {
  const newScope = scopeMakeUnsafe(finalizerStrategy);
  if (scope3.state._tag === "Closed") {
    newScope.state = scope3.state;
    return newScope;
  }
  const key = {};
  scopeAddFinalizerUnsafe(scope3, key, (exit3) => scopeClose(newScope, exit3));
  scopeAddFinalizerUnsafe(newScope, key, (_) => sync(() => scopeRemoveFinalizerUnsafe(scope3, key)));
  return newScope;
};
var scopeAddFinalizerExit = (scope3, finalizer) => {
  return suspend(() => {
    if (scope3.state._tag === "Closed") {
      return finalizer(scope3.state.exit);
    }
    scopeAddFinalizerUnsafe(scope3, {}, finalizer);
    return void_2;
  });
};
var scopeAddFinalizerUnsafe = (scope3, key, finalizer) => {
  if (scope3.state._tag === "Empty") {
    scope3.state = {
      _tag: "Open",
      finalizerKey: key,
      finalizer,
      finalizers: void 0
    };
  } else if (scope3.state._tag === "Open") {
    const state = scope3.state;
    if (state.finalizer !== void 0) {
      state.finalizers = /* @__PURE__ */ new Map([[state.finalizerKey, state.finalizer]]);
      state.finalizerKey = void 0;
      state.finalizer = void 0;
      state.finalizers.set(key, finalizer);
    } else if (state.finalizers === void 0) {
      state.finalizerKey = key;
      state.finalizer = finalizer;
    } else {
      state.finalizers.set(key, finalizer);
    }
  }
};
var scopeRemoveFinalizerUnsafe = (scope3, key) => {
  if (scope3.state._tag === "Open") {
    const state = scope3.state;
    if (state.finalizerKey === key) {
      state.finalizerKey = void 0;
      state.finalizer = void 0;
    } else if (state.finalizers !== void 0) {
      state.finalizers.delete(key);
    }
  }
};
var scopeMakeUnsafe = (finalizerStrategy = "sequential") => ({
  [ScopeCloseableTypeId]: ScopeCloseableTypeId,
  [ScopeTypeId]: ScopeTypeId,
  strategy: finalizerStrategy,
  state: constScopeEmpty
});
var constScopeEmpty = {
  _tag: "Empty"
};
var scope = scopeTag;
var provideScope = /* @__PURE__ */ provideService(scopeTag);
var scoped = (self) => withFiber((fiber3) => {
  const prev = fiber3.context;
  const scope3 = scopeMakeUnsafe();
  fiber3.setContext(add(fiber3.context, scopeTag, scope3));
  return onExitPrimitive(self, (exit3) => {
    fiber3.setContext(prev);
    return scopeCloseUnsafe(scope3, exit3);
  });
});
var scopedWith = (f) => suspend(() => {
  const scope3 = scopeMakeUnsafe();
  return onExit(f(scope3), (exit3) => suspend(() => scopeCloseUnsafe(scope3, exit3) ?? void_2));
});
var acquireRelease = (acquire, release, options) => contextWith((context3) => uninterruptibleMask((restore) => flatMap2(scope, (scope3) => tap2(options?.interruptible ? restore(acquire) : acquire, (a) => scopeAddFinalizerExit(scope3, (exit3) => provideContext(release(a, exit3), context3))))));
var addFinalizer = (finalizer) => flatMap2(scope, (scope3) => contextWith((context3) => scopeAddFinalizerExit(scope3, (exit3) => provideContext(finalizer(exit3), context3))));
var onExitPrimitive = /* @__PURE__ */ (function() {
  const Proto3 = /* @__PURE__ */ makePrimitiveProto({
    op: "OnExit",
    [evaluate](fiber3) {
      fiber3._stack.push(this);
      return this.effect;
    },
    [contAll](fiber3) {
      if (fiber3.interruptible && this.interruptible !== true) {
        fiber3._stack.push(setInterruptibleTrue);
        fiber3.interruptible = false;
      }
    },
    [contA](value, _, exit3) {
      exit3 ??= exitSucceed(value);
      const eff = this.onExit(exit3);
      return eff ? flatMap2(eff, (_2) => exit3) : exit3;
    },
    [contE](cause, _, exit3) {
      exit3 ??= exitFailCause(cause);
      const eff = this.onExit(exit3);
      return eff ? flatMap2(combineFinalizerCause(exit3, eff), (_2) => exit3) : exit3;
    }
  });
  const OnExitImpl = function(effect2, onExit3, interruptible3) {
    this.effect = effect2;
    this.onExit = onExit3;
    this.interruptible = interruptible3;
  };
  OnExitImpl.prototype = Proto3;
  return function(effect2, onExit3, interruptible3) {
    return new OnExitImpl(effect2, onExit3, interruptible3);
  };
})();
var onExit = /* @__PURE__ */ dual(2, onExitPrimitive);
var ensuring = /* @__PURE__ */ dual(2, (self, finalizer) => onExit(self, (_) => finalizer));
var onExitIf = /* @__PURE__ */ dual(3, (self, predicate, f) => onExit(self, (exit3) => {
  if (!predicate(exit3)) {
    return void_2;
  }
  return f(exit3);
}));
var onExitFilter = /* @__PURE__ */ dual(3, (self, filter5, f) => onExit(self, (exit3) => {
  const b = filter5(exit3);
  return isFailure2(b) ? void_2 : f(b.success, exit3);
}));
var onError = /* @__PURE__ */ dual(2, (self, f) => onExitFilter(self, exitFilterCause, f));
var onErrorIf = /* @__PURE__ */ dual(3, (self, predicate, f) => onExitIf(self, (exit3) => {
  if (exit3._tag !== "Failure") {
    return false;
  }
  return predicate(exit3.cause);
}, (exit3) => f(exit3.cause)));
var onErrorFilter = /* @__PURE__ */ dual(3, (self, filter5, f) => onExit(self, (exit3) => {
  if (exit3._tag !== "Failure") {
    return void_2;
  }
  const result3 = filter5(exit3.cause);
  return isFailure2(result3) ? void_2 : f(result3.success, exit3.cause);
}));
var onInterrupt = /* @__PURE__ */ dual(2, (self, finalizer) => onErrorFilter(causeFilterInterruptors, finalizer)(self));
var acquireUseRelease = (acquire, use, release) => uninterruptibleMask((restore) => flatMap2(acquire, (a) => onExitPrimitive(suspend(() => restore(use(a))), (exit3) => release(a, exit3), true)));
var acquireDisposable = (acquire) => acquireRelease(acquire, (resource) => hasProperty(resource, Symbol.asyncDispose) ? promise(() => resource[Symbol.asyncDispose]()) : sync(() => resource[Symbol.dispose]()));
var cachedInvalidateWithTTL = /* @__PURE__ */ dual(2, (self, ttl) => sync(() => {
  const ttlMillis = typeof ttl === "function" ? (exit4) => toMillis(fromInputUnsafe(ttl(exit4))) : constant(toMillis(fromInputUnsafe(ttl)));
  const latch = makeLatchUnsafe(false);
  let expiresAt = 0;
  let running = false;
  let exit3;
  const wait = flatMap2(latch.await, () => exit3);
  return [withFiber((fiber3) => {
    const clock = fiber3.getRef(ClockRef);
    const now = expiresAt === Infinity ? 0 : clock.currentTimeMillisUnsafe();
    if (running || now < expiresAt) return exit3 ?? wait;
    running = true;
    latch.closeUnsafe();
    exit3 = void 0;
    return onExit(self, (exit_) => sync(() => {
      try {
        const duration = ttlMillis(exit_);
        expiresAt = clock.currentTimeMillisUnsafe() + duration;
        exit3 = exit_;
      } catch (error) {
        const cause = causeDie(error);
        exit3 = exitFailCause(exitIsFailure(exit_) ? causeCombine(exit_.cause, cause) : cause);
        throw error;
      } finally {
        running = false;
        latch.openUnsafe();
      }
    }));
  }), sync(() => {
    expiresAt = 0;
    latch.closeUnsafe();
    exit3 = void 0;
  })];
}));
var cachedWithTTL = /* @__PURE__ */ dual(2, (self, timeToLive) => map2(cachedInvalidateWithTTL(self, timeToLive), (tuple) => tuple[0]));
var cached = (self) => sync(() => {
  const latch = makeLatchUnsafe(false);
  let started = false;
  let exit3;
  const wait = flatMap2(latch.await, () => exit3);
  return suspend(() => {
    if (exit3 !== void 0) return exit3;
    if (started) return wait;
    started = true;
    return onExit(self, (result3) => sync(() => {
      exit3 = result3;
      latch.openUnsafe();
    }));
  });
});
var interrupt = /* @__PURE__ */ withFiber((fiber3) => failCause(causeInterrupt(fiber3.id)));
var uninterruptible = (self) => withFiber((fiber3) => {
  if (!fiber3.interruptible) return self;
  fiber3.interruptible = false;
  fiber3._stack.push(setInterruptibleTrue);
  return self;
});
var setInterruptible = /* @__PURE__ */ makePrimitive({
  op: "SetInterruptible",
  [contAll](fiber3) {
    fiber3.interruptible = this[args];
    if (fiber3._interruptedCause && fiber3.interruptible) {
      return () => failCause(fiber3._interruptedCause);
    }
  }
});
var setInterruptibleTrue = /* @__PURE__ */ setInterruptible(true);
var setInterruptibleFalse = /* @__PURE__ */ setInterruptible(false);
var setFiberInterruptible = (fiber3) => {
  fiber3.interruptible = true;
  fiber3._stack.push(setInterruptibleFalse);
  if (fiber3._interruptedCause) return failCause(fiber3._interruptedCause);
};
var interruptible = (self) => withFiber((fiber3) => {
  if (fiber3.interruptible) return self;
  return setFiberInterruptible(fiber3) ?? self;
});
var uninterruptibleMask = (f) => withFiber((fiber3) => {
  if (!fiber3.interruptible) return f(identity);
  fiber3.interruptible = false;
  fiber3._stack.push(setInterruptibleTrue);
  return f(interruptible);
});
var interruptibleMask = (f) => withFiber((fiber3) => {
  if (fiber3.interruptible) return f(identity);
  const interrupted = setFiberInterruptible(fiber3);
  const effect2 = f(uninterruptible);
  return interrupted ?? effect2;
});
var abortSignal = /* @__PURE__ */ map2(/* @__PURE__ */ acquireRelease(/* @__PURE__ */ sync(() => new AbortController()), (controller) => sync(() => controller.abort())), (_) => _.signal);
var all2 = (arg, options) => {
  if (isIterable(arg)) {
    return options?.mode === "result" ? forEach(arg, result, options) : forEach(arg, identity, options);
  } else if (options?.discard) {
    return options.mode === "result" ? forEach(Object.values(arg), result, options) : forEach(Object.values(arg), identity, options);
  }
  return suspend(() => {
    const out = {};
    return as(forEach(Object.entries(arg), ([key, effect2]) => map2(options?.mode === "result" ? result(effect2) : effect2, (value) => {
      assignProperty(out, key, value);
    }), {
      discard: true,
      concurrency: options?.concurrency
    }), out);
  });
};
var partition2 = /* @__PURE__ */ dual((args2) => isIterable(args2[0]) && !isEffect(args2[0]), (elements, f, options) => map2(forEach(elements, (a, i) => result(f(a, i)), options), (results) => partition(results, identity)));
var reduce = /* @__PURE__ */ dual(3, (elements, zero2, f) => {
  const arr = fromIterable(elements);
  if (arr.length === 0) return sync(zero2);
  return suspend(() => {
    let index = 0;
    let state = zero2();
    return map2(whileLoop({
      while: () => index < arr.length,
      body: () => f(state, arr[index], index),
      step(next) {
        state = next;
        index++;
      }
    }), () => state);
  });
});
var validate = /* @__PURE__ */ dual((args2) => isIterable(args2[0]) && !isEffect(args2[0]), (elements, f, options) => flatMap2(partition2(elements, f, {
  concurrency: options?.concurrency
}), ([excluded, satisfying]) => {
  if (isArrayNonEmpty2(excluded)) {
    return fail3(excluded);
  }
  return options?.discard ? void_2 : succeed3(satisfying);
}));
var findFirst = /* @__PURE__ */ dual((args2) => isIterable(args2[0]) && !isEffect(args2[0]), (elements, predicate) => suspend(() => {
  const iterator = elements[Symbol.iterator]();
  const next = iterator.next();
  if (!next.done) {
    return findFirstLoop(iterator, 0, predicate, next.value);
  }
  return succeed3(none2());
}));
var findFirstLoop = (iterator, index, predicate, value) => flatMap2(predicate(value, index), (keep) => {
  if (keep) {
    return succeed3(some2(value));
  }
  const next = iterator.next();
  if (!next.done) {
    return findFirstLoop(iterator, index + 1, predicate, next.value);
  }
  return succeed3(none2());
});
var findFirstFilter = /* @__PURE__ */ dual((args2) => isIterable(args2[0]) && !isEffect(args2[0]), (elements, filter5) => suspend(() => {
  const iterator = elements[Symbol.iterator]();
  const next = iterator.next();
  if (!next.done) {
    return findFirstFilterLoop(iterator, 0, filter5, next.value);
  }
  return succeed3(none2());
}));
var findFirstFilterLoop = (iterator, index, filter5, value) => flatMap2(filter5(value, index), (result3) => {
  if (isSuccess2(result3)) {
    return succeed3(some2(result3.success));
  }
  const next = iterator.next();
  if (!next.done) {
    return findFirstFilterLoop(iterator, index + 1, filter5, next.value);
  }
  return succeed3(none2());
});
var whileLoop = /* @__PURE__ */ makePrimitive({
  op: "While",
  [contA](value, fiber3) {
    this[args].step(value);
    if (this[args].while()) {
      fiber3._stack.push(this);
      return this[args].body();
    }
    return exitVoid;
  },
  [evaluate](fiber3) {
    if (this[args].while()) {
      fiber3._stack.push(this);
      return this[args].body();
    }
    return exitVoid;
  }
});
var forEach = /* @__PURE__ */ dual((args2) => typeof args2[1] === "function", (iterable, f, options) => suspend(() => {
  const concurrency = resolveConcurrency(options?.concurrency);
  if (concurrency === 1) {
    return forEachSequential(iterable, f, options);
  }
  const items = fromIterable(iterable);
  let length = items.length;
  if (length === 0) {
    return options?.discard ? void_2 : succeed3([]);
  }
  const out = options?.discard ? void 0 : new Array(length);
  const eff = forEachConcurrent({
    f,
    out
  }, items, {
    concurrency
  });
  return eff ? as(eff, out) : succeed3(out);
}));
var head = (self) => flatMap2(self, (elements) => {
  const result3 = elements[Symbol.iterator]().next();
  return result3.done ? fail3(new NoSuchElementError()) : succeed3(result3.value);
});
var forEachSequential = (iterable, f, options) => suspend(() => {
  const out = options?.discard ? void 0 : [];
  const iterator = iterable[Symbol.iterator]();
  let state = iterator.next();
  let index = 0;
  return as(whileLoop({
    while: () => !state.done,
    body: () => f(state.value, index++),
    step: (b) => {
      if (out) out.push(b);
      state = iterator.next();
    }
  }), out);
});
var resolveConcurrency = (concurrency) => concurrency === "unbounded" ? Number.POSITIVE_INFINITY : Math.max(1, concurrency ?? 1);
var iterateConcurrentImpl = (options) => {
  const onItem = options.onItem;
  const step = options.step;
  return (state, items, opts) => {
    let index = 0;
    const end = opts.end ?? items.length;
    const concurrency = opts.concurrency;
    let done4 = false;
    let parentFiber;
    let fibers;
    let resume;
    let interrupted = false;
    let terminal;
    let effect2;
    const failDefect = (error) => {
      const defect = exitDie(error);
      terminal = defect;
      done4 = true;
      interrupted = true;
      return fibers && fibers.size > 0 ? flatMap2(uninterruptible(fiberInterruptAll(Array.from(fibers))), () => defect) : defect;
    };
    const go = () => {
      let paused = false;
      for (; !terminal && index < end; index++) {
        const item = items[index];
        const eff = effect2 ?? onItem(state, item, index);
        if (effectIsExit(eff)) {
          terminal = step(state, item, eff, index);
          if (terminal) break;
        } else if (!parentFiber) {
          return callback((cb) => {
            parentFiber = getCurrentFiber();
            fibers = /* @__PURE__ */ new Set();
            effect2 = eff;
            resume = cb;
            let result3;
            try {
              result3 = go();
            } catch (error) {
              return cb(failDefect(error));
            }
            if (result3) return cb(result3);
            return suspend(() => {
              terminal = exitVoid;
              interrupted = true;
              return fibers ? fiberInterruptAll(fibers) : void_2;
            });
          });
        } else {
          effect2 = void 0;
          const fiber3 = forkUnsafe(parentFiber, eff, true, true, "inherit");
          if (fiber3._exit) {
            terminal = step(state, item, fiber3._exit, index);
            if (terminal) break;
            continue;
          }
          fibers.add(fiber3);
          const currentIndex = index;
          fiber3.addObserver((exit3) => {
            fibers.delete(fiber3);
            try {
              if (terminal) {
                if (!interrupted && exit3._tag === "Failure") {
                  for (const reason of exit3.cause.reasons) {
                    if (reason._tag === "Interrupt") continue;
                    else if (terminal._tag === "Failure") {
                      ;
                      terminal.cause.reasons.push(reason);
                    } else {
                      terminal = exitFailCause(causeFromReasons([reason]));
                    }
                  }
                }
              } else {
                const result3 = step(state, item, exit3, currentIndex);
                if (result3) {
                  terminal = result3._tag === "Failure" ? exitFailCause(causeFromReasons(result3.cause.reasons.slice())) : result3;
                  go();
                }
              }
              if (paused) {
                const eff2 = go();
                if (eff2) resume(eff2);
              } else if (done4 && fibers.size === 0) {
                resume(terminal ?? void_2);
              }
            } catch (error) {
              resume(failDefect(error));
            }
          });
          if (fibers.size < concurrency) continue;
          paused = true;
          index++;
          return;
        }
      }
      done4 = true;
      if (terminal) {
        if (fibers && fibers.size > 0) {
          const annotations2 = fiberStackAnnotations(parentFiber);
          fibers.forEach((f) => f.interruptUnsafe(parentFiber.id, annotations2));
          return;
        }
        if (resume || terminal._tag === "Failure") {
          return terminal;
        }
      } else if (resume) {
        if (!fibers) {
          return exitVoid;
        } else if (fibers.size === 0) {
          resume(void_2);
        }
      }
    };
    return go();
  };
};
var forEachConcurrent = /* @__PURE__ */ iterateConcurrentImpl({
  onItem(state, item, index) {
    return state.f(item, index);
  },
  step(state, _, exit3, index) {
    if (exit3._tag === "Failure") return exit3;
    else if (state.out) {
      state.out[index] = exit3.value;
    }
  }
});
var filterOrElse = /* @__PURE__ */ dual(3, (self, predicate, orElse2) => flatMap2(self, (a) => predicate(a) ? succeed3(a) : orElse2(a)));
var filterMapOrElse = /* @__PURE__ */ dual(3, (self, filter5, orElse2) => flatMap2(self, (a) => {
  const result3 = filter5(a);
  return isFailure2(result3) ? orElse2(result3.failure) : succeed3(result3.success);
}));
var filterMapOrFail = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, filter5, orFailWith) => filterMapOrElse(self, filter5, orFailWith ? (x) => fail3(orFailWith(x)) : () => fail3(new NoSuchElementError())));
var filter2 = /* @__PURE__ */ dual((args2) => isIterable(args2[0]) && !isEffect(args2[0]), (elements, predicate, options) => suspend(() => {
  const out = [];
  return as(forEach(elements, (a, i) => {
    const result3 = predicate(a, i);
    if (typeof result3 === "boolean") {
      if (result3) out.push(a);
      return void_2;
    }
    return map2(result3, (keep) => {
      if (keep) {
        out.push(a);
      }
    });
  }, {
    discard: true,
    concurrency: options?.concurrency
  }), out);
}));
var filterMap = /* @__PURE__ */ dual((args2) => isIterable(args2[0]) && !isEffect(args2[0]), (elements, filter5) => suspend(() => {
  const out = [];
  for (const a of elements) {
    const result3 = filter5(a);
    if (isSuccess2(result3)) {
      out.push(result3.success);
    }
  }
  return succeed3(out);
}));
var filterMapEffect = /* @__PURE__ */ dual((args2) => isIterable(args2[0]) && !isEffect(args2[0]), (elements, filter5, options) => suspend(() => {
  const out = [];
  return as(forEach(elements, (a) => map2(filter5(a), (result3) => {
    if (isSuccess2(result3)) {
      out.push(result3.success);
    }
  }), {
    discard: true,
    concurrency: options?.concurrency
  }), out);
}));
var Do2 = /* @__PURE__ */ succeed3({});
var bindTo3 = /* @__PURE__ */ bindTo(map2);
var bind3 = /* @__PURE__ */ bind(map2, flatMap2);
var let_3 = /* @__PURE__ */ let_(map2);
var forkChild = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, options) => withFiber((fiber3) => {
  interruptChildrenPatch();
  return succeed3(forkUnsafe(fiber3, self, options?.startImmediately, false, options?.uninterruptible ?? false));
}));
var forkUnsafe = (parent, effect2, immediate = false, daemon = false, uninterruptible3 = false) => {
  const parentRuntime = parent;
  const interruptible3 = uninterruptible3 === "inherit" ? parentRuntime.interruptible : !uninterruptible3;
  const child = new FiberImpl(parentRuntime.context, interruptible3);
  if (immediate) {
    child.evaluate(effect2);
  } else {
    parentRuntime.currentDispatcher.scheduleTask(() => child.evaluate(effect2), 0);
  }
  if (!daemon && !child._exit) {
    parentRuntime.children().add(child);
    child._parent = parentRuntime;
  }
  return child;
};
var forkDetach = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, options) => withFiber((fiber3) => succeed3(forkUnsafe(fiber3, self, options?.startImmediately, true, options?.uninterruptible))));
var awaitAllChildren = (self) => withFiber((fiber3) => {
  const initialChildren = fiber3._children && new Set(fiber3._children);
  return onExit(self, (_) => {
    let children = fiber3._children;
    if (children === void 0 || children.size === 0) {
      return void_2;
    } else if (initialChildren) {
      children = filter(children, (child) => !initialChildren.has(child));
    }
    return asVoid(fiberAwaitAll(children));
  });
});
var forkIn = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, scope3, options) => withFiber((parent) => {
  const fiber3 = forkUnsafe(parent, self, options?.startImmediately, true, options?.uninterruptible);
  if (!fiber3._exit) {
    if (scope3.state._tag !== "Closed") {
      const key = {};
      const finalizer = () => withFiberId((interruptor) => interruptor === fiber3.id ? void_2 : fiberInterrupt(fiber3));
      scopeAddFinalizerUnsafe(scope3, key, finalizer);
      fiber3.addObserver(() => scopeRemoveFinalizerUnsafe(scope3, key));
    } else {
      fiber3.interruptUnsafe(parent.id, fiberStackAnnotations(parent));
    }
  }
  return succeed3(fiber3);
}));
var forkScoped = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, options) => flatMap2(scope, (scope3) => forkIn(self, scope3, options)));
var runForkWith = (context3) => (effect2, options) => {
  const fiber3 = new FiberImpl(options?.scheduler ? add(context3, Scheduler, options.scheduler) : context3, options?.uninterruptible !== true);
  fiber3.evaluate(effect2);
  if (fiber3._exit) return fiber3;
  if (options?.signal) {
    if (options.signal.aborted) {
      fiber3.interruptUnsafe();
    } else {
      const abort = () => fiber3.interruptUnsafe();
      options.signal.addEventListener("abort", abort, {
        once: true
      });
      fiber3.addObserver(() => options.signal.removeEventListener("abort", abort));
    }
  }
  if (options?.onFiberStart) {
    options.onFiberStart(fiber3);
  }
  return fiber3;
};
var fiberRunIn = /* @__PURE__ */ dual(2, (self, scope3) => {
  if (self._exit) {
    return self;
  } else if (scope3.state._tag === "Closed") {
    self.interruptUnsafe(self.id);
    return self;
  }
  const key = {};
  scopeAddFinalizerUnsafe(scope3, key, () => fiberInterrupt(self));
  self.addObserver(() => scopeRemoveFinalizerUnsafe(scope3, key));
  return self;
});
var runFork = /* @__PURE__ */ runForkWith(/* @__PURE__ */ empty2());
var runCallbackWith = (context3) => {
  const runFork3 = runForkWith(context3);
  return (effect2, options) => {
    const fiber3 = runFork3(effect2, options);
    if (options?.onExit) {
      fiber3.addObserver(options.onExit);
    }
    return (interruptor) => {
      return fiber3.interruptUnsafe(interruptor);
    };
  };
};
var runCallback = /* @__PURE__ */ runCallbackWith(/* @__PURE__ */ empty2());
var runPromiseExitWith = (context3) => {
  const runFork3 = runForkWith(context3);
  return (effect2, options) => {
    const fiber3 = runFork3(effect2, options);
    return new Promise((resolve2) => {
      fiber3.addObserver((exit3) => resolve2(exit3));
    });
  };
};
var runPromiseExit = /* @__PURE__ */ runPromiseExitWith(/* @__PURE__ */ empty2());
var runPromiseWith = (context3) => {
  const runPromiseExit3 = runPromiseExitWith(context3);
  return (effect2, options) => runPromiseExit3(effect2, options).then((exit3) => {
    if (exit3._tag === "Failure") {
      throw causeSquash(exit3.cause);
    }
    return exit3.value;
  });
};
var runPromise = /* @__PURE__ */ runPromiseWith(/* @__PURE__ */ empty2());
var runSyncExitWith = (context3) => {
  const runFork3 = runForkWith(context3);
  return (effect2) => {
    if (effectIsExit(effect2)) return effect2;
    const scheduler = new MixedScheduler("sync");
    const fiber3 = runFork3(effect2, {
      scheduler
    });
    fiber3._dispatcher?.flush();
    return fiber3._exit ?? exitDie(new AsyncFiberError(fiber3));
  };
};
var runSyncExit = /* @__PURE__ */ runSyncExitWith(/* @__PURE__ */ empty2());
var runSyncWith = (context3) => {
  const runSyncExit3 = runSyncExitWith(context3);
  return (effect2) => {
    const exit3 = runSyncExit3(effect2);
    if (exit3._tag === "Failure") throw causeSquash(exit3.cause);
    return exit3.value;
  };
};
var runSync = /* @__PURE__ */ runSyncWith(/* @__PURE__ */ empty2());
var succeedTrue = /* @__PURE__ */ succeed3(true);
var succeedFalse = /* @__PURE__ */ succeed3(false);
var Latch = class {
  waiters = [];
  scheduled = void 0;
  _isOpen;
  constructor(isOpen) {
    this._isOpen = isOpen;
  }
  scheduleUnsafe(fiber3) {
    if (this.waiters.length === 0) {
      return succeedTrue;
    }
    if (this.scheduled === void 0) {
      this.scheduled = this.waiters;
      fiber3.currentDispatcher.scheduleTask(this.flushScheduled, 0);
    } else {
      for (let i = 0; i < this.waiters.length; i++) {
        this.scheduled.push(this.waiters[i]);
      }
    }
    this.waiters = [];
    return succeedTrue;
  }
  flushScheduled = () => {
    if (this.scheduled === void 0) return;
    const waiters = this.scheduled;
    this.scheduled = void 0;
    for (let i = 0; i < waiters.length; i++) {
      waiters[i](exitVoid);
    }
  };
  flushWaiters() {
    const waiters = this.waiters;
    this.waiters = [];
    this.flushScheduled();
    for (let i = 0; i < waiters.length; i++) {
      waiters[i](exitVoid);
    }
  }
  open = /* @__PURE__ */ withFiber((fiber3) => {
    if (this._isOpen) return succeedFalse;
    this._isOpen = true;
    return this.scheduleUnsafe(fiber3);
  });
  release = /* @__PURE__ */ withFiber((fiber3) => this._isOpen ? succeedFalse : this.scheduleUnsafe(fiber3));
  openUnsafe() {
    if (this._isOpen) return false;
    this._isOpen = true;
    this.flushWaiters();
    return true;
  }
  await = /* @__PURE__ */ callback((resume) => {
    if (this._isOpen) {
      return resume(void_2);
    }
    this.waiters.push(resume);
    return sync(() => {
      let index = this.waiters.indexOf(resume);
      if (index !== -1) {
        this.waiters.splice(index, 1);
      } else if (this.scheduled !== void 0) {
        index = this.scheduled.indexOf(resume);
        if (index !== -1) {
          this.scheduled.splice(index, 1);
        }
      }
    });
  });
  closeUnsafe() {
    if (!this._isOpen) return false;
    this._isOpen = false;
    return true;
  }
  close = /* @__PURE__ */ sync(() => this.closeUnsafe());
  whenOpen = (self) => flatMap2(this.await, () => self);
  isOpen() {
    return this._isOpen;
  }
};
var makeLatchUnsafe = (open) => new Latch(open ?? false);
var tracer = /* @__PURE__ */ withFiber((fiber3) => succeed3(fiber3.getRef(Tracer)));
var withTracer = /* @__PURE__ */ dual(2, (effect2, tracer3) => provideService(effect2, Tracer, tracer3));
var withTracerEnabled = /* @__PURE__ */ provideService(TracerEnabled);
var withTracerTiming = /* @__PURE__ */ provideService(TracerTimingEnabled);
var bigint02 = /* @__PURE__ */ BigInt(0);
var NoopSpanProto = {
  _tag: "Span",
  spanId: "noop",
  traceId: "noop",
  sampled: false,
  status: {
    _tag: "Ended",
    startTime: bigint02,
    endTime: bigint02,
    exit: exitVoid
  },
  attributes: /* @__PURE__ */ new Map(),
  links: [],
  kind: "internal",
  attribute() {
  },
  event() {
  },
  end() {
  },
  addLinks() {
  }
};
var noopSpan = (options) => Object.assign(Object.create(NoopSpanProto), options);
var filterDisablePropagation = (span2) => {
  if (!span2) return none2();
  return get(span2.annotations, DisablePropagation) ? span2._tag === "Span" ? filterDisablePropagation(getOrUndefined(span2.parent)) : none2() : some2(span2);
};
var makeSpanUnsafe = (fiber3, name, options) => {
  const disablePropagation = !fiber3.getRef(TracerEnabled) || options?.annotations && get(options.annotations, DisablePropagation);
  const parent = options?.parent !== void 0 ? some2(options.parent) : options?.root ? none2() : filterDisablePropagation(fiber3.cache.span);
  let span2;
  if (disablePropagation) {
    span2 = noopSpan({
      name,
      parent,
      annotations: add(options?.annotations ?? empty2(), DisablePropagation, true)
    });
  } else {
    const tracer3 = fiber3.getRef(Tracer);
    const clock = fiber3.getRef(ClockRef);
    const timingEnabled = fiber3.getRef(TracerTimingEnabled);
    const annotationsFromEnv = fiber3.getRef(TracerSpanAnnotations);
    const linksFromEnv = fiber3.getRef(TracerSpanLinks);
    const level = options?.level ?? fiber3.getRef(CurrentTraceLevel);
    const links = options?.links !== void 0 ? [...linksFromEnv, ...options.links] : linksFromEnv.length === 0 ? [] : linksFromEnv.slice();
    span2 = tracer3.span({
      name,
      parent,
      annotations: options?.annotations ?? empty2(),
      links,
      startTime: timingEnabled ? clock.currentTimeNanosUnsafe() : bigint02,
      kind: options?.kind ?? "internal",
      root: options?.root ?? isNone2(parent),
      sampled: options?.sampled ?? (isSome2(parent) && parent.value.sampled === false ? false : !isLogLevelGreaterThan(fiber3.getRef(MinimumTraceLevel), level))
    });
    for (const key in annotationsFromEnv) {
      span2.attribute(key, annotationsFromEnv[key]);
    }
    if (options?.attributes !== void 0) {
      for (const key in options.attributes) {
        span2.attribute(key, options.attributes[key]);
      }
    }
  }
  return span2;
};
var makeSpan = (name, options) => withFiber((fiber3) => succeed3(makeSpanUnsafe(fiber3, name, options)));
var makeSpanScoped = (name, options) => uninterruptible(withFiber((fiber3) => {
  const scope3 = getUnsafe(fiber3.context, scopeTag);
  const span2 = makeSpanUnsafe(fiber3, name, options ?? {});
  const clock = fiber3.getRef(ClockRef);
  const timingEnabled = fiber3.getRef(TracerTimingEnabled);
  return as(scopeAddFinalizerExit(scope3, (exit3) => endSpan(span2, exit3, clock, timingEnabled)), span2);
}));
var withSpanScoped = function() {
  const dataFirst = typeof arguments[0] !== "string";
  const name = dataFirst ? arguments[1] : arguments[0];
  const options = addSpanStackTrace(dataFirst ? arguments[2] : arguments[1]);
  if (dataFirst) {
    const self = arguments[0];
    return flatMap2(makeSpanScoped(name, options), (span2) => withParentSpan(self, span2, options));
  }
  return (self) => flatMap2(makeSpanScoped(name, options), (span2) => withParentSpan(self, span2, options));
};
var provideSpanStackFrame = (name, stack) => {
  stack = typeof stack === "function" ? stack : constUndefined;
  return updateService(CurrentStackFrame, (parent) => ({
    name,
    stack,
    parent
  }));
};
var spanAnnotations = TracerSpanAnnotations;
var spanLinks = TracerSpanLinks;
var linkSpans = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, span2, attributes = {}) => {
  const spans = Array.isArray(span2) ? span2 : [span2];
  const links = spans.map((span3) => ({
    span: span3,
    attributes
  }));
  return updateService(self, TracerSpanLinks, (current) => [...current, ...links]);
});
var endSpan = (span2, exit3, clock, timingEnabled) => sync(() => {
  if (span2.status._tag === "Ended") return;
  span2.end(timingEnabled ? clock.currentTimeNanosUnsafe() : bigint02, exit3);
});
var useSpan = (name, ...args2) => {
  const options = args2.length === 1 ? void 0 : args2[0];
  const evaluate2 = args2[args2.length - 1];
  return withFiber((fiber3) => {
    const span2 = makeSpanUnsafe(fiber3, name, options);
    const clock = fiber3.getRef(ClockRef);
    const timingEnabled = fiber3.getRef(TracerTimingEnabled);
    return onExit(suspend(() => internalCall(() => evaluate2(span2))), (exit3) => endSpan(span2, exit3, clock, timingEnabled));
  });
};
var provideParentSpan = /* @__PURE__ */ provideService(ParentSpan);
var withParentSpan = function() {
  const dataFirst = isEffect(arguments[0]);
  const span2 = dataFirst ? arguments[1] : arguments[0];
  let options = dataFirst ? arguments[2] : arguments[1];
  let provideStackFrame = identity;
  if (span2._tag === "Span") {
    options = addSpanStackTrace(options);
    provideStackFrame = provideSpanStackFrame(span2.name, options?.captureStackTrace);
  }
  if (dataFirst) {
    return provideParentSpan(provideStackFrame(arguments[0]), span2);
  }
  return (self) => provideParentSpan(provideStackFrame(self), span2);
};
var withSpan = function() {
  const dataFirst = typeof arguments[0] !== "string";
  const name = dataFirst ? arguments[1] : arguments[0];
  const traceOptions = addSpanStackTrace(arguments[2]);
  if (dataFirst) {
    const self = arguments[0];
    return useSpan(name, arguments[2], (span2) => withParentSpan(self, span2, traceOptions));
  }
  const fnArg = typeof arguments[1] === "function" ? arguments[1] : void 0;
  const options = fnArg ? void 0 : arguments[1];
  return (self, ...args2) => useSpan(name, fnArg ? fnArg(...args2) : options, (span2) => withParentSpan(self, span2, traceOptions));
};
var annotateSpans = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (effect2, ...args2) => updateService(effect2, TracerSpanAnnotations, (annotations2) => {
  const newAnnotations = args2.length === 1 ? {
    ...annotations2,
    ...args2[0]
  } : {
    ...annotations2
  };
  if (args2.length === 1) {
    return newAnnotations;
  } else {
    assignProperty(newAnnotations, args2[0], args2[1]);
  }
  return newAnnotations;
}));
var annotateCurrentSpan = (...args2) => withFiber((fiber3) => {
  const span2 = fiber3.currentSpanLocal;
  if (span2) {
    if (args2.length === 1) {
      for (const [key, value] of Object.entries(args2[0])) {
        span2.attribute(key, value);
      }
    } else {
      span2.attribute(args2[0], args2[1]);
    }
  }
  return void_2;
});
var currentSpan = /* @__PURE__ */ withFiber((fiber3) => {
  const span2 = fiber3.currentSpanLocal;
  return span2 ? succeed3(span2) : fail3(new NoSuchElementError());
});
var currentParentSpan = /* @__PURE__ */ serviceOptional(ParentSpan);
var ClockRef = /* @__PURE__ */ Reference("effect/Clock", {
  defaultValue: () => new ClockImpl()
});
var MAX_TIMER_MILLIS = 2 ** 31 - 1;
var ClockImpl = class {
  currentTimeMillisUnsafe() {
    return Date.now();
  }
  currentTimeMillis = /* @__PURE__ */ sync(() => this.currentTimeMillisUnsafe());
  currentTimeNanosUnsafe() {
    return wallTimeNanos();
  }
  currentTimeNanos = /* @__PURE__ */ sync(() => this.currentTimeNanosUnsafe());
  monotonicTimeNanosUnsafe() {
    return monotonicNowNanos();
  }
  monotonicTimeNanos = /* @__PURE__ */ sync(() => this.monotonicTimeNanosUnsafe());
  sleep(duration) {
    return this.sleepMillis(toMillis(duration));
  }
  sleepMillis(millis2) {
    if (millis2 <= 0) return yieldNow;
    else if (!Number.isFinite(millis2)) return never;
    return callback((resume) => {
      const continuation = millis2 > MAX_TIMER_MILLIS ? this.sleepMillis(millis2 - MAX_TIMER_MILLIS) : void_2;
      const handle = setTimeout(() => resume(continuation), Math.min(millis2, MAX_TIMER_MILLIS));
      return sync(() => clearTimeout(handle));
    });
  }
};
var nanosPerMilli = /* @__PURE__ */ BigInt(1e6);
var monotonicNowNanos = /* @__PURE__ */ (function() {
  const processHrtime = globalThis.process?.hrtime;
  if (typeof processHrtime?.bigint === "function") {
    return () => processHrtime.bigint();
  }
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return () => BigInt(Math.round(performance.now() * 1e6));
  }
  let previous = /* @__PURE__ */ BigInt(0);
  return () => {
    const current = BigInt(Date.now()) * nanosPerMilli;
    if (current > previous) {
      previous = current;
    }
    return previous;
  };
})();
var wallTimeNanos = /* @__PURE__ */ (function() {
  const reanchorThresholdNanos = /* @__PURE__ */ BigInt(1e9);
  let origin;
  return () => {
    const monotonic = monotonicNowNanos();
    const wall = BigInt(Date.now()) * nanosPerMilli;
    if (origin === void 0) {
      origin = wall - monotonic;
    } else {
      const projected = origin + monotonic;
      const skew = wall > projected ? wall - projected : projected - wall;
      if (skew > reanchorThresholdNanos) {
        origin = wall - monotonic;
      }
    }
    return origin + monotonic;
  };
})();
var clockWith = (f) => withFiber((fiber3) => f(fiber3.getRef(ClockRef)));
var sleep = (duration) => clockWith((clock) => clock.sleep(fromInputUnsafe(duration)));
var currentTimeMillis = /* @__PURE__ */ clockWith((clock) => clock.currentTimeMillis);
var TimeoutErrorTypeId = "~effect/Cause/TimeoutError";
var isTimeoutError = (u) => hasProperty(u, TimeoutErrorTypeId);
var TimeoutError = class extends (/* @__PURE__ */ TaggedError("TimeoutError")) {
  [TimeoutErrorTypeId] = TimeoutErrorTypeId;
  constructor(message) {
    super({
      message
    });
  }
};
var IllegalArgumentErrorTypeId = "~effect/Cause/IllegalArgumentError";
var isIllegalArgumentError = (u) => hasProperty(u, IllegalArgumentErrorTypeId);
var IllegalArgumentError = class extends (/* @__PURE__ */ TaggedError("IllegalArgumentError")) {
  [IllegalArgumentErrorTypeId] = IllegalArgumentErrorTypeId;
  constructor(message) {
    super({
      message
    });
  }
};
var ExceededCapacityErrorTypeId = "~effect/Cause/ExceededCapacityError";
var isExceededCapacityError = (u) => hasProperty(u, ExceededCapacityErrorTypeId);
var ExceededCapacityError = class extends (/* @__PURE__ */ TaggedError("ExceededCapacityError")) {
  [ExceededCapacityErrorTypeId] = ExceededCapacityErrorTypeId;
  constructor(message) {
    super({
      message
    });
  }
};
var AsyncFiberErrorTypeId = "~effect/Cause/AsyncFiberError";
var isAsyncFiberError = (u) => hasProperty(u, AsyncFiberErrorTypeId);
var AsyncFiberError = class extends (/* @__PURE__ */ TaggedError("AsyncFiberError")) {
  [AsyncFiberErrorTypeId] = AsyncFiberErrorTypeId;
  constructor(fiber3) {
    super({
      message: "An asynchronous Effect was executed with Effect.runSync",
      fiber: fiber3
    });
  }
};
var UnknownErrorTypeId = "~effect/Cause/UnknownError";
var isUnknownError = (u) => hasProperty(u, UnknownErrorTypeId);
var UnknownError = class extends (/* @__PURE__ */ TaggedError("UnknownError")) {
  [UnknownErrorTypeId] = UnknownErrorTypeId;
  constructor(cause, message) {
    super({
      message,
      cause
    });
  }
};
var ConsoleRef = /* @__PURE__ */ Reference("effect/Console", {
  defaultValue: () => globalThis.console
});
var logLevelToOrder = (level) => {
  switch (level) {
    case "All":
      return Number.MIN_SAFE_INTEGER;
    case "Fatal":
      return 5e4;
    case "Error":
      return 4e4;
    case "Warn":
      return 3e4;
    case "Info":
      return 2e4;
    case "Debug":
      return 1e4;
    case "Trace":
      return 0;
    case "None":
      return Number.MAX_SAFE_INTEGER;
  }
};
var LogLevelOrder = /* @__PURE__ */ mapInput(Number2, logLevelToOrder);
var isLogLevelGreaterThan = /* @__PURE__ */ isGreaterThan(LogLevelOrder);
var CurrentLoggers = /* @__PURE__ */ Reference("effect/Logger/CurrentLoggers", {
  defaultValue: () => /* @__PURE__ */ new Set([defaultLogger, tracerLogger])
});
var LogToStderr = /* @__PURE__ */ Reference("effect/Logger/LogToStderr", {
  defaultValue: constFalse
});
var annotateLogsScoped = function() {
  const entries = typeof arguments[0] === "string" ? [[arguments[0], arguments[1]]] : Object.entries(arguments[0]);
  return uninterruptible(withFiber((fiber3) => {
    const prev = fiber3.getRef(CurrentLogAnnotations);
    const next = {
      ...prev
    };
    for (let i = 0; i < entries.length; i++) {
      const [key, value] = entries[i];
      assignProperty(next, key, value);
    }
    fiber3.setContext(add(fiber3.context, CurrentLogAnnotations, next));
    return scopeAddFinalizerExit(getUnsafe(fiber3.context, scopeTag), (_) => {
      const current = fiber3.getRef(CurrentLogAnnotations);
      const next2 = {
        ...current
      };
      for (let i = 0; i < entries.length; i++) {
        const [key, value] = entries[i];
        if (current[key] !== value && !Object.is(current[key], value)) continue;
        if (Object.hasOwn(prev, key)) {
          assignProperty(next2, key, prev[key]);
        } else {
          delete next2[key];
        }
      }
      fiber3.setContext(add(fiber3.context, CurrentLogAnnotations, next2));
      return void_2;
    });
  }));
};
var LoggerTypeId = "~effect/Logger";
var LoggerProto = {
  [LoggerTypeId]: {
    _Message: identity,
    _Output: identity
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var loggerMake = (log2) => {
  const self = Object.create(LoggerProto);
  self.log = log2;
  return self;
};
var formatLabel = (key) => key.replace(/[\s="]/g, "_");
var formatLogSpan = (self, now) => {
  const label = formatLabel(self[0]);
  return `${label}=${now - self[1]}ms`;
};
var logWithLevel = (level) => (...message) => {
  let cause = void 0;
  for (let i = 0, len = message.length; i < len; i++) {
    const msg = message[i];
    if (isCause(msg)) {
      if (cause) {
        ;
        message.splice(i, 1);
      } else {
        message = message.slice(0, i).concat(message.slice(i + 1));
      }
      cause = cause ? causeFromReasons(cause.reasons.concat(msg.reasons)) : msg;
      i--;
    }
  }
  if (cause === void 0) {
    cause = causeEmpty;
  }
  return withFiber((fiber3) => {
    const logLevel = level ?? fiber3.cache.logLevel;
    if (isLogLevelGreaterThan(fiber3.cache.minimumLogLevel, logLevel)) {
      return void_2;
    }
    const clock = fiber3.getRef(ClockRef);
    const loggers = fiber3.getRef(CurrentLoggers);
    if (loggers.size > 0) {
      const date = new Date(clock.currentTimeMillisUnsafe());
      for (const logger of loggers) {
        logger.log({
          cause,
          fiber: fiber3,
          date,
          logLevel,
          message
        });
      }
    }
    return void_2;
  });
};
var colors = {
  bold: "1",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  cyan: "36",
  white: "37",
  gray: "90",
  black: "30",
  bgBrightRed: "101"
};
var logLevelColors = {
  None: [],
  All: [],
  Trace: [colors.gray],
  Debug: [colors.blue],
  Info: [colors.green],
  Warn: [colors.yellow],
  Error: [colors.red],
  Fatal: [colors.bgBrightRed, colors.black]
};
var defaultDateFormat = (date) => `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}.${date.getMilliseconds().toString().padStart(3, "0")}`;
var defaultLogger = /* @__PURE__ */ loggerMake(({
  cause,
  date,
  fiber: fiber3,
  logLevel,
  message
}) => {
  const message_ = Array.isArray(message) ? message.slice() : [message];
  if (cause.reasons.length > 0) {
    message_.push(causePretty(cause));
  }
  const now = date.getTime();
  const spans = fiber3.getRef(CurrentLogSpans);
  let spanString = "";
  for (const span2 of spans) {
    spanString += ` ${formatLogSpan(span2, now)}`;
  }
  const annotations2 = fiber3.getRef(CurrentLogAnnotations);
  if (Object.keys(annotations2).length > 0) {
    message_.push(annotations2);
  }
  const console2 = fiber3.getRef(ConsoleRef);
  const log2 = fiber3.getRef(LogToStderr) ? console2.error : console2.log;
  log2(`[${defaultDateFormat(date)}] ${logLevel.toUpperCase()} (#${fiber3.id})${spanString}:`, ...message_);
});
var tracerLogger = /* @__PURE__ */ loggerMake(({
  cause,
  fiber: fiber3,
  logLevel,
  message
}) => {
  const clock = fiber3.getRef(ClockRef);
  const annotations2 = fiber3.getRef(CurrentLogAnnotations);
  const span2 = fiber3.cache.span;
  if (span2 === void 0 || span2._tag === "ExternalSpan") return;
  const attributes = {};
  for (const [key, value] of Object.entries(annotations2)) {
    assignProperty(attributes, key, value);
  }
  attributes["effect.fiberId"] = fiber3.id;
  attributes["effect.logLevel"] = logLevel.toUpperCase();
  if (cause.reasons.length > 0) {
    attributes["effect.cause"] = causePretty(cause);
  }
  span2.event(toStringUnknown(Array.isArray(message) && message.length === 1 ? message[0] : message), clock.currentTimeNanosUnsafe(), attributes);
});
function interruptChildrenPatch() {
  fiberMiddleware.interruptChildren ??= fiberInterruptChildren;
}
var undefined_ = /* @__PURE__ */ succeed3(void 0);
var withErrorReporting = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, options) => onError(self, (cause) => withFiber((fiber3) => {
  reportCauseUnsafe(fiber3, cause, options?.defectsOnly);
  return void_2;
})));
var reportCauseUnsafe = (fiber3, cause, defectsOnly) => {
  const reporters = fiber3.getRef(CurrentErrorReporters);
  if (reporters.size === 0) return;
  if (defectsOnly && !hasDies(cause)) return;
  const opts = {
    cause,
    fiber: fiber3,
    timestamp: fiber3.getRef(ClockRef).currentTimeNanosUnsafe()
  };
  reporters.forEach((reporter) => reporter.report(opts));
};

// ops/node_modules/effect/dist/Cause.js
var TypeId5 = CauseTypeId;
var ReasonTypeId = CauseReasonTypeId;
var isCause2 = isCause;
var isReason = isCauseReason;
var isFailReason2 = isFailReason;
var isDieReason2 = isDieReason;
var isInterruptReason2 = isInterruptReason;
var fromReasons = causeFromReasons;
var empty3 = causeEmpty;
var fail4 = causeFail;
var die2 = causeDie;
var interrupt2 = causeInterrupt;
var makeFailReason = (error) => new Fail(error);
var makeDieReason = (defect) => new Die(defect);
var makeInterruptReason2 = makeInterruptReason;
var hasInterruptsOnly2 = hasInterruptsOnly;
var map3 = causeMap;
var combine2 = causeCombine;
var squash = causeSquash;
var hasFails2 = hasFails;
var findFail2 = findFail;
var findError2 = findError;
var findErrorOption2 = findErrorOption;
var hasDies2 = hasDies;
var findDie2 = findDie;
var findDefect2 = findDefect;
var hasInterrupts2 = hasInterrupts;
var findInterrupt2 = findInterrupt;
var interruptors = causeInterruptors;
var filterInterruptors = causeFilterInterruptors;
var prettyErrors = causePrettyErrors;
var pretty = causePretty;
var isNoSuchElementError2 = isNoSuchElementError;
var NoSuchElementErrorTypeId2 = NoSuchElementErrorTypeId;
var NoSuchElementError2 = NoSuchElementError;
var isDone2 = isDone;
var DoneTypeId2 = DoneTypeId;
var Done2 = Done;
var done2 = done;
var TimeoutErrorTypeId2 = TimeoutErrorTypeId;
var isTimeoutError2 = isTimeoutError;
var TimeoutError2 = TimeoutError;
var IllegalArgumentErrorTypeId2 = IllegalArgumentErrorTypeId;
var isIllegalArgumentError2 = isIllegalArgumentError;
var IllegalArgumentError2 = IllegalArgumentError;
var isExceededCapacityError2 = isExceededCapacityError;
var ExceededCapacityErrorTypeId2 = ExceededCapacityErrorTypeId;
var ExceededCapacityError2 = ExceededCapacityError;
var AsyncFiberErrorTypeId2 = AsyncFiberErrorTypeId;
var isAsyncFiberError2 = isAsyncFiberError;
var AsyncFiberError2 = AsyncFiberError;
var UnknownErrorTypeId2 = UnknownErrorTypeId;
var isUnknownError2 = isUnknownError;
var UnknownError2 = UnknownError;
var annotate = causeAnnotate;
var reasonAnnotations2 = reasonAnnotations;
var annotations = causeAnnotations;
var StackTrace = class extends (/* @__PURE__ */ Service()("effect/Cause/StackTrace")) {
};
var InterruptorStackTrace2 = class extends (/* @__PURE__ */ Service()("effect/Cause/InterruptorStackTrace")) {
};

// ops/node_modules/effect/dist/Effect.js
var Effect_exports = {};
__export(Effect_exports, {
  Do: () => Do3,
  Transaction: () => Transaction,
  TypeId: () => TypeId12,
  abortSignal: () => abortSignal2,
  acquireDisposable: () => acquireDisposable2,
  acquireRelease: () => acquireRelease2,
  acquireUseRelease: () => acquireUseRelease2,
  addFinalizer: () => addFinalizer2,
  all: () => all3,
  andThen: () => andThen3,
  annotateCurrentSpan: () => annotateCurrentSpan2,
  annotateLogs: () => annotateLogs,
  annotateLogsScoped: () => annotateLogsScoped2,
  annotateSpans: () => annotateSpans2,
  as: () => as2,
  asSome: () => asSome2,
  asVoid: () => asVoid3,
  awaitAllChildren: () => awaitAllChildren2,
  bind: () => bind4,
  bindTo: () => bindTo4,
  cached: () => cached2,
  cachedInvalidateWithTTL: () => cachedInvalidateWithTTL2,
  cachedWithTTL: () => cachedWithTTL2,
  callback: () => callback2,
  catch: () => catch_3,
  catchCause: () => catchCause3,
  catchCauseFilter: () => catchCauseFilter2,
  catchCauseIf: () => catchCauseIf2,
  catchDefect: () => catchDefect2,
  catchEager: () => catchEager2,
  catchFilter: () => catchFilter2,
  catchIf: () => catchIf2,
  catchNoSuchElement: () => catchNoSuchElement2,
  catchReason: () => catchReason2,
  catchReasons: () => catchReasons2,
  catchTag: () => catchTag3,
  catchTags: () => catchTags2,
  clockWith: () => clockWith2,
  context: () => context2,
  contextWith: () => contextWith2,
  currentParentSpan: () => currentParentSpan2,
  currentSpan: () => currentSpan2,
  delay: () => delay2,
  die: () => die4,
  effectify: () => effectify,
  ensuring: () => ensuring2,
  eventually: () => eventually2,
  exit: () => exit2,
  fail: () => fail6,
  failCause: () => failCause3,
  failCauseSync: () => failCauseSync2,
  failSync: () => failSync2,
  fiber: () => fiber2,
  fiberId: () => fiberId2,
  filter: () => filter3,
  filterMap: () => filterMap2,
  filterMapEffect: () => filterMapEffect2,
  filterMapOrElse: () => filterMapOrElse2,
  filterMapOrFail: () => filterMapOrFail2,
  filterOrElse: () => filterOrElse2,
  filterOrFail: () => filterOrFail3,
  findFirst: () => findFirst2,
  findFirstFilter: () => findFirstFilter2,
  firstSuccessOf: () => firstSuccessOf2,
  flatMap: () => flatMap4,
  flatMapEager: () => flatMapEager2,
  flatten: () => flatten3,
  flip: () => flip3,
  fn: () => fn2,
  fnUntraced: () => fnUntraced2,
  fnUntracedEager: () => fnUntracedEager2,
  forEach: () => forEach2,
  forever: () => forever3,
  forkChild: () => forkChild2,
  forkDetach: () => forkDetach2,
  forkIn: () => forkIn2,
  forkScoped: () => forkScoped2,
  fromNullishOr: () => fromNullishOr3,
  fromOption: () => fromOption4,
  fromResult: () => fromResult2,
  gen: () => gen3,
  head: () => head2,
  ignore: () => ignore2,
  ignoreCause: () => ignoreCause2,
  interrupt: () => interrupt4,
  interruptible: () => interruptible2,
  interruptibleMask: () => interruptibleMask2,
  isEffect: () => isEffect2,
  isFailure: () => isFailure5,
  isSuccess: () => isSuccess5,
  let: () => let_4,
  linkSpans: () => linkSpans2,
  log: () => log,
  logDebug: () => logDebug,
  logError: () => logError,
  logFatal: () => logFatal,
  logInfo: () => logInfo,
  logTrace: () => logTrace,
  logWarning: () => logWarning,
  logWithLevel: () => logWithLevel2,
  makeSpan: () => makeSpan2,
  makeSpanScoped: () => makeSpanScoped2,
  map: () => map5,
  mapBoth: () => mapBoth4,
  mapBothEager: () => mapBothEager2,
  mapEager: () => mapEager2,
  mapError: () => mapError4,
  mapErrorEager: () => mapErrorEager2,
  match: () => match5,
  matchCause: () => matchCause2,
  matchCauseEager: () => matchCauseEager2,
  matchCauseEffect: () => matchCauseEffect2,
  matchCauseEffectEager: () => matchCauseEffectEager2,
  matchEager: () => matchEager2,
  matchEffect: () => matchEffect3,
  never: () => never2,
  onError: () => onError2,
  onErrorFilter: () => onErrorFilter2,
  onErrorIf: () => onErrorIf2,
  onExit: () => onExit2,
  onExitFilter: () => onExitFilter2,
  onExitIf: () => onExitIf2,
  onExitPrimitive: () => onExitPrimitive2,
  onInterrupt: () => onInterrupt2,
  option: () => option2,
  orDie: () => orDie3,
  orElseSucceed: () => orElseSucceed2,
  partition: () => partition3,
  promise: () => promise2,
  provide: () => provide4,
  provideContext: () => provideContext2,
  provideService: () => provideService2,
  provideServiceEffect: () => provideServiceEffect2,
  race: () => race2,
  raceAll: () => raceAll2,
  raceAllFirst: () => raceAllFirst2,
  raceFirst: () => raceFirst2,
  reduce: () => reduce2,
  repeat: () => repeat2,
  repeatOrElse: () => repeatOrElse2,
  replicate: () => replicate2,
  replicateEffect: () => replicateEffect2,
  request: () => request2,
  requestUnsafe: () => requestUnsafe2,
  result: () => result2,
  retry: () => retry2,
  retryOrElse: () => retryOrElse2,
  runCallback: () => runCallback2,
  runCallbackWith: () => runCallbackWith2,
  runFork: () => runFork2,
  runForkWith: () => runForkWith2,
  runPromise: () => runPromise2,
  runPromiseExit: () => runPromiseExit2,
  runPromiseExitWith: () => runPromiseExitWith2,
  runPromiseWith: () => runPromiseWith2,
  runSync: () => runSync2,
  runSyncExit: () => runSyncExit2,
  runSyncExitWith: () => runSyncExitWith2,
  runSyncWith: () => runSyncWith2,
  sandbox: () => sandbox2,
  satisfiesErrorType: () => satisfiesErrorType2,
  satisfiesServicesType: () => satisfiesServicesType2,
  satisfiesSuccessType: () => satisfiesSuccessType2,
  schedule: () => schedule,
  scheduleFrom: () => scheduleFrom2,
  scope: () => scope2,
  scoped: () => scoped2,
  scopedWith: () => scopedWith2,
  service: () => service2,
  serviceOption: () => serviceOption2,
  setContext: () => setContext2,
  sleep: () => sleep2,
  spanAnnotations: () => spanAnnotations2,
  spanLinks: () => spanLinks2,
  succeed: () => succeed6,
  succeedNone: () => succeedNone3,
  succeedSome: () => succeedSome3,
  suspend: () => suspend3,
  sync: () => sync3,
  tap: () => tap4,
  tapCause: () => tapCause3,
  tapCauseFilter: () => tapCauseFilter2,
  tapCauseIf: () => tapCauseIf2,
  tapDefect: () => tapDefect2,
  tapError: () => tapError3,
  tapErrorTag: () => tapErrorTag2,
  timed: () => timed2,
  timeout: () => timeout2,
  timeoutOption: () => timeoutOption2,
  timeoutOrElse: () => timeoutOrElse2,
  tracer: () => tracer2,
  track: () => track,
  trackDefects: () => trackDefects,
  trackDuration: () => trackDuration,
  trackErrors: () => trackErrors,
  trackSuccesses: () => trackSuccesses,
  transposeOption: () => transposeOption3,
  try: () => try_3,
  tryPromise: () => tryPromise2,
  tx: () => tx,
  txRetry: () => txRetry,
  undefined: () => undefined_2,
  uninterruptible: () => uninterruptible2,
  uninterruptibleMask: () => uninterruptibleMask2,
  unwrapReason: () => unwrapReason2,
  updateContext: () => updateContext2,
  updateService: () => updateService3,
  updateServiceScoped: () => updateServiceScoped2,
  useSpan: () => useSpan2,
  validate: () => validate2,
  void: () => void_4,
  when: () => when2,
  whileLoop: () => whileLoop2,
  withErrorReporting: () => withErrorReporting2,
  withExecutionPlan: () => withExecutionPlan2,
  withFiber: () => withFiber2,
  withFiberSucceed: () => withFiberSucceed2,
  withLogSpan: () => withLogSpan,
  withLogger: () => withLogger,
  withParentSpan: () => withParentSpan3,
  withSpan: () => withSpan3,
  withSpanScoped: () => withSpanScoped2,
  withTracer: () => withTracer2,
  withTracerEnabled: () => withTracerEnabled2,
  withTracerTiming: () => withTracerTiming2,
  yieldNow: () => yieldNow2,
  yieldNowWith: () => yieldNowWith2,
  zip: () => zip2,
  zipWith: () => zipWith2
});

// ops/node_modules/effect/dist/Exit.js
var Exit_exports = {};
__export(Exit_exports, {
  asVoid: () => asVoid2,
  asVoidAll: () => asVoidAll,
  die: () => die3,
  fail: () => fail5,
  failCause: () => failCause2,
  filterCause: () => filterCause,
  filterFailure: () => filterFailure,
  filterSuccess: () => filterSuccess,
  filterValue: () => filterValue,
  findDefect: () => findDefect3,
  findError: () => findError3,
  findErrorOption: () => findErrorOption3,
  getCause: () => getCause,
  getSuccess: () => getSuccess3,
  hasDies: () => hasDies3,
  hasFails: () => hasFails3,
  hasInterrupts: () => hasInterrupts3,
  interrupt: () => interrupt3,
  isExit: () => isExit2,
  isFailure: () => isFailure4,
  isSuccess: () => isSuccess4,
  map: () => map4,
  mapBoth: () => mapBoth3,
  mapError: () => mapError3,
  match: () => match4,
  succeed: () => succeed4,
  void: () => void_3
});
var isExit2 = isExit;
var succeed4 = exitSucceed;
var failCause2 = exitFailCause;
var fail5 = exitFail;
var die3 = exitDie;
var interrupt3 = exitInterrupt;
var void_3 = exitVoid;
var isSuccess4 = exitIsSuccess;
var isFailure4 = exitIsFailure;
var hasFails3 = exitHasFails;
var hasDies3 = exitHasDies;
var hasInterrupts3 = exitHasInterrupts;
var filterSuccess = exitFilterSuccess;
var filterValue = exitFilterValue;
var filterFailure = exitFilterFailure;
var filterCause = exitFilterCause;
var findError3 = exitFindError;
var findDefect3 = exitFindDefect;
var match4 = exitMatch;
var map4 = exitMap;
var mapError3 = exitMapError;
var mapBoth3 = exitMapBoth;
var asVoid2 = exitAsVoid;
var asVoidAll = exitAsVoidAll;
var getSuccess3 = exitGetSuccess;
var getCause = exitGetCause;
var findErrorOption3 = exitFindErrorOption;

// ops/node_modules/effect/dist/Layer.js
var Layer_exports = {};
__export(Layer_exports, {
  CurrentMemoMap: () => CurrentMemoMap,
  build: () => build,
  buildWithMemoMap: () => buildWithMemoMap,
  buildWithScope: () => buildWithScope,
  catch: () => catch_2,
  catchCause: () => catchCause2,
  catchTag: () => catchTag2,
  effect: () => effect,
  effectContext: () => effectContext,
  effectDiscard: () => effectDiscard,
  empty: () => empty4,
  flatMap: () => flatMap3,
  forkMemoMap: () => forkMemoMap,
  forkMemoMapUnsafe: () => forkMemoMapUnsafe,
  fresh: () => fresh,
  fromBuild: () => fromBuild,
  fromBuildMemo: () => fromBuildMemo,
  isLayer: () => isLayer,
  launch: () => launch,
  makeMemoMap: () => makeMemoMap,
  makeMemoMapUnsafe: () => makeMemoMapUnsafe,
  merge: () => merge3,
  mergeAll: () => mergeAll2,
  mock: () => mock,
  orDie: () => orDie2,
  parentSpan: () => parentSpan,
  provide: () => provide2,
  provideMerge: () => provideMerge,
  satisfiesErrorType: () => satisfiesErrorType,
  satisfiesServicesType: () => satisfiesServicesType,
  satisfiesSuccessType: () => satisfiesSuccessType,
  span: () => span,
  succeed: () => succeed5,
  succeedContext: () => succeedContext,
  suspend: () => suspend2,
  sync: () => sync2,
  syncContext: () => syncContext,
  tap: () => tap3,
  tapCause: () => tapCause2,
  tapError: () => tapError2,
  unwrap: () => unwrap,
  updateService: () => updateService2,
  withParentSpan: () => withParentSpan2,
  withSpan: () => withSpan2
});

// ops/node_modules/effect/dist/Deferred.js
var TypeId6 = "~effect/Deferred";
var DeferredProto = {
  [TypeId6]: {
    _A: identity,
    _E: identity
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var DeferredImpl = function() {
  this.resumes = void 0;
  this.effect = void 0;
};
DeferredImpl.prototype = DeferredProto;
var makeUnsafe2 = () => new DeferredImpl();
var _await = (self) => callback((resume) => {
  if (self.effect) return resume(self.effect);
  self.resumes ??= [];
  self.resumes.push(resume);
  return sync(() => {
    const resumes = self.resumes;
    if (resumes === void 0) return;
    const index = resumes.indexOf(resume);
    if (index >= 0) resumes.splice(index, 1);
  });
});
var completeWith = /* @__PURE__ */ dual(2, (self, effect2) => sync(() => doneUnsafe(self, effect2)));
var done3 = completeWith;
var doneUnsafe = (self, effect2) => {
  if (self.effect) return false;
  self.effect = effect2;
  if (self.resumes) {
    const resumes = self.resumes;
    self.resumes = void 0;
    for (let i = 0; i < resumes.length; i++) {
      resumes[i](effect2);
    }
  }
  return true;
};

// ops/node_modules/effect/dist/References.js
var CurrentLogAnnotations2 = CurrentLogAnnotations;
var CurrentLogSpans2 = CurrentLogSpans;
var CurrentStackFrame2 = CurrentStackFrame;

// ops/node_modules/effect/dist/Scope.js
var Scope = scopeTag;
var makeUnsafe3 = scopeMakeUnsafe;
var provide = provideScope;
var forkUnsafe2 = scopeForkUnsafe;
var close = scopeClose;

// ops/node_modules/effect/dist/Layer.js
var TypeId7 = "~effect/Layer";
var MemoMapTypeId = "~effect/Layer/MemoMap";
var memoMapReuse = (entry, scope3) => {
  entry.observers++;
  return andThen2(scopeAddFinalizerExit(scope3, (exit3) => entry.finalizer(exit3)), entry.effect);
};
var isLayer = (u) => hasProperty(u, TypeId7);
var LayerProto = {
  [TypeId7]: {
    _ROut: identity,
    _E: identity,
    _RIn: identity
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var fromBuildUnsafe = (build2) => {
  const self = Object.create(LayerProto);
  self.build = build2;
  return self;
};
var fromBuild = (build2) => fromBuildUnsafe((memoMap, scope3) => {
  const layerScope = forkUnsafe2(scope3);
  return onExit(build2(memoMap, layerScope), (exit3) => exit3._tag === "Failure" ? close(layerScope, exit3) : void_2);
});
var fromBuildMemo = (build2) => {
  const self = fromBuild((memoMap, scope3) => memoMap.getOrElseMemoize(self, scope3, build2));
  return self;
};
var memoMapBuild = (memoMap, layer, scope3, build2) => {
  const layerScope = makeUnsafe3();
  const deferred = makeUnsafe2();
  const entry = {
    observers: 1,
    effect: _await(deferred),
    finalizer: (exit3) => suspend(() => {
      entry.observers--;
      if (entry.observers === 0) {
        memoMap.map.delete(layer);
        return close(layerScope, exit3);
      }
      return void_2;
    })
  };
  memoMap.map.set(layer, entry);
  return scopeAddFinalizerExit(scope3, entry.finalizer).pipe(flatMap2(() => build2(memoMap, layerScope)), onExit((exit3) => {
    entry.effect = exit3;
    return done3(deferred, exit3);
  }));
};
var MemoMapImpl = class {
  get [MemoMapTypeId]() {
    return MemoMapTypeId;
  }
  parent;
  constructor(parent) {
    this.parent = parent;
  }
  map = /* @__PURE__ */ new Map();
  get(layer, scope3) {
    const local = this.map.get(layer);
    if (local) {
      return memoMapReuse(local, scope3);
    }
    return this.parent?.get(layer, scope3);
  }
  getOrElseMemoize(layer, scope3, build2) {
    return suspend(() => {
      const existing = this.get(layer, scope3);
      if (existing) {
        return existing;
      }
      return memoMapBuild(this, layer, scope3, build2);
    });
  }
};
var makeMemoMapUnsafe = () => new MemoMapImpl();
var forkMemoMapUnsafe = (parent) => new MemoMapImpl(parent);
var makeMemoMap = /* @__PURE__ */ sync(makeMemoMapUnsafe);
var forkMemoMap = (parent) => sync(() => forkMemoMapUnsafe(parent));
var CurrentMemoMap = class _CurrentMemoMap extends (/* @__PURE__ */ Service()("effect/Layer/CurrentMemoMap")) {
  static forkOrCreate(self) {
    const current = getOrUndefined3(self, _CurrentMemoMap);
    return current ? forkMemoMapUnsafe(current) : makeMemoMapUnsafe();
  }
};
var buildWithMemoMap = /* @__PURE__ */ dual(3, (self, memoMap, scope3) => provideService(map2(self.build(memoMap, scope3), add(CurrentMemoMap, memoMap)), CurrentMemoMap, memoMap));
var build = (self) => withFiber((fiber3) => buildWithMemoMap(self, CurrentMemoMap.forkOrCreate(fiber3.context), getUnsafe(fiber3.context, Scope)));
var buildWithScope = /* @__PURE__ */ dual(2, (self, scope3) => withFiber((fiber3) => buildWithMemoMap(self, CurrentMemoMap.forkOrCreate(fiber3.context), scope3)));
var succeed5 = function() {
  if (arguments.length === 1) {
    return (resource) => succeedContext(make3(arguments[0], resource));
  }
  return succeedContext(make3(arguments[0], arguments[1]));
};
var succeedContext = (context3) => fromBuildUnsafe(constant(succeed3(context3)));
var empty4 = /* @__PURE__ */ succeedContext(/* @__PURE__ */ empty2());
var sync2 = function() {
  if (arguments.length === 1) {
    return (evaluate2) => syncContext(() => make3(arguments[0], evaluate2()));
  }
  return syncContext(() => make3(arguments[0], arguments[1]()));
};
var syncContext = (evaluate2) => fromBuildMemo(constant(sync(evaluate2)));
var effect = function() {
  if (arguments.length === 1) {
    return (effect2) => effectImpl(arguments[0], effect2);
  }
  return effectImpl(arguments[0], arguments[1]);
};
var effectImpl = (service3, effect2) => effectContext(map2(effect2, (value) => make3(service3, value)));
var effectContext = (effect2) => fromBuildMemo((_, scope3) => provide(effect2, scope3));
var effectDiscard = (effect2) => effectContext(as(effect2, empty2()));
var suspend2 = (evaluate2) => fromBuildMemo((memoMap, scope3) => suspend(() => evaluate2().build(memoMap, scope3)));
var unwrapKey = /* @__PURE__ */ Service("effect/Layer/unwrap");
var unwrap = (self) => flatMap3(effect(unwrapKey)(self), get(unwrapKey));
var mergeAllEffect = (layers, memoMap, scope3) => {
  const parentScope = forkUnsafe2(scope3, "parallel");
  return forEach(layers, (layer) => layer.build(memoMap, forkUnsafe2(parentScope, "sequential")), {
    concurrency: layers.length
  }).pipe(map2((context3) => mergeAll(...context3)));
};
var mergeAll2 = (...layers) => fromBuild((memoMap, scope3) => mergeAllEffect(layers, memoMap, scope3));
var merge3 = /* @__PURE__ */ dual(2, (self, that) => mergeAll2(self, ...Array.isArray(that) ? that : [that]));
var provideWith = (self, that, f) => fromBuild((memoMap, scope3) => flatMap2(Array.isArray(that) ? mergeAllEffect(that, memoMap, scope3) : that.build(memoMap, scope3), (context3) => self.build(memoMap, scope3).pipe(provideContext(context3), map2((merged) => f(merged, context3)))));
var provide2 = /* @__PURE__ */ dual(2, (self, that) => provideWith(self, that, identity));
var provideMerge = /* @__PURE__ */ dual(2, (self, that) => provideWith(self, that, (self2, that2) => merge2(that2, self2)));
var flatMap3 = /* @__PURE__ */ dual(2, (self, f) => fromBuild((memoMap, scope3) => flatMap2(self.build(memoMap, scope3), (context3) => f(context3).build(memoMap, scope3))));
var tap3 = /* @__PURE__ */ dual(2, (self, f) => fromBuild((memoMap, scope3) => flatMap2(self.build(memoMap, scope3), (context3) => provide(as(f(context3), context3), scope3))));
var tapError2 = /* @__PURE__ */ dual(2, (self, f) => fromBuild((memoMap, scope3) => catch_(self.build(memoMap, scope3), (error) => provide(andThen2(f(error), fail3(error)), scope3))));
var tapCause2 = /* @__PURE__ */ dual(2, (self, f) => fromBuild((memoMap, scope3) => catchCause(self.build(memoMap, scope3), (cause) => provide(andThen2(f(cause), failCause(cause)), scope3))));
var orDie2 = (self) => fromBuildUnsafe((memoMap, scope3) => orDie(self.build(memoMap, scope3)));
var catch_2 = /* @__PURE__ */ dual(2, (self, onError3) => fromBuildUnsafe((memoMap, scope3) => catch_(self.build(memoMap, scope3), (e) => onError3(e).build(memoMap, scope3))));
var catchTag2 = /* @__PURE__ */ dual(3, (self, k, f) => fromBuildUnsafe((memoMap, scope3) => catchTag(self.build(memoMap, scope3), k, (error) => f(error).build(memoMap, scope3))));
var catchCause2 = /* @__PURE__ */ dual(2, (self, onError3) => fromBuildUnsafe((memoMap, scope3) => catchCause(self.build(memoMap, scope3), (cause) => onError3(cause).build(memoMap, scope3))));
var updateService2 = /* @__PURE__ */ dual(3, (layer, service3, f) => provide2(layer, effect(service3, map2(service3, f))));
var fresh = (self) => fromBuildUnsafe((_, scope3) => self.build(makeMemoMapUnsafe(), scope3));
var launch = (self) => scoped(andThen2(build(self), never));
var mock = function() {
  if (arguments.length === 1) {
    return (implementation) => mockImpl(arguments[0], implementation);
  }
  return mockImpl(arguments[0], arguments[1]);
};
var mockImpl = (service3, implementation) => succeed5(service3)(new Proxy({
  ...implementation
}, {
  get(target, prop, _receiver) {
    if (prop in target) {
      return target[prop];
    }
    const prevLimit = getStackTraceLimit();
    setStackTraceLimit(2);
    const error = new Error(`${service3.key}: Unimplemented method "${prop.toString()}"`);
    setStackTraceLimit(prevLimit);
    error.name = "UnimplementedError";
    return makeUnimplemented(error);
  },
  has: constTrue
}));
var makeUnimplemented = (error) => {
  const dead = Object.assign(die(error), {
    [StreamTypeId]: StreamTypeId,
    channel: {
      [ChannelTypeId]: ChannelTypeId,
      transform: () => succeed3(dead),
      pipe() {
        return pipeArguments(this, arguments);
      }
    },
    [ChannelTypeId]: ChannelTypeId,
    transform: () => succeed3(dead)
  });
  function unimplemented() {
    return dead;
  }
  Object.assign(unimplemented, dead);
  Object.setPrototypeOf(unimplemented, Object.getPrototypeOf(dead));
  return unimplemented;
};
var StreamTypeId = "~effect/Stream";
var ChannelTypeId = "~effect/Channel";
var satisfiesSuccessType = () => (layer) => layer;
var satisfiesErrorType = () => (layer) => layer;
var satisfiesServicesType = () => (layer) => layer;
var span = (name, options) => {
  options = addSpanStackTrace(options);
  return effect(ParentSpan, options?.onEnd ? tap2(makeSpanScoped(name, options), (span2) => addFinalizer((exit3) => options.onEnd(span2, exit3))) : makeSpanScoped(name, options));
};
var parentSpan = (span2) => succeedContext(ParentSpan.context(span2));
var withSpan2 = function() {
  const dataFirst = typeof arguments[0] !== "string";
  const name = dataFirst ? arguments[1] : arguments[0];
  const options = addSpanStackTrace(dataFirst ? arguments[2] : arguments[1]);
  if (dataFirst) {
    const self = arguments[0];
    return unwrap(map2(options?.onEnd !== void 0 ? tap2(makeSpanScoped(name, options), (span2) => addFinalizer((exit3) => options.onEnd(span2, exit3))) : makeSpanScoped(name, options), (span2) => withParentSpan2(self, span2, options)));
  }
  return (self) => unwrap(map2(options?.onEnd !== void 0 ? tap2(makeSpanScoped(name, options), (span2) => addFinalizer((exit3) => options.onEnd(span2, exit3))) : makeSpanScoped(name, options), (span2) => withParentSpan2(self, span2, options)));
};
var withParentSpan2 = function() {
  const dataFirst = isLayer(arguments[0]);
  const span2 = dataFirst ? arguments[1] : arguments[0];
  let options = dataFirst ? arguments[2] : arguments[1];
  let provideStackFrame = identity;
  if (span2._tag === "Span") {
    options = addSpanStackTrace(options);
    provideStackFrame = provideSpanStackFrame2(span2.name, options?.captureStackTrace);
  }
  const parentSpanLayer = parentSpan(span2);
  if (dataFirst) {
    return provide2(provideStackFrame(arguments[0]), parentSpanLayer);
  }
  return (self) => provide2(provideStackFrame(self), parentSpanLayer);
};
var provideSpanStackFrame2 = (name, stack) => {
  stack = typeof stack === "function" ? stack : constUndefined;
  return updateService2(CurrentStackFrame2, (parent) => ({
    name,
    stack,
    parent
  }));
};

// ops/node_modules/effect/dist/ExecutionPlan.js
var TypeId8 = "~effect/ExecutionPlan";
var Proto2 = {
  [TypeId8]: TypeId8,
  get captureRequirements() {
    const self = this;
    return contextWith((context3) => succeed3(makeProto(self.steps.map((step) => ({
      ...step,
      while: step.while ? (input) => provideContext(step.while(input), context3) : void 0,
      provide: isLayer(step.provide) ? provide2(step.provide, succeedContext(context3)) : step.provide
    })))));
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var makeProto = (steps) => {
  const self = Object.create(Proto2);
  self.steps = steps;
  return self;
};
var CurrentMetadata = /* @__PURE__ */ Reference("effect/ExecutionPlan/CurrentMetadata", {
  defaultValue: /* @__PURE__ */ constant({
    attempt: 0,
    stepIndex: 0
  })
});

// ops/node_modules/effect/dist/Pull.js
var catchDone = /* @__PURE__ */ dual(2, (effect2, f) => catchCauseFilter(effect2, filterDoneLeftover, (l) => f(l)));
var isDoneFailure = (failure) => failure._tag === "Fail" && isDone2(failure.error);
var filterDone = (cause) => {
  let done4;
  let hasFailure = false;
  for (const reason of cause.reasons) {
    if (isDoneFailure(reason)) {
      done4 ??= reason.error;
    } else if (reason._tag !== "Interrupt") {
      hasFailure = true;
    }
  }
  if (done4 === void 0) return fail2(cause);
  return hasFailure ? fail2(fromReasons(cause.reasons.filter((reason) => !isDoneFailure(reason)))) : succeed2(done4);
};
var filterDoneLeftover = (cause) => {
  const done4 = filterDone(cause);
  return isFailure2(done4) ? done4 : succeed2(done4.success.value);
};
var matchEffect2 = /* @__PURE__ */ dual(2, (self, options) => matchCauseEffect(self, {
  onSuccess: options.onSuccess,
  onFailure: (cause) => {
    const halt = filterDone(cause);
    return !isFailure2(halt) ? options.onDone(halt.success.value) : options.onFailure(halt.failure);
  }
}));

// ops/node_modules/effect/dist/Schedule.js
var TypeId9 = "~effect/Schedule";
var CurrentMetadata2 = /* @__PURE__ */ Reference("effect/Schedule/CurrentMetadata", {
  defaultValue: /* @__PURE__ */ constant({
    input: void 0,
    output: void 0,
    duration: zero,
    attempt: 0,
    start: 0,
    now: 0,
    elapsed: 0,
    elapsedSincePrevious: 0
  })
});
var ScheduleProto = {
  [TypeId9]: {
    _Out: identity,
    _In: identity,
    _Env: identity
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var isSchedule = (u) => hasProperty(u, TypeId9);
var fromStep = (step) => {
  const self = Object.create(ScheduleProto);
  self.step = step;
  return self;
};
var metadataFn = () => {
  let n = 0;
  let previous;
  let start;
  return (now, input) => {
    if (start === void 0) start = now;
    const elapsed = now - start;
    const elapsedSincePrevious = previous === void 0 ? 0 : now - previous;
    previous = now;
    return {
      input,
      attempt: ++n,
      start,
      now,
      elapsed,
      elapsedSincePrevious
    };
  };
};
var fromStepWithMetadata = (step) => fromStep(map2(step, (f) => {
  const meta = metadataFn();
  return (now, input) => f(meta(now, input));
}));
var toStep = (schedule2) => catchCause(schedule2.step, (cause) => succeed3(() => failCause(cause)));
var toStepWithMetadata = (schedule2) => clockWith((clock) => map2(toStep(schedule2), (step) => {
  const metaFn = metadataFn();
  return (input) => suspend(() => {
    const now = clock.currentTimeMillisUnsafe();
    return flatMap2(step(now, input), ([output, duration]) => {
      const meta = metaFn(now, input);
      meta.output = output;
      meta.duration = duration;
      return as(sleep(duration), meta);
    });
  });
}));
var passthrough = (self) => fromStep(map2(toStep(self), (step) => (now, input) => matchEffect2(step(now, input), {
  onSuccess: (result3) => succeed3([input, result3[1]]),
  onFailure: failCause,
  onDone: () => done2(input)
})));
var recurs = (times) => while_(forever2, ({
  attempt
}) => succeed3(attempt <= times));
var spaced = (duration) => {
  const decoded = fromInputUnsafe(duration);
  return fromStepWithMetadata(succeed3((meta) => succeed3([meta.attempt - 1, decoded])));
};
var while_ = /* @__PURE__ */ dual(2, (self, predicate) => fromStep(map2(toStep(self), (step) => {
  const meta = metadataFn();
  return (now, input) => flatMap2(step(now, input), (result3) => {
    const [output, duration] = result3;
    const eff = predicate({
      ...meta(now, input),
      output,
      duration
    });
    return flatMap2(isEffect(eff) ? eff : succeed3(eff), (check) => check ? succeed3(result3) : done2(output));
  });
})));
var forever2 = /* @__PURE__ */ spaced(zero);

// ops/node_modules/effect/dist/internal/layer.js
var provideLayer = (self, layer, options) => scopedWith((scope3) => flatMap2(options?.local ? buildWithMemoMap(layer, makeMemoMapUnsafe(), scope3) : buildWithScope(layer, scope3), (context3) => provideContext(self, context3)));
var provide3 = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, source, options) => isContext(source) ? provideContext(self, source) : provideLayer(self, Array.isArray(source) ? mergeAll2(...source) : source, options));

// ops/node_modules/effect/dist/internal/schedule.js
var repeatOrElse = /* @__PURE__ */ dual(3, (self, schedule2, orElse2) => flatMap2(toStepWithMetadata(schedule2), (step) => {
  let meta = CurrentMetadata2.defaultValue();
  return catch_(forever(tap2(flatMap2(suspend(() => provideService(self, CurrentMetadata2, meta)), step), (meta_) => sync(() => {
    meta = meta_;
  })), {
    disableYield: true
  }), (error) => isDone(error) ? succeed3(error.value) : orElse2(error, meta.attempt === 0 ? none2() : some2(meta)));
}));
var retryOrElse = /* @__PURE__ */ dual(3, (self, policy, orElse2) => flatMap2(toStepWithMetadata(policy), (step) => {
  let meta = CurrentMetadata2.defaultValue();
  let lastError;
  const loop = catch_(suspend(() => provideService(self, CurrentMetadata2, meta)), (error) => {
    lastError = error;
    return flatMap2(step(error), (meta_) => {
      meta = meta_;
      return loop;
    });
  });
  return catchDone(loop, (out) => internalCall(() => orElse2(lastError, out)));
}));
var repeat = /* @__PURE__ */ dual(2, (self, options) => {
  const schedule2 = typeof options === "function" ? options(identity) : isSchedule(options) ? options : buildFromOptions(options);
  return repeatOrElse(self, schedule2, fail3);
});
var retry = /* @__PURE__ */ dual(2, (self, options) => {
  const schedule2 = typeof options === "function" ? options(identity) : isSchedule(options) ? options : buildFromOptions(options);
  return retryOrElse(self, schedule2, fail3);
});
var scheduleFrom = /* @__PURE__ */ dual(3, (self, initial, schedule2) => flatMap2(toStepWithMetadata(schedule2), (step) => {
  let meta = CurrentMetadata2.defaultValue();
  const selfWithMeta = suspend(() => provideService(self, CurrentMetadata2, meta));
  return catch_(flatMap2(step(initial), (meta_) => {
    meta = meta_;
    const body = constant(flatMap2(selfWithMeta, step));
    return whileLoop({
      while: constTrue,
      body,
      step(meta_2) {
        meta = meta_2;
      }
    });
  }), (error) => isDone(error) ? succeed3(error.value) : fail3(error));
}));
var passthroughForever = /* @__PURE__ */ passthrough(forever2);
var buildFromOptions = (options) => {
  let schedule2 = options.schedule ? passthrough(options.schedule) : passthroughForever;
  if (options.while) {
    schedule2 = while_(schedule2, ({
      input
    }) => {
      const applied = options.while(input);
      return isEffect(applied) ? applied : succeed3(applied);
    });
  }
  if (options.until) {
    schedule2 = while_(schedule2, ({
      input
    }) => {
      const applied = options.until(input);
      return isEffect(applied) ? map2(applied, (b) => !b) : succeed3(!applied);
    });
  }
  if (options.times !== void 0) {
    schedule2 = while_(schedule2, ({
      attempt
    }) => succeed3(attempt <= options.times));
  }
  return schedule2;
};

// ops/node_modules/effect/dist/internal/executionPlan.js
var makeEventEmitter = (onEvent, currentMetadata) => {
  let lastStepIndex = -1;
  let stepAttempt = 0;
  const emit = (event) => ignoreCause(onEvent(event));
  return {
    begin: clockWith((clock) => suspend(() => {
      const meta = currentMetadata();
      if (meta.stepIndex !== lastStepIndex) {
        lastStepIndex = meta.stepIndex;
        stepAttempt = 0;
      }
      stepAttempt++;
      const state = {
        attempt: meta.attempt,
        stepAttempt,
        stepIndex: meta.stepIndex,
        startNanos: clock.monotonicTimeNanosUnsafe()
      };
      return as(emit({
        _tag: "AttemptStart",
        attempt: state.attempt,
        stepAttempt: state.stepAttempt,
        stepIndex: state.stepIndex
      }), state);
    })),
    end: (state, exit3) => clockWith((clock) => {
      const duration = nanos(clock.monotonicTimeNanosUnsafe() - state.startNanos);
      return emit(exit3._tag === "Success" ? {
        _tag: "AttemptSuccess",
        attempt: state.attempt,
        stepAttempt: state.stepAttempt,
        stepIndex: state.stepIndex,
        duration
      } : {
        _tag: "AttemptFailure",
        attempt: state.attempt,
        stepAttempt: state.stepAttempt,
        stepIndex: state.stepIndex,
        duration,
        cause: exit3.cause
      });
    })
  };
};
var withExecutionPlan = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (self, plan, options) => suspend(() => {
  let i = 0;
  let meta = {
    attempt: 0,
    stepIndex: 0
  };
  const provideMeta = provideServiceEffect(CurrentMetadata, sync(() => {
    meta = {
      attempt: meta.attempt + 1,
      stepIndex: i
    };
    return meta;
  }));
  const emitter = options?.onEvent === void 0 ? void 0 : makeEventEmitter(options.onEvent, () => meta);
  const instrument = emitter === void 0 ? identity : (attempt) => uninterruptibleMask((restore) => flatMap2(emitter.begin, (state) => onExit(restore(attempt), (exit3) => emitter.end(state, exit3))));
  let result3;
  return flatMap2(whileLoop({
    while: () => i < plan.steps.length && (result3 === void 0 || isFailure2(result3)),
    body() {
      const step = plan.steps[i];
      let nextEffect = provideMeta(instrument(provide3(self, step.provide)));
      if (result3) {
        let attempted = false;
        const wrapped = nextEffect;
        nextEffect = suspend(() => {
          if (attempted) return wrapped;
          attempted = true;
          return fromResult(result3);
        });
        nextEffect = retry(nextEffect, scheduleFromStep(step, false));
      } else {
        const schedule2 = scheduleFromStep(step, true);
        nextEffect = schedule2 ? retry(nextEffect, schedule2) : nextEffect;
      }
      return result(nextEffect);
    },
    step(result_) {
      result3 = result_;
      i++;
    }
  }), () => fromResult(result3));
}));
var scheduleFromStep = (step, first) => {
  if (!first) {
    return buildFromOptions({
      schedule: step.schedule ? step.schedule : step.attempts ? void 0 : scheduleOnce,
      times: step.attempts,
      while: step.while
    });
  } else if (step.attempts === 1 || !(step.schedule || step.attempts)) {
    return void 0;
  }
  return buildFromOptions({
    schedule: step.schedule,
    while: step.while,
    times: step.attempts ? step.attempts - 1 : void 0
  });
};
var scheduleOnce = /* @__PURE__ */ recurs(1);

// ops/node_modules/effect/dist/Request.js
var TypeId10 = "~effect/Request";
var requestVariance = /* @__PURE__ */ byReferenceUnsafe({
  /* c8 ignore next */
  _E: (_) => _,
  /* c8 ignore next */
  _A: (_) => _,
  /* c8 ignore next */
  _R: (_) => _
});
var RequestPrototype = {
  ...StructuralProto,
  [TypeId10]: requestVariance
};
var makeEntry = (options) => options;

// ops/node_modules/effect/dist/internal/request.js
var request = /* @__PURE__ */ dual(2, (self, resolver) => {
  const withResolver = (resolver2) => callback((resume) => {
    const entry = addEntry(resolver2, self, resume, getCurrentFiber());
    return maybeRemoveEntry(resolver2, entry);
  });
  return isEffect(resolver) ? flatMap2(resolver, withResolver) : withResolver(resolver);
});
var requestUnsafe = (self, options) => {
  const entry = addEntry(options.resolver, self, options.onExit, {
    context: options.context,
    cache: {
      scheduler: get(options.context, Scheduler)
    }
  });
  return () => removeEntryUnsafe(options.resolver, entry);
};
var batchPool = [];
var pendingBatches = /* @__PURE__ */ new WeakMap();
var addEntry = (resolver, request3, resume, fiber3) => {
  let batchMap = pendingBatches.get(resolver);
  if (!batchMap) {
    batchMap = /* @__PURE__ */ new Map();
    pendingBatches.set(resolver, batchMap);
  }
  let batch;
  let completed = false;
  const entry = makeEntry({
    request: request3,
    context: fiber3.context,
    uninterruptible: false,
    completeUnsafe(effect2) {
      if (completed) return;
      completed = true;
      if (batch && !batch.entrySet.delete(entry)) return;
      resume(effect2);
    }
  });
  if (resolver.preCheck !== void 0 && !resolver.preCheck(entry)) {
    return entry;
  }
  const key = resolver.batchKey(entry);
  batch = batchMap.get(key);
  if (!batch) {
    if (batchPool.length > 0) {
      batch = batchPool.pop();
      batch.key = key;
      batch.resolver = resolver;
      batch.map = batchMap;
    } else {
      const newBatch = {
        key,
        resolver,
        map: batchMap,
        entrySet: /* @__PURE__ */ new Set(),
        entries: /* @__PURE__ */ new Set(),
        delayEffect: flatMap2(suspend(() => newBatch.resolver.delay), (_) => runBatch(newBatch)),
        run: onExit(suspend(() => newBatch.resolver.runAll(Array.from(newBatch.entries), newBatch.key)), (exit3) => {
          for (const entry2 of newBatch.entrySet) {
            entry2.completeUnsafe(exit3._tag === "Success" ? exitDie(new Error("Effect.request: RequestResolver did not complete request", {
              cause: entry2.request
            })) : exit3);
          }
          newBatch.entries.clear();
          if (batchPool.length < 128) {
            newBatch.entrySet.clear();
            newBatch.key = void 0;
            newBatch.fiber = void 0;
            newBatch.resolver = void 0;
            newBatch.map = void 0;
            batchPool.push(newBatch);
          }
          return void_2;
        })
      };
      batch = newBatch;
    }
    batchMap.set(key, batch);
    batch.fiber = runForkWith(fiber3.context)(batch.delayEffect, {
      scheduler: fiber3.cache.scheduler
    });
  }
  batch.entrySet.add(entry);
  batch.entries.add(entry);
  if (batch.resolver.collectWhile(batch.entries)) return entry;
  batch.fiber.interruptUnsafe(fiber3.id);
  batch.fiber = runForkWith(fiber3.context)(runBatch(batch), {
    scheduler: fiber3.cache.scheduler
  });
  return entry;
};
var removeEntryUnsafe = (resolver, entry) => {
  if (entry.uninterruptible) return;
  const batchMap = pendingBatches.get(resolver);
  if (!batchMap) return;
  const key = resolver.batchKey(entry);
  const batch = batchMap.get(key);
  if (!batch) return;
  if (!batch.entries.delete(entry)) return;
  batch.entrySet.delete(entry);
  let fiber3;
  if (batch.entries.size === 0) {
    batchMap.delete(key);
    fiber3 = batch.fiber;
  }
  entry.completeUnsafe(exitInterrupt());
  fiber3?.interruptUnsafe();
};
var maybeRemoveEntry = (resolver, entry) => sync(() => removeEntryUnsafe(resolver, entry));
function runBatch(batch) {
  if (!batch.map.has(batch.key)) return void_2;
  batch.map.delete(batch.key);
  return batch.run;
}

// ops/node_modules/effect/dist/Metric.js
var CurrentMetricAttributesKey = "effect/Metric/CurrentMetricAttributes";
var CurrentMetricAttributes = /* @__PURE__ */ Reference(CurrentMetricAttributesKey, {
  defaultValue: () => ({})
});
var MetricRegistryKey = "effect/Metric/MetricRegistry";
var MetricRegistry = /* @__PURE__ */ Reference(MetricRegistryKey, {
  defaultValue: () => /* @__PURE__ */ new Map()
});
var TypeId11 = "~effect/Metric";
var Metric$ = class {
  [TypeId11] = TypeId11;
  #metadata = /* @__PURE__ */ new WeakMap();
  id;
  description;
  attributes;
  constructor(id, description, attributes) {
    this.id = id;
    this.description = description;
    this.attributes = attributes;
  }
  valueUnsafe(context3) {
    return this.hook(context3).get(context3);
  }
  modifyUnsafe(input, context3) {
    return this.hook(context3).modify(input, context3);
  }
  updateUnsafe(input, context3) {
    return this.hook(context3).update(input, context3);
  }
  hook(context3) {
    const extraAttributes = get(context3, CurrentMetricAttributes);
    if (Object.keys(extraAttributes).length > 0) {
      return this.getOrCreate(context3, mergeAttributes(this.attributes, extraAttributes)).hooks;
    }
    const registry = get(context3, MetricRegistry);
    let metadata = this.#metadata.get(registry);
    if (isUndefined(metadata)) {
      metadata = this.getOrCreate(context3, this.attributes);
      this.#metadata.set(registry, metadata);
    }
    return metadata.hooks;
  }
  getOrCreate(context3, attributes) {
    const key = makeKey(this, attributes);
    const registry = get(context3, MetricRegistry);
    if (registry.has(key)) {
      return registry.get(key);
    }
    const hooks = this.createHooks();
    const meta = {
      id: this.id,
      type: this.type,
      description: this.description,
      attributes: attributesToRecord(attributes),
      hooks
    };
    registry.set(key, meta);
    return meta;
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var update = /* @__PURE__ */ dual(2, (self, input) => contextWith((services) => sync(() => self.updateUnsafe(input, services))));
function makeKey(metric, attributes) {
  let key = `${metric.type}:${metric.id}`;
  if (isNotUndefined(metric.description)) {
    key += `:${metric.description}`;
  }
  if (isNotUndefined(attributes)) {
    key += `:${serializeAttributes(attributes)}`;
  }
  return key;
}
function serializeAttributes(attributes) {
  const entries = Array.isArray(attributes) ? [...attributes] : Object.entries(attributes);
  entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return JSON.stringify(entries);
}
function mergeAttributes(self, other) {
  return {
    ...attributesToRecord(self),
    ...attributesToRecord(other)
  };
}
function attributesToRecord(attributes) {
  if (isNotUndefined(attributes) && Array.isArray(attributes)) {
    return attributes.reduce((acc, [key, value]) => {
      assignProperty(acc, key, value);
      return acc;
    }, {});
  }
  return attributes;
}

// ops/node_modules/effect/dist/Effect.js
var TypeId12 = EffectTypeId;
var isEffect2 = isEffect;
var all3 = all2;
var partition3 = partition2;
var reduce2 = reduce;
var validate2 = validate;
var findFirst2 = findFirst;
var findFirstFilter2 = findFirstFilter;
var forEach2 = forEach;
var head2 = head;
var whileLoop2 = whileLoop;
var promise2 = promise;
var tryPromise2 = tryPromise;
var succeed6 = succeed3;
var succeedNone3 = succeedNone2;
var succeedSome3 = succeedSome2;
var suspend3 = suspend;
var sync3 = sync;
var void_4 = void_2;
var undefined_2 = undefined_;
var callback2 = callback;
var never2 = never;
var Do3 = Do2;
var bindTo4 = bindTo3;
var let_4 = let_3;
var bind4 = bind3;
var gen3 = gen2;
var fail6 = fail3;
var failSync2 = failSync;
var failCause3 = failCause;
var failCauseSync2 = failCauseSync;
var die4 = die;
var try_3 = try_2;
var yieldNow2 = yieldNow;
var yieldNowWith2 = yieldNowWith;
var withFiber2 = withFiber;
var withFiberSucceed2 = withFiberSucceed;
var fromResult2 = fromResult;
var fromOption4 = fromOption3;
var transposeOption3 = transposeOption2;
var fromNullishOr3 = fromNullishOr2;
var flatMap4 = flatMap2;
var flatten3 = flatten2;
var andThen3 = andThen2;
var tap4 = tap2;
var result2 = result;
var option2 = option;
var exit2 = exit;
var map5 = map2;
var as2 = as;
var asSome2 = asSome;
var asVoid3 = asVoid;
var flip3 = flip2;
var zip2 = zip;
var zipWith2 = zipWith;
var catch_3 = catch_;
var catchTag3 = catchTag;
var catchTags2 = catchTags;
var catchReason2 = catchReason;
var catchReasons2 = catchReasons;
var unwrapReason2 = unwrapReason;
var catchCause3 = catchCause;
var catchDefect2 = catchDefect;
var catchIf2 = catchIf;
var catchFilter2 = catchFilter;
var catchNoSuchElement2 = catchNoSuchElement;
var catchCauseIf2 = catchCauseIf;
var catchCauseFilter2 = catchCauseFilter;
var mapError4 = mapError2;
var mapBoth4 = mapBoth2;
var orDie3 = orDie;
var tapError3 = tapError;
var tapErrorTag2 = tapErrorTag;
var tapCause3 = tapCause;
var tapCauseIf2 = tapCauseIf;
var tapCauseFilter2 = tapCauseFilter;
var tapDefect2 = tapDefect;
var eventually2 = eventually;
var retry2 = retry;
var retryOrElse2 = retryOrElse;
var sandbox2 = sandbox;
var ignore2 = ignore;
var ignoreCause2 = ignoreCause;
var withExecutionPlan2 = withExecutionPlan;
var withErrorReporting2 = withErrorReporting;
var orElseSucceed2 = orElseSucceed;
var firstSuccessOf2 = firstSuccessOf;
var timeout2 = timeout;
var timeoutOption2 = timeoutOption;
var timeoutOrElse2 = timeoutOrElse;
var delay2 = delay;
var sleep2 = sleep;
var timed2 = timed;
var raceAll2 = raceAll;
var raceAllFirst2 = raceAllFirst;
var race2 = race;
var raceFirst2 = raceFirst;
var filter3 = filter2;
var filterMap2 = filterMap;
var filterMapEffect2 = filterMapEffect;
var filterOrElse2 = filterOrElse;
var filterMapOrElse2 = filterMapOrElse;
var filterOrFail3 = filterOrFail2;
var filterMapOrFail2 = filterMapOrFail;
var when2 = when;
var match5 = match3;
var matchEager2 = matchEager;
var matchCause2 = matchCause;
var matchCauseEager2 = matchCauseEager;
var matchCauseEffectEager2 = matchCauseEffectEager;
var matchCauseEffect2 = matchCauseEffect;
var matchEffect3 = matchEffect;
var isFailure5 = isFailure3;
var isSuccess5 = isSuccess3;
var context2 = context;
var contextWith2 = contextWith;
var provide4 = provide3;
var provideContext2 = provideContext;
var setContext2 = setContext;
var service2 = service;
var serviceOption2 = serviceOption;
var updateContext2 = updateContext;
var updateService3 = updateService;
var updateServiceScoped2 = updateServiceScoped;
var provideService2 = provideService;
var provideServiceEffect2 = provideServiceEffect;
var scope2 = scope;
var scoped2 = scoped;
var scopedWith2 = scopedWith;
var acquireRelease2 = acquireRelease;
var acquireDisposable2 = acquireDisposable;
var acquireUseRelease2 = acquireUseRelease;
var addFinalizer2 = addFinalizer;
var ensuring2 = ensuring;
var onError2 = onError;
var onErrorIf2 = onErrorIf;
var onErrorFilter2 = onErrorFilter;
var onExitPrimitive2 = onExitPrimitive;
var onExit2 = onExit;
var onExitIf2 = onExitIf;
var onExitFilter2 = onExitFilter;
var cached2 = cached;
var cachedWithTTL2 = cachedWithTTL;
var cachedInvalidateWithTTL2 = cachedInvalidateWithTTL;
var interrupt4 = interrupt;
var interruptible2 = interruptible;
var onInterrupt2 = onInterrupt;
var uninterruptible2 = uninterruptible;
var uninterruptibleMask2 = uninterruptibleMask;
var interruptibleMask2 = interruptibleMask;
var abortSignal2 = abortSignal;
var forever3 = forever;
var repeat2 = repeat;
var repeatOrElse2 = repeatOrElse;
var replicate2 = replicate;
var replicateEffect2 = replicateEffect;
var schedule = /* @__PURE__ */ dual(2, (self, schedule2) => scheduleFrom2(self, void 0, schedule2));
var scheduleFrom2 = scheduleFrom;
var tracer2 = tracer;
var withTracer2 = withTracer;
var withTracerEnabled2 = withTracerEnabled;
var withTracerTiming2 = withTracerTiming;
var annotateSpans2 = annotateSpans;
var annotateCurrentSpan2 = annotateCurrentSpan;
var currentSpan2 = currentSpan;
var currentParentSpan2 = currentParentSpan;
var spanAnnotations2 = spanAnnotations;
var spanLinks2 = spanLinks;
var linkSpans2 = linkSpans;
var makeSpan2 = makeSpan;
var makeSpanScoped2 = makeSpanScoped;
var useSpan2 = useSpan;
var withSpan3 = withSpan;
var withSpanScoped2 = withSpanScoped;
var withParentSpan3 = withParentSpan;
var request2 = request;
var requestUnsafe2 = requestUnsafe;
var forkChild2 = forkChild;
var forkIn2 = forkIn;
var forkScoped2 = forkScoped;
var forkDetach2 = forkDetach;
var awaitAllChildren2 = awaitAllChildren;
var fiber2 = fiber;
var fiberId2 = fiberId;
var runFork2 = runFork;
var runForkWith2 = runForkWith;
var runCallbackWith2 = runCallbackWith;
var runCallback2 = runCallback;
var runPromise2 = runPromise;
var runPromiseWith2 = runPromiseWith;
var runPromiseExit2 = runPromiseExit;
var runPromiseExitWith2 = runPromiseExitWith;
var runSync2 = runSync;
var runSyncWith2 = runSyncWith;
var runSyncExit2 = runSyncExit;
var runSyncExitWith2 = runSyncExitWith;
var fnUntraced2 = fnUntraced;
var fn2 = fn;
var clockWith2 = clockWith;
var logWithLevel2 = logWithLevel;
var log = /* @__PURE__ */ logWithLevel();
var logFatal = /* @__PURE__ */ logWithLevel("Fatal");
var logWarning = /* @__PURE__ */ logWithLevel("Warn");
var logError = /* @__PURE__ */ logWithLevel("Error");
var logInfo = /* @__PURE__ */ logWithLevel("Info");
var logDebug = /* @__PURE__ */ logWithLevel("Debug");
var logTrace = /* @__PURE__ */ logWithLevel("Trace");
var withLogger = /* @__PURE__ */ dual(2, (effect2, logger) => updateService(effect2, CurrentLoggers, (loggers) => /* @__PURE__ */ new Set([...loggers, logger])));
var annotateLogs = /* @__PURE__ */ dual((args2) => isEffect2(args2[0]), (effect2, ...args2) => updateService(effect2, CurrentLogAnnotations2, (annotations2) => {
  const newAnnotations = args2.length === 1 ? {
    ...annotations2,
    ...args2[0]
  } : {
    ...annotations2
  };
  if (args2.length === 1) {
    return newAnnotations;
  } else {
    assignProperty(newAnnotations, args2[0], args2[1]);
  }
  return newAnnotations;
}));
var annotateLogsScoped2 = annotateLogsScoped;
var withLogSpan = /* @__PURE__ */ dual(2, (effect2, label) => flatMap2(currentTimeMillis, (now) => updateService(effect2, CurrentLogSpans2, (spans) => {
  const span2 = [label, now];
  return [span2, ...spans];
})));
var track = /* @__PURE__ */ dual((args2) => isEffect2(args2[0]), (self, metric, f) => onExit2(self, (exit3) => {
  const input = f === void 0 ? exit3 : internalCall(() => f(exit3));
  return update(metric, input);
}));
var trackSuccesses = /* @__PURE__ */ dual((args2) => isEffect2(args2[0]), (self, metric, f) => tap4(self, (value) => {
  const input = f === void 0 ? value : f(value);
  return update(metric, input);
}));
var trackErrors = /* @__PURE__ */ dual((args2) => isEffect2(args2[0]), (self, metric, f) => tapError3(self, (error) => {
  const input = f === void 0 ? error : internalCall(() => f(error));
  return update(metric, input);
}));
var trackDefects = /* @__PURE__ */ dual((args2) => isEffect2(args2[0]), (self, metric, f) => tapDefect2(self, (defect) => {
  const input = f === void 0 ? defect : internalCall(() => f(defect));
  return update(metric, input);
}));
var trackDuration = /* @__PURE__ */ dual((args2) => isEffect2(args2[0]), (self, metric, f) => clockWith2((clock) => {
  const startTime = clock.monotonicTimeNanosUnsafe();
  return onExit2(self, () => {
    const endTime = clock.monotonicTimeNanosUnsafe();
    const duration = subtract(fromInputUnsafe(endTime), fromInputUnsafe(startTime));
    const input = f === void 0 ? duration : internalCall(() => f(duration));
    return update(metric, input);
  });
}));
var Transaction = class extends (/* @__PURE__ */ Service()("effect/Effect/Transaction")) {
};
var tx = (effect2) => withFiber2((fiber3) => {
  let state = getOrUndefined3(fiber3.context, Transaction);
  if (state) {
    return effect2;
  }
  state = {
    journal: /* @__PURE__ */ new Map(),
    retry: false
  };
  let result3;
  return uninterruptibleMask2((restore) => flatMap4(whileLoop2({
    while: () => !result3,
    body: constant(restore(effect2).pipe(provideService2(Transaction, state), tapCause3(() => {
      if (!state.retry) return void_4;
      return restore(awaitPendingTransaction(state));
    }), exit2)),
    step(exit3) {
      if (state.retry || !isTransactionConsistent(state)) {
        return clearTransaction(state);
      }
      if (isSuccess4(exit3)) {
        commitTransaction(fiber3, state);
      } else {
        clearTransaction(state);
      }
      result3 = exit3;
    }
  }), () => result3));
});
var isTransactionConsistent = (state) => {
  for (const [ref, {
    version
  }] of state.journal) {
    if (ref.version !== version) {
      return false;
    }
  }
  return true;
};
var awaitPendingTransaction = (state) => suspend3(() => {
  const key = {};
  const refs = Array.from(state.journal.keys());
  const clearPending = () => {
    for (const clear of refs) {
      clear.pending.delete(key);
    }
  };
  return callback2((resume) => {
    const onCall = () => {
      clearPending();
      resume(void_4);
    };
    for (const ref of refs) {
      ref.pending.set(key, onCall);
    }
    return sync3(clearPending);
  });
});
function commitTransaction(fiber3, state) {
  for (const [ref, {
    value
  }] of state.journal) {
    if (value !== ref.value) {
      ref.version = ref.version + 1;
      ref.value = value;
    }
    for (const pending of ref.pending.values()) {
      fiber3.currentDispatcher.scheduleTask(pending, 0);
    }
    ref.pending.clear();
  }
}
function clearTransaction(state) {
  state.retry = false;
  state.journal.clear();
}
var txRetry = /* @__PURE__ */ flatMap4(Transaction, (state) => {
  state.retry = true;
  return interrupt4;
});
var effectify = (fn3, onError3, onSyncError) => (...args2) => callback2((resume) => {
  try {
    fn3(...args2, (err, result3) => {
      if (err) {
        resume(fail6(onError3 ? onError3(err, args2) : err));
      } else {
        resume(succeed6(result3));
      }
    });
  } catch (err) {
    resume(onSyncError ? fail6(onSyncError(err, args2)) : die4(err));
  }
});
var satisfiesSuccessType2 = () => (effect2) => effect2;
var satisfiesErrorType2 = () => (effect2) => effect2;
var satisfiesServicesType2 = () => (effect2) => effect2;
var mapEager2 = mapEager;
var mapErrorEager2 = mapErrorEager;
var mapBothEager2 = mapBothEager;
var flatMapEager2 = flatMapEager;
var catchEager2 = catchEager;
var fnUntracedEager2 = fnUntracedEager;

// ops/node_modules/effect/dist/Fiber.js
var await_ = fiberAwait;
var runIn = fiberRunIn;

// ops/node_modules/effect/dist/ManagedRuntime.js
var ManagedRuntime_exports = {};
__export(ManagedRuntime_exports, {
  isManagedRuntime: () => isManagedRuntime,
  make: () => make6
});
var TypeId13 = "~effect/ManagedRuntime";
var isManagedRuntime = (input) => hasProperty(input, TypeId13);
var make6 = (layer, options) => {
  const memoMap = options?.memoMap ?? makeMemoMapUnsafe();
  const scope3 = makeUnsafe3("parallel");
  const layerScope = forkUnsafe2(scope3, "sequential");
  const defaultRunOptions = {
    onFiberStart: runIn(scope3)
  };
  const mergeRunOptions = (options2) => options2 ? {
    ...options2,
    onFiberStart: options2.onFiberStart ? (fiber3) => {
      defaultRunOptions.onFiberStart(fiber3);
      options2.onFiberStart(fiber3);
    } : defaultRunOptions.onFiberStart
  } : defaultRunOptions;
  let buildFiber;
  const contextEffect = withFiber2((fiber3) => {
    if (!buildFiber) {
      buildFiber = runFork2(tap4(buildWithMemoMap(layer, memoMap, layerScope), (context3) => sync3(() => {
        self.cachedContext = context3;
      })), {
        ...defaultRunOptions,
        scheduler: fiber3.cache.scheduler
      });
    }
    return flatten3(await_(buildFiber));
  });
  const self = {
    [TypeId13]: TypeId13,
    memoMap,
    scope: scope3,
    contextEffect,
    cachedContext: void 0,
    context() {
      return self.cachedContext === void 0 ? runPromise2(self.contextEffect) : Promise.resolve(self.cachedContext);
    },
    dispose() {
      return runPromise2(self.disposeEffect);
    },
    [Symbol.asyncDispose]() {
      return self.dispose();
    },
    disposeEffect: suspend3(() => {
      ;
      self.contextEffect = die4("ManagedRuntime disposed");
      self.cachedContext = void 0;
      return close(self.scope, void_3);
    }),
    runFork(effect2, options2) {
      return self.cachedContext === void 0 ? runFork2(provide5(self, effect2), mergeRunOptions(options2)) : runForkWith2(self.cachedContext)(effect2, mergeRunOptions(options2));
    },
    runCallback(effect2, options2) {
      return self.cachedContext === void 0 ? runCallback2(provide5(self, effect2), mergeRunOptions(options2)) : runCallbackWith2(self.cachedContext)(effect2, mergeRunOptions(options2));
    },
    runSyncExit(effect2) {
      return self.cachedContext === void 0 ? runSyncExit2(provide5(self, effect2)) : runSyncExitWith2(self.cachedContext)(effect2);
    },
    runSync(effect2) {
      return self.cachedContext === void 0 ? runSync2(provide5(self, effect2)) : runSyncWith2(self.cachedContext)(effect2);
    },
    runPromiseExit(effect2, options2) {
      return self.cachedContext === void 0 ? runPromiseExit2(provide5(self, effect2), mergeRunOptions(options2)) : runPromiseExitWith2(self.cachedContext)(effect2, mergeRunOptions(options2));
    },
    runPromise(effect2, options2) {
      return self.cachedContext === void 0 ? runPromise2(provide5(self, effect2), mergeRunOptions(options2)) : runPromiseWith2(self.cachedContext)(effect2, mergeRunOptions(options2));
    }
  };
  return self;
};
function provide5(managed, effect2) {
  return flatMap4(managed.contextEffect, (context3) => provideContext2(effect2, context3));
}

// ops/node_modules/balanced-match/dist/esm/index.js
var balanced = (a, b, str) => {
  const ma = a instanceof RegExp ? maybeMatch(a, str) : a;
  const mb = b instanceof RegExp ? maybeMatch(b, str) : b;
  const r = ma !== null && mb != null && range(ma, mb, str);
  return r && {
    start: r[0],
    end: r[1],
    pre: str.slice(0, r[0]),
    body: str.slice(r[0] + ma.length, r[1]),
    post: str.slice(r[1] + mb.length)
  };
};
var maybeMatch = (reg, str) => {
  const m = str.match(reg);
  return m ? m[0] : null;
};
var range = (a, b, str) => {
  let begs, beg, left, right = void 0, result3;
  let ai = str.indexOf(a);
  let bi = str.indexOf(b, ai + 1);
  let i = ai;
  if (ai >= 0 && bi > 0) {
    if (a === b) {
      return [ai, bi];
    }
    begs = [];
    left = str.length;
    while (i >= 0 && !result3) {
      if (i === ai) {
        begs.push(i);
        ai = str.indexOf(a, i + 1);
      } else if (begs.length === 1) {
        const r = begs.pop();
        if (r !== void 0)
          result3 = [r, bi];
      } else {
        beg = begs.pop();
        if (beg !== void 0 && beg < left) {
          left = beg;
          right = bi;
        }
        bi = str.indexOf(b, i + 1);
      }
      i = ai < bi && ai >= 0 ? ai : bi;
    }
    if (begs.length && right !== void 0) {
      result3 = [left, right];
    }
  }
  return result3;
};

// ops/node_modules/brace-expansion/dist/esm/index.js
var escSlash = "\0SLASH" + Math.random() + "\0";
var escOpen = "\0OPEN" + Math.random() + "\0";
var escClose = "\0CLOSE" + Math.random() + "\0";
var escComma = "\0COMMA" + Math.random() + "\0";
var escPeriod = "\0PERIOD" + Math.random() + "\0";
var escSlashPattern = new RegExp(escSlash, "g");
var escOpenPattern = new RegExp(escOpen, "g");
var escClosePattern = new RegExp(escClose, "g");
var escCommaPattern = new RegExp(escComma, "g");
var escPeriodPattern = new RegExp(escPeriod, "g");
var slashPattern = /\\\\/g;
var openPattern = /\\{/g;
var closePattern = /\\}/g;
var commaPattern = /\\,/g;
var periodPattern = /\\\./g;
var EXPANSION_MAX = 1e5;
var EXPANSION_MAX_LENGTH = 4e6;
var EXPANSION_MAX_DEPTH = 1e3;
var EXPANSION_MAX_REWRITES = 1e3;
function numeric(str) {
  return !isNaN(str) ? parseInt(str, 10) : str.charCodeAt(0);
}
function escapeBraces(str) {
  return str.replace(slashPattern, escSlash).replace(openPattern, escOpen).replace(closePattern, escClose).replace(commaPattern, escComma).replace(periodPattern, escPeriod);
}
function unescapeBraces(str) {
  return str.replace(escSlashPattern, "\\").replace(escOpenPattern, "{").replace(escClosePattern, "}").replace(escCommaPattern, ",").replace(escPeriodPattern, ".");
}
function pushAll(target, items) {
  for (let i = 0; i < items.length; i++) {
    target.push(items[i]);
  }
}
function parseCommaParts(str) {
  const parts2 = [];
  let carry = "";
  for (; ; ) {
    const m = balanced("{", "}", str);
    if (!m) {
      const tail = str.split(",");
      tail[0] = carry + tail[0];
      pushAll(parts2, tail);
      return parts2;
    }
    const { pre, body, post } = m;
    const p = pre.split(",");
    p[0] = carry + p[0];
    p[p.length - 1] += "{" + body + "}";
    if (!post.length) {
      pushAll(parts2, p);
      return parts2;
    }
    carry = p.pop();
    pushAll(parts2, p);
    str = post;
  }
}
function expand(str, options = {}) {
  if (!str) {
    return [];
  }
  const { max: max2 = EXPANSION_MAX, maxLength = EXPANSION_MAX_LENGTH, maxDepth = EXPANSION_MAX_DEPTH, maxRewrites = EXPANSION_MAX_REWRITES } = options;
  if (str.slice(0, 2) === "{}") {
    str = "\\{\\}" + str.slice(2);
  }
  return expand_(escapeBraces(str), max2, maxLength, maxDepth, 0, maxRewrites, true).map(unescapeBraces);
}
function embrace(str) {
  return "{" + str + "}";
}
function isPadded(el) {
  return /^-?0\d/.test(el);
}
function lte(i, y) {
  return i <= y;
}
function gte(i, y) {
  return i >= y;
}
function combine3(acc, pre, values, max2, maxLength, dropEmpties) {
  const out = [];
  let length = 0;
  for (let a = 0; a < acc.length; a++) {
    for (let v = 0; v < values.length; v++) {
      if (out.length >= max2)
        return out;
      const expansion = acc[a] + pre + values[v];
      if (dropEmpties && !expansion)
        continue;
      if (length + expansion.length > maxLength)
        return out;
      out.push(expansion);
      length += expansion.length;
    }
  }
  return out;
}
function expandSequence(body, isAlphaSequence, max2, maxLength) {
  const n = body.split(/\.\./);
  const N = [];
  if (n[0] === void 0 || n[1] === void 0) {
    return N;
  }
  const x = numeric(n[0]);
  const y = numeric(n[1]);
  const width = Math.max(n[0].length, n[1].length);
  let incr = n.length === 3 && n[2] !== void 0 ? Math.max(Math.abs(numeric(n[2])), 1) : 1;
  let test = lte;
  const reverse = y < x;
  if (reverse) {
    incr *= -1;
    test = gte;
  }
  const pad = n.some(isPadded);
  let length = 0;
  for (let i = x; test(i, y) && N.length < max2; i += incr) {
    let c;
    if (isAlphaSequence) {
      c = String.fromCharCode(i);
      if (c === "\\") {
        c = "";
      }
    } else {
      c = String(i);
      if (pad) {
        const need = width - c.length;
        if (need > 0) {
          const z = new Array(need + 1).join("0");
          if (i < 0) {
            c = "-" + z + c.slice(1);
          } else {
            c = z + c;
          }
        }
      }
    }
    if (length + c.length > maxLength)
      break;
    N.push(c);
    length += c.length;
  }
  return N;
}
function expand_(str, max2, maxLength, maxDepth, depth, maxRewrites, isTop) {
  if (depth > maxDepth) {
    return [str];
  }
  let acc = [""];
  let rewrites = 0;
  let dropEmpties = false;
  let firstGroup = true;
  for (; ; ) {
    const m = balanced("{", "}", str);
    if (!m) {
      return combine3(acc, str, [""], max2, maxLength, dropEmpties);
    }
    const pre = m.pre;
    if (/\$$/.test(pre)) {
      acc = combine3(acc, pre + "{" + m.body + "}", [""], max2, maxLength, dropEmpties && !m.post.length);
      firstGroup = false;
      if (!m.post.length)
        break;
      str = m.post;
      continue;
    }
    const isNumericSequence = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/.test(m.body);
    const isAlphaSequence = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/.test(m.body);
    const isSequence = isNumericSequence || isAlphaSequence;
    const isOptions = m.body.indexOf(",") >= 0;
    if (!isSequence && !isOptions) {
      if (rewrites < maxRewrites && m.post.match(/,(?!,).*\}/)) {
        rewrites++;
        str = m.pre + "{" + m.body + escClose + m.post;
        isTop = true;
        continue;
      }
      return combine3(acc, pre + "{" + m.body + "}" + m.post, [""], max2, maxLength, dropEmpties);
    }
    if (firstGroup) {
      dropEmpties = isTop && !isSequence;
      firstGroup = false;
    }
    let values;
    if (isSequence) {
      values = expandSequence(m.body, isAlphaSequence, max2, maxLength);
    } else {
      let n = parseCommaParts(m.body);
      if (n.length === 1 && n[0] !== void 0) {
        n = expand_(n[0], max2, maxLength, maxDepth, depth + 1, maxRewrites, false).map(embrace);
        if (n.length === 1) {
          acc = combine3(acc, pre + n[0], [""], max2, maxLength, dropEmpties && !m.post.length);
          if (!m.post.length)
            break;
          str = m.post;
          continue;
        }
      }
      let dropsEmpties = dropEmpties && !m.post.length && !pre;
      for (let d = 0; dropsEmpties && d < acc.length; d++) {
        if (acc[d]) {
          dropsEmpties = false;
        }
      }
      values = [];
      let valuesLength = 0;
      outer: for (let j = 0; j < n.length; j++) {
        const expanded = expand_(n[j], max2, maxLength, maxDepth, depth + 1, maxRewrites, false);
        for (let k = 0; k < expanded.length; k++) {
          const v = expanded[k];
          if (dropsEmpties && !v)
            continue;
          if (values.length >= max2 || valuesLength + v.length > maxLength) {
            break outer;
          }
          values.push(v);
          valuesLength += v.length;
        }
      }
    }
    acc = combine3(acc, pre, values, max2, maxLength, dropEmpties && !m.post.length);
    if (!m.post.length)
      break;
    str = m.post;
  }
  return acc;
}

// ops/node_modules/minimatch/dist/esm/assert-valid-pattern.js
var MAX_PATTERN_LENGTH = 1024 * 64;
var assertValidPattern = (pattern) => {
  if (typeof pattern !== "string") {
    throw new TypeError("invalid pattern");
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new TypeError("pattern is too long");
  }
};

// ops/node_modules/minimatch/dist/esm/brace-expressions.js
var posixClasses = {
  "[:alnum:]": ["\\p{L}\\p{Nl}\\p{Nd}", true],
  "[:alpha:]": ["\\p{L}\\p{Nl}", true],
  "[:ascii:]": ["\\x00-\\x7f", false],
  "[:blank:]": ["\\p{Zs}\\t", true],
  "[:cntrl:]": ["\\p{Cc}", true],
  "[:digit:]": ["\\p{Nd}", true],
  "[:graph:]": ["\\p{Z}\\p{C}", true, true],
  "[:lower:]": ["\\p{Ll}", true],
  "[:print:]": ["\\p{C}", true],
  "[:punct:]": ["\\p{P}", true],
  "[:space:]": ["\\p{Z}\\t\\r\\n\\v\\f", true],
  "[:upper:]": ["\\p{Lu}", true],
  "[:word:]": ["\\p{L}\\p{Nl}\\p{Nd}\\p{Pc}", true],
  "[:xdigit:]": ["A-Fa-f0-9", false]
};
var braceEscape = (s) => s.replace(/[[\]\\-]/g, "\\$&");
var regexpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
var rangesToString = (ranges) => ranges.join("");
var parseClass = (glob, position) => {
  const pos = position;
  if (glob.charAt(pos) !== "[") {
    throw new Error("not in a brace expression");
  }
  const ranges = [];
  const negs = [];
  let i = pos + 1;
  let sawStart = false;
  let uflag = false;
  let escaping = false;
  let negate = false;
  let endPos = pos;
  let rangeStart = "";
  WHILE: while (i < glob.length) {
    const c = glob.charAt(i);
    if ((c === "!" || c === "^") && i === pos + 1) {
      negate = true;
      i++;
      continue;
    }
    if (c === "]" && sawStart && !escaping) {
      endPos = i + 1;
      break;
    }
    sawStart = true;
    if (c === "\\") {
      if (!escaping) {
        escaping = true;
        i++;
        continue;
      }
    }
    if (c === "[" && !escaping) {
      for (const [cls, [unip, u, neg]] of Object.entries(posixClasses)) {
        if (glob.startsWith(cls, i)) {
          if (rangeStart) {
            return ["$.", false, glob.length - pos, true];
          }
          i += cls.length;
          if (neg)
            negs.push(unip);
          else
            ranges.push(unip);
          uflag = uflag || u;
          continue WHILE;
        }
      }
    }
    escaping = false;
    if (rangeStart) {
      if (c > rangeStart) {
        ranges.push(braceEscape(rangeStart) + "-" + braceEscape(c));
      } else if (c === rangeStart) {
        ranges.push(braceEscape(c));
      }
      rangeStart = "";
      i++;
      continue;
    }
    if (glob.startsWith("-]", i + 1)) {
      ranges.push(braceEscape(c + "-"));
      i += 2;
      continue;
    }
    if (glob.startsWith("-", i + 1)) {
      rangeStart = c;
      i += 2;
      continue;
    }
    ranges.push(braceEscape(c));
    i++;
  }
  if (endPos < i) {
    return ["", false, 0, false];
  }
  if (!ranges.length && !negs.length) {
    return ["$.", false, glob.length - pos, true];
  }
  if (negs.length === 0 && ranges.length === 1 && /^\\?.$/.test(ranges[0]) && !negate) {
    const r = ranges[0].length === 2 ? ranges[0].slice(-1) : ranges[0];
    return [regexpEscape(r), false, endPos - pos, false];
  }
  const sranges = "[" + (negate ? "^" : "") + rangesToString(ranges) + "]";
  const snegs = "[" + (negate ? "" : "^") + rangesToString(negs) + "]";
  const comb = ranges.length && negs.length ? "(" + sranges + "|" + snegs + ")" : ranges.length ? sranges : snegs;
  return [comb, uflag, endPos - pos, true];
};

// ops/node_modules/minimatch/dist/esm/unescape.js
var unescape = (s, { windowsPathsNoEscape = false, magicalBraces = true } = {}) => {
  if (magicalBraces) {
    return windowsPathsNoEscape ? s.replace(/\[([^/\\])\]/g, "$1") : s.replace(/((?!\\).|^)\[([^/\\])\]/g, "$1$2").replace(/\\([^/])/g, "$1");
  }
  return windowsPathsNoEscape ? s.replace(/\[([^/\\{}])\]/g, "$1") : s.replace(/((?!\\).|^)\[([^/\\{}])\]/g, "$1$2").replace(/\\([^/{}])/g, "$1");
};

// ops/node_modules/minimatch/dist/esm/ast.js
var _a;
var types = /* @__PURE__ */ new Set(["!", "?", "+", "*", "@"]);
var isExtglobType = (c) => types.has(c);
var isExtglobAST = (c) => isExtglobType(c.type);
var adoptionMap = /* @__PURE__ */ new Map([
  ["!", ["@"]],
  ["?", ["?", "@"]],
  ["@", ["@"]],
  ["*", ["*", "+", "?", "@"]],
  ["+", ["+", "@"]]
]);
var adoptionWithSpaceMap = /* @__PURE__ */ new Map([
  ["!", ["?"]],
  ["@", ["?"]],
  ["+", ["?", "*"]]
]);
var adoptionAnyMap = /* @__PURE__ */ new Map([
  ["!", ["?", "@"]],
  ["?", ["?", "@"]],
  ["@", ["?", "@"]],
  ["*", ["*", "+", "?", "@"]],
  ["+", ["+", "@", "?", "*"]]
]);
var usurpMap = /* @__PURE__ */ new Map([
  ["!", /* @__PURE__ */ new Map([["!", "@"]])],
  [
    "?",
    /* @__PURE__ */ new Map([
      ["*", "*"],
      ["+", "*"]
    ])
  ],
  [
    "@",
    /* @__PURE__ */ new Map([
      ["!", "!"],
      ["?", "?"],
      ["@", "@"],
      ["*", "*"],
      ["+", "+"]
    ])
  ],
  [
    "+",
    /* @__PURE__ */ new Map([
      ["?", "*"],
      ["*", "*"]
    ])
  ]
]);
var startNoTraversal = "(?!(?:^|/)\\.\\.?(?:$|/))";
var startNoDot = "(?!\\.)";
var addPatternStart = /* @__PURE__ */ new Set(["[", "."]);
var justDots = /* @__PURE__ */ new Set(["..", "."]);
var reSpecials = new Set("().*{}+?[]^$\\!");
var regExpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
var qmark = "[^/]";
var star = qmark + "*?";
var starNoEmpty = qmark + "+?";
var ID = 0;
var AST = class {
  type;
  #root;
  #hasMagic;
  #uflag = false;
  #parts = [];
  #parent;
  #parentIndex;
  #negs;
  #filledNegs = false;
  #options;
  #toString;
  // set to true if it's an extglob with no children
  // (which really means one child of '')
  #emptyExt = false;
  id = ++ID;
  get depth() {
    return (this.#parent?.depth ?? -1) + 1;
  }
  [/* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom")]() {
    return {
      "@@type": "AST",
      id: this.id,
      type: this.type,
      root: this.#root.id,
      parent: this.#parent?.id,
      depth: this.depth,
      partsLength: this.#parts.length,
      parts: this.#parts
    };
  }
  constructor(type, parent, options = {}) {
    this.type = type;
    if (type)
      this.#hasMagic = true;
    this.#parent = parent;
    this.#root = this.#parent ? this.#parent.#root : this;
    this.#options = this.#root === this ? options : this.#root.#options;
    this.#negs = this.#root === this ? [] : this.#root.#negs;
    if (type === "!" && !this.#root.#filledNegs)
      this.#negs.push(this);
    this.#parentIndex = this.#parent ? this.#parent.#parts.length : 0;
  }
  get hasMagic() {
    if (this.#hasMagic !== void 0)
      return this.#hasMagic;
    for (const p of this.#parts) {
      if (typeof p === "string")
        continue;
      if (p.type || p.hasMagic)
        return this.#hasMagic = true;
    }
    return this.#hasMagic;
  }
  // reconstructs the pattern
  toString() {
    return this.#toString !== void 0 ? this.#toString : !this.type ? this.#toString = this.#parts.map((p) => String(p)).join("") : this.#toString = this.type + "(" + this.#parts.map((p) => String(p)).join("|") + ")";
  }
  #fillNegs() {
    if (this !== this.#root)
      throw new Error("should only call on root");
    if (this.#filledNegs)
      return this;
    this.toString();
    this.#filledNegs = true;
    let n;
    while (n = this.#negs.pop()) {
      if (n.type !== "!")
        continue;
      let p = n;
      let pp = p.#parent;
      while (pp) {
        for (let i = p.#parentIndex + 1; !pp.type && i < pp.#parts.length; i++) {
          for (const part of n.#parts) {
            if (typeof part === "string") {
              throw new Error("string part in extglob AST??");
            }
            part.copyIn(pp.#parts[i]);
          }
        }
        p = pp;
        pp = p.#parent;
      }
    }
    return this;
  }
  push(...parts2) {
    for (const p of parts2) {
      if (p === "")
        continue;
      if (typeof p !== "string" && !(p instanceof _a && p.#parent === this)) {
        throw new Error("invalid part: " + p);
      }
      this.#parts.push(p);
    }
  }
  toJSON() {
    const ret = this.type === null ? this.#parts.slice().map((p) => typeof p === "string" ? p : p.toJSON()) : [this.type, ...this.#parts.map((p) => p.toJSON())];
    if (this.isStart() && !this.type)
      ret.unshift([]);
    if (this.isEnd() && (this === this.#root || this.#root.#filledNegs && this.#parent?.type === "!")) {
      ret.push({});
    }
    return ret;
  }
  isStart() {
    if (this.#root === this)
      return true;
    if (!this.#parent?.isStart())
      return false;
    if (this.#parentIndex === 0)
      return true;
    const p = this.#parent;
    for (let i = 0; i < this.#parentIndex; i++) {
      const pp = p.#parts[i];
      if (!(pp instanceof _a && pp.type === "!")) {
        return false;
      }
    }
    return true;
  }
  isEnd() {
    if (this.#root === this)
      return true;
    if (this.#parent?.type === "!")
      return true;
    if (!this.#parent?.isEnd())
      return false;
    if (!this.type)
      return this.#parent?.isEnd();
    const pl = this.#parent ? this.#parent.#parts.length : 0;
    return this.#parentIndex === pl - 1;
  }
  copyIn(part) {
    if (typeof part === "string")
      this.push(part);
    else
      this.push(part.clone(this));
  }
  clone(parent) {
    const c = new _a(this.type, parent);
    for (const p of this.#parts) {
      c.copyIn(p);
    }
    return c;
  }
  static #parseAST(str, ast, pos, opt, extDepth) {
    const maxDepth = opt.maxExtglobRecursion ?? 2;
    let escaping = false;
    let inBrace = false;
    let braceStart = -1;
    let braceNeg = false;
    if (ast.type === null) {
      let i2 = pos;
      let acc2 = "";
      while (i2 < str.length) {
        const c = str.charAt(i2++);
        if (escaping || c === "\\") {
          escaping = !escaping;
          acc2 += c;
          continue;
        }
        if (inBrace) {
          if (i2 === braceStart + 1) {
            if (c === "^" || c === "!") {
              braceNeg = true;
            }
          } else if (c === "]" && !(i2 === braceStart + 2 && braceNeg)) {
            inBrace = false;
          }
          acc2 += c;
          continue;
        } else if (c === "[") {
          inBrace = true;
          braceStart = i2;
          braceNeg = false;
          acc2 += c;
          continue;
        }
        const doRecurse = !opt.noext && isExtglobType(c) && str.charAt(i2) === "(" && extDepth <= maxDepth;
        if (doRecurse) {
          ast.push(acc2);
          acc2 = "";
          const ext2 = new _a(c, ast);
          i2 = _a.#parseAST(str, ext2, i2, opt, extDepth + 1);
          ast.push(ext2);
          continue;
        }
        acc2 += c;
      }
      ast.push(acc2);
      return i2;
    }
    let i = pos + 1;
    let part = new _a(null, ast);
    const parts2 = [];
    let acc = "";
    while (i < str.length) {
      const c = str.charAt(i++);
      if (escaping || c === "\\") {
        escaping = !escaping;
        acc += c;
        continue;
      }
      if (inBrace) {
        if (i === braceStart + 1) {
          if (c === "^" || c === "!") {
            braceNeg = true;
          }
        } else if (c === "]" && !(i === braceStart + 2 && braceNeg)) {
          inBrace = false;
        }
        acc += c;
        continue;
      } else if (c === "[") {
        inBrace = true;
        braceStart = i;
        braceNeg = false;
        acc += c;
        continue;
      }
      const doRecurse = !opt.noext && isExtglobType(c) && str.charAt(i) === "(" && /* c8 ignore start - the maxDepth is sufficient here */
      (extDepth <= maxDepth || ast && ast.#canAdoptType(c));
      if (doRecurse) {
        const depthAdd = ast && ast.#canAdoptType(c) ? 0 : 1;
        part.push(acc);
        acc = "";
        const ext2 = new _a(c, part);
        part.push(ext2);
        i = _a.#parseAST(str, ext2, i, opt, extDepth + depthAdd);
        continue;
      }
      if (c === "|") {
        part.push(acc);
        acc = "";
        parts2.push(part);
        part = new _a(null, ast);
        continue;
      }
      if (c === ")") {
        if (acc === "" && ast.#parts.length === 0) {
          ast.#emptyExt = true;
        }
        part.push(acc);
        acc = "";
        ast.push(...parts2, part);
        return i;
      }
      acc += c;
    }
    ast.type = null;
    ast.#hasMagic = void 0;
    ast.#parts = [str.substring(pos - 1)];
    return i;
  }
  #canAdoptWithSpace(child) {
    return this.#canAdopt(child, adoptionWithSpaceMap);
  }
  #canAdopt(child, map6 = adoptionMap) {
    if (!child || typeof child !== "object" || child.type !== null || child.#parts.length !== 1 || this.type === null) {
      return false;
    }
    const gc = child.#parts[0];
    if (!gc || typeof gc !== "object" || gc.type === null) {
      return false;
    }
    return this.#canAdoptType(gc.type, map6);
  }
  #canAdoptType(c, map6 = adoptionAnyMap) {
    return !!map6.get(this.type)?.includes(c);
  }
  #adoptWithSpace(child, index) {
    const gc = child.#parts[0];
    const blank = new _a(null, gc, this.options);
    blank.#parts.push("");
    gc.push(blank);
    this.#adopt(child, index);
  }
  #adopt(child, index) {
    const gc = child.#parts[0];
    this.#parts.splice(index, 1, ...gc.#parts);
    for (const p of gc.#parts) {
      if (typeof p === "object")
        p.#parent = this;
    }
    this.#toString = void 0;
  }
  #canUsurpType(c) {
    const m = usurpMap.get(this.type);
    return !!m?.has(c);
  }
  #canUsurp(child) {
    if (!child || typeof child !== "object" || child.type !== null || child.#parts.length !== 1 || this.type === null || this.#parts.length !== 1) {
      return false;
    }
    const gc = child.#parts[0];
    if (!gc || typeof gc !== "object" || gc.type === null) {
      return false;
    }
    return this.#canUsurpType(gc.type);
  }
  #usurp(child) {
    const m = usurpMap.get(this.type);
    const gc = child.#parts[0];
    const nt = m?.get(gc.type);
    if (!nt)
      return false;
    this.#parts = gc.#parts;
    for (const p of this.#parts) {
      if (typeof p === "object") {
        p.#parent = this;
      }
    }
    this.type = nt;
    this.#toString = void 0;
    this.#emptyExt = false;
  }
  static fromGlob(pattern, options = {}) {
    const ast = new _a(null, void 0, options);
    _a.#parseAST(pattern, ast, 0, options, 0);
    return ast;
  }
  // returns the regular expression if there's magic, or the unescaped
  // string if not.
  toMMPattern() {
    if (this !== this.#root)
      return this.#root.toMMPattern();
    const glob = this.toString();
    const [re, body, hasMagic, uflag] = this.toRegExpSource();
    const anyMagic = hasMagic || this.#hasMagic || this.#options.nocase && !this.#options.nocaseMagicOnly && glob.toUpperCase() !== glob.toLowerCase();
    if (!anyMagic) {
      return body;
    }
    const flags = (this.#options.nocase ? "i" : "") + (uflag ? "u" : "");
    return Object.assign(new RegExp(`^${re}$`, flags), {
      _src: re,
      _glob: glob
    });
  }
  get options() {
    return this.#options;
  }
  // returns the string match, the regexp source, whether there's magic
  // in the regexp (so a regular expression is required) and whether or
  // not the uflag is needed for the regular expression (for posix classes)
  // TODO: instead of injecting the start/end at this point, just return
  // the BODY of the regexp, along with the start/end portions suitable
  // for binding the start/end in either a joined full-path makeRe context
  // (where we bind to (^|/), or a standalone matchPart context (where
  // we bind to ^, and not /).  Otherwise slashes get duped!
  //
  // In part-matching mode, the start is:
  // - if not isStart: nothing
  // - if traversal possible, but not allowed: ^(?!\.\.?$)
  // - if dots allowed or not possible: ^
  // - if dots possible and not allowed: ^(?!\.)
  // end is:
  // - if not isEnd(): nothing
  // - else: $
  //
  // In full-path matching mode, we put the slash at the START of the
  // pattern, so start is:
  // - if first pattern: same as part-matching mode
  // - if not isStart(): nothing
  // - if traversal possible, but not allowed: /(?!\.\.?(?:$|/))
  // - if dots allowed or not possible: /
  // - if dots possible and not allowed: /(?!\.)
  // end is:
  // - if last pattern, same as part-matching mode
  // - else nothing
  //
  // Always put the (?:$|/) on negated tails, though, because that has to be
  // there to bind the end of the negated pattern portion, and it's easier to
  // just stick it in now rather than try to inject it later in the middle of
  // the pattern.
  //
  // We can just always return the same end, and leave it up to the caller
  // to know whether it's going to be used joined or in parts.
  // And, if the start is adjusted slightly, can do the same there:
  // - if not isStart: nothing
  // - if traversal possible, but not allowed: (?:/|^)(?!\.\.?$)
  // - if dots allowed or not possible: (?:/|^)
  // - if dots possible and not allowed: (?:/|^)(?!\.)
  //
  // But it's better to have a simpler binding without a conditional, for
  // performance, so probably better to return both start options.
  //
  // Then the caller just ignores the end if it's not the first pattern,
  // and the start always gets applied.
  //
  // But that's always going to be $ if it's the ending pattern, or nothing,
  // so the caller can just attach $ at the end of the pattern when building.
  //
  // So the todo is:
  // - better detect what kind of start is needed
  // - return both flavors of starting pattern
  // - attach $ at the end of the pattern when creating the actual RegExp
  //
  // Ah, but wait, no, that all only applies to the root when the first pattern
  // is not an extglob. If the first pattern IS an extglob, then we need all
  // that dot prevention biz to live in the extglob portions, because eg
  // +(*|.x*) can match .xy but not .yx.
  //
  // So, return the two flavors if it's #root and the first child is not an
  // AST, otherwise leave it to the child AST to handle it, and there,
  // use the (?:^|/) style of start binding.
  //
  // Even simplified further:
  // - Since the start for a join is eg /(?!\.) and the start for a part
  // is ^(?!\.), we can just prepend (?!\.) to the pattern (either root
  // or start or whatever) and prepend ^ or / at the Regexp construction.
  toRegExpSource(allowDot) {
    const dot = allowDot ?? !!this.#options.dot;
    if (this.#root === this) {
      this.#flatten();
      this.#fillNegs();
    }
    if (!isExtglobAST(this)) {
      const noEmpty = this.isStart() && this.isEnd() && !this.#parts.some((s) => typeof s !== "string");
      const src = this.#parts.map((p) => {
        const [re, _, hasMagic, uflag] = typeof p === "string" ? _a.#parseGlob(p, this.#hasMagic, noEmpty) : p.toRegExpSource(allowDot);
        this.#hasMagic = this.#hasMagic || hasMagic;
        this.#uflag = this.#uflag || uflag;
        return re;
      }).join("");
      let start2 = "";
      if (this.isStart()) {
        if (typeof this.#parts[0] === "string") {
          const dotTravAllowed = this.#parts.length === 1 && justDots.has(this.#parts[0]);
          if (!dotTravAllowed) {
            const aps = addPatternStart;
            const needNoTrav = (
              // dots are allowed, and the pattern starts with [ or .
              dot && aps.has(src.charAt(0)) || // the pattern starts with \., and then [ or .
              src.startsWith("\\.") && aps.has(src.charAt(2)) || // the pattern starts with \.\., and then [ or .
              src.startsWith("\\.\\.") && aps.has(src.charAt(4))
            );
            const needNoDot = !dot && !allowDot && aps.has(src.charAt(0));
            start2 = needNoTrav ? startNoTraversal : needNoDot ? startNoDot : "";
          }
        }
      }
      let end = "";
      if (this.isEnd() && this.#root.#filledNegs && this.#parent?.type === "!") {
        end = "(?:$|\\/)";
      }
      const final2 = start2 + src + end;
      return [
        final2,
        unescape(src),
        this.#hasMagic = !!this.#hasMagic,
        this.#uflag
      ];
    }
    const repeated = this.type === "*" || this.type === "+";
    const start = this.type === "!" ? "(?:(?!(?:" : "(?:";
    let body = this.#partsToRegExp(dot);
    if (this.isStart() && this.isEnd() && !body && this.type !== "!") {
      const s = this.toString();
      const me = this;
      me.#parts = [s];
      me.type = null;
      me.#hasMagic = void 0;
      return [s, unescape(this.toString()), false, false];
    }
    let bodyDotAllowed = !repeated || allowDot || dot || !startNoDot ? "" : this.#partsToRegExp(true);
    if (bodyDotAllowed === body) {
      bodyDotAllowed = "";
    }
    if (bodyDotAllowed) {
      body = `(?:${body})(?:${bodyDotAllowed})*?`;
    }
    let final = "";
    if (this.type === "!" && this.#emptyExt) {
      final = (this.isStart() && !dot ? startNoDot : "") + starNoEmpty;
    } else {
      const close2 = this.type === "!" ? (
        // !() must match something,but !(x) can match ''
        "))" + (this.isStart() && !dot && !allowDot ? startNoDot : "") + star + ")"
      ) : this.type === "@" ? ")" : this.type === "?" ? ")?" : this.type === "+" && bodyDotAllowed ? ")" : this.type === "*" && bodyDotAllowed ? `)?` : `)${this.type}`;
      final = start + body + close2;
    }
    return [
      final,
      unescape(body),
      this.#hasMagic = !!this.#hasMagic,
      this.#uflag
    ];
  }
  #flatten() {
    if (!isExtglobAST(this)) {
      for (const p of this.#parts) {
        if (typeof p === "object") {
          p.#flatten();
        }
      }
    } else {
      let iterations = 0;
      let done4 = false;
      do {
        done4 = true;
        for (let i = 0; i < this.#parts.length; i++) {
          const c = this.#parts[i];
          if (typeof c === "object") {
            c.#flatten();
            if (this.#canAdopt(c)) {
              done4 = false;
              this.#adopt(c, i);
            } else if (this.#canAdoptWithSpace(c)) {
              done4 = false;
              this.#adoptWithSpace(c, i);
            } else if (this.#canUsurp(c)) {
              done4 = false;
              this.#usurp(c);
            }
          }
        }
      } while (!done4 && ++iterations < 10);
    }
    this.#toString = void 0;
  }
  #partsToRegExp(dot) {
    return this.#parts.map((p) => {
      if (typeof p === "string") {
        throw new Error("string type in extglob ast??");
      }
      const [re, _, _hasMagic, uflag] = p.toRegExpSource(dot);
      this.#uflag = this.#uflag || uflag;
      return re;
    }).filter((p) => !(this.isStart() && this.isEnd()) || !!p).join("|");
  }
  static #parseGlob(glob, hasMagic, noEmpty = false) {
    let escaping = false;
    let re = "";
    let uflag = false;
    let inStar = false;
    for (let i = 0; i < glob.length; i++) {
      const c = glob.charAt(i);
      if (escaping) {
        escaping = false;
        re += (reSpecials.has(c) ? "\\" : "") + c;
        continue;
      }
      if (c === "*") {
        if (inStar)
          continue;
        inStar = true;
        re += noEmpty && /^[*]+$/.test(glob) ? starNoEmpty : star;
        hasMagic = true;
        continue;
      } else {
        inStar = false;
      }
      if (c === "\\") {
        if (i === glob.length - 1) {
          re += "\\\\";
        } else {
          escaping = true;
        }
        continue;
      }
      if (c === "[") {
        const [src, needUflag, consumed, magic] = parseClass(glob, i);
        if (consumed) {
          re += src;
          uflag = uflag || needUflag;
          i += consumed - 1;
          hasMagic = hasMagic || magic;
          continue;
        }
      }
      if (c === "?") {
        re += qmark;
        hasMagic = true;
        continue;
      }
      re += regExpEscape(c);
    }
    return [re, unescape(glob), !!hasMagic, uflag];
  }
};
_a = AST;

// ops/node_modules/minimatch/dist/esm/escape.js
var escape = (s, { windowsPathsNoEscape = false, magicalBraces = false } = {}) => {
  if (magicalBraces) {
    return windowsPathsNoEscape ? s.replace(/[?*()[\]{}]/g, "[$&]") : s.replace(/[?*()[\]\\{}]/g, "\\$&");
  }
  return windowsPathsNoEscape ? s.replace(/[?*()[\]]/g, "[$&]") : s.replace(/[?*()[\]\\]/g, "\\$&");
};

// ops/node_modules/minimatch/dist/esm/index.js
var minimatch = (p, pattern, options = {}) => {
  assertValidPattern(pattern);
  if (!options.nocomment && pattern.charAt(0) === "#") {
    return false;
  }
  return new Minimatch(pattern, options).match(p);
};
var starDotExtRE = /^\*+([^+@!?*[(]*)$/;
var starDotExtTest = (ext2) => (f) => !f.startsWith(".") && f.endsWith(ext2);
var starDotExtTestDot = (ext2) => (f) => f.endsWith(ext2);
var starDotExtTestNocase = (ext2) => {
  ext2 = ext2.toLowerCase();
  return (f) => !f.startsWith(".") && f.toLowerCase().endsWith(ext2);
};
var starDotExtTestNocaseDot = (ext2) => {
  ext2 = ext2.toLowerCase();
  return (f) => f.toLowerCase().endsWith(ext2);
};
var starDotStarRE = /^\*+\.\*+$/;
var starDotStarTest = (f) => !f.startsWith(".") && f.includes(".");
var starDotStarTestDot = (f) => f !== "." && f !== ".." && f.includes(".");
var dotStarRE = /^\.\*+$/;
var dotStarTest = (f) => f !== "." && f !== ".." && f.startsWith(".");
var starRE = /^\*+$/;
var starTest = (f) => f.length !== 0 && !f.startsWith(".");
var starTestDot = (f) => f.length !== 0 && f !== "." && f !== "..";
var qmarksRE = /^\?+([^+@!?*[(]*)?$/;
var qmarksTestNocase = ([$0, ext2 = ""]) => {
  const noext = qmarksTestNoExt([$0]);
  if (!ext2)
    return noext;
  ext2 = ext2.toLowerCase();
  return (f) => noext(f) && f.toLowerCase().endsWith(ext2);
};
var qmarksTestNocaseDot = ([$0, ext2 = ""]) => {
  const noext = qmarksTestNoExtDot([$0]);
  if (!ext2)
    return noext;
  ext2 = ext2.toLowerCase();
  return (f) => noext(f) && f.toLowerCase().endsWith(ext2);
};
var qmarksTestDot = ([$0, ext2 = ""]) => {
  const noext = qmarksTestNoExtDot([$0]);
  return !ext2 ? noext : (f) => noext(f) && f.endsWith(ext2);
};
var qmarksTest = ([$0, ext2 = ""]) => {
  const noext = qmarksTestNoExt([$0]);
  return !ext2 ? noext : (f) => noext(f) && f.endsWith(ext2);
};
var qmarksTestNoExt = ([$0]) => {
  const len = $0.length;
  return (f) => f.length === len && !f.startsWith(".");
};
var qmarksTestNoExtDot = ([$0]) => {
  const len = $0.length;
  return (f) => f.length === len && f !== "." && f !== "..";
};
var defaultPlatform = typeof process === "object" && process ? typeof process.env === "object" && process.env && process.env.__MINIMATCH_TESTING_PLATFORM__ || process.platform : "posix";
var path = {
  win32: { sep: "\\" },
  posix: { sep: "/" }
};
var sep = defaultPlatform === "win32" ? path.win32.sep : path.posix.sep;
minimatch.sep = sep;
var GLOBSTAR = /* @__PURE__ */ Symbol("globstar **");
minimatch.GLOBSTAR = GLOBSTAR;
var qmark2 = "[^/]";
var star2 = qmark2 + "*?";
var twoStarDot = "(?:(?!(?:\\/|^)(?:\\.{1,2})($|\\/)).)*?";
var twoStarNoDot = "(?:(?!(?:\\/|^)\\.).)*?";
var filter4 = (pattern, options = {}) => (p) => minimatch(p, pattern, options);
minimatch.filter = filter4;
var ext = (a, b = {}) => Object.assign({}, a, b);
var defaults = (def) => {
  if (!def || typeof def !== "object" || !Object.keys(def).length) {
    return minimatch;
  }
  const orig = minimatch;
  const m = (p, pattern, options = {}) => orig(p, pattern, ext(def, options));
  return Object.assign(m, {
    Minimatch: class Minimatch extends orig.Minimatch {
      constructor(pattern, options = {}) {
        super(pattern, ext(def, options));
      }
      static defaults(options) {
        return orig.defaults(ext(def, options)).Minimatch;
      }
    },
    AST: class AST extends orig.AST {
      /* c8 ignore start */
      constructor(type, parent, options = {}) {
        super(type, parent, ext(def, options));
      }
      /* c8 ignore stop */
      static fromGlob(pattern, options = {}) {
        return orig.AST.fromGlob(pattern, ext(def, options));
      }
    },
    unescape: (s, options = {}) => orig.unescape(s, ext(def, options)),
    escape: (s, options = {}) => orig.escape(s, ext(def, options)),
    filter: (pattern, options = {}) => orig.filter(pattern, ext(def, options)),
    defaults: (options) => orig.defaults(ext(def, options)),
    makeRe: (pattern, options = {}) => orig.makeRe(pattern, ext(def, options)),
    braceExpand: (pattern, options = {}) => orig.braceExpand(pattern, ext(def, options)),
    match: (list, pattern, options = {}) => orig.match(list, pattern, ext(def, options)),
    sep: orig.sep,
    GLOBSTAR
  });
};
minimatch.defaults = defaults;
var braceExpand = (pattern, options = {}) => {
  assertValidPattern(pattern);
  if (options.nobrace || !/\{(?:(?!\{).)*\}/.test(pattern)) {
    return [pattern];
  }
  return expand(pattern, { max: options.braceExpandMax });
};
minimatch.braceExpand = braceExpand;
var makeRe = (pattern, options = {}) => new Minimatch(pattern, options).makeRe();
minimatch.makeRe = makeRe;
var match6 = (list, pattern, options = {}) => {
  const mm = new Minimatch(pattern, options);
  list = list.filter((f) => mm.match(f));
  if (mm.options.nonull && !list.length) {
    list.push(pattern);
  }
  return list;
};
minimatch.match = match6;
var globMagic = /[?*]|[+@!]\(.*?\)|\[|\]/;
var regExpEscape2 = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
var Minimatch = class {
  options;
  set;
  pattern;
  windowsPathsNoEscape;
  nonegate;
  negate;
  comment;
  empty;
  preserveMultipleSlashes;
  partial;
  globSet;
  globParts;
  nocase;
  isWindows;
  platform;
  windowsNoMagicRoot;
  maxGlobstarRecursion;
  regexp;
  constructor(pattern, options = {}) {
    assertValidPattern(pattern);
    options = options || {};
    this.options = options;
    this.maxGlobstarRecursion = options.maxGlobstarRecursion ?? 200;
    this.pattern = pattern;
    this.platform = options.platform || defaultPlatform;
    this.isWindows = this.platform === "win32";
    const awe = "allowWindowsEscape";
    this.windowsPathsNoEscape = !!options.windowsPathsNoEscape || options[awe] === false;
    if (this.windowsPathsNoEscape) {
      this.pattern = this.pattern.replace(/\\/g, "/");
    }
    this.preserveMultipleSlashes = !!options.preserveMultipleSlashes;
    this.regexp = null;
    this.negate = false;
    this.nonegate = !!options.nonegate;
    this.comment = false;
    this.empty = false;
    this.partial = !!options.partial;
    this.nocase = !!this.options.nocase;
    this.windowsNoMagicRoot = options.windowsNoMagicRoot !== void 0 ? options.windowsNoMagicRoot : !!(this.isWindows && this.nocase);
    this.globSet = [];
    this.globParts = [];
    this.set = [];
    this.make();
  }
  hasMagic() {
    if (this.options.magicalBraces && this.set.length > 1) {
      return true;
    }
    for (const pattern of this.set) {
      for (const part of pattern) {
        if (typeof part !== "string")
          return true;
      }
    }
    return false;
  }
  debug(..._) {
  }
  make() {
    const pattern = this.pattern;
    const options = this.options;
    if (!options.nocomment && pattern.charAt(0) === "#") {
      this.comment = true;
      return;
    }
    if (!pattern) {
      this.empty = true;
      return;
    }
    this.parseNegate();
    this.globSet = [...new Set(this.braceExpand())];
    if (options.debug) {
      this.debug = (...args2) => console.error(...args2);
    }
    this.debug(this.pattern, this.globSet);
    const rawGlobParts = this.globSet.map((s) => this.slashSplit(s));
    this.globParts = this.preprocess(rawGlobParts);
    this.debug(this.pattern, this.globParts);
    let set = this.globParts.map((s, _, __) => {
      if (this.isWindows && this.windowsNoMagicRoot) {
        const isUNC = s[0] === "" && s[1] === "" && (s[2] === "?" || !globMagic.test(s[2])) && !globMagic.test(s[3]);
        const isDrive = /^[a-z]:/i.test(s[0]);
        if (isUNC) {
          return [
            ...s.slice(0, 4),
            ...s.slice(4).map((ss) => this.parse(ss))
          ];
        } else if (isDrive) {
          return [s[0], ...s.slice(1).map((ss) => this.parse(ss))];
        }
      }
      return s.map((ss) => this.parse(ss));
    });
    this.debug(this.pattern, set);
    this.set = set.filter((s) => s.indexOf(false) === -1);
    if (this.isWindows) {
      for (let i = 0; i < this.set.length; i++) {
        const p = this.set[i];
        if (p[0] === "" && p[1] === "" && this.globParts[i][2] === "?" && typeof p[3] === "string" && /^[a-z]:$/i.test(p[3])) {
          p[2] = "?";
        }
      }
    }
    this.debug(this.pattern, this.set);
  }
  // various transforms to equivalent pattern sets that are
  // faster to process in a filesystem walk.  The goal is to
  // eliminate what we can, and push all ** patterns as far
  // to the right as possible, even if it increases the number
  // of patterns that we have to process.
  preprocess(globParts) {
    if (this.options.noglobstar) {
      for (const partset of globParts) {
        for (let j = 0; j < partset.length; j++) {
          if (partset[j] === "**") {
            partset[j] = "*";
          }
        }
      }
    }
    const { optimizationLevel = 1 } = this.options;
    if (optimizationLevel >= 2) {
      globParts = this.firstPhasePreProcess(globParts);
      globParts = this.secondPhasePreProcess(globParts);
    } else if (optimizationLevel >= 1) {
      globParts = this.levelOneOptimize(globParts);
    } else {
      globParts = this.adjascentGlobstarOptimize(globParts);
    }
    return globParts;
  }
  // just get rid of adjascent ** portions
  adjascentGlobstarOptimize(globParts) {
    return globParts.map((parts2) => {
      let gs = -1;
      while (-1 !== (gs = parts2.indexOf("**", gs + 1))) {
        let i = gs;
        while (parts2[i + 1] === "**") {
          i++;
        }
        if (i !== gs) {
          parts2.splice(gs, i - gs);
        }
      }
      return parts2;
    });
  }
  // get rid of adjascent ** and resolve .. portions
  levelOneOptimize(globParts) {
    return globParts.map((parts2) => {
      parts2 = parts2.reduce((set, part) => {
        const prev = set[set.length - 1];
        if (part === "**" && prev === "**") {
          return set;
        }
        if (part === "..") {
          if (prev && prev !== ".." && prev !== "." && prev !== "**") {
            set.pop();
            return set;
          }
        }
        set.push(part);
        return set;
      }, []);
      return parts2.length === 0 ? [""] : parts2;
    });
  }
  levelTwoFileOptimize(parts2) {
    if (!Array.isArray(parts2)) {
      parts2 = this.slashSplit(parts2);
    }
    let didSomething = false;
    do {
      didSomething = false;
      if (!this.preserveMultipleSlashes) {
        for (let i = 1; i < parts2.length - 1; i++) {
          const p = parts2[i];
          if (i === 1 && p === "" && parts2[0] === "")
            continue;
          if (p === "." || p === "") {
            didSomething = true;
            parts2.splice(i, 1);
            i--;
          }
        }
        if (parts2[0] === "." && parts2.length === 2 && (parts2[1] === "." || parts2[1] === "")) {
          didSomething = true;
          parts2.pop();
        }
      }
      let dd = 0;
      while (-1 !== (dd = parts2.indexOf("..", dd + 1))) {
        const p = parts2[dd - 1];
        if (p && p !== "." && p !== ".." && p !== "**" && !(this.isWindows && /^[a-z]:$/i.test(p))) {
          didSomething = true;
          parts2.splice(dd - 1, 2);
          dd -= 2;
        }
      }
    } while (didSomething);
    return parts2.length === 0 ? [""] : parts2;
  }
  // First phase: single-pattern processing
  // <pre> is 1 or more portions
  // <rest> is 1 or more portions
  // <p> is any portion other than ., .., '', or **
  // <e> is . or ''
  //
  // **/.. is *brutal* for filesystem walking performance, because
  // it effectively resets the recursive walk each time it occurs,
  // and ** cannot be reduced out by a .. pattern part like a regexp
  // or most strings (other than .., ., and '') can be.
  //
  // <pre>/**/../<p>/<p>/<rest> -> {<pre>/../<p>/<p>/<rest>,<pre>/**/<p>/<p>/<rest>}
  // <pre>/<e>/<rest> -> <pre>/<rest>
  // <pre>/<p>/../<rest> -> <pre>/<rest>
  // **/**/<rest> -> **/<rest>
  //
  // **/*/<rest> -> */**/<rest> <== not valid because ** doesn't follow
  // this WOULD be allowed if ** did follow symlinks, or * didn't
  firstPhasePreProcess(globParts) {
    let didSomething = false;
    do {
      didSomething = false;
      for (let parts2 of globParts) {
        let gs = -1;
        while (-1 !== (gs = parts2.indexOf("**", gs + 1))) {
          let gss = gs;
          while (parts2[gss + 1] === "**") {
            gss++;
          }
          if (gss > gs) {
            parts2.splice(gs + 1, gss - gs);
          }
          let next = parts2[gs + 1];
          const p = parts2[gs + 2];
          const p2 = parts2[gs + 3];
          if (next !== "..")
            continue;
          if (!p || p === "." || p === ".." || !p2 || p2 === "." || p2 === "..") {
            continue;
          }
          didSomething = true;
          parts2.splice(gs, 1);
          const other = parts2.slice(0);
          other[gs] = "**";
          globParts.push(other);
          gs--;
        }
        if (!this.preserveMultipleSlashes) {
          for (let i = 1; i < parts2.length - 1; i++) {
            const p = parts2[i];
            if (i === 1 && p === "" && parts2[0] === "")
              continue;
            if (p === "." || p === "") {
              didSomething = true;
              parts2.splice(i, 1);
              i--;
            }
          }
          if (parts2[0] === "." && parts2.length === 2 && (parts2[1] === "." || parts2[1] === "")) {
            didSomething = true;
            parts2.pop();
          }
        }
        let dd = 0;
        while (-1 !== (dd = parts2.indexOf("..", dd + 1))) {
          const p = parts2[dd - 1];
          if (p && p !== "." && p !== ".." && p !== "**") {
            didSomething = true;
            const needDot = dd === 1 && parts2[dd + 1] === "**";
            const splin = needDot ? ["."] : [];
            parts2.splice(dd - 1, 2, ...splin);
            if (parts2.length === 0)
              parts2.push("");
            dd -= 2;
          }
        }
      }
    } while (didSomething);
    return globParts;
  }
  // second phase: multi-pattern dedupes
  // {<pre>/*/<rest>,<pre>/<p>/<rest>} -> <pre>/*/<rest>
  // {<pre>/<rest>,<pre>/<rest>} -> <pre>/<rest>
  // {<pre>/**/<rest>,<pre>/<rest>} -> <pre>/**/<rest>
  //
  // {<pre>/**/<rest>,<pre>/**/<p>/<rest>} -> <pre>/**/<rest>
  // ^-- not valid because ** doens't follow symlinks
  secondPhasePreProcess(globParts) {
    for (let i = 0; i < globParts.length - 1; i++) {
      for (let j = i + 1; j < globParts.length; j++) {
        const matched = this.partsMatch(globParts[i], globParts[j], !this.preserveMultipleSlashes);
        if (matched) {
          globParts[i] = [];
          globParts[j] = matched;
          break;
        }
      }
    }
    return globParts.filter((gs) => gs.length);
  }
  partsMatch(a, b, emptyGSMatch = false) {
    let ai = 0;
    let bi = 0;
    let result3 = [];
    let which = "";
    while (ai < a.length && bi < b.length) {
      if (a[ai] === b[bi]) {
        result3.push(which === "b" ? b[bi] : a[ai]);
        ai++;
        bi++;
      } else if (emptyGSMatch && a[ai] === "**" && b[bi] === a[ai + 1]) {
        result3.push(a[ai]);
        ai++;
      } else if (emptyGSMatch && b[bi] === "**" && a[ai] === b[bi + 1]) {
        result3.push(b[bi]);
        bi++;
      } else if (a[ai] === "*" && b[bi] && (this.options.dot || !b[bi].startsWith(".")) && b[bi] !== "**") {
        if (which === "b")
          return false;
        which = "a";
        result3.push(a[ai]);
        ai++;
        bi++;
      } else if (b[bi] === "*" && a[ai] && (this.options.dot || !a[ai].startsWith(".")) && a[ai] !== "**") {
        if (which === "a")
          return false;
        which = "b";
        result3.push(b[bi]);
        ai++;
        bi++;
      } else {
        return false;
      }
    }
    return a.length === b.length && result3;
  }
  parseNegate() {
    if (this.nonegate)
      return;
    const pattern = this.pattern;
    let negate = false;
    let negateOffset = 0;
    for (let i = 0; i < pattern.length && pattern.charAt(i) === "!"; i++) {
      negate = !negate;
      negateOffset++;
    }
    if (negateOffset)
      this.pattern = pattern.slice(negateOffset);
    this.negate = negate;
  }
  // set partial to true to test if, for example,
  // "/a/b" matches the start of "/*/b/*/d"
  // Partial means, if you run out of file before you run
  // out of pattern, then that's fine, as long as all
  // the parts match.
  matchOne(file, pattern, partial = false) {
    let fileStartIndex = 0;
    let patternStartIndex = 0;
    if (this.isWindows) {
      const fileDrive = typeof file[0] === "string" && /^[a-z]:$/i.test(file[0]);
      const fileUNC = !fileDrive && file[0] === "" && file[1] === "" && file[2] === "?" && /^[a-z]:$/i.test(file[3]);
      const patternDrive = typeof pattern[0] === "string" && /^[a-z]:$/i.test(pattern[0]);
      const patternUNC = !patternDrive && pattern[0] === "" && pattern[1] === "" && pattern[2] === "?" && typeof pattern[3] === "string" && /^[a-z]:$/i.test(pattern[3]);
      const fdi = fileUNC ? 3 : fileDrive ? 0 : void 0;
      const pdi = patternUNC ? 3 : patternDrive ? 0 : void 0;
      if (typeof fdi === "number" && typeof pdi === "number") {
        const [fd, pd] = [
          file[fdi],
          pattern[pdi]
        ];
        if (fd.toLowerCase() === pd.toLowerCase()) {
          pattern[pdi] = fd;
          patternStartIndex = pdi;
          fileStartIndex = fdi;
        }
      }
    }
    const { optimizationLevel = 1 } = this.options;
    if (optimizationLevel >= 2) {
      file = this.levelTwoFileOptimize(file);
    }
    if (pattern.includes(GLOBSTAR)) {
      return this.#matchGlobstar(file, pattern, partial, fileStartIndex, patternStartIndex);
    }
    return this.#matchOne(file, pattern, partial, fileStartIndex, patternStartIndex);
  }
  #matchGlobstar(file, pattern, partial, fileIndex, patternIndex) {
    const firstgs = pattern.indexOf(GLOBSTAR, patternIndex);
    const lastgs = pattern.lastIndexOf(GLOBSTAR);
    const [head3, body, tail] = partial ? [
      pattern.slice(patternIndex, firstgs),
      pattern.slice(firstgs + 1),
      []
    ] : [
      pattern.slice(patternIndex, firstgs),
      pattern.slice(firstgs + 1, lastgs),
      pattern.slice(lastgs + 1)
    ];
    if (head3.length) {
      const fileHead = file.slice(fileIndex, fileIndex + head3.length);
      if (!this.#matchOne(fileHead, head3, partial, 0, 0)) {
        return false;
      }
      fileIndex += head3.length;
      patternIndex += head3.length;
    }
    let fileTailMatch = 0;
    if (tail.length) {
      if (tail.length + fileIndex > file.length)
        return false;
      let tailStart = file.length - tail.length;
      if (this.#matchOne(file, tail, partial, tailStart, 0)) {
        fileTailMatch = tail.length;
      } else {
        if (file[file.length - 1] !== "" || fileIndex + tail.length === file.length) {
          return false;
        }
        tailStart--;
        if (!this.#matchOne(file, tail, partial, tailStart, 0)) {
          return false;
        }
        fileTailMatch = tail.length + 1;
      }
    }
    if (!body.length) {
      let sawSome = !!fileTailMatch;
      for (let i2 = fileIndex; i2 < file.length - fileTailMatch; i2++) {
        const f = String(file[i2]);
        sawSome = true;
        if (f === "." || f === ".." || !this.options.dot && f.startsWith(".")) {
          return false;
        }
      }
      return partial || sawSome;
    }
    const bodySegments = [[[], 0]];
    let currentBody = bodySegments[0];
    let nonGsParts = 0;
    const nonGsPartsSums = [0];
    for (const b of body) {
      if (b === GLOBSTAR) {
        nonGsPartsSums.push(nonGsParts);
        currentBody = [[], 0];
        bodySegments.push(currentBody);
      } else {
        currentBody[0].push(b);
        nonGsParts++;
      }
    }
    let i = bodySegments.length - 1;
    const fileLength = file.length - fileTailMatch;
    for (const b of bodySegments) {
      b[1] = fileLength - (nonGsPartsSums[i--] + b[0].length);
    }
    return !!this.#matchGlobStarBodySections(file, bodySegments, fileIndex, 0, partial, 0, !!fileTailMatch);
  }
  // return false for "nope, not matching"
  // return null for "not matching, cannot keep trying"
  #matchGlobStarBodySections(file, bodySegments, fileIndex, bodyIndex, partial, globStarDepth, sawTail) {
    const bs = bodySegments[bodyIndex];
    if (!bs) {
      for (let i = fileIndex; i < file.length; i++) {
        sawTail = true;
        const f = file[i];
        if (f === "." || f === ".." || !this.options.dot && f.startsWith(".")) {
          return false;
        }
      }
      return sawTail;
    }
    const [body, after] = bs;
    while (fileIndex <= after) {
      const m = this.#matchOne(file.slice(0, fileIndex + body.length), body, partial, fileIndex, 0);
      if (m && globStarDepth < this.maxGlobstarRecursion) {
        const sub = this.#matchGlobStarBodySections(file, bodySegments, fileIndex + body.length, bodyIndex + 1, partial, globStarDepth + 1, sawTail);
        if (sub !== false) {
          return sub;
        }
      }
      const f = file[fileIndex];
      if (f === "." || f === ".." || !this.options.dot && f.startsWith(".")) {
        return false;
      }
      fileIndex++;
    }
    return partial || null;
  }
  #matchOne(file, pattern, partial, fileIndex, patternIndex) {
    let fi;
    let pi;
    let pl;
    let fl;
    for (fi = fileIndex, pi = patternIndex, fl = file.length, pl = pattern.length; fi < fl && pi < pl; fi++, pi++) {
      this.debug("matchOne loop");
      let p = pattern[pi];
      let f = file[fi];
      this.debug(pattern, p, f);
      if (p === false || p === GLOBSTAR) {
        return false;
      }
      let hit;
      if (typeof p === "string") {
        hit = f === p;
        this.debug("string match", p, f, hit);
      } else {
        hit = p.test(f);
        this.debug("pattern match", p, f, hit);
      }
      if (!hit)
        return false;
    }
    if (fi === fl && pi === pl) {
      return true;
    } else if (fi === fl) {
      return partial;
    } else if (pi === pl) {
      return fi === fl - 1 && file[fi] === "";
    } else {
      throw new Error("wtf?");
    }
  }
  braceExpand() {
    return braceExpand(this.pattern, this.options);
  }
  parse(pattern) {
    assertValidPattern(pattern);
    const options = this.options;
    if (pattern === "**")
      return GLOBSTAR;
    if (pattern === "")
      return "";
    let m;
    let fastTest = null;
    if (m = pattern.match(starRE)) {
      fastTest = options.dot ? starTestDot : starTest;
    } else if (m = pattern.match(starDotExtRE)) {
      fastTest = (options.nocase ? options.dot ? starDotExtTestNocaseDot : starDotExtTestNocase : options.dot ? starDotExtTestDot : starDotExtTest)(m[1]);
    } else if (m = pattern.match(qmarksRE)) {
      fastTest = (options.nocase ? options.dot ? qmarksTestNocaseDot : qmarksTestNocase : options.dot ? qmarksTestDot : qmarksTest)(m);
    } else if (m = pattern.match(starDotStarRE)) {
      fastTest = options.dot ? starDotStarTestDot : starDotStarTest;
    } else if (m = pattern.match(dotStarRE)) {
      fastTest = dotStarTest;
    }
    const re = AST.fromGlob(pattern, this.options).toMMPattern();
    if (fastTest && typeof re === "object") {
      Reflect.defineProperty(re, "test", { value: fastTest });
    }
    return re;
  }
  makeRe() {
    if (this.regexp || this.regexp === false)
      return this.regexp;
    const set = this.set;
    if (!set.length) {
      this.regexp = false;
      return this.regexp;
    }
    const options = this.options;
    const twoStar = options.noglobstar ? star2 : options.dot ? twoStarDot : twoStarNoDot;
    const flags = new Set(options.nocase ? ["i"] : []);
    let re = set.map((pattern) => {
      const pp = pattern.map((p) => {
        if (p instanceof RegExp) {
          for (const f of p.flags.split(""))
            flags.add(f);
        }
        return typeof p === "string" ? regExpEscape2(p) : p === GLOBSTAR ? GLOBSTAR : p._src;
      });
      pp.forEach((p, i) => {
        const next = pp[i + 1];
        const prev = pp[i - 1];
        if (p !== GLOBSTAR || prev === GLOBSTAR) {
          return;
        }
        if (prev === void 0) {
          if (next !== void 0 && next !== GLOBSTAR) {
            pp[i + 1] = "(?:\\/|" + twoStar + "\\/)?" + next;
          } else {
            pp[i] = twoStar;
          }
        } else if (next === void 0) {
          pp[i - 1] = prev + "(?:\\/|\\/" + twoStar + ")?";
        } else if (next !== GLOBSTAR) {
          pp[i - 1] = prev + "(?:\\/|\\/" + twoStar + "\\/)" + next;
          pp[i + 1] = GLOBSTAR;
        }
      });
      const filtered = pp.filter((p) => p !== GLOBSTAR);
      if (this.partial && filtered.length >= 1) {
        const prefixes = [];
        for (let i = 1; i <= filtered.length; i++) {
          prefixes.push(filtered.slice(0, i).join("/"));
        }
        return "(?:" + prefixes.join("|") + ")";
      }
      return filtered.join("/");
    }).join("|");
    const [open, close2] = set.length > 1 ? ["(?:", ")"] : ["", ""];
    re = "^" + open + re + close2 + "$";
    if (this.partial) {
      re = "^(?:\\/|" + open + re.slice(1, -1) + close2 + ")$";
    }
    if (this.negate)
      re = "^(?!" + re + ").+$";
    try {
      this.regexp = new RegExp(re, [...flags].join(""));
    } catch {
      this.regexp = false;
    }
    return this.regexp;
  }
  slashSplit(p) {
    if (this.preserveMultipleSlashes) {
      return p.split("/");
    } else if (this.isWindows && /^\/\/[^/]+/.test(p)) {
      return ["", ...p.split(/\/+/)];
    } else {
      return p.split(/\/+/);
    }
  }
  match(f, partial = this.partial) {
    this.debug("match", f, this.pattern);
    if (this.comment) {
      return false;
    }
    if (this.empty) {
      return f === "";
    }
    if (f === "/" && partial) {
      return true;
    }
    const options = this.options;
    if (this.isWindows) {
      f = f.split("\\").join("/");
    }
    const ff = this.slashSplit(f);
    this.debug(this.pattern, "split", ff);
    const set = this.set;
    this.debug(this.pattern, "set", set);
    let filename = ff[ff.length - 1];
    if (!filename) {
      for (let i = ff.length - 2; !filename && i >= 0; i--) {
        filename = ff[i];
      }
    }
    for (const pattern of set) {
      let file = ff;
      if (options.matchBase && pattern.length === 1) {
        file = [filename];
      }
      const hit = this.matchOne(file, pattern, partial);
      if (hit) {
        if (options.flipNegate) {
          return true;
        }
        return !this.negate;
      }
    }
    if (options.flipNegate) {
      return false;
    }
    return this.negate;
  }
  static defaults(def) {
    return minimatch.defaults(def).Minimatch;
  }
};
minimatch.AST = AST;
minimatch.Minimatch = Minimatch;
minimatch.escape = escape;
minimatch.unescape = unescape;

// ops/node_modules/@tian.zuo/pi-find/lib/rg-json.ts
function decodeText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value.text === "string") return value.text;
  if (typeof value.bytes === "string") {
    try {
      return Buffer.from(value.bytes, "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  return "";
}
function decodeRgSummary(line) {
  if (!line.startsWith('{"data"')) return void 0;
  try {
    const event = JSON.parse(line);
    const stats = event.data?.stats;
    if (event.type !== "summary" || typeof stats?.searches !== "number" || typeof stats.bytes_searched !== "number")
      return void 0;
    return { searchedFiles: stats.searches, searchedBytes: stats.bytes_searched };
  } catch {
    return void 0;
  }
}
function decodeRgEvent(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return void 0;
  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return void 0;
  }
  if (event == null || event.type !== "match" && event.type !== "context") return void 0;
  const data = event.data;
  if (!data || typeof data.line_number !== "number") return void 0;
  const path3 = decodeText(data.path);
  if (path3.length === 0) return void 0;
  const text = decodeText(data.lines).replace(/\r?\n$/, "").replace(/\r/g, "");
  const first = data.submatches?.[0];
  let matchStart;
  let matchEnd;
  if (first && Number.isInteger(first.start) && Number.isInteger(first.end) && first.start >= 0 && first.end >= first.start) {
    const bytes = typeof data.lines?.bytes === "string" ? Buffer.from(data.lines.bytes, "base64") : Buffer.from(decodeText(data.lines), "utf8");
    if (first.end <= bytes.length) {
      matchStart = Math.min(
        text.length,
        bytes.subarray(0, first.start).toString("utf8").replace(/\r/g, "").length
      );
      matchEnd = Math.min(
        text.length,
        bytes.subarray(0, first.end).toString("utf8").replace(/\r/g, "").length
      );
    }
  }
  return {
    path: path3,
    lineNumber: data.line_number,
    text,
    isContext: event.type === "context",
    matchStart,
    matchEnd
  };
}

// ops/node_modules/@tian.zuo/pi-find/src/errors.ts
var SearchToolMissingError = class extends Data_exports.TaggedError("SearchToolMissingError") {
};
var SearchProcessError = class extends Data_exports.TaggedError("SearchProcessError") {
};
var SearchInputError = class extends Data_exports.TaggedError("SearchInputError") {
};
var SearchAbortedError = class extends Data_exports.TaggedError("SearchAbortedError") {
};
function toThrowable(error) {
  const thrown = new Error(error.message, { cause: error });
  if (error._tag === "SearchAbortedError") thrown.name = "AbortError";
  return thrown;
}

// ops/node_modules/@tian.zuo/pi-find/src/stream.ts
import { spawn } from "node:child_process";
import { statSync as statSync2 } from "node:fs";

// ops/node_modules/@tian.zuo/pi-find/src/binaries.ts
import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import * as path2 from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
var cache = /* @__PURE__ */ new Map();
var MINIMUM_VERSIONS = {
  rg: [12, 0, 0],
  fd: [8, 7, 0]
};
function isSupportedVersion(binary, versionOutput) {
  const match7 = versionOutput.match(/\b(\d+)\.(\d+)(?:\.(\d+))?/);
  if (match7 === null) return false;
  const actual = [Number(match7[1]), Number(match7[2]), Number(match7[3] ?? 0)];
  const minimum = MINIMUM_VERSIONS[binary];
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}
function hasSupportedVersion(candidate, binary) {
  try {
    const output = execFileSync(candidate, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2e3
    });
    return isSupportedVersion(binary, output);
  } catch {
    return false;
  }
}
function isExecutable(candidate) {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function pathCandidates(binary) {
  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  const names = binary === "fd" && process.platform !== "win32" ? ["fd", "fdfind"] : [`${binary}${exeSuffix}`];
  const entries = (process.env.PATH ?? "").split(path2.delimiter);
  return entries.filter((entry) => entry.length > 0).flatMap((entry) => names.map((name) => path2.join(entry, name)));
}
function resolveBinary(binary) {
  const cached3 = cache.get(binary);
  if (cached3 !== void 0) {
    if (isExecutable(cached3)) return cached3;
    cache.delete(binary);
  }
  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  const candidates = [
    // pi's own managed copy: guaranteed version-compatible with the harness.
    path2.join(getAgentDir(), "bin", `${binary}${exeSuffix}`),
    ...pathCandidates(binary)
  ];
  const found = candidates.find(
    (candidate) => isExecutable(candidate) && hasSupportedVersion(candidate, binary)
  );
  if (found !== void 0) cache.set(binary, found);
  return found ?? null;
}
function missingBinaryMessage(binary) {
  const name = binary === "rg" ? "ripgrep (rg)" : "fd";
  const minimum = MINIMUM_VERSIONS[binary].join(".");
  const install = binary === "rg" ? "brew install ripgrep" : "brew install fd";
  return `A supported ${name} (>= ${minimum}) was not found in pi's bin directory or on PATH. Install or upgrade it with \`${install}\` (or the equivalent for your platform) and retry.`;
}

// ops/node_modules/@tian.zuo/pi-find/src/stream.ts
var PATH_ERROR = /\(os error \d+\)$/;
var STDERR_LIMIT = 4096;
function pathErrorOf(stderr) {
  const lines = stderr.split("\n").map((line) => line.trim());
  if (stderr.length >= STDERR_LIMIT) lines.pop();
  const messages = lines.filter((line) => line.length > 0);
  if (messages.length === 0 || !messages.every((line) => PATH_ERROR.test(line))) return void 0;
  return messages[0]?.replace(/^(rg: |\[fd error\]: )/, "");
}
var MAX_RECORD_BYTES = 8 * 1024 * 1024;
function isBenignExit(binary, code, stoppedEarly, timedOut) {
  if (code === 0) return true;
  if (stoppedEarly || timedOut) return true;
  return binary === "rg" && code === 1;
}
function isDirectoryPath(candidate) {
  try {
    return statSync2(candidate).isDirectory();
  } catch {
    return false;
  }
}
function streamLines(request3) {
  return Effect_exports.callback((resume, effectSignal) => {
    const binaryPath = resolveBinary(request3.binary);
    if (binaryPath === null) {
      resume(
        new SearchToolMissingError({
          message: missingBinaryMessage(request3.binary),
          tool: request3.binary
        })
      );
      return;
    }
    const outerSignal = request3.signal;
    if (outerSignal?.aborted === true || effectSignal.aborted) {
      resume(new SearchAbortedError({ message: `${request3.binary} search aborted` }));
      return;
    }
    if (!isDirectoryPath(request3.cwd)) {
      resume(
        new SearchProcessError({
          message: `${request3.binary} could not start: working directory does not exist or is not a directory: ${request3.cwd}`,
          tool: request3.binary
        })
      );
      return;
    }
    const child = spawn(binaryPath, [...request3.args], {
      cwd: request3.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const delimiter2 = request3.delimiter ?? "\n";
    const maxRecordBytes = request3.maxRecordBytes ?? MAX_RECORD_BYTES;
    let pending = "";
    let cutting = false;
    let stderr = "";
    let stoppedEarly = false;
    let timedOut = false;
    let settled = false;
    let aborted = false;
    const cleanup = () => {
      child.stdout.removeListener("data", onData);
      clearTimeout(timeoutId);
      outerSignal?.removeEventListener("abort", onAbort);
      effectSignal.removeEventListener("abort", onAbort);
    };
    const settle = (effect2) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(effect2);
    };
    const stopChild = (signal = "SIGTERM") => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    };
    function onAbort() {
      aborted = true;
      stopChild("SIGKILL");
    }
    const timeoutId = setTimeout(() => {
      timedOut = true;
      stopChild("SIGKILL");
    }, request3.timeoutMs ?? SEARCH_TIMEOUT_MS);
    outerSignal?.addEventListener("abort", onAbort, { once: true });
    effectSignal.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < STDERR_LIMIT)
        stderr = (stderr + chunk.toString("utf8")).slice(0, STDERR_LIMIT);
    });
    function onLine(line, clipped) {
      if (settled || stoppedEarly || aborted) return;
      let wantsMore;
      try {
        wantsMore = request3.onLine(line, clipped);
      } catch (error) {
        stoppedEarly = true;
        stopChild("SIGKILL");
        settle(
          new SearchProcessError({
            message: `Failed to read ${request3.binary} output: ${error instanceof Error ? error.message : String(error)}`,
            tool: request3.binary
          })
        );
        return;
      }
      if (!wantsMore) {
        stoppedEarly = true;
        stopChild("SIGKILL");
      }
    }
    function flush(cut) {
      const line = pending;
      pending = "";
      cutting = false;
      onLine(line, cut);
    }
    function onData(chunk) {
      if (settled || stoppedEarly || aborted) return;
      let start = 0;
      for (; ; ) {
        const end = chunk.indexOf(delimiter2, start);
        if (cutting) {
          if (end === -1) return;
          flush(true);
          if (settled || stoppedEarly || aborted) return;
          start = end + 1;
          continue;
        }
        const room = maxRecordBytes - pending.length;
        const segment = end === -1 ? chunk.slice(start) : chunk.slice(start, end);
        if (segment.length > room) {
          pending += segment.slice(0, room);
          if (end === -1) {
            cutting = true;
            return;
          }
          flush(true);
          if (settled || stoppedEarly || aborted) return;
          start = end + 1;
          continue;
        }
        pending += segment;
        if (end === -1) return;
        flush(false);
        if (settled || stoppedEarly || aborted) return;
        start = end + 1;
      }
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.on("error", (error) => {
      settle(
        new SearchProcessError({
          message: `Failed to run ${request3.binary}: ${error.message}`,
          tool: request3.binary
        })
      );
    });
    child.on("close", (code, signal) => {
      if (!timedOut && (pending.length > 0 || cutting)) flush(cutting);
      pending = "";
      cutting = false;
      if (aborted) {
        settle(
          new SearchAbortedError({
            message: `${request3.binary} search aborted`
          })
        );
        return;
      }
      const pathError = pathErrorOf(stderr);
      const partialWalk = request3.binary === "rg" && code === 2 && pathError !== void 0;
      if (!partialWalk && !isBenignExit(request3.binary, code, stoppedEarly, timedOut)) {
        const detail = stderr.trim().split("\n")[0] ?? "";
        settle(
          new SearchProcessError({
            message: detail.length > 0 ? `${request3.binary} failed: ${detail}` : signal !== null ? `${request3.binary} terminated by ${signal}` : `${request3.binary} exited with code ${code}`,
            tool: request3.binary,
            exitCode: code ?? void 0
          })
        );
        return;
      }
      settle(Effect_exports.succeed({ stoppedEarly, timedOut, exitCode: code, pathError }));
    });
    return Effect_exports.sync(() => {
      stopChild("SIGKILL");
      cleanup();
    });
  });
}

// ops/node_modules/@tian.zuo/pi-find/src/runtime.ts
var MAX_LINE_LENGTH = 400;
function finalizeGrep(outcome) {
  const complete = !outcome.truncated && !outcome.timedOut && outcome.skippedRecords === 0;
  const include = outcome.output === "content" && complete && outcome.matches.length >= 1 && outcome.matches.length <= AUTO_CONTEXT_MAX_MATCHES;
  return {
    ...outcome,
    context: include ? outcome.context.filter(
      (row) => outcome.matches.some(
        (match7) => match7.path === row.path && Math.abs(match7.lineNumber - row.lineNumber) <= AUTO_CONTEXT_LINES
      )
    ) : []
  };
}
var SearchRuntime = class extends Context_exports.Service()(
  "pi-find/SearchRuntime"
) {
};
function normalizeResultPath(filePath) {
  const native = nodePath.normalize(filePath);
  const normalized = process.platform === "win32" ? native.replaceAll("\\", "/") : native;
  return normalized.replace(/^\.\//, "");
}
function clipLine(text, matchStart = 0, matchEnd = matchStart) {
  if (text.length <= MAX_LINE_LENGTH) return text;
  const padding = Math.floor(
    (MAX_LINE_LENGTH - Math.min(matchEnd - matchStart, MAX_LINE_LENGTH)) / 2
  );
  let start = Math.max(0, Math.min(matchStart - padding, text.length - MAX_LINE_LENGTH));
  let end = start + MAX_LINE_LENGTH;
  if (/[\uDC00-\uDFFF]/.test(text[start] ?? "")) start += 1;
  if (/[\uDC00-\uDFFF]/.test(text[end] ?? "")) end -= 1;
  return `${start > 0 ? "\u2026 " : ""}${text.slice(start, end)}${end < text.length ? "\u2026" : ""} (${text.length} chars)`;
}
function searchTarget(cwd, requestedPath, requireDirectory) {
  let argument = (requestedPath ?? ".").replace(/^@/, "");
  if (argument === "~") argument = homedir();
  else if (argument.startsWith("~/") || process.platform === "win32" && argument.startsWith("~\\")) {
    argument = nodePath.join(homedir(), argument.slice(2));
  }
  const absolute = nodePath.resolve(cwd, argument);
  let isDirectory;
  try {
    isDirectory = statSync3(absolute).isDirectory();
  } catch {
    return new SearchInputError({ message: missingSearchPathError(argument) });
  }
  let resolved = absolute;
  try {
    resolved = realpathSync(absolute);
  } catch {
  }
  if ([absolute, resolved].some((path3) => normalizeResultPath(path3).split("/").includes(".git"))) {
    return new SearchInputError({ message: GIT_PATH_ERROR });
  }
  if (requireDirectory && !isDirectory) {
    return new SearchInputError({ message: findPathNotDirectoryError(argument) });
  }
  return {
    argument,
    root: isDirectory ? absolute : nodePath.dirname(absolute),
    isFile: !isDirectory
  };
}
function isInsideGitRepository(root) {
  for (let current = root; ; ) {
    if (existsSync(nodePath.join(current, ".git"))) return true;
    const parent = nodePath.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
function isExplicitHiddenPath(searchPath) {
  if (searchPath === void 0) return false;
  return searchPath.replaceAll("\\", "/").split("/").some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");
}
var GREP_MAX_FILESIZE = "4M";
function globBody(pattern) {
  return pattern.startsWith("!") ? pattern.slice(1) : pattern;
}
function basenamePrefilter(pattern) {
  if (pattern === void 0 || pattern.startsWith("!")) return "*";
  const basename = pattern.split("/").at(-1);
  return /^[a-zA-Z0-9_./*?-]+$/.test(pattern) && basename ? basename : "*";
}
function buildRgArgs(request3, searchRoot) {
  const args2 = [
    "--no-config",
    "--case-sensitive",
    "--color=never",
    "--max-filesize",
    GREP_MAX_FILESIZE
  ];
  if (request3.output === "files") {
    args2.push("--files-with-matches", "--null");
  } else {
    args2.push("--json", "--line-number", "--context", String(AUTO_CONTEXT_LINES));
  }
  if (request3.literal) args2.push("--fixed-strings");
  if (!isInsideGitRepository(searchRoot)) args2.push("--no-require-git");
  const prefilter = basenamePrefilter(request3.glob);
  if (prefilter !== "*") args2.push("--type-add", `pifind:${prefilter}`, "--type", "pifind");
  if (!isExplicitHiddenPath(request3.path)) args2.push("--glob", "!.*");
  args2.push("--glob", "!.git/", "--regexp", request3.pattern, "--", request3.path ?? ".");
  return args2;
}
function buildFdArgs(request3, searchRoot) {
  const args2 = [
    "--type",
    "f",
    "--print0",
    // fd hides unreadable directories by default, which would pass a
    // partial walk off as a complete one.
    "--show-errors",
    "--color=never",
    "--ignore-case",
    "--glob",
    "--exclude",
    ".git"
  ];
  if (!isInsideGitRepository(searchRoot)) args2.push("--no-require-git");
  args2.push("--", basenamePrefilter(request3.pattern), request3.path ?? ".");
  return args2;
}
function pathMatcher(pattern, root, cwd, nocase) {
  const negated = pattern?.startsWith("!") === true;
  const body = pattern === void 0 ? void 0 : globBody(pattern);
  const matcher = body === void 0 || body.length === 0 ? void 0 : new Minimatch(body, {
    dot: true,
    matchBase: !body.includes("/"),
    nonegate: true,
    nocomment: true,
    nocase
  });
  return (file) => {
    if (matcher === void 0) return true;
    const absolute = nodePath.resolve(cwd, file);
    const matched = matcher.match(normalizeResultPath(nodePath.relative(root, absolute)));
    return negated ? !matched : matched;
  };
}
var makeSearchRuntime = Effect_exports.gen(function* () {
  const grep = (request3) => Effect_exports.suspend(() => {
    if (request3.pattern.length === 0) {
      return Effect_exports.fail(new SearchInputError({ message: EMPTY_PATTERN_ERROR }));
    }
    if (request3.glob !== void 0 && globBody(request3.glob).length === 0) {
      return Effect_exports.fail(new SearchInputError({ message: EMPTY_PATTERN_ERROR }));
    }
    const target = searchTarget(request3.cwd, request3.path, false);
    if (target instanceof SearchInputError) return Effect_exports.fail(target);
    const accepts = pathMatcher(request3.glob, target.root, request3.cwd, false);
    const output = request3.output ?? "content";
    const matches = [];
    const context3 = [];
    const files = /* @__PURE__ */ new Set();
    let skippedRecords = 0;
    let rejectedByGlob = 0;
    let clippedLines = 0;
    let searched;
    return streamLines({
      binary: "rg",
      args: buildRgArgs({ ...request3, path: target.argument }, target.root),
      delimiter: output === "files" ? "\0" : "\n",
      cwd: request3.cwd,
      signal: request3.signal,
      onLine(line, clipped) {
        if (clipped) {
          if (output === "files" || !line.startsWith('{"type":"context"')) {
            skippedRecords += 1;
          }
          return true;
        }
        if (output === "files") {
          if (line.length === 0) return true;
          if (!accepts(line)) {
            rejectedByGlob += 1;
            return true;
          }
          const file = normalizeResultPath(line);
          if (files.has(file)) return true;
          if (files.size >= GREP_FILE_LIMIT) return false;
          files.add(file);
          return true;
        }
        const event = decodeRgEvent(line);
        if (event === void 0) {
          searched = decodeRgSummary(line) ?? searched;
          return true;
        }
        if (!accepts(event.path)) {
          if (!event.isContext) rejectedByGlob += 1;
          return true;
        }
        if (event.isContext && (skippedRecords > 0 || matches.length > AUTO_CONTEXT_MAX_MATCHES))
          return true;
        if (!event.isContext && matches.length >= GREP_RESULT_LIMIT) return false;
        const row = {
          path: normalizeResultPath(event.path),
          lineNumber: event.lineNumber,
          text: clipLine(event.text, event.matchStart, event.matchEnd)
        };
        if (event.isContext) {
          context3.push(row);
        } else {
          matches.push(row);
          files.add(row.path);
          if (event.text.length > MAX_LINE_LENGTH) clippedLines += 1;
          if (matches.length > AUTO_CONTEXT_MAX_MATCHES) context3.length = 0;
        }
        return true;
      }
    }).pipe(
      Effect_exports.map(
        (result3) => finalizeGrep({
          output,
          matches,
          context: context3,
          files: [...files].sort(),
          truncated: result3.stoppedEarly,
          timedOut: result3.timedOut,
          skippedRecords,
          rejectedByGlob,
          explicitFile: target.isFile,
          clippedLines,
          pathError: result3.pathError,
          searched
        })
      )
    );
  });
  const find = (request3) => Effect_exports.suspend(() => {
    if (globBody(request3.pattern).length === 0) {
      return Effect_exports.fail(new SearchInputError({ message: EMPTY_PATTERN_ERROR }));
    }
    const target = searchTarget(request3.cwd, request3.path, true);
    if (target instanceof SearchInputError) return Effect_exports.fail(target);
    const accepts = pathMatcher(request3.pattern, target.root, request3.cwd, true);
    const files = [];
    let sawOverflow = false;
    let skippedRecords = 0;
    let rejectedByGlob = 0;
    return streamLines({
      binary: "fd",
      args: buildFdArgs({ ...request3, path: target.argument }, target.root),
      delimiter: "\0",
      cwd: request3.cwd,
      signal: request3.signal,
      onLine(line, clipped) {
        if (clipped) {
          skippedRecords += 1;
          return true;
        }
        const file = line;
        if (file.length === 0) return true;
        if (!accepts(file)) {
          rejectedByGlob += 1;
          return true;
        }
        if (files.length >= FIND_RESULT_LIMIT) {
          sawOverflow = true;
          return false;
        }
        files.push(normalizeResultPath(file));
        return true;
      }
    }).pipe(
      Effect_exports.map(
        (result3) => ({
          files: files.sort(),
          truncated: sawOverflow || result3.stoppedEarly,
          timedOut: result3.timedOut,
          skippedRecords,
          rejectedByGlob,
          pathError: result3.pathError
        })
      )
    );
  });
  return SearchRuntime.of({ grep, find });
});
var SearchRuntimeLive = Layer_exports.effect(
  SearchRuntime,
  makeSearchRuntime
);
function createSearchRuntime() {
  return ManagedRuntime_exports.make(SearchRuntimeLive);
}
async function runSearch(runtime, effect2, options = {}) {
  const exit3 = await runtime.runPromiseExit(
    effect2,
    options.signal ? { signal: options.signal } : void 0
  );
  if (Exit_exports.isSuccess(exit3)) return exit3.value;
  if (Cause_exports.hasInterruptsOnly(exit3.cause)) {
    const aborted = new Error("search aborted");
    aborted.name = "AbortError";
    throw aborted;
  }
  const failure = Cause_exports.findFail(exit3.cause);
  if (Result_exports.isSuccess(failure)) throw toThrowable(failure.success.error);
  const [first] = Cause_exports.prettyErrors(exit3.cause);
  throw new Error(first?.message ?? Cause_exports.pretty(exit3.cause));
}

// ops/node_modules/@tian.zuo/pi-find/lib/debug.ts
import { appendFileSync, mkdirSync, renameSync, statSync as statSync4 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import nodePath2 from "node:path";
var DEBUG_EVENT_VERSION = 2;
var MAX_DEBUG_LOG_BYTES = 10 * 1024 * 1024;
function debugEnabled() {
  const value = process.env.PI_FIND_DEBUG;
  return value === "1" || value === "true" || value === "on";
}
function debugFile() {
  return process.env.PI_FIND_DEBUG_FILE ?? nodePath2.join(homedir2(), ".pi", "pi-find", "debug.jsonl");
}
function appendEvent(event) {
  try {
    const file = debugFile();
    mkdirSync(nodePath2.dirname(file), { recursive: true });
    try {
      if (statSync4(file).size >= MAX_DEBUG_LOG_BYTES) renameSync(file, `${file}.1`);
    } catch {
    }
    appendFileSync(file, `${JSON.stringify(event)}
`);
  } catch {
  }
}
function sessionFields(ctx) {
  try {
    return {
      sessionId: ctx.sessionManager?.getSessionId(),
      sessionFile: ctx.sessionManager?.getSessionFile(),
      model: ctx.model === void 0 ? void 0 : `${ctx.model.provider}/${ctx.model.id}`
    };
  } catch {
    return {};
  }
}
function failureFields(error) {
  const cause = error instanceof Error ? error.cause : void 0;
  const typed = typeof cause === "object" && cause !== null && "_tag" in cause ? cause : void 0;
  return {
    outcome: error instanceof Error && error.name === "AbortError" ? "aborted" : "error",
    errorTag: typed?._tag,
    exitCode: typed?.exitCode,
    error: error instanceof Error ? error.message : String(error)
  };
}
async function withSearchLog(call, run) {
  if (!debugEnabled()) return (await run()).result;
  const startedAt = Date.now();
  const base = () => ({
    v: DEBUG_EVENT_VERSION,
    ts: new Date(startedAt).toISOString(),
    tool: call.tool,
    cwd: call.ctx.cwd,
    ...sessionFields(call.ctx),
    toolCallId: call.toolCallId,
    params: call.params,
    durationMs: Date.now() - startedAt
  });
  try {
    const { result: result3, stats } = await run();
    appendEvent({ ...base(), outcome: "ok", ...stats });
    return result3;
  } catch (error) {
    appendEvent({ ...base(), ...failureFields(error) });
    throw error;
  }
}

// ops/node_modules/@tian.zuo/pi-find/lib/results.ts
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
var BODY_MAX_BYTES = DEFAULT_MAX_BYTES - 8 * 1024;
function displayPath(path3) {
  return /[\x00-\x1f\x7f\\"]/.test(path3) ? JSON.stringify(path3) : path3;
}
function fileRows(files) {
  return files.map((path3) => ({ path: path3, text: displayPath(path3), isMatch: true }));
}
function grepRows(outcome) {
  const groups = /* @__PURE__ */ new Map();
  for (const match7 of outcome.matches) {
    const group = groups.get(match7.path) ?? /* @__PURE__ */ new Map();
    group.set(match7.lineNumber, { text: match7.text, isMatch: true });
    groups.set(match7.path, group);
  }
  for (const row of outcome.context) {
    const group = groups.get(row.path);
    if (group && !group.has(row.lineNumber)) {
      group.set(row.lineNumber, { text: row.text, isMatch: false });
    }
  }
  const rows = [];
  for (const [path3, group] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    let previous;
    for (const [number2, row] of [...group].sort(([a], [b]) => a - b)) {
      const prefix = previous === void 0 ? `${rows.length > 0 ? "\n" : ""}${displayPath(path3)}
` : number2 > previous + 1 ? "--\n" : "";
      rows.push({
        path: path3,
        isMatch: row.isMatch,
        text: `${prefix}${number2}${row.isMatch ? ":" : "-"} ${row.text}`
      });
      previous = number2;
    }
  }
  return rows;
}
function boundedBody(rows, maxBytes = BODY_MAX_BYTES) {
  const body = [];
  const files = /* @__PURE__ */ new Set();
  let bytes = 0;
  let resultCount = 0;
  let quotedPaths = false;
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(row.text, "utf8") + (body.length > 0 ? 1 : 0);
    if (bytes + rowBytes > maxBytes) break;
    body.push(row.text);
    bytes += rowBytes;
    files.add(row.path);
    if (row.isMatch) resultCount += 1;
    if (displayPath(row.path) !== row.path) quotedPaths = true;
  }
  return {
    text: body.join("\n"),
    resultCount,
    fileCount: files.size,
    truncated: body.length < rows.length,
    quotedPaths
  };
}
function resultText(header, body, notices) {
  return [
    header,
    ...body.length === 0 ? [] : ["", body],
    ...notices.flatMap((notice2) => ["", notice2])
  ].join("\n");
}

// ops/node_modules/@tian.zuo/pi-find/lib/tools.ts
var notice = (id, text) => ({ id, text });
var texts = (notices) => notices.map((entry) => entry.text);
var ids = (notices) => notices.map((entry) => entry.id);
function slashGlobNotices(glob, searchPath, rejected) {
  if (glob === void 0 || searchPath === void 0 || rejected === 0 || !glob.includes("/"))
    return [];
  const base = searchPath.replace(/^@/, "").replaceAll("\\", "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (base === "" || base === ".") return [];
  const negation = glob.startsWith("!") ? "!" : "";
  const body = glob.slice(negation.length).replace(/^(\.\/)+/, "");
  if (body.startsWith(`${base}/`) && body.length > base.length + 1) {
    const suggestion = `${negation}${body.slice(base.length + 1)}`;
    return [notice("glob_prefix", globPrefixNotice(glob, searchPath, suggestion))];
  }
  return [notice("slash_glob", SLASH_GLOB_NOTICE)];
}
function hiddenPathNotices(searchPath, explicitFile) {
  return explicitFile || isExplicitHiddenPath(searchPath?.replace(/^@/, "")) ? [] : [notice("hidden_path", HIDDEN_PATH_NOTICE)];
}
function unreadableNotices(pathError) {
  return pathError === void 0 ? [] : [notice("unreadable_path", unreadablePathNotice(pathError))];
}
var GrepParams = Type.Object({
  pattern: Type.String({ minLength: 1, description: GREP_PARAMETER_DESCRIPTIONS.pattern }),
  path: Type.Optional(Type.String({ minLength: 1, description: GREP_PARAMETER_DESCRIPTIONS.path })),
  glob: Type.Optional(Type.String({ minLength: 1, description: GREP_PARAMETER_DESCRIPTIONS.glob })),
  output: Type.Optional(
    StringEnum(["content", "files"], { description: GREP_PARAMETER_DESCRIPTIONS.output })
  ),
  literal: Type.Optional(Type.Boolean({ description: GREP_PARAMETER_DESCRIPTIONS.literal }))
});
var FindParams = Type.Object({
  pattern: Type.String({ minLength: 1, description: FIND_PARAMETER_DESCRIPTIONS.pattern }),
  path: Type.Optional(Type.String({ minLength: 1, description: FIND_PARAMETER_DESCRIPTIONS.path }))
});
function registerTools(pi, runtime) {
  pi.registerTool({
    name: "grep",
    label: "grep",
    description: GREP_TOOL_DESCRIPTION,
    promptSnippet: GREP_PROMPT_SNIPPET,
    parameters: GrepParams,
    execute(toolCallId, params, signal, _onUpdate, ctx) {
      return withSearchLog({ tool: "grep", toolCallId, params, ctx }, async () => {
        const service3 = runtime.runSync(SearchRuntime);
        const outcome = await runSearch(
          runtime,
          service3.grep({ ...params, cwd: ctx.cwd, signal }),
          { signal }
        );
        const filesOnly = outcome.output === "files";
        let body = boundedBody(filesOnly ? fileRows(outcome.files) : grepRows(outcome));
        const droppedContext = body.truncated && outcome.context.length > 0;
        if (droppedContext) body = boundedBody(grepRows({ ...outcome, context: [] }));
        const truncated = outcome.truncated || body.truncated || outcome.skippedRecords > 0;
        const unreadable = outcome.pathError !== void 0;
        const partial = truncated || outcome.timedOut || unreadable;
        const notices = [
          ...body.quotedPaths ? [notice("quoted_path", QUOTED_PATH_NOTICE)] : [],
          ...unreadableNotices(outcome.pathError),
          ...outcome.truncated ? [
            notice(
              "result_limit",
              resultLimitNotice(
                filesOnly ? "files" : "matches",
                filesOnly ? GREP_FILE_LIMIT : GREP_RESULT_LIMIT
              )
            )
          ] : [],
          ...body.truncated ? [notice("output_limit", outputLimitNotice(filesOnly ? "find" : "grep"))] : [],
          ...outcome.skippedRecords > 0 ? [notice("oversized_record", oversizedRecordNotice(MAX_RECORD_BYTES))] : [],
          ...outcome.timedOut ? [notice("timeout", searchTimeoutNotice(SEARCH_TIMEOUT_MS))] : [],
          ...!droppedContext && outcome.context.length > 0 ? [notice("auto_context", AUTO_CONTEXT_NOTICE)] : [],
          ...body.resultCount === 0 && !partial ? [
            ...outcome.explicitFile ? [] : [notice("file_size_limit", FILE_SIZE_LIMIT_NOTICE)],
            ...hiddenPathNotices(params.path, outcome.explicitFile),
            ...slashGlobNotices(params.glob, params.path, outcome.rejectedByGlob)
          ] : []
        ];
        const header = body.resultCount === 0 && !partial ? filesOnly ? NO_FILES_FOUND : NO_GREP_MATCHES : filesOnly ? findResultHeader(body.resultCount, partial) : grepResultHeader(body.resultCount, body.fileCount, partial);
        const text = resultText(header, body.text, texts(notices));
        return {
          result: {
            content: [{ type: "text", text }],
            details: {
              kind: "grep",
              output: outcome.output,
              query: params.pattern,
              resultCount: body.resultCount,
              fileCount: body.fileCount,
              truncated,
              timedOut: outcome.timedOut,
              unreadable
            }
          },
          stats: {
            resultCount: body.resultCount,
            collectedCount: filesOnly ? outcome.files.length : outcome.matches.length,
            fileCount: body.fileCount,
            resultLimitHit: outcome.truncated,
            outputLimitHit: body.truncated,
            timedOut: outcome.timedOut,
            skippedRecords: outcome.skippedRecords,
            rejectedByGlob: outcome.rejectedByGlob,
            prefilter: basenamePrefilter(params.glob),
            outputBytes: Buffer.byteLength(text, "utf8"),
            pathError: outcome.pathError,
            explicitFile: outcome.explicitFile,
            clippedLines: outcome.clippedLines,
            searchedFiles: outcome.searched?.searchedFiles,
            searchedBytes: outcome.searched?.searchedBytes,
            contextLines: droppedContext ? 0 : outcome.context.length,
            droppedContext,
            notices: ids(notices)
          }
        };
      });
    },
    renderCall(args2, theme) {
      const pattern = typeof args2?.pattern === "string" && args2.pattern.length > 0 ? theme.fg("accent", args2.literal ? JSON.stringify(args2.pattern) : `/${args2.pattern}/`) : theme.fg("muted", "\u2026");
      const scope3 = typeof args2?.path === "string" ? theme.fg("muted", ` in ${args2.path}`) : "";
      const filter5 = typeof args2?.glob === "string" ? theme.fg("muted", ` (${args2.glob})`) : "";
      const mode = args2?.output === "files" ? theme.fg("muted", " [files]") : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("grep ")) + pattern + scope3 + filter5 + mode,
        0,
        0
      );
    },
    renderResult(result3, options, theme, context3) {
      return renderSearchResult(result3, options, theme, context3.isError);
    }
  });
  pi.registerTool({
    name: "find",
    label: "find",
    description: FIND_TOOL_DESCRIPTION,
    promptSnippet: FIND_PROMPT_SNIPPET,
    parameters: FindParams,
    execute(toolCallId, params, signal, _onUpdate, ctx) {
      return withSearchLog({ tool: "find", toolCallId, params, ctx }, async () => {
        const service3 = runtime.runSync(SearchRuntime);
        const outcome = await runSearch(
          runtime,
          service3.find({ ...params, cwd: ctx.cwd, signal }),
          { signal }
        );
        const body = boundedBody(fileRows(outcome.files));
        const count = body.resultCount;
        const truncated = outcome.truncated || body.truncated || outcome.skippedRecords > 0;
        const unreadable = outcome.pathError !== void 0;
        const partial = truncated || outcome.timedOut || unreadable;
        const notices = [
          ...outcome.skippedRecords > 0 ? [notice("oversized_record", oversizedRecordNotice(MAX_RECORD_BYTES))] : [],
          ...body.quotedPaths ? [notice("quoted_path", QUOTED_PATH_NOTICE)] : [],
          ...unreadableNotices(outcome.pathError),
          ...outcome.truncated ? [notice("result_limit", resultLimitNotice("files", FIND_RESULT_LIMIT))] : [],
          ...body.truncated ? [notice("output_limit", outputLimitNotice("find"))] : [],
          ...outcome.timedOut ? [notice("timeout", searchTimeoutNotice(SEARCH_TIMEOUT_MS))] : [],
          ...count === 0 && !partial ? [
            ...hiddenPathNotices(params.path, false),
            ...slashGlobNotices(params.pattern, params.path, outcome.rejectedByGlob)
          ] : []
        ];
        const header = count === 0 && !partial ? NO_FILES_FOUND : findResultHeader(count, partial);
        const text = resultText(header, body.text, texts(notices));
        return {
          result: {
            content: [{ type: "text", text }],
            details: {
              kind: "find",
              query: params.pattern,
              resultCount: count,
              fileCount: body.fileCount,
              truncated,
              timedOut: outcome.timedOut,
              unreadable
            }
          },
          stats: {
            resultCount: count,
            collectedCount: outcome.files.length,
            fileCount: body.fileCount,
            resultLimitHit: outcome.truncated,
            outputLimitHit: body.truncated,
            timedOut: outcome.timedOut,
            skippedRecords: outcome.skippedRecords,
            rejectedByGlob: outcome.rejectedByGlob,
            prefilter: basenamePrefilter(params.pattern),
            outputBytes: Buffer.byteLength(text, "utf8"),
            pathError: outcome.pathError,
            notices: ids(notices)
          }
        };
      });
    },
    renderCall(args2, theme) {
      const pattern = typeof args2?.pattern === "string" && args2.pattern.length > 0 ? theme.fg("accent", args2.pattern) : theme.fg("muted", "\u2026");
      const scope3 = typeof args2?.path === "string" ? theme.fg("muted", ` in ${args2.path}`) : "";
      return new Text(theme.fg("toolTitle", theme.bold("find ")) + pattern + scope3, 0, 0);
    },
    renderResult(result3, options, theme, context3) {
      return renderSearchResult(result3, options, theme, context3.isError);
    }
  });
}
function textResult(result3) {
  return result3.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
function expandedResult(summary, output, expanded, theme) {
  if (!expanded || output.length === 0) return new Text(summary, 0, 0);
  return new Text([summary, theme.fg("toolOutput", output)].join("\n"), 0, 0);
}
function renderSearchResult(result3, options, theme, isError) {
  const output = textResult(result3);
  if (options.isPartial) return new Text(theme.fg("warning", "searching\u2026"), 0, 0);
  if (isError) {
    const firstLine = output.split("\n").find((line) => line.trim().length > 0) ?? "search failed";
    return expandedResult(theme.fg("error", `\u2717 ${firstLine}`), output, options.expanded, theme);
  }
  const details = result3.details;
  if (details === void 0) {
    return expandedResult(
      theme.fg("success", "\u2713 search completed"),
      output,
      options.expanded,
      theme
    );
  }
  if (details.resultCount === 0) {
    const summary2 = details.timedOut ? theme.fg("warning", "search timed out (no results gathered)") : details.truncated ? theme.fg("warning", "no results shown (truncated)") : details.unreadable ? theme.fg("warning", "no results (some paths unreadable)") : theme.fg("muted", "no results");
    return expandedResult(summary2, output, options.expanded, theme);
  }
  const filesOnly = details.kind === "find" || details.output === "files";
  const unit = filesOnly ? `file${details.resultCount === 1 ? "" : "s"}` : `match${details.resultCount === 1 ? "" : "es"}`;
  const scope3 = filesOnly ? "" : ` in ${details.fileCount} file${details.fileCount === 1 ? "" : "s"}`;
  const more = (details.truncated ? theme.fg("warning", " (truncated)") : "") + (details.timedOut ? theme.fg("warning", " (timed out)") : "") + (details.unreadable ? theme.fg("warning", " (some paths unreadable)") : "");
  const summary = theme.fg("success", "\u2713 ") + theme.fg("muted", `${details.resultCount} ${unit}${scope3}`) + more;
  return expandedResult(summary, output, options.expanded, theme);
}

// ops/node_modules/@tian.zuo/pi-find/index.ts
function searchExtension(pi) {
  const runtime = createSearchRuntime();
  registerTools(pi, runtime);
  pi.on("session_shutdown", async () => {
    try {
      await runtime.dispose();
    } catch {
    }
  });
}
export {
  searchExtension as default
};
